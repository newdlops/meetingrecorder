import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
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
    const pythonPath = this.getPythonPath();
    const workerPath = this.getWorkerPath();
    const timeout = Number(process.env.MEETING_RECORDER_STT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const assetRoot = this.getEngineAssetRoot();
    const args = [
      workerPath,
      '--audio',
      audioPath,
      '--model',
      this.getWhisperModelPath(assetRoot),
      '--device',
      process.env.MEETING_RECORDER_STT_DEVICE ?? 'cpu',
      '--compute-type',
      process.env.MEETING_RECORDER_STT_COMPUTE_TYPE ?? 'int8',
      '--language',
      process.env.MEETING_RECORDER_STT_LANGUAGE ?? DEFAULT_STT_LANGUAGE,
      '--task',
      process.env.MEETING_RECORDER_STT_TASK ?? DEFAULT_STT_TASK,
      '--asset-root',
      assetRoot,
      '--model-dir',
      process.env.MEETING_RECORDER_STT_MODEL_DIR ?? path.join(assetRoot, 'whisper')
    ];

    this.appendOptionalArg(args, '--min-speakers', request.minSpeakers?.toString());
    this.appendOptionalArg(args, '--max-speakers', request.maxSpeakers?.toString());

    if (process.env.MEETING_RECORDER_STT_ALLOW_DOWNLOAD !== '1') {
      args.push('--offline-only');
    }

    try {
      const workerEnv = await this.createWorkerEnvironment();
      const { stdout } = await execFileAsync(pythonPath, args, {
        timeout,
        maxBuffer: 1024 * 1024 * 64,
        env: workerEnv
      });

      return this.parseWorkerOutput(stdout);
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

  // 환경변수가 없으면 프로젝트 내부 STT 전용 가상환경을 우선 사용한다.
  private getPythonPath(): string {
    if (process.env.MEETING_RECORDER_STT_PYTHON) {
      return process.env.MEETING_RECORDER_STT_PYTHON;
    }

    const candidatePaths = [
      path.join(process.resourcesPath, 'engines/python/bin/python3'),
      path.join(process.resourcesPath, '.venv-stt/bin/python'),
      path.join(process.resourcesPath, '.venv-stt/Scripts/python.exe'),
      path.join(this.appRoot, '.venv-stt/bin/python'),
      path.join(this.appRoot, '.venv-stt/Scripts/python.exe')
    ];

    for (const candidatePath of candidatePaths) {
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return 'python3';
  }

  // 개발 중에는 repo worker, 패키징 후에는 resources worker를 실행한다.
  private getWorkerPath(): string {
    if (process.env.MEETING_RECORDER_STT_WORKER) {
      return process.env.MEETING_RECORDER_STT_WORKER;
    }

    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'engines/offline-whisperx/worker.py');
    }

    return path.join(this.appRoot, 'engines/offline-whisperx/worker.py');
  }

  // macOS의 keg-only ffmpeg@7과 Python 라이브러리 캐시 경로를 worker 환경에 주입한다.
  private async createWorkerEnvironment(): Promise<NodeJS.ProcessEnv> {
    const cacheDirectory = path.join(tmpdir(), 'meeting-recorder-worker-cache');
    const ffmpegDirectory = this.getFfmpegDirectory();
    await mkdir(cacheDirectory, { recursive: true });

    return {
      ...process.env,
      PATH: this.prependPath(process.env.PATH, ffmpegDirectory),
      MPLCONFIGDIR: process.env.MPLCONFIGDIR ?? path.join(cacheDirectory, 'matplotlib'),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(cacheDirectory, 'xdg'),
      PYTHONUNBUFFERED: '1'
    };
  }

  // 앱에 포함된 ffmpeg-static 바이너리를 우선 사용하고, 개발 환경에서는 시스템 ffmpeg로 보완한다.
  private getFfmpegDirectory(): string | undefined {
    if (ffmpegPath && existsSync(ffmpegPath)) {
      return path.dirname(ffmpegPath);
    }

    const fallbackPaths = [
      '/opt/homebrew/opt/ffmpeg@7/bin',
      '/usr/local/opt/ffmpeg@7/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ];
    return fallbackPaths.find((candidatePath) => existsSync(path.join(candidatePath, 'ffmpeg')));
  }

  // 개발 중에는 repo 폴더, 패키징 후에는 resources 폴더의 모델 자산을 사용한다.
  private getEngineAssetRoot(): string {
    if (process.env.MEETING_RECORDER_ENGINE_ASSET_ROOT) {
      return process.env.MEETING_RECORDER_ENGINE_ASSET_ROOT;
    }

    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'engines/models');
    }

    return path.join(this.appRoot, 'engines/models');
  }

  // standalone 자산에 포함된 faster-whisper 모델 폴더를 기본 모델로 사용한다.
  private getWhisperModelPath(assetRoot: string): string {
    if (process.env.MEETING_RECORDER_STT_MODEL) {
      return process.env.MEETING_RECORDER_STT_MODEL;
    }

    return path.join(assetRoot, 'whisper/faster-whisper-large-v3');
  }

  // 기존 환경변수 경로 앞에 worker 전용 경로를 붙인다.
  private prependPath(currentValue: string | undefined, nextValue: string | undefined): string | undefined {
    if (!nextValue) {
      return currentValue;
    }

    return currentValue ? `${nextValue}${path.delimiter}${currentValue}` : nextValue;
  }

  // 값이 있을 때만 CLI 인자를 추가한다.
  private appendOptionalArg(args: string[], key: string, value?: string): void {
    if (value) {
      args.push(key, value);
    }
  }

  // 외부 STT 라이브러리 로그가 stdout에 섞여도 마지막 JSON 결과만 안정적으로 파싱한다.
  private parseWorkerOutput(stdout: string): OfflineTranscriptionResult {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of [...lines].reverse()) {
      if (!line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;

        if (this.isTranscriptionResult(parsed)) {
          return parsed;
        }
      } catch {
        // JSON처럼 보이지만 결과 객체가 아닌 로그 라인은 건너뛴다.
      }
    }

    const outputTail = lines.slice(-8).join('\n');
    throw new Error(`전사 엔진 결과 JSON을 찾을 수 없습니다.\n${outputTail}`);
  }

  // worker 결과가 앱에서 필요한 최소 필드를 갖춘 전사 결과인지 확인한다.
  private isTranscriptionResult(value: unknown): value is OfflineTranscriptionResult {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<OfflineTranscriptionResult>;
    return (
      typeof candidate.engineName === 'string' &&
      Array.isArray(candidate.speakers) &&
      Array.isArray(candidate.segments)
    );
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
