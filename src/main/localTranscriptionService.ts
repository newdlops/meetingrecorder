import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import ffmpegPath from 'ffmpeg-static';
import type {
  OfflineTranscriptionRequest,
  OfflineTranscriptionResult,
  TranscriptSegment,
  TranscriptionEngine,
  TranscriptionInferenceMode,
  TranscriptionProgressEvent
} from '../shared/types';
import { PersistentTranscriptionWorker, type ProgressCallback } from './persistentTranscriptionWorker';
import type { RecordingFileService } from './recordingFileService';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_STT_LANGUAGE = 'ko';
const DEFAULT_STT_TASK = 'transcribe';
const DEFAULT_PREVIEW_BATCH_SIZE = '2';
const DEFAULT_PREVIEW_THREAD_COUNT = '1';
const DEFAULT_PREVIEW_WORKER_COUNT = 2;
const MAX_PREVIEW_WORKER_COUNT = 8;
const DEFAULT_PERSISTENT_THREAD_COUNT = '2';
const DEFAULT_FINAL_CHUNK_MS = 10 * 60 * 1000;
const SINGLE_PASS_CHUNK_COUNT = 1;
const FINAL_WORKER_ID = 'final-1';
const FINAL_WORKER_LABEL = '최종 전사';
const DEFAULT_TRANSCRIPTION_ENGINE: TranscriptionEngine = 'whisperx';
const DEFAULT_TRANSCRIPTION_INFERENCE_MODE: TranscriptionInferenceMode = 'literal';

type TranscriptionWorkerPurpose = 'final' | 'preview';

interface ManagedPreviewWorker {
  id: string;
  label: string;
  worker: PersistentTranscriptionWorker;
  activeJobs: number;
}

// WhisperX 기반 Python 상주 worker를 통해 오프라인 전사/화자분리 결과를 만든다.
export class LocalTranscriptionService {
  private finalWorker?: PersistentTranscriptionWorker;
  private previewWorkers?: ManagedPreviewWorker[];
  private previewWorkerCursor = 0;

  constructor(
    private readonly appRoot = app.getAppPath(),
    private readonly recordingFileService?: RecordingFileService
  ) {}

  // 앱 시작 후 백그라운드에서 모델을 미리 올린다.
  async warmUp(): Promise<void> {
    await this.getFinalWorker().warmUp();
  }

  // 앱 종료 시 상주 worker 프로세스를 함께 종료한다.
  shutdown(): void {
    this.finalWorker?.shutdown();
    this.shutdownPreviewWorkers();
  }

  private shutdownPreviewWorkers(): void {
    this.previewWorkers?.forEach(({ worker }) => worker.shutdown());
    this.previewWorkers = undefined;
    this.previewWorkerCursor = 0;
  }

  // 렌더러에서 받은 오디오 바이트를 임시 파일로 저장한 뒤 상주 worker에 전달한다.
  async transcribe(
    request: OfflineTranscriptionRequest,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    const isPreviewRequest = request.mode === 'preview';

    if (!isPreviewRequest) {
      this.shutdownPreviewWorkers();
    }

    if (request.audioRecordingId && isPreviewRequest) {
      return this.transcribePreviewRecordingChunk(request, onProgress);
    }

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

  async transcribeStoredAudioFile(
    request: OfflineTranscriptionRequest,
    audioPath: string,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    this.shutdownPreviewWorkers();
    return this.transcribeAudioFile(
      {
        ...request,
        audioData: undefined,
        audioRecordingId: undefined,
        mode: 'final'
      },
      audioPath,
      false,
      onProgress
    );
  }

  private async transcribePreviewRecordingChunk(
    request: OfflineTranscriptionRequest,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    if (!this.recordingFileService || !request.audioRecordingId) {
      throw new Error('녹음 파일 서비스가 준비되지 않았습니다.');
    }

    const startMs = Math.max(0, Math.round(request.audioStartOffsetMs ?? 0));
    const endMs =
      typeof request.audioEndOffsetMs === 'number'
        ? Math.max(startMs + 1, Math.round(request.audioEndOffsetMs))
        : startMs + Math.max(1, Math.round(request.audioDurationMs ?? 1));
    const durationMs = Math.max(1, endMs - startMs);
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'meeting-recorder-preview-chunk-'));
    const audioPath = path.join(tempDirectory, 'preview-chunk.wav');

