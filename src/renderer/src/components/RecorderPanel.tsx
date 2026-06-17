import {
  Loader2,
  MessageSquareText,
  Mic,
  MonitorSpeaker,
  SlidersHorizontal,
  Square,
  Users,
  Waves
} from 'lucide-react';
import type { RecordingStatus } from '../../../shared/types';
import type { RecorderInputSource } from '../hooks/useRecorder';
import { formatDuration } from '../utils/time';

interface RecorderPanelProps {
  status: RecordingStatus;
  elapsedMs: number;
  error: string | null;
  sensitivity: number;
  inputLevel: number;
  inputSource: RecorderInputSource;
  captureDistantSpeech: boolean;
  liveTranscriptionEnabled: boolean;
  expectedSpeakerCount: number;
  isLivePreviewing?: boolean;
  processingLabel?: string;
  progressMessage?: string;
  progressPercent?: number;
  onSensitivityChange(value: number): void;
  onInputSourceChange(value: RecorderInputSource): void;
  onCaptureDistantSpeechChange(value: boolean): void;
  onLiveTranscriptionEnabledChange(value: boolean): void;
  onExpectedSpeakerCountChange(value: number): void;
  onStart(): void;
  onStop(): void;
}

// 녹음 시작/중지와 현재 녹음 시간을 표시하는 상단 패널이다.
export function RecorderPanel({
  status,
  elapsedMs,
  error,
  sensitivity,
  inputLevel,
  inputSource,
  captureDistantSpeech,
  liveTranscriptionEnabled,
  expectedSpeakerCount,
  isLivePreviewing = false,
  processingLabel,
  progressMessage,
  progressPercent,
  onSensitivityChange,
  onInputSourceChange,
  onCaptureDistantSpeechChange,
  onLiveTranscriptionEnabledChange,
  onExpectedSpeakerCountChange,
  onStart,
  onStop
}: RecorderPanelProps): JSX.Element {
  const isRecording = status === 'recording';
  const isSaving = status === 'saving';
  const statusLabel =
    isSaving
      ? processingLabel ?? '처리 중'
      : isRecording
        ? '녹음 중'
        : '대기';
  const secondaryStatus =
    isSaving && typeof progressPercent === 'number'
      ? `${progressMessage ?? '전사 진행 중'} · ${Math.round(progressPercent)}%`
      : liveTranscriptionEnabled && isRecording
        ? isLivePreviewing
          ? '실시간 전사 처리 중'
          : '실시간 전사 대기'
        : null;

  return (
    <section className="recorderPanel">
      <div className="recordingMeter" aria-live="polite">
        <span className={isRecording ? 'recordDot active' : 'recordDot'} />
        <div>
          <p className="eyebrow">{statusLabel}</p>
          <strong>{formatDuration(elapsedMs)}</strong>
          {secondaryStatus ? <p className="recorderProgressSummary">{secondaryStatus}</p> : null}
        </div>
      </div>

      <div className="recorderActions">
        <button className="primaryButton" disabled={isRecording || isSaving} type="button" onClick={onStart}>
          <Mic size={18} />
          녹음 시작
        </button>
        <button className="dangerButton" disabled={!isRecording || isSaving} type="button" onClick={onStop}>
          {isSaving ? <Loader2 className="spin" size={18} /> : <Square size={18} />}
          녹음 종료
        </button>
      </div>

      <div className="recorderControls">
        <div className="sourceSegmentedControl" aria-label="녹음 입력">
          <button
            aria-pressed={inputSource === 'microphone'}
            className={inputSource === 'microphone' ? 'active' : ''}
            disabled={isRecording || isSaving}
            type="button"
            onClick={() => onInputSourceChange('microphone')}
          >
            <Mic size={15} />
            마이크
          </button>
          <button
            aria-pressed={inputSource === 'system'}
            className={inputSource === 'system' ? 'active' : ''}
            disabled={isRecording || isSaving}
            type="button"
            onClick={() => onInputSourceChange('system')}
          >
            <MonitorSpeaker size={15} />
            시스템
          </button>
        </div>
        <label className="sensitivityControl">
          <span>
            <SlidersHorizontal size={15} />
            감도 {sensitivity.toFixed(1)}x
          </span>
          <input
            max="4"
            min="0.5"
            step="0.1"
            type="range"
            value={sensitivity}
            onChange={(event) => onSensitivityChange(Number(event.target.value))}
          />
        </label>
        <label className="distantSpeechToggle">
          <input
            checked={captureDistantSpeech}
            disabled={isRecording || isSaving || inputSource === 'system'}
            type="checkbox"
            onChange={(event) => onCaptureDistantSpeechChange(event.target.checked)}
          />
          <Waves size={15} />
          주변음
        </label>
        <label className="speakerCountControl">
          <span>
            <Users size={15} />
            화자 수
          </span>
          <select
            disabled={isRecording || isSaving}
            value={expectedSpeakerCount}
            onChange={(event) => onExpectedSpeakerCountChange(Number(event.target.value))}
          >
            <option value={0}>자동</option>
            <option value={1}>1명</option>
            <option value={2}>2명</option>
            <option value={3}>3명</option>
            <option value={4}>4명</option>
            <option value={5}>5명</option>
            <option value={6}>6명</option>
          </select>
        </label>
        <label className="liveTranscriptToggle">
          <input
            checked={liveTranscriptionEnabled}
            disabled={isSaving}
            type="checkbox"
            onChange={(event) => onLiveTranscriptionEnabledChange(event.target.checked)}
          />
          <MessageSquareText size={15} />
          실시간 전사
        </label>
        <div className="inputLevelMeter" aria-label="입력 레벨">
          <span style={{ width: `${inputLevel}%` }} />
        </div>
      </div>

      {error ? <p className="errorText">{error}</p> : null}
    </section>
  );
}
