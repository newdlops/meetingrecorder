import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { OfflineTranscriptionRequest, OfflineTranscriptionResult, TranscriptSegment } from '../shared/types';
import { PersistentTranscriptionWorker, type ProgressCallback } from './persistentTranscriptionWorker';
import type { RecordingFileService } from './recordingFileService';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_STT_LANGUAGE = 'ko';
const DEFAULT_STT_TASK = 'transcribe';
const DEFAULT_PREVIEW_BATCH_SIZE = '2';
const DEFAULT_PERSISTENT_THREAD_COUNT = '2';
const DEFAULT_FINAL_CHUNK_MS = 10 * 60 * 1000;
const SINGLE_PASS_CHUNK_COUNT = 1;

// WhisperX 기반 Python 상주 worker를 통해 오프라인 전사/화자분리 결과를 만든다.
export class LocalTranscriptionService {
  private persistentWorker?: PersistentTranscriptionWorker;

  constructor(
    private readonly appRoot = app.getAppPath(),
    private readonly recordingFileService?: RecordingFileService
  ) {}

  // 앱 시작 후 백그라운드에서 모델을 미리 올린다.
  async warmUp(): Promise<void> {
    await this.getPersistentWorker().warmUp();
  }

  // 앱 종료 시 상주 worker 프로세스를 함께 종료한다.
  shutdown(): void {
    this.persistentWorker?.shutdown();
  }

