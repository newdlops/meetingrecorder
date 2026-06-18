import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  OfflineTranscriptionRequest,
  OfflineTranscriptionResult,
  TranscriptionEngine,
  TranscriptionInferenceMode,
  TranscriptionProgressEvent,
  TranscriptionProgressStage
} from '../shared/types';

export type ProgressCallback = (progress: TranscriptionProgressEvent) => void;

export interface PersistentWorkerConfig {
  pythonPath: string;
  workerPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export interface PersistentTranscriptionJob {
  request: OfflineTranscriptionRequest;
  audioPath: string;
  transcribeOnly: boolean;
  batchSize?: string;
  finalDecoder?: TranscriptionInferenceMode;
  transcriptionEngine?: TranscriptionEngine;
  minSpeakers?: number;
  maxSpeakers?: number;
  allowDiarizationFallback?: boolean;
  standardDecoderForTranscribeOnly?: boolean;
}

interface PendingRequest {
  request: OfflineTranscriptionRequest;
  onProgress?: ProgressCallback;
  latestProgress?: TranscriptionProgressEvent;
  timeoutId: NodeJS.Timeout;
  heartbeatId: NodeJS.Timeout;
  resolve(result: OfflineTranscriptionResult): void;
  reject(error: Error): void;
}

// Python 상주 worker를 관리하고 요청/응답 JSON 라인을 앱 타입으로 변환한다.
export class PersistentTranscriptionWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private isReady = false;
  private currentConfig: PersistentWorkerConfig | null = null;

  constructor(private readonly createConfig: () => Promise<PersistentWorkerConfig>) {}

  // 앱 시작 직후 모델을 미리 올려 첫 전사 대기 시간을 줄인다.
  async warmUp(): Promise<void> {
    await this.ensureReady();
  }

