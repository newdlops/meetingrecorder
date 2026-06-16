import { FileText } from 'lucide-react';
import type { MeetingSessionSummary } from '../../../shared/types';
import { formatDateTime, formatDuration } from '../utils/time';

interface SessionListProps {
  sessions: MeetingSessionSummary[];
  activeSessionId?: string;
  disabled: boolean;
  onSelect(id: string): void;
}

// 저장된 회의 목록을 선택 가능한 버튼 목록으로 렌더링한다.
export function SessionList({
  sessions,
  activeSessionId,
  disabled,
  onSelect
}: SessionListProps): JSX.Element {
  return (
    <nav className="sessionList" aria-label="회의 목록">
      <div className="sectionHeader">
        <span>회의 목록</span>
        <strong>{sessions.length}</strong>
      </div>

      {sessions.length === 0 ? (
        <p className="emptyText">저장된 회의가 없습니다.</p>
      ) : (
        sessions.map((session) => (
          <button
            className={session.id === activeSessionId ? 'sessionItem selected' : 'sessionItem'}
            disabled={disabled}
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
          >
            <FileText size={17} />
            <span className="sessionMeta">
              <strong>{session.title}</strong>
              <small>
                {formatDateTime(session.updatedAt)} · {formatDuration(session.durationMs)}
              </small>
              <small>
                화자 {session.speakerCount}명 · 구간 {session.segmentCount}개
              </small>
            </span>
          </button>
        ))
      )}
    </nav>
  );
}