  // 렌더러에서 받은 오디오 바이트를 임시 파일로 저장한 뒤 상주 worker에 전달한다.
  async transcribe(
    request: OfflineTranscriptionRequest,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    const isPreviewRequest = request.mode === 'preview';

    if (request.audioRecordingId && !isPreviewRequest) {
      if (!this.recordingFileService) {
        throw new Error('녹음 파일 서비스가 준비되지 않았습니다.');
      }

      const recordingFile = this.recordingFileService.getCompletedFile(request.audioRecordingId);
      return this.transcribeAudioFile(
        {
          ...request,
          audioData: undefined,
          audioDurationMs: request.audioDurationMs ?? recordingFile.durationMs
        },
        recordingFile.filePath,
        false,
        onProgress
      );
    }

    if (!request.audioData) {
      throw new Error('전사할 오디오 데이터가 없습니다.');
    }

    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'meeting-recorder-'));
    const audioPath = path.join(tempDirectory, this.getAudioFileName(request.audioMimeType));

    try {
      await writeFile(audioPath, Buffer.from(request.audioData));
      return await this.transcribeAudioFile(request, audioPath, isPreviewRequest, onProgress);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async transcribeAudioFile(
    request: OfflineTranscriptionRequest,
    audioPath: string,
    isPreviewRequest: boolean,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    if (!isPreviewRequest && this.shouldUseChunkedFinalTranscription(request)) {
      return this.transcribeFinalAudioInChunks(request, audioPath, onProgress);
    }

    return this.getPersistentWorker().transcribe(
      {
        request,
        audioPath,
        transcribeOnly: isPreviewRequest,
        batchSize: this.getBatchSize(isPreviewRequest),
        minSpeakers: request.minSpeakers,
        maxSpeakers: request.maxSpeakers
      },
      onProgress
    );
  }

  private shouldUseChunkedFinalTranscription(request: OfflineTranscriptionRequest): boolean {
    const durationMs = request.audioDurationMs ?? 0;
    const chunkMs = this.getFinalChunkMs();

    return chunkMs > 0 && durationMs > chunkMs * SINGLE_PASS_CHUNK_COUNT;
  }

  private async transcribeFinalAudioInChunks(
    request: OfflineTranscriptionRequest,
    audioPath: string,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    const chunkMs = this.getFinalChunkMs();
    const durationMs = Math.max(request.audioDurationMs ?? chunkMs, chunkMs);
    const chunkCount = Math.max(1, Math.ceil(durationMs / chunkMs));
    const chunkDirectory = await mkdtemp(path.join(tmpdir(), 'meeting-recorder-final-chunks-'));
    const segments: TranscriptSegment[] = [];
    const speakers = new Map<string, OfflineTranscriptionResult['speakers'][number]>();
    let language: string | undefined;

    try {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunkStartMs = chunkIndex * chunkMs;
        const chunkDurationMs = Math.min(chunkMs, durationMs - chunkStartMs);
        const chunkPath = path.join(chunkDirectory, `chunk-${String(chunkIndex + 1).padStart(4, '0')}.wav`);

        onProgress?.({
          sessionId: request.sessionId,
          mode: 'final',
          stage: 'audio',
          progress: this.mapChunkProgress(chunkIndex, chunkCount, 0),
          message: `오디오 구간 준비 중 (${chunkIndex + 1}/${chunkCount})`
        });
        await this.extractAudioChunk(audioPath, chunkPath, chunkStartMs, chunkDurationMs);

        const chunkRequest: OfflineTranscriptionRequest = {
          ...request,
          audioData: undefined,
          audioRecordingId: undefined,
          audioMimeType: 'audio/wav',
          audioDurationMs: chunkDurationMs
        };
        const chunkResult = await this.getPersistentWorker().transcribe(
          {
            request: chunkRequest,
            audioPath: chunkPath,
            transcribeOnly: false,
            batchSize: this.getBatchSize(false),
            minSpeakers: request.minSpeakers,
            maxSpeakers: request.maxSpeakers
          },
          (progress) => {
            onProgress?.({
              ...progress,
              progress: this.mapChunkProgress(chunkIndex, chunkCount, progress.progress),
              message: `구간 ${chunkIndex + 1}/${chunkCount} · ${progress.message}`
            });
          }
        );

        language = language ?? chunkResult.language;
        for (const speaker of chunkResult.speakers) {
          if (!speakers.has(speaker.id)) {
            speakers.set(speaker.id, speaker);
          }
        }

        for (const segment of chunkResult.segments) {
          segments.push({
            ...segment,
            id: `segment-${segments.length + 1}`,
            startMs: chunkStartMs + segment.startMs,
            endMs: chunkStartMs + segment.endMs
          });
        }
      }

      onProgress?.({
        sessionId: request.sessionId,
        mode: 'final',
        stage: 'done',
        progress: 100,
        message: '전사 완료'
      });

      return {
        engineName: 'whisperx-sherpa-onnx-local-chunked',
        language,
        durationMs,
        speakers: [...speakers.values()],
        segments
      };
    } finally {
      await rm(chunkDirectory, { recursive: true, force: true });
    }
  }

  private mapChunkProgress(chunkIndex: number, chunkCount: number, chunkProgress: number): number {
    const completedWeight = chunkIndex / chunkCount;
    const currentWeight = Math.max(0, Math.min(100, chunkProgress)) / 100 / chunkCount;
    return Math.min(98, Math.round((completedWeight + currentWeight) * 98));
  }

  private async extractAudioChunk(
    inputPath: string,
    outputPath: string,
    startMs: number,
    durationMs: number
  ): Promise<void> {
    const ffmpegBinary = this.getFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-threads',
      '1',
      outputPath
    ];

    await this.runProcess(ffmpegBinary, args);
  }

  private async runProcess(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf-8')}`.slice(-4000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `오디오 구간 추출에 실패했습니다. 코드: ${code ?? 'unknown'}`));
      });
    });
  }

  // 상주 worker 인스턴스를 지연 생성해 같은 Python 프로세스를 계속 재사용한다.
  private getPersistentWorker(): PersistentTranscriptionWorker {
    if (!this.persistentWorker) {
      this.persistentWorker = new PersistentTranscriptionWorker(async () => {
        const assetRoot = this.getEngineAssetRoot();

        return {
          pythonPath: this.getPythonPath(),
          workerPath: this.getPersistentWorkerPath(),
          args: this.createPersistentWorkerArgs(assetRoot),
          env: await this.createWorkerEnvironment(),
          timeout: Number(process.env.MEETING_RECORDER_STT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
        };
      });
    }

    return this.persistentWorker;
  }

  // 상주 worker가 모델을 한 번 로드할 때 필요한 실행 인자를 구성한다.
  private createPersistentWorkerArgs(assetRoot: string): string[] {
    const args = [
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

    this.appendOptionalArg(args, '--threads', this.getPersistentThreadCount());
    this.appendOptionalArg(args, '--cluster-threshold', process.env.MEETING_RECORDER_DIARIZATION_CLUSTER_THRESHOLD);
    this.appendOptionalArg(args, '--diarization-min-turn-ms', process.env.MEETING_RECORDER_DIARIZATION_MIN_TURN_MS);
    this.appendOptionalArg(args, '--diarization-merge-gap-ms', process.env.MEETING_RECORDER_DIARIZATION_MERGE_GAP_MS);
    this.appendOptionalArg(args, '--no-speech-threshold', process.env.MEETING_RECORDER_STT_NO_SPEECH_THRESHOLD);
    this.appendOptionalArg(args, '--log-prob-threshold', process.env.MEETING_RECORDER_STT_LOG_PROB_THRESHOLD);
    this.appendOptionalArg(
      args,
      '--hallucination-silence-threshold',
      process.env.MEETING_RECORDER_STT_HALLUCINATION_SILENCE_THRESHOLD
    );
    this.appendOptionalArg(args, '--vad-onset', process.env.MEETING_RECORDER_STT_VAD_ONSET);
    this.appendOptionalArg(args, '--vad-offset', process.env.MEETING_RECORDER_STT_VAD_OFFSET);
    this.appendOptionalArg(args, '--final-decoder', process.env.MEETING_RECORDER_STT_FINAL_DECODER);
    this.appendOptionalArg(args, '--final-beam-size', process.env.MEETING_RECORDER_STT_FINAL_BEAM_SIZE);
    this.appendOptionalArg(args, '--final-patience', process.env.MEETING_RECORDER_STT_FINAL_PATIENCE);
    this.appendOptionalArg(
      args,
      '--final-repetition-penalty',
      process.env.MEETING_RECORDER_STT_FINAL_REPETITION_PENALTY
    );
    this.appendOptionalArg(
      args,
      '--final-min-silence-duration-ms',
      process.env.MEETING_RECORDER_STT_FINAL_MIN_SILENCE_MS
    );
    this.appendOptionalArg(args, '--final-speech-pad-ms', process.env.MEETING_RECORDER_STT_FINAL_SPEECH_PAD_MS);
    this.appendOptionalArg(args, '--initial-prompt', process.env.MEETING_RECORDER_STT_INITIAL_PROMPT);
    this.appendOptionalArg(args, '--hotwords', process.env.MEETING_RECORDER_STT_HOTWORDS);

    if (process.env.MEETING_RECORDER_STT_ALLOW_DOWNLOAD !== '1') {
      args.push('--offline-only');
    }

    return args;
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
  private getPersistentWorkerPath(): string {
    if (process.env.MEETING_RECORDER_STT_PERSISTENT_WORKER) {
      return process.env.MEETING_RECORDER_STT_PERSISTENT_WORKER;
    }

    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'engines/offline-whisperx/persistent_worker.py');
    }

    return path.join(this.appRoot, 'engines/offline-whisperx/persistent_worker.py');
  }

  // Python 라이브러리 캐시와 앱에 포함된 ffmpeg 경로를 worker 환경에 주입한다.
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

  private getFfmpegPath(): string {
    if (ffmpegPath && existsSync(ffmpegPath)) {
      return ffmpegPath;
    }

    const ffmpegDirectory = this.getFfmpegDirectory();

    if (ffmpegDirectory) {
      return path.join(ffmpegDirectory, 'ffmpeg');
    }

    return 'ffmpeg';
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

  // 미리보기 전사는 작은 배치로 돌리고, 최종 전사는 WhisperX 기본 배치를 사용한다.
  private getBatchSize(isPreviewRequest: boolean): string | undefined {
    if (isPreviewRequest) {
      return process.env.MEETING_RECORDER_STT_PREVIEW_BATCH_SIZE ?? DEFAULT_PREVIEW_BATCH_SIZE;
    }

    return process.env.MEETING_RECORDER_STT_BATCH_SIZE;
  }

  // 녹음 중 미리보기 부하를 고려해 상주 모델의 CPU 스레드 수를 보수적으로 둔다.
  private getPersistentThreadCount(): string | undefined {
    return process.env.MEETING_RECORDER_STT_THREADS ?? DEFAULT_PERSISTENT_THREAD_COUNT;
  }

  private getFinalChunkMs(): number {
    const rawValue = Number(process.env.MEETING_RECORDER_STT_FINAL_CHUNK_MS ?? DEFAULT_FINAL_CHUNK_MS);

    if (!Number.isFinite(rawValue)) {
      return DEFAULT_FINAL_CHUNK_MS;
    }

    return Math.max(0, Math.round(rawValue));
  }
}
