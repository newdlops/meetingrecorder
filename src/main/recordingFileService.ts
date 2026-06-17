import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  RecordingChunkAppendRequest,
  RecordingFileCompleteRequest,
  RecordingFileResult,
  RecordingFileStartRequest
} from '../shared/types';

interface RecordingFileSession {
  recordingId: string;
  audioMimeType: string;
  filePath: string;
  tempDir: string;
  writeQueue: Promise<void>;
  dataBytes: number;
  isWav: boolean;
  externalWriter: boolean;
}

interface CompletedRecordingFile {
  recordingId: string;
  audioMimeType: string;
  filePath: string;
  tempDir: string;
  durationMs: number;
}

interface WavSnapshot {
  fileData: Buffer;
  header: Buffer;
  dataBytes: number;
  byteRate: number;
  blockAlign: number;
}

const WAV_HEADER_BYTES = 44;
const WAV_PREVIEW_CHUNK_WAIT_TIMEOUT_MS = 15_000;
const WAV_PREVIEW_CHUNK_WAIT_INTERVAL_MS = 250;

// 장시간 녹음이 렌더러 메모리와 IPC 한계를 넘지 않도록 청크를 메인 프로세스 파일로 누적한다.
export class RecordingFileService {
  private activeRecordings = new Map<string, RecordingFileSession>();
  private completedRecordings = new Map<string, CompletedRecordingFile>();

