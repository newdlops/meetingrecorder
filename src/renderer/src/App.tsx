import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MeetingSession,
  MeetingSessionSummary,
  RecordingStatus,
  SessionDetailsUpdateRequest,
  TranscriptSegment,
  TranscriptionProgressEvent
} from '../../shared/types';
import { buildTranscriptText } from '../../shared/transcriptFormatter';
import { RecorderPanel } from './components/RecorderPanel';
import { SessionList } from './components/SessionList';
import { SessionManagementPanel } from './components/SessionManagementPanel';
import { SpeakerEditor } from './components/SpeakerEditor';
import { TranscriptPanel } from './components/TranscriptPanel';
import { type RecorderInputSource, type RecorderSettings, useRecorder } from './hooks/useRecorder';
import { createDraftMeetingSession } from './services/meetingFactory';
import { transcribeRecordedAudio } from './services/offlineTranscription';

// 전사용 오디오 청크는 5초 단위로 만들어지고, UI 루프는 준비된 청크가 있는지만 가볍게 확인한다.
const LIVE_PREVIEW_INITIAL_DELAY_MS = 1_000;
const LIVE_PREVIEW_INTERVAL_MS = 1_000;
const PREVIEW_SEGMENT_ID_PREFIX = 'preview';

function createPreviewSegmentId(previewStartMs: number, segmentId: string): string {
  return `${PREVIEW_SEGMENT_ID_PREFIX}-${previewStartMs}-${segmentId}`;
}