    try {
      const chunk = await this.recordingFileService.writeWavChunkToFile(
        request.audioRecordingId,
        audioPath,
        startMs,
        durationMs
      );

      return await this.transcribePreviewAudioFile(
        {
          ...request,
          audioData: undefined,
          audioRecordingId: undefined,
          audioMimeType: chunk.audioMimeType,
          audioDurationMs: chunk.durationMs
        },
        audioPath,
        onProgress
      );
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
    if (isPreviewRequest) {
      return this.transcribePreviewAudioFile(request, audioPath, onProgress);
    }

    if (!isPreviewRequest && this.shouldUseChunkedFinalTranscription(request)) {
      return this.transcribeFinalAudioInChunks(request, audioPath, onProgress);
    }

    const inferenceMode = this.getTranscriptionInferenceMode(request.transcriptionInferenceMode);
    const transcriptionEngine = this.getTranscriptionEngine(request.transcriptionEngine);

    return this.getFinalWorker().transcribe(
      {
        request,
        audioPath,
        transcribeOnly: false,
        batchSize: this.getBatchSize(false),
        finalDecoder: inferenceMode,
        transcriptionEngine,
        minSpeakers: request.minSpeakers,
        maxSpeakers: request.maxSpeakers
      },
      this.withWorkerProgress(FINAL_WORKER_ID, FINAL_WORKER_LABEL, onProgress)
    );
  }

