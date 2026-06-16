import { app } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OfflineTranscriptionRequest, OfflineTranscriptionResult } from '../shared/types';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_STT_LANGUAGE = 'ko';
const DEFAULT_STT_TASK = 'transcribe';

// WhisperX 기반 Python worker를 실행해 오프라인 전사/화자분리 결과를 만든다.
export class LocalTranscriptionService {
  constructor(private readonly appRoot = app.getAppPath()) {}

  // 렌더러에서 받은 오디오 바이트를 임시 파일로 저장한 뒤 worker에 전달한다.
  async transcribe(request: OfflineTranscriptionRequest): Promise<OfflineTranscriptionResult> {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'meeting-recorder-'));
    const audioPath = path.join(tempDirectory, this.getAudioFileName(request.audioMimeType));

    try {
      await writeFile(audioPath, Buffer.from(request.audioData));
      return await this.runWorker(audioPath, request);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  // Python worker 실행 인자를 구성하고 JSON 결과를 파싱한다.
  private async runWorker(
    audioPath: string,
    request: OfflineTranscriptionRequest
  ): Promise<OfflineTranscriptionResult> {
    const pythonPath = process.env.MEETING_RECORDER_STT_PYTHON ?? 'python3';
    const workerPath =
      process.env.MEETING_RECORDER_STT_WORKER ??
      path.join(this.appRoot, 'engines/offline-whisperx/worker.py');
    const timeout = Number(process.env.MEETING_RECORDER_STT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const args = [
      workerPath,
      '--audio',
      audioPath,
      '--model',
      process.env.MEETING_RECORDER_STT_MODEL ?? 'large-v3',
      '--device',
      process.env.MEETING_RECORDER_STT_DEVICE ?? 'cpu',
      '--compute-type',
      process.env.MEETING_RECORDER_STT_COMPUTE_TYPE ?? 'int8',
      '--language',
      process.env.MEETING_RECORDER_STT_LANGUAGE ?? DEFAULT_STT_LANGUAGE,
      '--task',
      process.env.MEETING_RECORDER_STT_TASK ?? DEFAULT_STT_TASK
    ];

    this.appendOptionalArg(args, '--hf-token', process.env.MEETING_RECORDER_HF_TOKEN);
    this.appendOptionalArg(args, '--model-dir', process.env.MEETING_RECORDER_STT_MODEL_DIR);
    this.appendOptionalArg(args, '--min-speakers', request.minSpeakers?.toString());
    this.appendOptionalArg(args, '--max-speakers', request.maxSpeakers?.toString());

    if (process.env.MEETING_RECORDER_STT_OFFLINE === '1') {
      args.push('--offline-only');
    }

    try {
      const { stdout } = await execFileAsync(pythonPath, args, {
        timeout,
        maxBuffer: 1024 * 1024 * 64,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        }
      });

      return JSON.parse(stdout) as OfflineTranscriptionResult;
    } catch (error) {
      throw new Error(this.formatWorkerError(error));
    }
  }

  // MIME 타입에 따라 ffmpeg/torchcodec이 이해하기 쉬운 임시 파일 확장자를 고른다.
  private getAudioFileName(mimeType: string): string {
    if (mimeType.includes('mp4')) {
      return 'recording.mp4';
    }

    if (mimeType.includes('wav')) {
      return 'recording.wav';
    }

    return 'recording.webm';
  }

  // 값이 있을 때만 CLI 인자를 추가한다.
  private appendOptionalArg(args: string[], key: string, value?: string): void {
    if (value) {
      args.push(key, value);
    }
  }

  // worker 실패 원인을 UI에 표시할 수 있는 짧은 문장으로 정리한다.
  private formatWorkerError(error: unknown): string {
    if (typeof error === 'object' && error && 'stderr' in error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '').trim();

      if (stderr) {
        return stderr.split('\n').slice(-8).join('\n');
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return '오프라인 전사 엔진 실행에 실패했습니다.';
  }
}