function mergePreviewSegments(
  currentSegments: TranscriptSegment[],
  nextPreviewSegments: TranscriptSegment[]
): TranscriptSegment[] {
  const nextPreviewIds = new Set(nextPreviewSegments.map((segment) => segment.id));

  return [
    ...currentSegments.filter((segment) => !nextPreviewIds.has(segment.id)),
    ...nextPreviewSegments
  ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

// 전체 앱 상태를 조율하고 메인 프로세스 IPC API를 호출한다.
export function App(): JSX.Element {
  const {
    status: recordingStatus,
    elapsedMs,
    inputLevel,
    error: recorderError,
    startRecording,
    stopRecording,
    createRecordingSnapshot,
    setLiveTranscriptionPreviewEnabled,
    updateSensitivity
  } = useRecorder();
  const draftSessionRef = useRef<MeetingSession | null>(null);
  const recordingStatusRef = useRef<RecordingStatus>(recordingStatus);
  const livePreviewRunIdRef = useRef(0);
  const livePreviewInFlightRef = useRef(false);
  const livePreviewActiveRunRef = useRef<number | null>(null);
  const livePreviewLastDurationRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentPlaybackTimeoutRef = useRef<number | null>(null);
  const [sessions, setSessions] = useState<MeetingSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<MeetingSession | null>(null);
  const [draftSession, setDraftSession] = useState<MeetingSession | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLivePreviewing, setIsLivePreviewing] = useState(false);
  const [recorderSettings, setRecorderSettings] = useState<RecorderSettings>({
    sensitivity: 1.8,
    captureDistantSpeech: true,
    inputSource: 'microphone',
    liveTranscriptionEnabled: false,
    expectedSpeakerCount: 0
  });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const [livePreviewProgress, setLivePreviewProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [finalTranscriptionProgress, setFinalTranscriptionProgress] = useState<TranscriptionProgressEvent | null>(null);
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
    let objectUrl: string | null = null;
    let canceled = false;

    setAudioUrl(null);
    setPlayingSegmentId(null);

    if (segmentPlaybackTimeoutRef.current) {
      window.clearTimeout(segmentPlaybackTimeoutRef.current);
      segmentPlaybackTimeoutRef.current = null;
    }

    audioRef.current?.pause();

    if (!selectedSession?.audioFileName || draftSession) {
      return () => undefined;
    }

    window.meetingRecorder
      .getAudioFile(selectedSession.id)
      .then((payload) => {
        if (!payload) {
          return;
        }

        const audioData = payload.audioData instanceof Uint8Array ? payload.audioData : new Uint8Array(payload.audioData);
        objectUrl = URL.createObjectURL(new Blob([audioData], { type: payload.audioMimeType ?? 'audio/webm' }));

        if (canceled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setAudioUrl(objectUrl);
      })
      .catch((error) => {
        if (!canceled) {
          setAppError(error instanceof Error ? error.message : '녹음 파일을 불러오지 못했습니다.');
        }
      });

    return () => {
      canceled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [draftSession, selectedSession?.audioFileName, selectedSession?.id]);

  useEffect(() => {
    return () => {
      if (segmentPlaybackTimeoutRef.current) {
        window.clearTimeout(segmentPlaybackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return window.meetingRecorder.onTranscriptionProgress((progress) => {
      const currentDraft = draftSessionRef.current;

      if (!currentDraft || currentDraft.id !== progress.sessionId) {
        return;
      }

      if (progress.mode === 'preview') {
        setLivePreviewProgress(progress);
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
      const snapshotEndMs = snapshot ? (snapshot.startOffsetMs ?? 0) + snapshot.durationMs : 0;

      if (
        !snapshot ||
        snapshotEndMs <= livePreviewLastDurationRef.current ||
        livePreviewRunIdRef.current !== runId ||
        recordingStatusRef.current !== 'recording'
      ) {
        return;
      }

      livePreviewInFlightRef.current = true;
      livePreviewActiveRunRef.current = runId;
      livePreviewLastDurationRef.current = snapshotEndMs;
      setIsLivePreviewing(true);

      try {
        const payload = await transcribeRecordedAudio(sessionId, snapshot, {
          mode: 'preview',
          includeAudioData: false
        });
        const previewResult = payload.result;

        if (payload.error) {
          setAppError(`실시간 전사에 실패했습니다.\n${payload.error}`);
        }

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
          const previewStartMs = Math.max(0, Math.round(snapshot.startOffsetMs ?? 0));
          const shiftedSegments = previewResult.segments.map((segment) => ({
            ...segment,
            id: createPreviewSegmentId(previewStartMs, segment.id),
            startMs: previewStartMs + segment.startMs,
            endMs: previewStartMs + segment.endMs
          }));
          const nextSegments = hasPreviewSegments
            ? mergePreviewSegments(currentSession.segments, shiftedSegments)
            : currentSession.segments;
          const nextSession: MeetingSession = {
            ...currentSession,
            durationMs: Math.max(currentSession.durationMs, snapshotEndMs),
            speakers: hasPreviewSegments ? previewResult.speakers : currentSession.speakers,
            segments: nextSegments,
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
          setLivePreviewProgress(null);
        }
      }
    },
    [createRecordingSnapshot]
  );

  useEffect(() => {
    if (recordingStatus !== 'recording' || !draftSession?.id || !recorderSettings.liveTranscriptionEnabled) {
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
  }, [draftSession?.id, recorderSettings.liveTranscriptionEnabled, recordingStatus, runLivePreview]);

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

  // 감도 슬라이더 값을 저장하고 녹음 중이면 Web Audio gain에 즉시 반영한다.
  const handleSensitivityChange = useCallback(
    (sensitivity: number) => {
      setRecorderSettings((currentSettings) => ({ ...currentSettings, sensitivity }));
      updateSensitivity(sensitivity);
    },
    [updateSensitivity]
  );

  // 주변음 모드는 멀리 있는 발화가 잘리지 않도록 다음 녹음의 마이크 처리 방식을 바꾼다.
  const handleCaptureDistantSpeechChange = useCallback((captureDistantSpeech: boolean) => {
    setRecorderSettings((currentSettings) => ({ ...currentSettings, captureDistantSpeech }));
  }, []);

  // 테스트 녹음 대상이 되는 입력 소스를 마이크 또는 시스템 오디오로 전환한다.
  const handleInputSourceChange = useCallback((inputSource: RecorderInputSource) => {
    setRecorderSettings((settings) => ({ ...settings, inputSource }));
  }, []);

  // 실시간 전사 모드는 녹음 중 미리보기 청크 전사를 켜고 끈다.
  const handleLiveTranscriptionEnabledChange = useCallback((liveTranscriptionEnabled: boolean) => {
    setRecorderSettings((currentSettings) => ({ ...currentSettings, liveTranscriptionEnabled }));
    setLiveTranscriptionPreviewEnabled(liveTranscriptionEnabled);
    setLivePreviewProgress(null);
  }, [setLiveTranscriptionPreviewEnabled]);

  // 참석자 수를 알 때 최종 화자분리 클러스터 수를 고정해 자동 분리 흔들림을 줄인다.
  const handleExpectedSpeakerCountChange = useCallback((expectedSpeakerCount: number) => {
    setRecorderSettings((currentSettings) => ({ ...currentSettings, expectedSpeakerCount }));
  }, []);

  // 마이크 녹음을 시작하고 오프라인 전사용 회의 초안을 만든다.
  const handleStartRecording = useCallback(async () => {
    setAppError(null);
    setLivePreviewProgress(null);
    setFinalTranscriptionProgress(null);

    try {
      const nextSession = createDraftMeetingSession();
      await startRecording(recorderSettings, nextSession.id);
      setSelectedSession(null);
      setDraftSession(nextSession);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '녹음을 시작할 수 없습니다.');
    }
  }, [recorderSettings, startRecording]);

  // 녹음을 종료한 뒤 로컬 오프라인 엔진으로 전사하고 파일 저장소에 저장한다.
  const handleStopRecording = useCallback(async () => {
    if (!draftSessionRef.current) {
      return;
    }

    setIsSaving(true);
    setAppError(null);
    setLivePreviewProgress(null);
    setFinalTranscriptionProgress(null);

    try {
      const recordedAudio = await stopRecording();
      const latestDraft = draftSessionRef.current;

      if (!latestDraft) {
        return;
      }

      const expectedSpeakerCount = recorderSettings.expectedSpeakerCount;
      const speakerOptions =
        expectedSpeakerCount > 0
          ? {
              minSpeakers: expectedSpeakerCount,
              maxSpeakers: expectedSpeakerCount
            }
          : undefined;
      const transcriptionPayload = await transcribeRecordedAudio(latestDraft.id, recordedAudio, speakerOptions);
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
        audioRecordingId: recordedAudio?.recordingId,
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
  }, [recorderSettings.expectedSpeakerCount, refreshSessions, stopRecording]);

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

  // 선택한 문장 구간만 재생하고 구간 끝에서 자동으로 멈춘다.
  const handlePlaySegment = useCallback(
    (segment: TranscriptSegment) => {
      const audio = audioRef.current;

      if (!audio || !audioUrl) {
        return;
      }

      if (segmentPlaybackTimeoutRef.current) {
        window.clearTimeout(segmentPlaybackTimeoutRef.current);
        segmentPlaybackTimeoutRef.current = null;
      }

      if (playingSegmentId === segment.id && !audio.paused) {
        audio.pause();
        setPlayingSegmentId(null);
        return;
      }

      audio.currentTime = Math.max(0, segment.startMs / 1000);
      setPlayingSegmentId(segment.id);

      const stopDelayMs = Math.max(250, segment.endMs - segment.startMs);
      segmentPlaybackTimeoutRef.current = window.setTimeout(() => {
        audio.pause();
        setPlayingSegmentId(null);
        segmentPlaybackTimeoutRef.current = null;
      }, stopDelayMs);

      void audio.play().catch((error) => {
        if (segmentPlaybackTimeoutRef.current) {
          window.clearTimeout(segmentPlaybackTimeoutRef.current);
          segmentPlaybackTimeoutRef.current = null;
        }

        setPlayingSegmentId(null);
        setAppError(error instanceof Error ? error.message : '문장 재생을 시작하지 못했습니다.');
      });
    },
    [audioUrl, playingSegmentId]
  );

  // 문장별 메모를 초안 또는 저장된 세션에 반영한다.
  const handleUpdateSegmentMemo = useCallback(
    async (segmentId: string, memo: string) => {
      const draft = draftSessionRef.current;

      if (draft) {
        setDraftSession({
          ...draft,
          segments: draft.segments.map((segment) =>
            segment.id === segmentId ? { ...segment, memo } : segment
          ),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      if (!selectedSession) {
        return;
      }

      try {
        const updatedSession = await window.meetingRecorder.updateSegmentMemo({
          sessionId: selectedSession.id,
          segmentId,
          memo
        });
        setSelectedSession(updatedSession);
        await refreshSessions();
      } catch (error) {
        setAppError(error instanceof Error ? error.message : '문장 메모를 저장하지 못했습니다.');
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
          captureDistantSpeech={recorderSettings.captureDistantSpeech}
          elapsedMs={elapsedMs}
          error={appError ?? recorderError}
          inputLevel={inputLevel}
          inputSource={recorderSettings.inputSource}
          liveTranscriptionEnabled={recorderSettings.liveTranscriptionEnabled}
          expectedSpeakerCount={recorderSettings.expectedSpeakerCount}
          progressPercent={finalTranscriptionProgress?.progress}
          isLivePreviewing={isLivePreviewing}
          sensitivity={recorderSettings.sensitivity}
          status={visibleStatus}
          onCaptureDistantSpeechChange={handleCaptureDistantSpeechChange}
          onExpectedSpeakerCountChange={handleExpectedSpeakerCountChange}
          onInputSourceChange={handleInputSourceChange}
          onLiveTranscriptionEnabledChange={handleLiveTranscriptionEnabledChange}
          onSensitivityChange={handleSensitivityChange}
          onStart={handleStartRecording}
          onStop={handleStopRecording}
        />

        <section className="contentGrid">
          <TranscriptPanel
            isLivePreviewing={isLivePreviewing}
            isRecording={recordingStatus === 'recording'}
            isRealtimeTranscriptionEnabled={recorderSettings.liveTranscriptionEnabled}
            canPlaySegments={Boolean(audioUrl && selectedSession && !draftSession)}
            memoDisabled={isSaving || recordingStatus === 'recording'}
            playingSegmentId={playingSegmentId}
            previewProgress={livePreviewProgress}
            session={activeSession}
            onPlaySegment={handlePlaySegment}
            onSegmentMemoChange={handleUpdateSegmentMemo}
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
        <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => setPlayingSegmentId(null)} />
      </main>
    </div>
  );
}
