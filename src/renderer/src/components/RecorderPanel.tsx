import { Loader2, Mic, SlidersHorizontal, Square, Waves } from 'lucide-react';
import type { RecordingStatus } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface RecorderPanelProps {
  status: RecordingStatus;
  elapsedMs: number;
  error: string | null;
  sensitivity: number;
  inputLevel: number;
  captureDistantSpeech: boolean;
  isLivePreviewing?: boolean;
  progressPercent?: number;
  onSensitivityChange(value: number): void;
  onCaptureDistantSpeechChange(value: boolean): void;
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
  captureDistantSpeech,
  isLivePreviewing = false,
  progressPercent,
  onSensitivityChange,
  onCaptureDistantSpeechChange,
  onStart,
  onStop
}: RecorderPanelProps): JSX.Element {
  const isRecording = status === 'recording';
  const isSaving = status === 'saving';
  const statusLabel =
    isSaving && typeof progressPercent === 'number'
      ? `전사 중 ${Math.round(progressPercent)}%`
      : isSaving
        ? '저장 중'
        : isLivePreviewing
          ? '전사 중'
          : isRecording
            ? '녹음 중'
            : '대기';

  return (
    <section className="recorderPanel">
      <div className="recordingMeter" aria-live="polite">
        <span className={isRecording ? 'recordDot active' : 'recordDot'} />
        <div>
          <p className="eyebrow">{statusLabel}</p>
          <strong>{formatDuration(elapsedMs)}</strong>
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
            disabled={isRecording}
            type="checkbox"
            onChange={(event) => onCaptureDistantSpeechChange(event.target.checked)}
          />
          <Waves size={15} />
          주변음
        </label>
        <div className="inputLevelMeter" aria-label="입력 레벨">
          <span style={{ width: `${inputLevel}%` }} />
        </div>
      </div>

      {error ? <p className="errorText">{error}</p> : null}
    </section>
  );
}
