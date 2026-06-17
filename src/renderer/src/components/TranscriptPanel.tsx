import { Download, Loader2, MessageSquareText, Pause, Play, StickyNote } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { MeetingSession, TranscriptSegment, TranscriptionProgressEvent } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface TranscriptPanelProps {
  session: MeetingSession | null;
  isRecording?: boolean;
  isLivePreviewing?: boolean;
  showLivePreviewStatus?: boolean;
  isRealtimeTranscriptionEnabled?: boolean;
  canPlaySegments?: boolean;
  memoDisabled?: boolean;
  playingSegmentId?: string | null;
  previewProgress?: TranscriptionProgressEvent | null;
  previewQueuePendingCount?: number;
  previewActiveWorkerCount?: number;
  previewMaxWorkerCount?: number;
  previewWorkerProgress?: TranscriptionProgressEvent[];
  onPlaySegment?: (segment: TranscriptSegment) => void;
  onSegmentMemoChange?: (segmentId: string, memo: string) => void;
  onExport?: () => void;
}

// 전사 구간을 시간순으로 표시하고 텍스트 내보내기를 제공한다.
export function TranscriptPanel({
  session,
  isRecording = false,
  isLivePreviewing = false,
  showLivePreviewStatus = false,
  isRealtimeTranscriptionEnabled = false,
  canPlaySegments = false,
  memoDisabled = false,
  playingSegmentId,
  previewProgress,
  previewQueuePendingCount = 0,
  previewActiveWorkerCount = 0,
  previewMaxWorkerCount = 0,
  previewWorkerProgress = [],
  onPlaySegment,
  onSegmentMemoChange,
  onExport
}: TranscriptPanelProps): JSX.Element {
  const speakerMap = new Map(session?.speakers.map((speaker) => [speaker.id, speaker]) ?? []);
  const previewMessage = previewProgress?.message ?? (isLivePreviewing ? '전사 미리보기 생성 중' : '음성 감지 대기');
  const shouldShowLivePreviewStatus = isRealtimeTranscriptionEnabled && (showLivePreviewStatus || isLivePreviewing);

  return (
    <section className="transcriptPanel">
      <div className="panelTitle transcriptTitle">
        <div>
          <MessageSquareText size={18} />
          <h2>{session?.title ?? '전사'}</h2>
        </div>
        {onExport ? (
          <button className="ghostButton" type="button" onClick={onExport}>
            <Download size={17} />
            텍스트 저장
          </button>
        ) : null}
      </div>

      {shouldShowLivePreviewStatus ? (
        <div className="livePreviewStatus">
          <div className="livePreviewSummary">
            {isLivePreviewing ? <Loader2 className="spin" size={16} /> : <MessageSquareText size={16} />}
            <strong>{previewMessage}</strong>
            <span>
              대기 {previewQueuePendingCount}개 · 처리 {previewActiveWorkerCount}/{previewMaxWorkerCount}
            </span>
          </div>
          {previewWorkerProgress.length > 0 ? (
            <div className="workerStatusGrid">
              {previewWorkerProgress.map((progress) => (
                <div className="workerStatus" key={progress.workerId ?? progress.workerLabel ?? progress.message}>
                  <div className="workerStatusHeader">
                    <strong>{progress.workerLabel ?? '전사 worker'}</strong>
                    <span>{Math.round(progress.progress)}%</span>
                  </div>
                  <div className="workerProgressTrack">
                    <span style={{ width: `${Math.max(0, Math.min(100, progress.progress))}%` }} />
                  </div>
                  <p>{progress.message}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!session || session.segments.length === 0 ? (
        <p className="emptyText">전사 구간이 없습니다.</p>
      ) : (
        <div className="transcriptList">
          {session.segments.map((segment) => {
            const speaker = speakerMap.get(segment.speakerId);

            return (
              <TranscriptSegmentCard
                canPlaySegments={canPlaySegments}
                isPlaying={playingSegmentId === segment.id}
                isRealtimeTranscriptionEnabled={isRealtimeTranscriptionEnabled}
                isRecording={isRecording}
                key={segment.id}
                memoDisabled={memoDisabled || !onSegmentMemoChange}
                segment={segment}
                speakerColor={speaker?.color ?? '#607d8b'}
                speakerName={speaker?.name ?? '알 수 없는 화자'}
                onMemoChange={(memo) => onSegmentMemoChange?.(segment.id, memo)}
                onPlaySegment={onPlaySegment}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function TranscriptSegmentCard({
  canPlaySegments,
  isPlaying,
  isRealtimeTranscriptionEnabled,
  isRecording,
  memoDisabled,
  segment,
  speakerColor,
  speakerName,
  onMemoChange,
  onPlaySegment
}: {
  canPlaySegments: boolean;
  isPlaying: boolean;
  isRealtimeTranscriptionEnabled: boolean;
  isRecording: boolean;
  memoDisabled: boolean;
  segment: TranscriptSegment;
  speakerColor: string;
  speakerName: string;
  onMemoChange(memo: string): void;
  onPlaySegment?: (segment: TranscriptSegment) => void;
}): JSX.Element {
  const [isMemoEditing, setIsMemoEditing] = useState(false);
  const hasMemo = (segment.memo ?? '').trim().length > 0;
  const shouldAnimateSyllables = isRecording && isRealtimeTranscriptionEnabled;
  const style = { '--speaker-color': speakerColor } as CSSProperties;

  return (
    <article
      className={shouldAnimateSyllables ? 'transcriptSegment realtimeSegment' : 'transcriptSegment'}
      style={style}
    >
      <div className="segmentHeader">
        <strong>{speakerName}</strong>
        <span>
          {formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}
        </span>
        {segment.isOverlapped ? <em>동시 발화</em> : null}
        <div className="segmentHeaderActions">
          <button
            aria-label={hasMemo ? '문장 메모 수정' : '문장 메모 추가'}
            className={hasMemo ? 'segmentMemoHeaderButton active' : 'segmentMemoHeaderButton'}
            disabled={memoDisabled}
            title={hasMemo ? segment.memo?.trim() : '메모'}
            type="button"
            onClick={() => setIsMemoEditing(true)}
          >
            <StickyNote size={14} />
            {hasMemo ? <span>{segment.memo?.trim()}</span> : null}
          </button>
          <button
            aria-label={isPlaying ? '문장 재생 중지' : '문장 재생'}
            className={isPlaying ? 'segmentPlayButton active' : 'segmentPlayButton'}
            disabled={!canPlaySegments || !onPlaySegment}
            title={isPlaying ? '문장 재생 중지' : '문장 재생'}
            type="button"
            onClick={() => onPlaySegment?.(segment)}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </button>
        </div>
      </div>
      {shouldAnimateSyllables ? <SyllableText text={segment.text} /> : <p>{segment.text}</p>}
      {isMemoEditing ? (
        <SegmentMemoEditor
          disabled={memoDisabled}
          memo={segment.memo ?? ''}
          onChange={(memo) => {
            onMemoChange(memo);
            setIsMemoEditing(false);
          }}
        />
      ) : null}
    </article>
  );
}

function SegmentMemoEditor({
  disabled,
  memo,
  onChange
}: {
  disabled: boolean;
  memo: string;
  onChange(memo: string): void;
}): JSX.Element {
  return (
    <textarea
      autoFocus
      aria-label="문장 메모"
      className="segmentMemoInput"
      defaultValue={memo}
      disabled={disabled}
      placeholder="메모"
      rows={2}
      onBlur={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

function SyllableText({ text }: { text: string }): JSX.Element {
  return (
    <p className="syllableText" aria-label={text}>
      {Array.from(text).map((character, index) => (
        <span
          aria-hidden="true"
          className="syllableUnit"
          key={`${character}-${index}`}
          style={{ animationDelay: `${Math.min(index * 24, 1200)}ms` }}
        >
          {character}
        </span>
      ))}
    </p>
  );
}
