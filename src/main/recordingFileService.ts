import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
}

interface CompletedRecordingFile {
  recordingId: string;
  audioMimeType: string;
  filePath: string;
  tempDir: string;
  durationMs: number;
}

// 장시간 녹음이 렌더러 메모리와 IPC 한계를 넘지 않도록 청크를 메인 프로세스 파일로 누적한다.
export class RecordingFileService {
  private activeRecordings = new Map<string, RecordingFileSession>();
  private completedRecordings = new Map<string, CompletedRecordingFile>();

  async start(request: RecordingFileStartRequest): Promise<void> {
    this.assertSafeRecordingId(request.recordingId);
    await this.discard(request.recordingId);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'meeting-recorder-live-recording-'));
    const filePath = path.join(tempDir, `recording${this.getExtension(request.audioMimeType)}`);
    await mkdir(tempDir, { recursive: true });

    this.activeRecordings.set(request.recordingId, {
      recordingId: request.recordingId,
      audioMimeType: request.audioMimeType,
      filePath,
      tempDir,
      writeQueue: Promise.resolve()
    });
  }

  async appendChunk(request: RecordingChunkAppendRequest): Promise<void> {
    const recording = this.getActiveRecording(request.recordingId);
    const chunk = Buffer.from(request.audioData);

    recording.writeQueue = recording.writeQueue.then(() => appendFile(recording.filePath, chunk));
    await recording.writeQueue;
  }

  async complete(request: RecordingFileCompleteRequest): Promise<RecordingFileResult> {
    const recording = this.getActiveRecording(request.recordingId);
    await recording.writeQueue;
    this.activeRecordings.delete(request.recordingId);

    const completed: CompletedRecordingFile = {
      recordingId: recording.recordingId,
      audioMimeType: request.audioMimeType || recording.audioMimeType,
      filePath: recording.filePath,
      tempDir: recording.tempDir,
      durationMs: request.durationMs
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
}
