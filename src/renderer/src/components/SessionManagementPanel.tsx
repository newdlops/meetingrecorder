import { Download, FileAudio, Save, StickyNote, Trash2, Type } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MeetingSession, SessionDetailsUpdateRequest, TranscriptionProgressEvent } from '../../../shared/types';

interface SessionManagementPanelProps {
  session: MeetingSession | null;
  disabled: boolean;
  allowDelete: boolean;
  transcriptionProgress: TranscriptionProgressEvent | null;
  onSaveDetails(details: Omit<SessionDetailsUpdateRequest, 'sessionId'>): void;
  onExportAudio(): void;
  onDeleteSession(): void;
}

// 회의 제목, 원본 오디오, 전사 텍스트, 메모를 한곳에서 관리하는 패널이다.
export function SessionManagementPanel({
  session,
  disabled,
  allowDelete,
  transcriptionProgress,
  onSaveDetails,
  onExportAudio,
  onDeleteSession
}: SessionManagementPanelProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [memo, setMemo] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    setTitle(session?.title ?? '');
    setTranscriptText(session?.transcriptText ?? '');
    setMemo(session?.memo ?? '');
  }, [session?.id, session?.memo, session?.title, session?.transcriptText]);

  useEffect(() => {
    let nextAudioUrl: string | null = null;
    let isActive = true;

    if (!session?.audioFileName) {
      setAudioUrl(null);
      return undefined;
    }

    // 저장된 오디오 바이트를 Blob URL로 바꿔 브라우저 audio 컨트롤에 연결한다.
    window.meetingRecorder
      .getAudioFile(session.id)
      .then((payload) => {
        if (!payload || !isActive) {
          return;
        }

        const blob = new Blob([payload.audioData], {
          type: payload.audioMimeType ?? session.audioMimeType ?? 'audio/webm'
        });
        nextAudioUrl = URL.createObjectURL(blob);
        setAudioUrl(nextAudioUrl);
      })
      .catch(() => {
        if (isActive) {
          setAudioUrl(null);
        }
      });

    return () => {
      isActive = false;

      if (nextAudioUrl) {
        URL.revokeObjectURL(nextAudioUrl);
      }
    };
  }, [session?.audioFileName, session?.audioMimeType, session?.id]);

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
                <strong>{transcriptionProgress.message}</strong>
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
            {audioUrl ? <audio controls src={audioUrl} /> : <p className="emptyText">녹음 파일 없음</p>}
            <button className="ghostButton" disabled={!session.audioFileName} type="button" onClick={onExportAudio}>
              <Download size={16} />
              오디오 저장
            </button>
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

          <div className="managementActions">
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
