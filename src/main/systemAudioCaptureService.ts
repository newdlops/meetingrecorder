import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SystemAudioCaptureResult } from '../shared/types';

interface HelperMessage {
  type: string;
  message?: string;
  sampleBuffers?: number;
  appendedBuffers?: number;
  droppedBuffers?: number;
}

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BaseSystemAudioCapture {
  outputPath: string;
  tempDir: string;
  ownsTempDir: boolean;
  startedAt: number;
  snapshotStartedAt: number;
}

interface HelperSystemAudioCapture extends BaseSystemAudioCapture {
  kind: 'helper';
  child: ChildProcessWithoutNullStreams;
  snapshotByteOffset: number;
  stdoutRemainder: string;
  stderrTail: string[];
  errorMessages: string[];
  doneStats: SystemAudioCaptureStats | null;
  messageListeners: Set<(message: HelperMessage) => void>;
  closePromise: Promise<CloseResult>;
  closeResult: CloseResult | null;
}

interface MockSystemAudioCapture extends BaseSystemAudioCapture {
  kind: 'mock';
}

type ActiveSystemAudioCapture = HelperSystemAudioCapture | MockSystemAudioCapture;

interface SystemAudioCaptureStats {
  sampleBuffers: number;
  appendedBuffers: number;
  droppedBuffers: number;
}

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LIMIT = 12;
const MIN_NONEMPTY_CAPTURE_DURATION_MS = 1_500;
const MIN_SYSTEM_AUDIO_SNAPSHOT_DURATION_MS = 5_000;
const SYSTEM_AUDIO_HELPER_BUNDLE_ID = 'com.meetingrecorder.system-audio-recorder';
const MOCK_AUDIO_SAMPLE_RATE = 16_000;
const MOCK_AUDIO_CHANNELS = 1;
const MOCK_AUDIO_BYTES_PER_SAMPLE = 2;

// macOS ScreenCaptureKit 헬퍼 프로세스를 실행해 시스템 출력 오디오를 WAV 파일로 녹음한다.
export class SystemAudioCaptureService {
  private activeCapture: ActiveSystemAudioCapture | null = null;

