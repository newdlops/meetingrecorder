import { appendFile, copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  startedAt: string;
}

interface CompletedRecordingFile {
  recordingId: string;
  audioMimeType: string;
  filePath: string;
  tempDir: string;
  durationMs: number;
  dataBytes: number;
  isWav: boolean;
  externalWriter: boolean;
  startedAt: string;
  completedAt: string;
}

interface RecordingFileManifest {
  recordingId: string;
  audioMimeType: string;
  fileName: string;
  startedAt: string;
  updatedAt: string;
  status: 'active' | 'completed';
  dataBytes: number;
  durationMs?: number;
  isWav: boolean;
  externalWriter: boolean;
}

export interface RecoverableRecordingFile {
  recordingId: string;
  audioMimeType: string;
  filePath: string;
  startedAt: string;
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
const RECORDING_MANIFEST_FILE_NAME = 'recording.json';

// 장시간 녹음이 렌더러 메모리와 IPC 한계를 넘지 않도록 청크를 메인 프로세스 파일로 누적한다.
export class RecordingFileService {
  private activeRecordings = new Map<string, RecordingFileSession>();
  private completedRecordings = new Map<string, CompletedRecordingFile>();

  constructor(private readonly recoveryDirectory = path.join(os.tmpdir(), 'meeting-recorder-recording-recovery')) {}

  async init(): Promise<void> {
    await mkdir(this.recoveryDirectory, { recursive: true });
  }