  // 이미 로드된 모델을 재사용해 전사 요청을 처리한다.
  async transcribe(
    job: PersistentTranscriptionJob,
    onProgress?: ProgressCallback
  ): Promise<OfflineTranscriptionResult> {
    const config = await this.ensureReady();
    const requestId = randomUUID();

    return new Promise<OfflineTranscriptionResult>((resolve, reject) => {
      const pending = this.createPendingRequest(requestId, job.request, config.timeout, resolve, reject, onProgress);
      this.pendingRequests.set(requestId, pending);

      const payload = {
        type: 'transcribe',
        id: requestId,
        audioPath: job.audioPath,
        mode: job.request.mode ?? 'final',
        transcribeOnly: job.transcribeOnly,
        batchSize: job.batchSize ? Number(job.batchSize) : undefined,
        finalDecoder: job.finalDecoder,
        transcriptionEngine: job.transcriptionEngine,
        minSpeakers: job.minSpeakers,
        maxSpeakers: job.maxSpeakers,
        allowDiarizationFallback: job.allowDiarizationFallback,
        standardDecoderForTranscribeOnly: job.standardDecoderForTranscribeOnly,
        progress: Boolean(onProgress)
      };

      this.child?.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }

        this.rejectPendingRequest(requestId, error);
      });
    });
  }

  // 앱 종료 시 Python worker도 같이 정리한다.
  shutdown(): void {
    this.child?.kill();
    this.child = null;
    this.isReady = false;
    this.readyPromise = null;
  }

  // worker가 없으면 새로 띄우고 ready 메시지를 기다린다.
  private async ensureReady(): Promise<PersistentWorkerConfig> {
    if (this.child && this.isReady && this.currentConfig) {
      return this.currentConfig;
    }

    if (this.readyPromise && this.currentConfig) {
      await this.readyPromise;
      return this.currentConfig;
    }

    const config = await this.createConfig();
    this.currentConfig = config;
    this.startProcess(config);
    await this.readyPromise;
    return config;
  }

  // Python 프로세스를 시작하고 stdout/stderr 스트림을 연결한다.
  private startProcess(config: PersistentWorkerConfig): void {
    this.stderrBuffer = '';
    this.stdoutBuffer = '';
    this.isReady = false;
    this.child = spawn(config.pythonPath, [config.workerPath, ...config.args], { env: config.env });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString('utf-8')}`.slice(-8000);
    });
    this.child.on('error', (error) => this.handleProcessExit(error));
    this.child.on('close', (code) => {
      this.handleProcessExit(new Error(`전사 엔진이 종료되었습니다. 코드: ${code ?? 'unknown'}`));
    });
  }

  // stdout을 줄 단위로 잘라 JSON 프로토콜 메시지만 처리한다.
  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
      this.handleProtocolLine(line);
    }
  }

  // worker 로그와 프로토콜 메시지가 섞여도 JSON 프로토콜만 받아들인다.
  private handleProtocolLine(line: string): void {
    if (!line.startsWith('{') || !line.endsWith('}')) {
      return;
    }

    try {
      const message = JSON.parse(line) as { type?: string; id?: string; result?: unknown; message?: string };

      if (message.type === 'ready') {
        this.isReady = true;
        this.readyResolve?.();
        return;
      }

      if (message.type === 'progress') {
        this.handleProgressMessage(message);
        return;
      }

      if (message.type === 'result' && message.id) {
        this.resolvePendingRequest(message.id, message.result);
        return;
      }

      if (message.type === 'error' && message.id) {
        this.rejectPendingRequest(message.id, new Error(message.message ?? '전사 엔진 실행에 실패했습니다.'));
      }
    } catch {
      // JSON처럼 보이는 외부 라이브러리 로그는 무시한다.
    }
  }

  // 진행률 메시지를 해당 요청의 콜백으로 전달한다.
  private handleProgressMessage(message: { id?: string; stage?: unknown; progress?: unknown; message?: unknown }): void {
    if (!message.id) {
      return;
    }

    const pending = this.pendingRequests.get(message.id);

    if (!pending || typeof message.progress !== 'number' || typeof message.stage !== 'string') {
      return;
    }

    const progressEvent = this.createProgressEvent(
      pending.request,
      message.stage as TranscriptionProgressStage,
      message.progress,
      typeof message.message === 'string' ? message.message : '전사 진행 중'
    );
    pending.latestProgress = progressEvent;
    pending.onProgress?.(progressEvent);
  }

  // 요청 타임아웃과 진행률 보정 타이머를 만든다.
  private createPendingRequest(
    id: string,
    request: OfflineTranscriptionRequest,
    timeout: number,
    resolve: (result: OfflineTranscriptionResult) => void,
    reject: (error: Error) => void,
    onProgress?: ProgressCallback
  ): PendingRequest {
    const pending = {
      request,
      onProgress,
      resolve,
      reject,
      timeoutId: setTimeout(() => {
        this.rejectPendingRequest(
          id,
          new Error(`전사 엔진 실행 시간이 초과되었습니다. (${Math.round(timeout / 1000)}초)`)
        );
      }, timeout),
      heartbeatId: setInterval(() => this.tickProgress(pending), 1000)
    };

    return pending;
  }

  // 긴 단계에서 진행률이 멈춰 보이지 않도록 단계별 상한 안에서 조금씩 올린다.
  private tickProgress(pending: PendingRequest): void {
    if (!pending.latestProgress || !pending.onProgress) {
      return;
    }

    const nextProgress = Math.min(
      this.getStageProgressCap(pending.latestProgress.stage),
      pending.latestProgress.progress + 1
    );

    if (nextProgress > pending.latestProgress.progress) {
      pending.latestProgress = { ...pending.latestProgress, progress: nextProgress };
      pending.onProgress(pending.latestProgress);
    }
  }

  // 결과 메시지를 앱 전사 결과로 검증한 뒤 요청 Promise를 완료한다.
  private resolvePendingRequest(id: string, result: unknown): void {
    const pending = this.pendingRequests.get(id);

    if (!pending) {
      return;
    }

    if (!this.isTranscriptionResult(result)) {
      this.rejectPendingRequest(id, new Error('전사 엔진 결과 형식이 올바르지 않습니다.'));
      return;
    }

    pending.onProgress?.(this.createProgressEvent(pending.request, 'done', 100, '전사 완료'));
    this.clearPendingRequest(id);
    pending.resolve(result);
  }

  // 실패한 요청의 타이머를 해제하고 Promise를 거절한다.
  private rejectPendingRequest(id: string, error: Error): void {
    const pending = this.pendingRequests.get(id);

    if (!pending) {
      return;
    }

    this.clearPendingRequest(id);
    pending.reject(error);
  }

  // 요청 타이머를 정리하고 pending map에서 제거한다.
  private clearPendingRequest(id: string): void {
    const pending = this.pendingRequests.get(id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    clearInterval(pending.heartbeatId);
    this.pendingRequests.delete(id);
  }

  // worker 프로세스가 죽으면 대기 중인 모든 요청을 실패 처리하고 다음 요청에서 재시작하게 한다.
  private handleProcessExit(error: Error): void {
    const stderrTail = this.stderrBuffer.trim().split('\n').slice(-8).join('\n');
    const wrappedError = new Error(stderrTail || error.message);

    this.readyReject?.(wrappedError);
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.child = null;
    this.isReady = false;
    this.currentConfig = null;

    for (const id of this.pendingRequests.keys()) {
      this.rejectPendingRequest(id, wrappedError);
    }
  }

  // 앱 공통 진행률 이벤트 객체를 만든다.
  private createProgressEvent(
    request: OfflineTranscriptionRequest,
    stage: TranscriptionProgressStage,
    progress: number,
    message: string
  ): TranscriptionProgressEvent {
    return {
      sessionId: request.sessionId,
      mode: request.mode ?? 'final',
      stage,
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      message
    };
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

  // 보정 진행률이 실제 처리 단계보다 지나치게 앞서가지 않도록 제한한다.
  private getStageProgressCap(stage: TranscriptionProgressStage): number {
    const caps: Record<TranscriptionProgressStage, number> = {
      prepare: 8,
      model: 18,
      audio: 24,
      transcribe: 58,
      align: 70,
      diarize: 92,
      save: 98,
      done: 100
    };

    return caps[stage];
  }
}
