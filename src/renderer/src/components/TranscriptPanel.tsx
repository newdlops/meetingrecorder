import { Download, MessageSquareText } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MeetingSession } from '../../../shared/types';
import { formatDuration } from '../utils/time';

interface TranscriptPanelProps {
  session: MeetingSession | null;
  onExport?: () => void;
}

// 전사 구간을 시간순으로 표시하고 텍스트 내보내기를 제공한다.
export function TranscriptPanel({ session, onExport }: TranscriptPanelProps): JSX.Element {
  const speakerMap = new Map(session?.speakers.map((speaker) => [speaker.id, speaker]) ?? []);

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
