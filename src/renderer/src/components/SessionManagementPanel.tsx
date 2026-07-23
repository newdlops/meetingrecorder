import { Download, FileAudio, RefreshCw, Save, StickyNote, Trash2, Type } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MeetingSession, SessionDetailsUpdateRequest, TranscriptionProgressEvent } from '../../../shared/types';

interface SessionManagementPanelProps {
  session: MeetingSession | null;
  audioUrl: string | null;
  disabled: boolean;
  allowDelete: boolean;
  canReprocess: boolean;
  isReprocessing: boolean;
  transcriptionProgress: TranscriptionProgressEvent | null;
  onSaveDetails(details: Omit<SessionDetailsUpdateRequest, 'sessionId'>): void;
  onExportAudio(): void;
  onReprocess(): void;
  onDeleteSession(): void;
}

// 회의 제목, 원본 오디오, 전사 텍스트, 메모를 한곳에서 관리하는 패널이다.
export function SessionManagementPanel({
  session,
  audioUrl,
  disabled,
  allowDelete,
  canReprocess,
  isReprocessing,
  transcriptionProgress,
  onSaveDetails,
  onExportAudio,
  onReprocess,
  onDeleteSession
}: SessionManagementPanelProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    setTitle(session?.title ?? '');
    setTranscriptText(session?.transcriptText ?? '');
    setMemo(session?.memo ?? '');
  }, [session?.id, session?.memo, session?.title, session?.transcriptText]);

  const hasChanges = useMemo(() => {
    return (
      Boolean(session) &&
      (title !== session?.title || transcriptText !== session?.transcriptText || memo !== session?.memo)
    );
  }, [memo, session, title, transcriptText]);

  // 입력 중인 제목, 전사 텍스트, 메모를 상위 상태나 저장소에 반영한다.
  const saveDetails = (): void => {
    if (!session || disabled || !hasChanges) {
      return;
    }

    onSaveDetails({ title, transcriptText, memo });
  };

  return (
    <aside className="managementPanel">
      <div className="panelTitle">
        <FileAudio size={18} />
        <h2>관리</h2>
      </div>

      {!session ? (
        <p className="emptyText">선택된 회의가 없습니다.</p>
      ) : (
        <div className="managementForm">
          {transcriptionProgress ? (
            <div className="progressBlock">
              <div className="progressHeader">
                <strong>
                  {transcriptionProgress.workerLabel
                    ? `${transcriptionProgress.workerLabel} · ${transcriptionProgress.message}`
                    : transcriptionProgress.message}
                </strong>
                <span>{Math.round(transcriptionProgress.progress)}%</span>
              </div>
              <div className="progressTrack">
                <span style={{ width: `${transcriptionProgress.progress}%` }} />
              </div>
            </div>
          ) : null}

          <label className="fieldBlock">
            <span>제목</span>
            <input disabled={disabled} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>

          <div className="audioBlock">
            {audioUrl ? <audio controls preload="metadata" src={audioUrl} /> : <p className="emptyText">녹음 파일 없음</p>}
            <div className="panelButtonGrid">
              <button className="ghostButton" disabled={!session.audioFileName} type="button" onClick={onExportAudio}>
                <Download size={16} />
                오디오 저장
              </button>
              <button
                className="ghostButton"
                disabled={disabled || !canReprocess}
                title="마지막 최고 품질 보정이 필요할 때만 사용"
                type="button"
                onClick={onReprocess}
              >
                <RefreshCw className={isReprocessing ? 'spin' : undefined} size={16} />
                최종 고품질 보정
              </button>
            </div>
          </div>

          <label className="fieldBlock">
            <span>
              <Type size={15} />
              전사 텍스트
            </span>
            <textarea
              disabled={disabled}
              rows={8}
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
            />
          </label>

          <label className="fieldBlock">
            <span>
              <StickyNote size={15} />
              메모
            </span>
            <textarea disabled={disabled} rows={5} value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>

          <div className="managementActions panelButtonGrid">
            <button className="primaryButton" disabled={disabled || !hasChanges} type="button" onClick={saveDetails}>
              <Save size={16} />
              저장
            </button>
            <button className="dangerButton" disabled={!allowDelete} type="button" onClick={onDeleteSession}>
              <Trash2 size={16} />
              삭제
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