  async start(request: RecordingFileStartRequest): Promise<void> {
    this.assertSafeRecordingId(request.recordingId);
    await this.discard(request.recordingId);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'meeting-recorder-live-recording-'));
    const filePath = path.join(tempDir, `recording${this.getExtension(request.audioMimeType)}`);
    const isWav = request.audioMimeType.includes('wav');
    const externalWriter = Boolean(request.externalWriter);
    await mkdir(tempDir, { recursive: true });

    if (!externalWriter) {
      await writeFile(filePath, isWav ? this.createWavHeader(0) : Buffer.alloc(0));
    }

    this.activeRecordings.set(request.recordingId, {
      recordingId: request.recordingId,
      audioMimeType: request.audioMimeType,
      filePath,
      tempDir,
      writeQueue: Promise.resolve(),
      dataBytes: 0,
      isWav,
      externalWriter
    });
  }

  async appendChunk(request: RecordingChunkAppendRequest): Promise<void> {
    const recording = this.getActiveRecording(request.recordingId);
    const chunk = Buffer.from(request.audioData);

    recording.dataBytes += chunk.byteLength;
    recording.writeQueue = recording.writeQueue.then(() => appendFile(recording.filePath, chunk));
    await recording.writeQueue;
  }

  async complete(request: RecordingFileCompleteRequest): Promise<RecordingFileResult> {
    const recording = this.getActiveRecording(request.recordingId);
    await recording.writeQueue;
    if (recording.isWav && recording.dataBytes > 0 && !recording.externalWriter) {
      await this.finalizeWavHeader(recording.filePath, recording.dataBytes);
    }
    this.activeRecordings.delete(request.recordingId);
    const durationMs =
      recording.isWav && recording.dataBytes > 0 && !recording.externalWriter
        ? Math.round((recording.dataBytes / (16_000 * 2)) * 1000)
        : request.durationMs;

    const completed: CompletedRecordingFile = {
      recordingId: recording.recordingId,
      audioMimeType: request.audioMimeType || recording.audioMimeType,
      filePath: recording.filePath,
      tempDir: recording.tempDir,
      durationMs
    };
    this.completedRecordings.set(request.recordingId, completed);

    return {
      recordingId: completed.recordingId,
      audioMimeType: completed.audioMimeType,
      durationMs: completed.durationMs
    };
  }

  getActiveFilePath(recordingId: string): string {
    return this.getActiveRecording(recordingId).filePath;
  }

  getCompletedFile(recordingId: string): CompletedRecordingFile {
    this.assertSafeRecordingId(recordingId);
    const recording = this.completedRecordings.get(recordingId);

    if (!recording) {
      throw new Error('완료된 녹음 파일을 찾을 수 없습니다.');
    }

    return recording;
  }

  async copyCompletedFile(recordingId: string, targetPath: string): Promise<void> {
    const recording = this.getCompletedFile(recordingId);
    await copyFile(recording.filePath, targetPath);
  }

  async writeWavChunkToFile(
    recordingId: string,
    outputPath: string,
    startMs: number,
    durationMs: number
  ): Promise<{ audioMimeType: string; durationMs: number }> {
    const recording = await this.waitForReadableWavChunk(recordingId, startMs, durationMs);
    const snapshot = await this.readWavSnapshot(recording);
    const startByte = this.alignByteOffset(Math.round((startMs / 1000) * snapshot.byteRate), snapshot.blockAlign);
    const requestedBytes = this.alignByteOffset(
      Math.round((Math.max(1, durationMs) / 1000) * snapshot.byteRate),
      snapshot.blockAlign
    );
    const endByte = Math.min(snapshot.dataBytes, startByte + requestedBytes);

    if (endByte <= startByte) {
      throw new Error('전사할 녹음 구간이 아직 파일에 저장되지 않았습니다.');
    }

    const chunkData = snapshot.fileData.subarray(WAV_HEADER_BYTES + startByte, WAV_HEADER_BYTES + endByte);
    const header = this.createWavHeaderFromSource(snapshot.header, chunkData.byteLength);
    await writeFile(outputPath, Buffer.concat([header, chunkData]));

    return {
      audioMimeType: recording.audioMimeType,
      durationMs: Math.max(1, Math.round((chunkData.byteLength / snapshot.byteRate) * 1000))
    };
  }

  async discard(recordingId: string): Promise<void> {
    this.assertSafeRecordingId(recordingId);
    const activeRecording = this.activeRecordings.get(recordingId);
    const completedRecording = this.completedRecordings.get(recordingId);
    this.activeRecordings.delete(recordingId);
    this.completedRecordings.delete(recordingId);

    if (activeRecording) {
      await activeRecording.writeQueue.catch(() => undefined);
      await rm(activeRecording.tempDir, { recursive: true, force: true });
    }

    if (completedRecording) {
      await rm(completedRecording.tempDir, { recursive: true, force: true });
    }
  }

  async shutdown(): Promise<void> {
    const recordingIds = new Set([
      ...this.activeRecordings.keys(),
      ...this.completedRecordings.keys()
    ]);

    await Promise.all([...recordingIds].map((recordingId) => this.discard(recordingId)));
  }

  private getActiveRecording(recordingId: string): RecordingFileSession {
    this.assertSafeRecordingId(recordingId);
    const recording = this.activeRecordings.get(recordingId);

    if (!recording) {
      throw new Error('진행 중인 녹음 파일을 찾을 수 없습니다.');
    }

    return recording;
  }

  private getReadableRecording(recordingId: string): RecordingFileSession | CompletedRecordingFile {
    this.assertSafeRecordingId(recordingId);
    const activeRecording = this.activeRecordings.get(recordingId);

    if (activeRecording) {
      return activeRecording;
    }

    const completedRecording = this.completedRecordings.get(recordingId);

    if (completedRecording) {
      return completedRecording;
    }

    throw new Error('녹음 파일을 찾을 수 없습니다.');
  }

  private async waitForReadableWavChunk(
    recordingId: string,
    startMs: number,
    durationMs: number
  ): Promise<RecordingFileSession | CompletedRecordingFile> {
    const recording = this.getReadableRecording(recordingId);
    const deadline = Date.now() + WAV_PREVIEW_CHUNK_WAIT_TIMEOUT_MS;
    const requestedEndMs = startMs + Math.max(1, durationMs);
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        if ('writeQueue' in recording) {
          await recording.writeQueue;
        }

        const snapshot = await this.readWavSnapshot(recording);
        const readableDurationMs = Math.floor((snapshot.dataBytes / snapshot.byteRate) * 1000);

        if (readableDurationMs >= requestedEndMs) {
          return recording;
        }
      } catch (error) {
        lastError = error;
      }

      await this.delay(WAV_PREVIEW_CHUNK_WAIT_INTERVAL_MS);
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error('녹음 파일에 전사할 미리보기 구간이 아직 충분히 저장되지 않았습니다.');
  }

  private async readWavSnapshot(recording: RecordingFileSession | CompletedRecordingFile): Promise<WavSnapshot> {
    const fileData = await readFile(recording.filePath);

    if (fileData.byteLength <= WAV_HEADER_BYTES) {
      throw new Error('녹음 파일에 오디오 데이터가 아직 없습니다.');
    }

    const header = fileData.subarray(0, WAV_HEADER_BYTES);

    if (!this.isStandardWavHeader(header)) {
      throw new Error('미리보기 전사는 WAV 녹음 파일에서만 구간 추출을 지원합니다.');
    }

    const byteRate = Math.max(1, header.readUInt32LE(28));
    const blockAlign = Math.max(1, header.readUInt16LE(32));
    const declaredDataBytes = header.readUInt32LE(40);
    const availableDataBytes = this.alignByteOffset(fileData.byteLength - WAV_HEADER_BYTES, blockAlign);
    const dataBytes =
      declaredDataBytes > 0
        ? Math.min(availableDataBytes, this.alignByteOffset(declaredDataBytes, blockAlign))
        : availableDataBytes;

    return {
      fileData,
      header,
      dataBytes,
      byteRate,
      blockAlign
    };
  }

  private isStandardWavHeader(header: Buffer): boolean {
    return (
      header.byteLength >= WAV_HEADER_BYTES &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE' &&
      header.toString('ascii', 36, 40) === 'data'
    );
  }

  private getExtension(mimeType: string): string {
    if (mimeType.includes('wav')) {
      return '.wav';
    }

    if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
      return '.mp4';
    }

    return '.webm';
  }

  private assertSafeRecordingId(recordingId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(recordingId)) {
      throw new Error('잘못된 녹음 ID입니다.');
    }
  }

  private createWavHeader(dataBytes: number): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(16_000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);
    return header;
  }

  private createWavHeaderFromSource(sourceHeader: Buffer, dataBytes: number): Buffer {
    const header = Buffer.from(sourceHeader.subarray(0, WAV_HEADER_BYTES));
    header.writeUInt32LE(36 + dataBytes, 4);
    header.writeUInt32LE(dataBytes, 40);
    return header;
  }

  private alignByteOffset(byteOffset: number, blockAlign: number): number {
    return Math.max(0, Math.floor(byteOffset / Math.max(1, blockAlign)) * Math.max(1, blockAlign));
  }

  private async delay(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private async finalizeWavHeader(filePath: string, dataBytes: number): Promise<void> {
    const handle = await open(filePath, 'r+');

    try {
      const header = this.createWavHeader(dataBytes);
      await handle.write(header, 0, header.byteLength, 0);
    } finally {
      await handle.close();
    }
  }
}