  private async transcribePreviewAudioFile(
    request: OfflineTranscriptionRequest,
    audioPath: string,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    const managedWorker = this.getNextPreviewWorker(this.getPreviewWorkerCount(request.previewWorkerCount));
    const inferenceMode = this.getTranscriptionInferenceMode(request.transcriptionInferenceMode);
    const transcriptionEngine = this.getTranscriptionEngine(request.transcriptionEngine);
    managedWorker.activeJobs += 1;

    try {
      return await managedWorker.worker.transcribe(
        {
          request,
          audioPath,
          transcribeOnly: false,
          batchSize: this.getBatchSize(true),
          finalDecoder: inferenceMode,
          transcriptionEngine,
          minSpeakers: request.minSpeakers,
          maxSpeakers: request.maxSpeakers,
          allowDiarizationFallback: true,
          standardDecoderForTranscribeOnly: true
        },
        this.withWorkerProgress(managedWorker.id, managedWorker.label, onProgress)
      );
    } finally {
      managedWorker.activeJobs = Math.max(0, managedWorker.activeJobs - 1);
    }
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
    const flushedSegmentsPath = path.join(chunkDirectory, 'segments.jsonl');
    const speakers = new Map<string, OfflineTranscriptionResult['speakers'][number]>();
    const inferenceMode = this.getTranscriptionInferenceMode(request.transcriptionInferenceMode);
    const transcriptionEngine = this.getTranscriptionEngine(request.transcriptionEngine);
    let language: string | undefined;
    let flushedSegmentCount = 0;

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
          message: `오디오 구간 준비 중 (${chunkIndex + 1}/${chunkCount})`,
          workerId: FINAL_WORKER_ID,
          workerLabel: FINAL_WORKER_LABEL
        });
        await this.extractAudioChunk(audioPath, chunkPath, chunkStartMs, chunkDurationMs);

        const chunkRequest: OfflineTranscriptionRequest = {
          ...request,
          audioData: undefined,
          audioRecordingId: undefined,
          audioMimeType: 'audio/wav',
          audioDurationMs: chunkDurationMs
        };
        try {
          const chunkResult = await this.getFinalWorker().transcribe(
            {
              request: chunkRequest,
              audioPath: chunkPath,
              transcribeOnly: false,
              batchSize: this.getBatchSize(false),
              finalDecoder: inferenceMode,
              transcriptionEngine,
              minSpeakers: request.minSpeakers,
              maxSpeakers: request.maxSpeakers
            },
            this.withWorkerProgress(FINAL_WORKER_ID, FINAL_WORKER_LABEL, (progress) => {
              onProgress?.({
                ...progress,
                progress: this.mapChunkProgress(chunkIndex, chunkCount, progress.progress),
                message: `구간 ${chunkIndex + 1}/${chunkCount} · ${progress.message}`
              });
            })
          );

          language = language ?? chunkResult.language;
          for (const speaker of chunkResult.speakers) {
            if (!speakers.has(speaker.id)) {
              speakers.set(speaker.id, speaker);
            }
          }

          onProgress?.({
            sessionId: request.sessionId,
            mode: 'final',
            stage: 'save',
            progress: this.mapChunkProgress(chunkIndex, chunkCount, 99),
            message: `구간 ${chunkIndex + 1}/${chunkCount} 결과 저장 중`,
            workerId: FINAL_WORKER_ID,
            workerLabel: FINAL_WORKER_LABEL
          });

          flushedSegmentCount = await this.flushFinalChunkSegments(
            flushedSegmentsPath,
            chunkResult.segments,
            chunkStartMs,
            flushedSegmentCount
          );
          chunkResult.segments = [];
          chunkResult.speakers = [];
        } finally {
          await rm(chunkPath, { force: true });
          await this.yieldToEventLoop();
        }
      }

      const segments = await this.readFlushedTranscriptSegments(flushedSegmentsPath);

      onProgress?.({
        sessionId: request.sessionId,
        mode: 'final',
        stage: 'done',
        progress: 100,
        message: '전사 완료',
        workerId: FINAL_WORKER_ID,
        workerLabel: FINAL_WORKER_LABEL
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

  private async flushFinalChunkSegments(
    outputPath: string,
    chunkSegments: TranscriptSegment[],
    chunkStartMs: number,
    currentSegmentCount: number
  ): Promise<number> {
    if (chunkSegments.length === 0) {
      return currentSegmentCount;
    }

    const lines = chunkSegments
      .map((segment, index) =>
        JSON.stringify({
          ...segment,
          id: `segment-${currentSegmentCount + index + 1}`,
          startMs: chunkStartMs + segment.startMs,
          endMs: chunkStartMs + segment.endMs
        })
      )
      .join('\n');

    await appendFile(outputPath, `${lines}\n`, 'utf-8');
    return currentSegmentCount + chunkSegments.length;
  }

  private async readFlushedTranscriptSegments(inputPath: string): Promise<TranscriptSegment[]> {
    if (!existsSync(inputPath)) {
      return [];
    }

    const segments: TranscriptSegment[] = [];
    const reader = createInterface({
      input: createReadStream(inputPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    for await (const line of reader) {
      const normalizedLine = line.trim();

      if (normalizedLine) {
        segments.push(JSON.parse(normalizedLine) as TranscriptSegment);
      }
    }

    return segments;
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
  private getFinalWorker(): PersistentTranscriptionWorker {
    if (!this.finalWorker) {
      this.finalWorker = new PersistentTranscriptionWorker(async () => {
        const assetRoot = this.getEngineAssetRoot();

        return {
          pythonPath: this.getPythonPath(),
          workerPath: this.getPersistentWorkerPath(),
          args: this.createPersistentWorkerArgs(assetRoot, 'final'),
          env: await this.createWorkerEnvironment(),
          timeout: Number(process.env.MEETING_RECORDER_STT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
        };
      });
    }

    return this.finalWorker;
  }

  // 실시간 미리보기는 여러 상주 worker에 분산해 미처리 청크가 한 줄로 쌓이지 않게 한다.
  private getPreviewWorkers(workerCount = this.getPreviewWorkerCount()): ManagedPreviewWorker[] {
    if (this.previewWorkers && this.previewWorkers.length !== workerCount) {
      const hasActiveJobs = this.previewWorkers.some((previewWorker) => previewWorker.activeJobs > 0);

      if (!hasActiveJobs) {
        this.shutdownPreviewWorkers();
      }
    }

    if (!this.previewWorkers) {
      this.previewWorkers = Array.from({ length: workerCount }, (_unused, index) => ({
        id: `preview-${index + 1}`,
        label: `미리보기 ${index + 1}`,
        worker: new PersistentTranscriptionWorker(async () => {
          const assetRoot = this.getEngineAssetRoot();

          return {
            pythonPath: this.getPythonPath(),
            workerPath: this.getPersistentWorkerPath(),
            args: this.createPersistentWorkerArgs(assetRoot, 'preview'),
            env: await this.createWorkerEnvironment(),
            timeout: Number(process.env.MEETING_RECORDER_STT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
          };
        }),
        activeJobs: 0
      }));
    }

    return this.previewWorkers;
  }

  private getNextPreviewWorker(workerCount = this.getPreviewWorkerCount()): ManagedPreviewWorker {
    const workers = this.getPreviewWorkers(workerCount);

    for (let offset = 0; offset < workers.length; offset += 1) {
      const index = (this.previewWorkerCursor + offset) % workers.length;
      const worker = workers[index];

      if (worker.activeJobs === 0) {
        this.previewWorkerCursor = (index + 1) % workers.length;
        return worker;
      }
    }

    let selectedIndex = 0;

    for (let index = 1; index < workers.length; index += 1) {
      if (workers[index].activeJobs < workers[selectedIndex].activeJobs) {
        selectedIndex = index;
      }
    }

    this.previewWorkerCursor = (selectedIndex + 1) % workers.length;
    return workers[selectedIndex];
  }

  private withWorkerProgress(
    workerId: string,
    workerLabel: string,
    onProgress?: ProgressCallback
  ): ProgressCallback | undefined {
    if (!onProgress) {
      return undefined;
    }

    return (progress: TranscriptionProgressEvent) => {
      onProgress({
        ...progress,
        workerId,
        workerLabel
      });
    };
  }

  // 상주 worker가 모델을 한 번 로드할 때 필요한 실행 인자를 구성한다.
  private createPersistentWorkerArgs(assetRoot: string, purpose: TranscriptionWorkerPurpose): string[] {
    const useFinalQualityModel = purpose === 'preview';
    const args = [
      '--model',
      this.getWhisperModelPath(assetRoot, purpose, useFinalQualityModel),
      '--device',
      this.getWorkerDevice(purpose),
      '--compute-type',
      this.getWorkerComputeType(purpose),
      '--language',
      process.env.MEETING_RECORDER_STT_LANGUAGE ?? DEFAULT_STT_LANGUAGE,
      '--task',
      process.env.MEETING_RECORDER_STT_TASK ?? DEFAULT_STT_TASK,
      '--asset-root',
      assetRoot,
      '--model-dir',
      this.getWhisperModelDirectory(assetRoot, purpose, useFinalQualityModel),
      '--whisper-cpp-binary',
      this.getWhisperCppBinaryPath(),
      '--whisper-cpp-model',
      this.getWhisperCppModelPath(assetRoot)
    ];

    this.appendOptionalArg(args, '--threads', this.getPersistentThreadCount(purpose));
    this.appendOptionalArg(args, '--cluster-threshold', process.env.MEETING_RECORDER_DIARIZATION_CLUSTER_THRESHOLD);
    this.appendOptionalArg(args, '--diarization-min-turn-ms', process.env.MEETING_RECORDER_DIARIZATION_MIN_TURN_MS);
    this.appendOptionalArg(args, '--diarization-merge-gap-ms', process.env.MEETING_RECORDER_DIARIZATION_MERGE_GAP_MS);
    this.appendOptionalArg(
      args,
      '--diarization-overlap-min-turn-ms',
      process.env.MEETING_RECORDER_DIARIZATION_OVERLAP_MIN_TURN_MS
    );
    this.appendOptionalArg(
      args,
      '--diarization-overlap-bridge-gap-ms',
      process.env.MEETING_RECORDER_DIARIZATION_OVERLAP_BRIDGE_GAP_MS
    );
    this.appendOptionalArg(
      args,
      '--diarization-overlap-padding-ms',
      process.env.MEETING_RECORDER_DIARIZATION_OVERLAP_PADDING_MS
    );
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
  private getWhisperModelPath(
    assetRoot: string,
    purpose: TranscriptionWorkerPurpose,
    useFinalQualityModel = false
  ): string {
    if (purpose === 'preview' && !useFinalQualityModel && process.env.MEETING_RECORDER_STT_PREVIEW_MODEL) {
      return process.env.MEETING_RECORDER_STT_PREVIEW_MODEL;
    }

    if (process.env.MEETING_RECORDER_STT_MODEL) {
      return process.env.MEETING_RECORDER_STT_MODEL;
    }

    return path.join(assetRoot, 'whisper/faster-whisper-large-v3');
  }

  private getWhisperModelDirectory(
    assetRoot: string,
    purpose: TranscriptionWorkerPurpose,
    useFinalQualityModel = false
  ): string {
    if (purpose === 'preview' && !useFinalQualityModel && process.env.MEETING_RECORDER_STT_PREVIEW_MODEL_DIR) {
      return process.env.MEETING_RECORDER_STT_PREVIEW_MODEL_DIR;
    }

    return process.env.MEETING_RECORDER_STT_MODEL_DIR ?? path.join(assetRoot, 'whisper');
  }

  private getWhisperCppBinaryPath(): string {
    if (process.env.MEETING_RECORDER_WHISPER_CPP_BINARY) {
      return process.env.MEETING_RECORDER_WHISPER_CPP_BINARY;
    }

    const executableName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
    const candidatePaths = [
      path.join(process.resourcesPath, 'engines/whisper.cpp/bin', executableName),
      path.join(this.appRoot, 'engines/whisper.cpp/bin', executableName)
    ];

    return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? candidatePaths[candidatePaths.length - 1];
  }

  private getWhisperCppModelPath(assetRoot: string): string {
    if (process.env.MEETING_RECORDER_WHISPER_CPP_MODEL) {
      return process.env.MEETING_RECORDER_WHISPER_CPP_MODEL;
    }

    return path.join(assetRoot, 'whisper.cpp/ggml-large-v3.bin');
  }

  private getWorkerDevice(purpose: TranscriptionWorkerPurpose): string {
    if (purpose === 'preview' && process.env.MEETING_RECORDER_STT_PREVIEW_DEVICE) {
      return process.env.MEETING_RECORDER_STT_PREVIEW_DEVICE;
    }

    return process.env.MEETING_RECORDER_STT_DEVICE ?? 'cpu';
  }

  private getWorkerComputeType(purpose: TranscriptionWorkerPurpose): string {
    if (purpose === 'preview' && process.env.MEETING_RECORDER_STT_PREVIEW_COMPUTE_TYPE) {
      return process.env.MEETING_RECORDER_STT_PREVIEW_COMPUTE_TYPE;
    }

    return process.env.MEETING_RECORDER_STT_COMPUTE_TYPE ?? 'int8';
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

  private getTranscriptionInferenceMode(value?: TranscriptionInferenceMode): TranscriptionInferenceMode {
    return value === 'contextual' || value === 'literal' ? value : DEFAULT_TRANSCRIPTION_INFERENCE_MODE;
  }

  private getTranscriptionEngine(value?: TranscriptionEngine): TranscriptionEngine {
    return value === 'whisperCpp' || value === 'whisperx' ? value : DEFAULT_TRANSCRIPTION_ENGINE;
  }

  // 녹음 중 미리보기 부하를 고려해 상주 모델의 CPU 스레드 수를 보수적으로 둔다.
  private getPersistentThreadCount(purpose: TranscriptionWorkerPurpose): string | undefined {
    if (purpose === 'preview') {
      return process.env.MEETING_RECORDER_STT_PREVIEW_THREADS ?? DEFAULT_PREVIEW_THREAD_COUNT;
    }

    return process.env.MEETING_RECORDER_STT_THREADS ?? DEFAULT_PERSISTENT_THREAD_COUNT;
  }

  private getPreviewWorkerCount(requestedWorkerCount?: number): number {
    const rawValue = Number(
      requestedWorkerCount ?? process.env.MEETING_RECORDER_STT_PREVIEW_WORKERS ?? DEFAULT_PREVIEW_WORKER_COUNT
    );

    if (!Number.isFinite(rawValue)) {
      return DEFAULT_PREVIEW_WORKER_COUNT;
    }

    return Math.max(1, Math.min(MAX_PREVIEW_WORKER_COUNT, Math.round(rawValue)));
  }

  private getFinalChunkMs(): number {
    const rawValue = Number(process.env.MEETING_RECORDER_STT_FINAL_CHUNK_MS ?? DEFAULT_FINAL_CHUNK_MS);

    if (!Number.isFinite(rawValue)) {
      return DEFAULT_FINAL_CHUNK_MS;
    }

    return Math.max(0, Math.round(rawValue));
  }
}
