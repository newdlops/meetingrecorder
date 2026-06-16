import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeetingSession, MeetingSessionSummary, RecordingStatus } from '../../shared/types';
import { RecorderPanel } from './components/RecorderPanel';
import { SessionList } from './components/SessionList';
import { SpeakerEditor } from './components/SpeakerEditor';
import { TranscriptPanel } from './components/TranscriptPanel';
import { useRecorder } from './hooks/useRecorder';
import { createDraftMeetingSession } from './services/meetingFactory';
import { transcribeRecordedAudio } from './services/offlineTranscription';

// 전체 앱 상태를 조율하고 메인 프로세스 IPC API를 호출한다.
export function App(): JSX.Element {
  const recorder = useRecorder();
  const draftSessionRef = useRef<MeetingSession | null>(null);
  const [sessions, setSessions] = useState<MeetingSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<MeetingSession | null>(null);
  const [draftSession, setDraftSession] = useState<MeetingSession | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  const activeSession = draftSession ?? selectedSession;
  const visibleStatus: RecordingStatus = isSaving ? 'saving' : recorder.status;

  useEffect(() => {
    draftSessionRef.current = draftSession;
  }, [draftSession]);

  // 저장된 회의 목록을 새로 읽는다.
  const refreshSessions = useCallback(async () => {
    const nextSessions = await window.meetingRecorder.listSessions();
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    refreshSessions().catch((error) => setAppError(error.message));
  }, [refreshSessions]);

  // 목록에서 선택한 회의의 상세 데이터를 불러온다.
  const handleSelectSession = useCallback(
    async (id: string) => {
      if (recorder.status === 'recording') {
        return;
      }

      const session = await window.meetingRecorder.getSession(id);
      setDraftSession(null);
      setSelectedSession(session);
    },
    [recorder.status]
  );

  // 마이크 녹음을 시작하고 오프라인 전사용 회의 초안을 만든다.
  const handleStartRecording = useCallback(async () => {
    setAppError(null);

    try {
      await recorder.startRecording();

      const nextSession = createDraftMeetingSession();
      setSelectedSession(null);
      setDraftSession(nextSession);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '녹음을 시작할 수 없습니다.');
    }
  }, [recorder]);

  // 녹음을 종료한 뒤 로컬 오프라인 엔진으로 전사하고 파일 저장소에 저장한다.
  const handleStopRecording = useCallback(async () => {
    if (!draftSessionRef.current) {
      return;
    }

    setIsSaving(true);
    setAppError(null);

    try {
      const recordedAudio = await recorder.stopRecording();
      const latestDraft = draftSessionRef.current;

      if (!latestDraft) {
        return;
      }

      const transcriptionPayload = await transcribeRecordedAudio(latestDraft.id, recordedAudio);
      const transcriptionResult = transcriptionPayload.result;
      const completedSession: MeetingSession = {
        ...latestDraft,
        durationMs: transcriptionResult?.durationMs ?? recordedAudio?.durationMs ?? latestDraft.durationMs,
        audioMimeType: recordedAudio?.mimeType ?? latestDraft.audioMimeType,
        speakers: transcriptionResult?.speakers ?? latestDraft.speakers,
        segments: transcriptionResult?.segments ?? latestDraft.segments,
        updatedAt: new Date().toISOString()
      };

      const savedSession = await window.meetingRecorder.saveSession({
        session: completedSession,
        audioData: transcriptionPayload.audioData,
        audioMimeType: recordedAudio?.mimeType
      });

      setDraftSession(null);
      setSelectedSession(savedSession);
      await refreshSessions();

      if (transcriptionPayload.error) {
        setAppError(`오디오는 저장됐지만 전사 엔진 실행에 실패했습니다.\n${transcriptionPayload.error}`);
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '회의 저장에 실패했습니다.');
    } finally {
      setIsSaving(false);
    }
  }, [recorder, refreshSessions]);

  // 저장된 회의의 화자명은 파일에 반영하고, 녹음 중 초안은 메모리만 수정한다.
  const handleRenameSpeaker = useCallback(
    async (speakerId: string, name: string) => {
      const normalizedName = name.trim();

      if (!normalizedName) {
        return;
      }

      if (draftSessionRef.current) {
        setDraftSession((currentSession) =>
          currentSession
            ? {
                ...currentSession,
                speakers: currentSession.speakers.map((speaker) =>
                  speaker.id === speakerId ? { ...speaker, name: normalizedName } : speaker
                )
              }
            : currentSession
        );
        return;
      }

      if (!selectedSession) {
        return;
      }

      try {
        const updatedSession = await window.meetingRecorder.updateSpeakerName({
          sessionId: selectedSession.id,
          speakerId,
          name: normalizedName
        });
        setSelectedSession(updatedSession);
        await refreshSessions();
      } catch (error) {
        setAppError(error instanceof Error ? error.message : '화자명을 저장하지 못했습니다.');
      }
    },
    [refreshSessions, selectedSession]
  );

  // 선택된 회의의 텍스트 회의록을 사용자가 고른 위치로 저장한다.
  const handleExportTranscript = useCallback(async () => {
    if (!selectedSession) {
      return;
    }

    try {
      await window.meetingRecorder.exportTranscript(selectedSession.id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '회의록 내보내기에 실패했습니다.');
    }
  }, [selectedSession]);

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandBlock">
          <span className="brandMark" />
          <div>
            <h1>회의 속기록</h1>
            <p>Meeting Recorder</p>
          </div>
        </div>
        <SessionList
          activeSessionId={activeSession?.id}
          disabled={recorder.status === 'recording'}
          sessions={sessions}
          onSelect={handleSelectSession}
        />
      </aside>

      <main className="workspace">
        <RecorderPanel
          elapsedMs={recorder.elapsedMs}
          error={appError ?? recorder.error}
          status={visibleStatus}
          onStart={handleStartRecording}
          onStop={handleStopRecording}
        />

        <section className="contentGrid">
          <TranscriptPanel
            session={activeSession}
            onExport={selectedSession && !draftSession ? handleExportTranscript : undefined}
          />
          <SpeakerEditor
            disabled={!activeSession}
            session={activeSession}
            onRename={handleRenameSpeaker}
          />
        </section>
      </main>
    </div>
  );
}