  // 시스템 오디오 녹음을 시작하고 헬퍼가 실제 캡처 준비를 마칠 때까지 기다린다.
  async start(targetOutputPath?: string): Promise<void> {
    if (this.activeCapture) {
      throw new Error('이미 시스템 오디오 녹음이 진행 중입니다.');
    }

    if (this.shouldUseMockCapture()) {
      const ownsTempDir = !targetOutputPath;
      const tempDir = targetOutputPath
        ? path.dirname(targetOutputPath)
        : await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-recorder-system-audio-'));
      const outputPath = targetOutputPath ?? path.join(tempDir, 'system-audio.wav');
      this.activeCapture = {
        kind: 'mock',
        outputPath,
        tempDir,
        ownsTempDir,
        startedAt: Date.now(),
        snapshotStartedAt: Date.now()
      };
      return;
    }

    if (process.platform !== 'darwin') {
      throw new Error('시스템 오디오 녹음은 macOS에서만 사용할 수 있습니다.');
    }

    const helperPath = this.resolveHelperPath();
    await fs.access(helperPath, constants.X_OK).catch(() => {
      throw new Error('시스템 오디오 녹음 헬퍼가 없습니다. 앱을 다시 빌드하세요.');
    });

    const ownsTempDir = !targetOutputPath;
    const tempDir = targetOutputPath
      ? path.dirname(targetOutputPath)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-recorder-system-audio-'));
    const outputPath = targetOutputPath ?? path.join(tempDir, 'system-audio.wav');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    const child = spawn(helperPath, ['--output', outputPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const capture = this.createCaptureSession(child, outputPath, tempDir, ownsTempDir);

    this.activeCapture = capture;
    this.attachProcessListeners(capture);

    try {
      await this.waitForReady(capture);
    } catch (error) {
      this.activeCapture = null;
      await this.terminateCapture(capture);
      await this.cleanupCaptureOutput(capture);
      throw this.normalizeStartError(error);
    }
  }

  // 시스템 오디오 녹음을 종료하고 완성된 WAV 데이터를 렌더러로 돌려준다.
  async stop(): Promise<SystemAudioCaptureResult> {
    const capture = this.activeCapture;

    if (!capture) {
      throw new Error('진행 중인 시스템 오디오 녹음이 없습니다.');
    }

    this.activeCapture = null;

    try {
      if (capture.kind === 'mock') {
        const durationMs = Date.now() - capture.startedAt;

        return {
          audioData: this.createSilentWav(durationMs),
          audioMimeType: 'audio/wav',
          durationMs
        };
      }

      if (!capture.closeResult) {
        capture.child.stdin.write('stop\n');
        capture.child.stdin.end();
      }

      const closeResult = await this.waitForClose(capture, STOP_TIMEOUT_MS);
      const durationMs = Date.now() - capture.startedAt;

      if (capture.errorMessages.length > 0) {
        throw new Error(
          `시스템 오디오 녹음 중 오류가 발생했습니다. ${
            capture.errorMessages[capture.errorMessages.length - 1]
          }`
        );
      }

      if (closeResult.code !== 0) {
        throw new Error(`시스템 오디오 헬퍼가 비정상 종료되었습니다. ${this.formatDiagnostics(capture)}`);
      }

      const audioData = await fs.readFile(capture.outputPath).catch(() => {
        throw new Error(`시스템 오디오 녹음 파일을 읽을 수 없습니다. ${this.formatDiagnostics(capture)}`);
      });

      if (durationMs >= MIN_NONEMPTY_CAPTURE_DURATION_MS && this.isEmptyWav(audioData)) {
        throw new Error(
          `시스템 오디오 샘플이 들어오지 않았습니다. ${
            this.formatCaptureStats(capture)
          } 재생 앱이나 브라우저 탭 자체가 음소거/정지 상태가 아닌지 확인하세요. DRM 보호 콘텐츠나 앱 내부에서 0으로 만든 오디오는 녹음되지 않을 수 있습니다.`
        );
      }

      return {
        audioData,
        audioMimeType: 'audio/wav',
        durationMs
      };
    } finally {
      await this.cleanupCaptureOutput(capture);
    }
  }

  // 시스템 오디오 녹음을 종료하고 완성된 WAV를 지정된 파일로 복사한다.
  async stopToFile(targetPath: string): Promise<Omit<SystemAudioCaptureResult, 'audioData'>> {
    const capture = this.activeCapture;

    if (!capture) {
      throw new Error('진행 중인 시스템 오디오 녹음이 없습니다.');
    }

    this.activeCapture = null;

    try {
      if (capture.kind === 'mock') {
        const durationMs = Date.now() - capture.startedAt;
        await fs.writeFile(targetPath, this.createSilentWav(durationMs));

        return {
          audioMimeType: 'audio/wav',
          durationMs
        };
      }

      if (!capture.closeResult) {
        capture.child.stdin.write('stop\n');
        capture.child.stdin.end();
      }

      const closeResult = await this.waitForClose(capture, STOP_TIMEOUT_MS);
      const durationMs = Date.now() - capture.startedAt;

      if (capture.errorMessages.length > 0) {
        throw new Error(
          `시스템 오디오 녹음 중 오류가 발생했습니다. ${
            capture.errorMessages[capture.errorMessages.length - 1]
          }`
        );
      }

      if (closeResult.code !== 0) {
        throw new Error(`시스템 오디오 헬퍼가 비정상 종료되었습니다. ${this.formatDiagnostics(capture)}`);
      }

      const audioStat = await fs.stat(capture.outputPath).catch(() => {
        throw new Error(`시스템 오디오 녹음 파일을 읽을 수 없습니다. ${this.formatDiagnostics(capture)}`);
      });

      if (durationMs >= MIN_NONEMPTY_CAPTURE_DURATION_MS && audioStat.size <= 44) {
        throw new Error(
          `시스템 오디오 샘플이 들어오지 않았습니다. ${
            this.formatCaptureStats(capture)
          } 재생 앱이나 브라우저 탭 자체가 음소거/정지 상태가 아닌지 확인하세요. DRM 보호 콘텐츠나 앱 내부에서 0으로 만든 오디오는 녹음되지 않을 수 있습니다.`
        );
      }

      if (path.resolve(capture.outputPath) !== path.resolve(targetPath)) {
        await fs.copyFile(capture.outputPath, targetPath);
      }

      return {
        audioMimeType: 'audio/wav',
        durationMs
      };
    } finally {
      await this.cleanupCaptureOutput(capture);
    }
  }

  // 진행 중인 시스템 오디오 파일에서 마지막 스냅샷 이후의 PCM만 잘라 전사용 WAV 조각을 만든다.
  async createSnapshot(): Promise<SystemAudioCaptureResult | null> {
    const capture = this.activeCapture;

    if (!capture) {
      return null;
    }

    if (capture.kind === 'mock') {
      const now = Date.now();
      const durationMs = now - capture.snapshotStartedAt;
      const startOffsetMs = Math.max(0, capture.snapshotStartedAt - capture.startedAt);

      if (durationMs < MIN_SYSTEM_AUDIO_SNAPSHOT_DURATION_MS) {
        return null;
      }

      capture.snapshotStartedAt = now;

      return {
        audioData: this.createSilentWav(durationMs),
        audioMimeType: 'audio/wav',
        durationMs,
        startOffsetMs
      };
    }

    const fileData = await fs.readFile(capture.outputPath).catch(() => null);

    if (!fileData || fileData.byteLength <= 44 || fileData.byteLength <= capture.snapshotByteOffset) {
      return null;
    }

    const header = fileData.subarray(0, 44);

    if (!this.isStandardWavHeader(header)) {
      return null;
    }

    const blockAlign = Math.max(1, header.readUInt16LE(32));
    const byteRate = Math.max(1, header.readUInt32LE(28));
    const dataStart = Math.max(44, capture.snapshotByteOffset);
    const alignedDataEnd = 44 + Math.floor((fileData.byteLength - 44) / blockAlign) * blockAlign;

    if (alignedDataEnd <= dataStart) {
      return null;
    }

    const audioData = this.createWavFromChunk(header, fileData.subarray(dataStart, alignedDataEnd));
    const durationMs = Math.max(1, Math.round(((alignedDataEnd - dataStart) / byteRate) * 1000));
    const startOffsetMs = Math.max(0, Math.round(((dataStart - 44) / byteRate) * 1000));

    if (durationMs < MIN_SYSTEM_AUDIO_SNAPSHOT_DURATION_MS) {
      return null;
    }

    capture.snapshotByteOffset = alignedDataEnd;
    capture.snapshotStartedAt = Date.now();

    return {
      audioData,
      audioMimeType: 'audio/wav',
      durationMs,
      startOffsetMs
    };
  }

  // 실시간 전사를 껐다 켤 때 이전 구간이 다음 스냅샷에 섞이지 않게 현재 위치를 기준점으로 잡는다.
  async resetSnapshot(): Promise<void> {
    const capture = this.activeCapture;

    if (!capture) {
      return;
    }

    capture.snapshotStartedAt = Date.now();

    if (capture.kind === 'mock') {
      return;
    }

    const fileData = await fs.readFile(capture.outputPath).catch(() => null);

    if (!fileData || fileData.byteLength <= 44) {
      capture.snapshotByteOffset = 44;
      return;
    }

    const header = fileData.subarray(0, 44);

    if (!this.isStandardWavHeader(header)) {
      capture.snapshotByteOffset = fileData.byteLength;
      return;
    }

    const blockAlign = Math.max(1, header.readUInt16LE(32));
    capture.snapshotByteOffset = 44 + Math.floor((fileData.byteLength - 44) / blockAlign) * blockAlign;
  }

  // 앱 종료 시 떠 있는 헬퍼 프로세스와 임시 녹음 파일을 정리한다.
  async shutdown(): Promise<void> {
    const capture = this.activeCapture;

    if (!capture) {
      return;
    }

    this.activeCapture = null;

    if (capture.kind === 'mock') {
      await this.cleanupCaptureOutput(capture);
      return;
    }

    await this.terminateCapture(capture);
    await this.cleanupCaptureOutput(capture);
  }

  // 개발 모드와 패키징된 앱에서 각각 다른 위치의 헬퍼 바이너리를 찾는다.
  private resolveHelperPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'native/SystemAudioRecorder.app/Contents/MacOS/SystemAudioRecorder');
    }

