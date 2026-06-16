import { Download, Loader2, MessageSquareText } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MeetingSession, TranscriptionProgressEvent } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface TranscriptPanelProps {
  session: MeetingSession | null;
  isRecording?: boolean;
  isLivePreviewing?: boolean;
  previewProgress?: TranscriptionProgressEvent | null;
  onExport?: () => void;
}

// 전사 구간을 시간순으로 표시하고 텍스트 내보내기를 제공한다.
export function TranscriptPanel({
  session,
  isRecording = false,
  isLivePreviewing = false,
  previewProgress,
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

      {isRecording ? (
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

            return (
              <article className="transcriptSegment" key={segment.id} style={style}>
                <div className="segmentHeader">
                  <strong>{speaker?.name ?? '알 수 없는 화자'}</strong>
                  <span>
                    {formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}
                  </span>
                  {segment.isOverlapped ? <em>동시 발화</em> : null}
                </div>
                <p>{segment.text}</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