  async start(request: RecordingFileStartRequest): Promise<void> {
    this.assertSafeRecordingId(request.recordingId);
    await this.init();
    await this.discard(request.recordingId);

    const tempDir = this.getRecordingDirectory(request.recordingId);
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
      externalWriter,
      startedAt: new Date().toISOString()
    });
    await this.writeManifest(this.activeRecordings.get(request.recordingId)!, 'active');
  }

  async appendChunk(request: RecordingChunkAppendRequest): Promise<void> {
    const recording = this.getActiveRecording(request.recordingId);
    const chunk = Buffer.from(request.audioData);

    recording.dataBytes += chunk.byteLength;
    recording.writeQueue = recording.writeQueue.then(async () => {
      await appendFile(recording.filePath, chunk);
      await this.writeManifest(recording, 'active');
    });
    await recording.writeQueue;
  }

  async complete(request: RecordingFileCompleteRequest): Promise<RecordingFileResult> {
    const recording = this.getActiveRecording(request.recordingId);
    await recording.writeQueue;
    if (recording.isWav && recording.dataBytes > 0 && !recording.externalWriter) {
      await this.finalizeWavHeader(recording.filePath, recording.dataBytes);
    }
    const recoveredAudio = await this.prepareRecoverableAudioFile(recording.filePath, recording.audioMimeType);
    this.activeRecordings.delete(request.recordingId);
    const durationMs =
      recoveredAudio?.durationMs ??
      (recording.isWav && recording.dataBytes > 0 && !recording.externalWriter
        ? Math.round((recording.dataBytes / (16_000 * 2)) * 1000)
        : request.durationMs);

    const completed: CompletedRecordingFile = {
      recordingId: recording.recordingId,
      audioMimeType: request.audioMimeType || recording.audioMimeType,
      filePath: recording.filePath,
      tempDir: recording.tempDir,
      durationMs,
      dataBytes: recoveredAudio?.dataBytes ?? recording.dataBytes,
      isWav: recording.isWav,
      externalWriter: recording.externalWriter,
      startedAt: recording.startedAt,
      completedAt: new Date().toISOString()
    };
    this.completedRecordings.set(request.recordingId, completed);
    await this.writeManifest(completed, 'completed');

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
    } else if (!activeRecording) {
      await rm(this.getRecordingDirectory(recordingId), { recursive: true, force: true });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.activeRecordings.values()].map(async (recording) => {
        await recording.writeQueue.catch(() => undefined);
        const recoveredAudio = recording.externalWriter
          ? undefined
          : await this.prepareRecoverableAudioFile(recording.filePath, recording.audioMimeType);

        if (recoveredAudio) {
          recording.dataBytes = recoveredAudio.dataBytes;
        }

        await this.writeManifest(recording, 'active').catch(() => undefined);
      })
    );
    await Promise.all(
      [...this.completedRecordings.values()].map((recording) =>
        this.writeManifest(recording, 'completed').catch(() => undefined)
      )
    );
    this.activeRecordings.clear();
    this.completedRecordings.clear();
  }

  async listRecoverableRecordings(): Promise<RecoverableRecordingFile[]> {
    await this.init();
    const entries = await readdir(this.recoveryDirectory, { withFileTypes: true }).catch(() => []);
    const recoveredRecordings: RecoverableRecordingFile[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !this.isSafeRecordingId(entry.name)) {
        continue;
      }

      if (this.activeRecordings.has(entry.name) || this.completedRecordings.has(entry.name)) {
        continue;
      }

      const recordingDirectory = this.getRecordingDirectory(entry.name);
      const manifest = await this.readManifest(recordingDirectory);
      const filePath = await this.resolveRecoverableFilePath(recordingDirectory, manifest);

      if (!filePath) {
        continue;
      }

      const audioMimeType = manifest?.audioMimeType ?? this.getMimeTypeFromFileName(path.basename(filePath));
      const recoveredAudio = await this.prepareRecoverableAudioFile(filePath, audioMimeType);

      if (!recoveredAudio || recoveredAudio.dataBytes <= 0) {
        continue;
      }

      recoveredRecordings.push({
        recordingId: entry.name,
        audioMimeType,
        filePath,
        startedAt: manifest?.startedAt ?? recoveredAudio.modifiedAt,
        durationMs: manifest?.durationMs && manifest.durationMs > 0 ? manifest.durationMs : recoveredAudio.durationMs
      });
    }

    return recoveredRecordings.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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

  private getMimeTypeFromFileName(fileName: string): string {
    if (fileName.endsWith('.wav')) {
      return 'audio/wav';
    }

    if (fileName.endsWith('.mp4') || fileName.endsWith('.m4a')) {
      return 'audio/mp4';
    }

    return 'audio/webm';
  }

  private assertSafeRecordingId(recordingId: string): void {
    if (!this.isSafeRecordingId(recordingId)) {
      throw new Error('잘못된 녹음 ID입니다.');
    }
  }

  private isSafeRecordingId(recordingId: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(recordingId);
  }

  private getRecordingDirectory(recordingId: string): string {
    this.assertSafeRecordingId(recordingId);
    return path.join(this.recoveryDirectory, recordingId);
  }

  private getManifestPath(recordingDirectory: string): string {
    return path.join(recordingDirectory, RECORDING_MANIFEST_FILE_NAME);
  }

  private async writeManifest(
    recording: RecordingFileSession | CompletedRecordingFile,
    status: RecordingFileManifest['status']
  ): Promise<void> {
    const manifest: RecordingFileManifest = {
      recordingId: recording.recordingId,
      audioMimeType: recording.audioMimeType,
      fileName: path.basename(recording.filePath),
      startedAt: recording.startedAt,
      updatedAt: new Date().toISOString(),
      status,
      dataBytes: recording.dataBytes,
      durationMs: 'durationMs' in recording ? recording.durationMs : undefined,
      isWav: recording.isWav,
      externalWriter: recording.externalWriter
    };

    await writeFile(this.getManifestPath(recording.tempDir), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  private async readManifest(recordingDirectory: string): Promise<RecordingFileManifest | undefined> {
    try {
      return JSON.parse(await readFile(this.getManifestPath(recordingDirectory), 'utf-8')) as RecordingFileManifest;
    } catch {
      return undefined;
    }
  }

  private async resolveRecoverableFilePath(
    recordingDirectory: string,
    manifest?: RecordingFileManifest
  ): Promise<string | undefined> {
    if (manifest?.fileName) {
      const manifestFilePath = path.join(recordingDirectory, manifest.fileName);
      const manifestFileStats = await stat(manifestFilePath).catch(() => undefined);

      if (manifestFileStats?.isFile()) {
        return manifestFilePath;
      }
    }

    const entries = await readdir(recordingDirectory, { withFileTypes: true }).catch(() => []);
    const audioEntry = entries.find(
      (entry) =>
        entry.isFile() &&
        /\.(wav|webm|mp4|m4a)$/i.test(entry.name) &&
        entry.name !== RECORDING_MANIFEST_FILE_NAME
    );

    return audioEntry ? path.join(recordingDirectory, audioEntry.name) : undefined;
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

  private async prepareRecoverableAudioFile(
    filePath: string,
    audioMimeType: string
  ): Promise<{ dataBytes: number; durationMs: number; modifiedAt: string } | undefined> {
    const fileStats = await stat(filePath).catch(() => undefined);

    if (!fileStats?.isFile() || fileStats.size <= 0) {
      return undefined;
    }

    if (!audioMimeType.includes('wav') && !filePath.toLowerCase().endsWith('.wav')) {
      return {
        dataBytes: fileStats.size,
        durationMs: 0,
        modifiedAt: fileStats.mtime.toISOString()
      };
    }

    if (fileStats.size <= WAV_HEADER_BYTES) {
      return undefined;
    }

    const handle = await open(filePath, 'r+');

    try {
      const header = Buffer.alloc(WAV_HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);

      if (bytesRead < WAV_HEADER_BYTES || !this.isStandardWavHeader(header)) {
        return undefined;
      }

      const blockAlign = Math.max(1, header.readUInt16LE(32));
      const byteRate = Math.max(1, header.readUInt32LE(28));
      const availableDataBytes = this.alignByteOffset(fileStats.size - WAV_HEADER_BYTES, blockAlign);
      const declaredDataBytes = this.alignByteOffset(header.readUInt32LE(40), blockAlign);

      if (availableDataBytes > 0 && declaredDataBytes !== availableDataBytes) {
        const fixedHeader = this.createWavHeaderFromSource(header, availableDataBytes);
        await handle.write(fixedHeader, 0, fixedHeader.byteLength, 0);
      }

      return {
        dataBytes: availableDataBytes,
        durationMs: Math.max(1, Math.round((availableDataBytes / byteRate) * 1000)),
        modifiedAt: fileStats.mtime.toISOString()
      };
    } finally {
      await handle.close();
    }
  }
}