    return path.join(
      app.getAppPath(),
      'native/macos-system-audio-recorder/build/SystemAudioRecorder.app/Contents/MacOS/SystemAudioRecorder'
    );
  }

  // 헬퍼 프로세스 상태와 출력 버퍼를 한 객체로 묶어 추적한다.
  private createCaptureSession(
    child: ChildProcessWithoutNullStreams,
    outputPath: string,
    tempDir: string,
    ownsTempDir: boolean
  ): HelperSystemAudioCapture {
    const capture: HelperSystemAudioCapture = {
      kind: 'helper',
      child,
      outputPath,
      tempDir,
      ownsTempDir,
      startedAt: Date.now(),
      snapshotStartedAt: Date.now(),
      snapshotByteOffset: 44,
      stdoutRemainder: '',
      stderrTail: [],
      errorMessages: [],
      doneStats: null,
      messageListeners: new Set<(message: HelperMessage) => void>(),
      closePromise: Promise.resolve({ code: null, signal: null }),
      closeResult: null
    };

    capture.closePromise = new Promise<CloseResult>((resolve) => {
      child.once('close', (code, signal) => {
        capture.closeResult = { code, signal };
        resolve(capture.closeResult);
      });
    });

    return capture;
  }

  // stdout은 JSON 라인 프로토콜로, stderr는 진단용 꼬리 로그로 저장한다.
  private attachProcessListeners(capture: HelperSystemAudioCapture): void {
    capture.child.stdout.setEncoding('utf8');
    capture.child.stderr.setEncoding('utf8');
    capture.child.stdout.on('data', (chunk: string) => this.handleStdout(capture, chunk));
    capture.child.stderr.on('data', (chunk: string) => this.appendStderr(capture, chunk));
  }

  // 헬퍼가 ready 메시지를 줄 때까지 기다리고, 오류/종료/타임아웃은 사용자 문장으로 바꾼다.
  private async waitForReady(capture: HelperSystemAudioCapture): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        capture.messageListeners.delete(onMessage);
        error ? reject(error) : resolve();
      };
      const onMessage = (message: HelperMessage) => {
        if (message.type === 'ready') {
          settle();
          return;
        }

        if (message.type === 'error') {
          settle(new Error(message.message ?? '시스템 오디오 헬퍼에서 오류가 발생했습니다.'));
        }
      };
      const timer = setTimeout(() => {
        settle(new Error(`시스템 오디오 헬퍼가 응답하지 않습니다. ${this.formatDiagnostics(capture)}`));
      }, READY_TIMEOUT_MS);

      capture.messageListeners.add(onMessage);
      capture.child.once('error', (error) => settle(error));
      capture.closePromise.then((closeResult) => {
        settle(new Error(`시스템 오디오 헬퍼가 준비 전에 종료되었습니다. ${this.describeClose(closeResult)} ${this.formatDiagnostics(capture)}`));
      });
    });
  }

  // 지정 시간 안에 프로세스가 종료되지 않으면 현재 녹음이 멈추지 않은 것으로 판단한다.
  private async waitForClose(capture: HelperSystemAudioCapture, timeoutMs: number): Promise<CloseResult> {
    if (capture.closeResult) {
      return capture.closeResult;
    }

    return Promise.race([
      capture.closePromise,
      new Promise<CloseResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error('시스템 오디오 헬퍼 종료 시간이 초과되었습니다.')), timeoutMs);
      })
    ]);
  }

  // JSON 라인 메시지를 파싱해 대기 중인 시작 로직에 전달한다.
  private handleStdout(capture: HelperSystemAudioCapture, chunk: string): void {
    capture.stdoutRemainder += chunk;
    const lines = capture.stdoutRemainder.split(/\r?\n/);
    capture.stdoutRemainder = lines.pop() ?? '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        continue;
      }

      try {
        const message = JSON.parse(trimmedLine) as HelperMessage;

        if (message.type === 'error' && message.message) {
          capture.errorMessages.push(message.message);
        }

        if (message.type === 'diagnostic' && message.message) {
          capture.stderrTail.push(message.message);
          capture.stderrTail = capture.stderrTail.slice(-STDERR_TAIL_LIMIT);
        }

        if (
          message.type === 'done' &&
          typeof message.sampleBuffers === 'number' &&
          typeof message.appendedBuffers === 'number' &&
          typeof message.droppedBuffers === 'number'
        ) {
          capture.doneStats = {
            sampleBuffers: message.sampleBuffers,
            appendedBuffers: message.appendedBuffers,
            droppedBuffers: message.droppedBuffers
          };
        }

        capture.messageListeners.forEach((listener) => listener(message));
      } catch {
        this.appendStderr(capture, trimmedLine);
      }
    }
  }

  // 긴 stderr 전체 대신 마지막 몇 줄만 보관해 오류 메시지가 과하게 길어지는 것을 막는다.
  private appendStderr(capture: HelperSystemAudioCapture, chunk: string): void {
    const nextLines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    capture.stderrTail.push(...nextLines);
    capture.stderrTail = capture.stderrTail.slice(-STDERR_TAIL_LIMIT);
  }

  // 시작 실패나 앱 종료 때 헬퍼 프로세스를 멈춘다.
  private async terminateCapture(capture: HelperSystemAudioCapture): Promise<void> {
    if (capture.closeResult) {
      return;
    }

    capture.child.kill('SIGTERM');

    try {
      await this.waitForClose(capture, 3_000);
    } catch {
      capture.child.kill('SIGKILL');
    }
  }

  // 임시 WAV 파일과 폴더는 저장소에 복사한 뒤 제거한다.
  private async cleanupCaptureOutput(capture: ActiveSystemAudioCapture): Promise<void> {
    if (capture.ownsTempDir) {
      await fs.rm(capture.tempDir, { recursive: true, force: true });
    }
  }

  // 헬퍼 종료 상태를 오류 문장 안에 짧게 넣는다.
  private describeClose(closeResult: CloseResult): string {
    if (closeResult.signal) {
      return `signal=${closeResult.signal}`;
    }

    return `code=${closeResult.code ?? 'unknown'}`;
  }

  // 헬퍼가 남긴 오류와 stderr 로그를 합쳐 사용자가 원인을 파악할 수 있게 한다.
  private formatDiagnostics(capture: HelperSystemAudioCapture): string {
    const details = [...capture.errorMessages.slice(-2), ...capture.stderrTail].filter(Boolean);

    return details.length > 0 ? details.join(' / ') : '추가 로그가 없습니다.';
  }

  private isEmptyWav(audioData: Buffer): boolean {
    return audioData.byteLength <= 44;
  }

  private isStandardWavHeader(header: Buffer): boolean {
    return (
      header.byteLength >= 44 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE' &&
      header.toString('ascii', 36, 40) === 'data'
    );
  }

  private createWavFromChunk(sourceHeader: Buffer, audioData: Buffer): Buffer {
    const header = Buffer.from(sourceHeader);
    const dataSize = audioData.byteLength;

    header.writeUInt32LE(36 + dataSize, 4);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, audioData]);
  }

  private formatCaptureStats(capture: HelperSystemAudioCapture): string {
    if (!capture.doneStats) {
      return '샘플 통계가 없습니다.';
    }

    return `sampleBuffers=${capture.doneStats.sampleBuffers}, appendedBuffers=${capture.doneStats.appendedBuffers}, droppedBuffers=${capture.doneStats.droppedBuffers}.`;
  }

  // 개발 UI 테스트에서는 macOS TCC 프롬프트 없이 빈 WAV를 돌려줄 수 있게 한다.
  private shouldUseMockCapture(): boolean {
    if (app.isPackaged) {
      return false;
    }

    const mode = process.env.MEETING_RECORDER_SYSTEM_AUDIO_MODE?.toLowerCase();
    const legacyFlag = process.env.MEETING_RECORDER_MOCK_SYSTEM_AUDIO?.toLowerCase();

    return mode === 'mock' || legacyFlag === '1' || legacyFlag === 'true';
  }

  private normalizeStartError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);

    if (!this.isTccDeniedMessage(message)) {
      return error instanceof Error ? error : new Error(message);
    }

    const recoveryHint = app.isPackaged
      ? 'macOS 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 Meeting Recorder System Audio를 허용한 뒤 앱을 다시 시작하세요.'
      : `개발 모드에서는 npm run reset:system-audio-permission으로 ${SYSTEM_AUDIO_HELPER_BUNDLE_ID}의 거절 상태를 초기화하거나, npm run dev:mock-system-audio로 권한 요청 없는 UI 테스트를 실행하세요.`;

    return new Error(`시스템 오디오 캡처 권한이 거부되었습니다. ${recoveryHint} 원본 오류: ${message}`);
  }

  private isTccDeniedMessage(message: string): boolean {
    return (
      message.includes('SCStreamErrorDomain Code=-3801') ||
      message.includes('TCC를 거절') ||
      /tcc.*denied/i.test(message) ||
      /screen.*capture.*denied/i.test(message)
    );
  }

  private createSilentWav(durationMs: number): Buffer {
    const frameCount = Math.max(1, Math.ceil((durationMs / 1000) * MOCK_AUDIO_SAMPLE_RATE));
    const byteRate = MOCK_AUDIO_SAMPLE_RATE * MOCK_AUDIO_CHANNELS * MOCK_AUDIO_BYTES_PER_SAMPLE;
    const blockAlign = MOCK_AUDIO_CHANNELS * MOCK_AUDIO_BYTES_PER_SAMPLE;
    const dataSize = frameCount * blockAlign;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(MOCK_AUDIO_CHANNELS, 22);
    buffer.writeUInt32LE(MOCK_AUDIO_SAMPLE_RATE, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(MOCK_AUDIO_BYTES_PER_SAMPLE * 8, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    return buffer;
  }
}
