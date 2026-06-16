import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MeetingSession,
  MeetingSessionSummary,
  RecordingStatus,
  SessionDetailsUpdateRequest,
  TranscriptionProgressEvent
} from '../../shared/types';
import { buildTranscriptText } from '../../shared/transcriptFormatter';
import { RecorderPanel } from './components/RecorderPanel';
import { SessionList } from './components/SessionList';
import { SessionManagementPanel } from './components/SessionManagementPanel';
import { SpeakerEditor } from './components/SpeakerEditor';
import { TranscriptPanel } from './components/TranscriptPanel';
import { useRecorder } from './hooks/useRecorder';
import { createDraftMeetingSession } from './services/meetingFactory';
import { transcribeRecordedAudio } from './services/offlineTranscription';

// 녹음 안정성을 지키기 위해 5초마다 한 번씩만 미리보기 전사를 요청한다.
const LIVE_PREVIEW_INITIAL_DELAY_MS = 5_000;
const LIVE_PREVIEW_INTERVAL_MS = 5_000;
const LIVE_PREVIEW_MIN_NEW_AUDIO_MS = 5_000;

// 전체 앱 상태를 조율하고 메인 프로세스 IPC API를 호출한다.
export function App(): JSX.Element {
  const {
    status: recordingStatus,
    elapsedMs,
    error: recorderError,
    startRecording,
    stopRecording,
    createRecordingSnapshot
  } = useRecorder();
  const draftSessionRef = useRef<MeetingSession | null>(null);
  const recordingStatusRef = useRef<RecordingStatus>(recordingStatus);
  const livePreviewRunIdRef = useRef(0);
  const livePreviewInFlightRef = useRef(false);
  const livePreviewActiveRunRef = useRef<number | null>(null);
  const livePreviewLastDurationRef = useRef(0);
  const [sessions, setSessions] = useState<MeetingSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<MeetingSession | null>(null);
  const [draftSession, setDraftSession] = useState<MeetingSession | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLivePreviewing, setIsLivePreviewing] = useState(false);
  const [finalTranscriptionProgress, setFinalTranscriptionProgress] =
    useState<TranscriptionProgressEvent | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  const activeSession = draftSession ?? selectedSession;
  const visibleStatus: RecordingStatus = isSaving ? 'saving' : recordingStatus;

  useEffect(() => {
    draftSessionRef.current = draftSession;
  }, [draftSession]);

  useEffect(() => {
    recordingStatusRef.current = recordingStatus;
  }, [recordingStatus]);

  useEffect(() => {
    return window.meetingRecorder.onTranscriptionProgress((progress) => {
      const currentDraft = draftSessionRef.current;

      if (progress.mode !== 'final' || !currentDraft || currentDraft.id !== progress.sessionId) {
        return;
      }

      setFinalTranscriptionProgress(progress);
    });
  }, []);

  // 저장된 회의 목록을 새로 읽는다.
  const refreshSessions = useCallback(async () => {
    const nextSessions = await window.meetingRecorder.listSessions();
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    refreshSessions().catch((error) => setAppError(error.message));
  }, [refreshSessions]);

  // 녹음 파일을 건드리지 않고 현재까지의 복사본만 보내 지연된 전사 미리보기를 갱신한다.
  const runLivePreview = useCallback(
    async (sessionId: string, runId: number) => {
      if (livePreviewInFlightRef.current || recordingStatusRef.current !== 'recording') {
        return;
      }

      const snapshot = await createRecordingSnapshot();
      const hasEnoughAudio =
        snapshot &&
        snapshot.durationMs >= LIVE_PREVIEW_INITIAL_DELAY_MS &&
        snapshot.durationMs - livePreviewLastDurationRef.current >= LIVE_PREVIEW_MIN_NEW_AUDIO_MS;

      if (
        !snapshot ||
        !hasEnoughAudio ||
        livePreviewRunIdRef.current !== runId ||
        recordingStatusRef.current !== 'recording'
      ) {
        return;
      }

      livePreviewInFlightRef.current = true;
      livePreviewActiveRunRef.current = runId;
      livePreviewLastDurationRef.current = snapshot.durationMs;
      setIsLivePreviewing(true);

      try {
        const payload = await transcribeRecordedAudio(sessionId, snapshot, {
          mode: 'preview',
          includeAudioData: false
        });
        const previewResult = payload.result;

        if (
          !previewResult ||
          livePreviewRunIdRef.current !== runId ||
          recordingStatusRef.current !== 'recording'
        ) {
          return;
        }

        setDraftSession((currentSession) => {
          if (!currentSession || currentSession.id !== sessionId) {
            return currentSession;
          }

          const hasPreviewSegments = previewResult.segments.length > 0;
          const nextSession: MeetingSession = {
            ...currentSession,
            durationMs: snapshot.durationMs,
            speakers: hasPreviewSegments ? previewResult.speakers : currentSession.speakers,
            segments: hasPreviewSegments ? previewResult.segments : currentSession.segments,
            updatedAt: new Date().toISOString()
          };

          return {
            ...nextSession,
            transcriptText: hasPreviewSegments ? buildTranscriptText(nextSession) : currentSession.transcriptText
          };
        });
      } finally {
        livePreviewInFlightRef.current = false;

        if (livePreviewActiveRunRef.current === runId) {
          livePreviewActiveRunRef.current = null;
          setIsLivePreviewing(false);
        }
      }
    },
    [createRecordingSnapshot]
  );

  useEffect(() => {
    if (recordingStatus !== 'recording' || !draftSession?.id) {
      return;
    }

    const runId = livePreviewRunIdRef.current + 1;
    const sessionId = draftSession.id;

    livePreviewRunIdRef.current = runId;
    livePreviewLastDurationRef.current = 0;

    const requestPreview = () => {
      void runLivePreview(sessionId, runId);
    };
    const initialTimerId = window.setTimeout(requestPreview, LIVE_PREVIEW_INITIAL_DELAY_MS);
    const intervalTimerId = window.setInterval(requestPreview, LIVE_PREVIEW_INTERVAL_MS);

    return () => {
      window.clearTimeout(initialTimerId);
      window.clearInterval(intervalTimerId);
      livePreviewRunIdRef.current += 1;

      if (livePreviewActiveRunRef.current === runId) {
        livePreviewActiveRunRef.current = null;
        setIsLivePreviewing(false);
      }
    };
  }, [draftSession?.id, recordingStatus, runLivePreview]);

  // 목록에서 선택한 회의의 상세 데이터를 불러온다.
  const handleSelectSession = useCallback(
    async (id: string) => {
      if (recordingStatus === 'recording') {
        return;
      }

      const session = await window.meetingRecorder.getSession(id);
      setDraftSession(null);
      setSelectedSession(session);
    },
    [recordingStatus]
  );

  // 마이크 녹음을 시작하고 오프라인 전사용 회의 초안을 만든다.
  const handleStartRecording = useCallback(async () => {
    setAppError(null);
    setFinalTranscriptionProgress(null);

    try {
      await startRecording();

      const nextSession = createDraftMeetingSession();
      setSelectedSession(null);
      setDraftSession(nextSession);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '녹음을 시작할 수 없습니다.');
    }
  }, [startRecording]);

  // 녹음을 종료한 뒤 로컬 오프라인 엔진으로 전사하고 파일 저장소에 저장한다.
  const handleStopRecording = useCallback(async () => {
    if (!draftSessionRef.current) {
      return;
    }

    setIsSaving(true);
    setAppError(null);
    setFinalTranscriptionProgress(null);

    try {
      const recordedAudio = await stopRecording();
      const latestDraft = draftSessionRef.current;

      if (!latestDraft) {
        return;
      }

      const transcriptionPayload = await transcribeRecordedAudio(latestDraft.id, recordedAudio);
      const transcriptionResult = transcriptionPayload.result;
      const resultSession: MeetingSession = {
        ...latestDraft,
        durationMs: transcriptionResult?.durationMs ?? recordedAudio?.durationMs ?? latestDraft.durationMs,
        audioMimeType: recordedAudio?.mimeType ?? latestDraft.audioMimeType,
        speakers: transcriptionResult?.speakers ?? latestDraft.speakers,
        segments: transcriptionResult?.segments ?? latestDraft.segments,
        updatedAt: new Date().toISOString()
      };
      const completedSession: MeetingSession = {
        ...resultSession,
        transcriptText: transcriptionResult ? buildTranscriptText(resultSession) : latestDraft.transcriptText,
        memo: latestDraft.memo
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
      setFinalTranscriptionProgress(null);
    }
  }, [refreshSessions, stopRecording]);

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

  // 제목, 전사 텍스트, 메모 변경을 초안 또는 저장된 세션에 반영한다.
  const handleSaveDetails = useCallback(
    async (details: Omit<SessionDetailsUpdateRequest, 'sessionId'>) => {
      const draft = draftSessionRef.current;

      if (draft) {
        setDraftSession({
          ...draft,
          title: details.title?.trim() || draft.title,
          transcriptText: details.transcriptText ?? draft.transcriptText,
          memo: details.memo ?? draft.memo,
          updatedAt: new Date().toISOString()
        });
        return;
      }

      if (!selectedSession) {
        return;
      }

      try {
        const updatedSession = await window.meetingRecorder.updateSessionDetails({
          sessionId: selectedSession.id,
          ...details
        });
        setSelectedSession(updatedSession);
        await refreshSessions();
      } catch (error) {
        setAppError(error instanceof Error ? error.message : '회의 정보를 저장하지 못했습니다.');
      }
    },
    [refreshSessions, selectedSession]
  );

  // 선택된 회의의 원본 녹음 파일을 사용자가 고른 위치로 저장한다.
  const handleExportAudio = useCallback(async () => {
    if (!selectedSession) {
      return;
    }

    try {
      await window.meetingRecorder.exportAudio(selectedSession.id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '녹음 파일 내보내기에 실패했습니다.');
    }
  }, [selectedSession]);

  // 저장된 회의 폴더를 삭제하고 목록을 갱신한다.
  const handleDeleteSession = useCallback(async () => {
    if (!selectedSession) {
      return;
    }

    const shouldDelete = window.confirm(`"${selectedSession.title}" 회의를 삭제할까요?`);

    if (!shouldDelete) {
      return;
    }

    try {
      await window.meetingRecorder.deleteSession(selectedSession.id);
      setSelectedSession(null);
      await refreshSessions();
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '회의를 삭제하지 못했습니다.');
    }
  }, [refreshSessions, selectedSession]);

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
          disabled={recordingStatus === 'recording'}
          sessions={sessions}
          onSelect={handleSelectSession}
        />
      </aside>

      <main className="workspace">
        <RecorderPanel
          elapsedMs={elapsedMs}
          error={appError ?? recorderError}
          progressPercent={finalTranscriptionProgress?.progress}
          isLivePreviewing={isLivePreviewing}
          status={visibleStatus}
          onStart={handleStartRecording}
          onStop={handleStopRecording}
        />

        <section className="contentGrid">
          <TranscriptPanel
            session={activeSession}
            onExport={selectedSession && !draftSession ? handleExportTranscript : undefined}
          />
          <div className="sideStack">
            <SessionManagementPanel
              allowDelete={Boolean(selectedSession && !draftSession && recordingStatus !== 'recording' && !isSaving)}
              disabled={isSaving}
              session={activeSession}
              transcriptionProgress={isSaving ? finalTranscriptionProgress : null}
              onDeleteSession={handleDeleteSession}
              onExportAudio={handleExportAudio}
              onSaveDetails={handleSaveDetails}
            />
            <SpeakerEditor disabled={!activeSession || isSaving} session={activeSession} onRename={handleRenameSpeaker} />
          </div>
        </section>
      </main>
    </div>
  );
}
