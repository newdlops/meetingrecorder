import { Loader2, Mic, Square } from 'lucide-react';
import type { RecordingStatus } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface RecorderPanelProps {
  status: RecordingStatus;
  elapsedMs: number;
  error: string | null;
  isLivePreviewing?: boolean;
  progressPercent?: number;
  onStart(): void;
  onStop(): void;
}

// 녹음 시작/중지와 현재 녹음 시간을 표시하는 상단 패널이다.
export function RecorderPanel({
  status,
  elapsedMs,
  error,
  isLivePreviewing = false,
  progressPercent,
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

      {error ? <p className="errorText">{error}</p> : null}
    </section>
  );
}
