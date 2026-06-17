import { Download, Loader2, MessageSquareText, Pause, Play } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MeetingSession, TranscriptSegment, TranscriptionProgressEvent } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface TranscriptPanelProps {
  session: MeetingSession | null;
  isRecording?: boolean;
  isLivePreviewing?: boolean;
  isRealtimeTranscriptionEnabled?: boolean;
  canPlaySegments?: boolean;
  memoDisabled?: boolean;
  playingSegmentId?: string | null;
  previewProgress?: TranscriptionProgressEvent | null;
  onPlaySegment?: (segment: TranscriptSegment) => void;
  onSegmentMemoChange?: (segmentId: string, memo: string) => void;
  onExport?: () => void;
}

// 전사 구간을 시간순으로 표시하고 텍스트 내보내기를 제공한다.
export function TranscriptPanel({
  session,
  isRecording = false,
  isLivePreviewing = false,
  isRealtimeTranscriptionEnabled = false,
  canPlaySegments = false,
  memoDisabled = false,
  playingSegmentId,
  previewProgress,
  onPlaySegment,
  onSegmentMemoChange,
  onExport
}: TranscriptPanelProps): JSX.Element {
  const speakerMap = new Map(session?.speakers.map((speaker) => [speaker.id, speaker]) ?? []);
  const previewMessage = previewProgress?.message ?? (isLivePreviewing ? '전사 미리보기 생성 중' : '음성 감지 대기');

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

      {isRecording && isRealtimeTranscriptionEnabled ? (
        <div className="livePreviewStatus">
          {isLivePreviewing ? <Loader2 className="spin" size={16} /> : <MessageSquareText size={16} />}
          <strong>{previewMessage}</strong>
          {previewProgress ? <span>{Math.round(previewProgress.progress)}%</span> : null}
        </div>
      ) : null}

      {!session || session.segments.length === 0 ? (
        <p className="emptyText">전사 구간이 없습니다.</p>
      ) : (
        <div className="transcriptList">
          {session.segments.map((segment) => {
            const speaker = speakerMap.get(segment.speakerId);
            const style = { '--speaker-color': speaker?.color ?? '#607d8b' } as CSSProperties;
            const isPlaying = playingSegmentId === segment.id;
            const shouldAnimateSyllables = isRecording && isRealtimeTranscriptionEnabled;

            return (
              <article
                className={shouldAnimateSyllables ? 'transcriptSegment realtimeSegment' : 'transcriptSegment'}
                key={segment.id}
                style={style}
              >
                <div className="segmentHeader">
                  <strong>{speaker?.name ?? '알 수 없는 화자'}</strong>
                  <span>
                    {formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}
                  </span>
                  {segment.isOverlapped ? <em>동시 발화</em> : null}
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
                {shouldAnimateSyllables ? <SyllableText text={segment.text} /> : <p>{segment.text}</p>}
                <textarea
                  aria-label="문장 메모"
                  className="segmentMemoInput"
                  defaultValue={segment.memo ?? ''}
                  disabled={memoDisabled || !onSegmentMemoChange}
                  placeholder="메모"
                  rows={2}
                  onBlur={(event) => onSegmentMemoChange?.(segment.id, event.target.value)}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
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
