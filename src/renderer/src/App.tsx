import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MeetingSession,
  MeetingSessionSummary,
  RecordingStatus,
  SessionDetailsUpdateRequest,
  SpeakerProfile,
  TranscriptSegment,
  TranscriptionInferenceMode,
  TranscriptionProgressEvent
} from '../../shared/types';
import { buildTranscriptText } from '../../shared/transcriptFormatter';
import { RecorderPanel } from './components/RecorderPanel';
import { ProcessingSettingsPanel } from './components/ProcessingSettingsPanel';
import { SessionList } from './components/SessionList';
import { SessionManagementPanel } from './components/SessionManagementPanel';
import { SpeakerEditor } from './components/SpeakerEditor';
import { TranscriptPanel } from './components/TranscriptPanel';
import {
  TranscriptionReviewPanel,
  type TranscriptionReviewChoice,
  type TranscriptionReviewItem
} from './components/TranscriptionReviewPanel';
import { type RecordedAudio, type RecorderInputSource, type RecorderSettings, useRecorder } from './hooks/useRecorder';
import { createDraftMeetingSession } from './services/meetingFactory';
import { transcribeRecordedAudio } from './services/offlineTranscription';

// 전사용 오디오 청크는 5초 단위로 만들어지고, UI 루프는 준비된 청크가 있는지만 가볍게 확인한다.
const LIVE_PREVIEW_INITIAL_DELAY_MS = 1_000;
const LIVE_PREVIEW_INTERVAL_MS = 1_000;
const LIVE_PREVIEW_STOP_DRAIN_POLL_MS = 250;
const DEFAULT_PREVIEW_WORKER_COUNT = 2;
const MIN_PREVIEW_WORKER_COUNT = 1;
const MAX_PREVIEW_WORKER_COUNT = 8;
const PREVIEW_SEGMENT_ID_PREFIX = 'preview';
const PREVIEW_WORKER_COUNT_STORAGE_KEY = 'meetingRecorder.previewWorkerCount';
const DEFAULT_TRANSCRIPTION_INFERENCE_MODE: TranscriptionInferenceMode = 'literal';
const FINAL_REPROCESS_INFERENCE_MODE: TranscriptionInferenceMode = 'contextual';
const TRANSCRIPTION_INFERENCE_MODE_STORAGE_KEY = 'meetingRecorder.transcriptionInferenceMode';

interface LivePreviewQueueItem {
  snapshot: RecordedAudio;
  snapshotEndMs: number;
}

interface TranscriptionReviewState {
  baseSession: MeetingSession;
  refinedSession: MeetingSession;
  items: TranscriptionReviewItem[];
  choices: Record<string, TranscriptionReviewChoice>;
}

interface LivePreviewQueueStats {
  pendingCount: number;
  activeCount: number;
  maxParallel: number;
}

interface LivePreviewWorkStats {
  pendingCount: number;
  activeCount: number;
  markerCount: number;
}

type StopRecordingChoice = 'drain' | 'immediate';

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

function mergeSpeakers(currentSpeakers: SpeakerProfile[], nextSpeakers: SpeakerProfile[]): SpeakerProfile[] {
  const speakerMap = new Map(currentSpeakers.map((speaker) => [speaker.id, speaker]));

  for (const speaker of nextSpeakers) {
    if (!speakerMap.has(speaker.id)) {
      speakerMap.set(speaker.id, speaker);
    }
  }

  return [...speakerMap.values()];
}

function createContiguousPreviewQueueItem(
  snapshot: RecordedAudio,
  lastQueuedEndMs: number
): LivePreviewQueueItem | null {
  const snapshotStartMs = Math.max(0, Math.round(snapshot.startOffsetMs ?? 0));
  const snapshotEndMs = snapshotStartMs + Math.max(1, Math.round(snapshot.durationMs));

  if (lastQueuedEndMs <= 0) {
    return {
      snapshot: {
        ...snapshot,
        startOffsetMs: snapshotStartMs,
        durationMs: snapshotEndMs - snapshotStartMs
      },
      snapshotEndMs
    };
  }

  if (snapshotEndMs <= lastQueuedEndMs) {
    return null;
  }

  return {
    snapshot: {
      ...snapshot,
      startOffsetMs: lastQueuedEndMs,
      durationMs: snapshotEndMs - lastQueuedEndMs
    },
    snapshotEndMs
  };
}

function createTranscriptionReviewState(
  baseSession: MeetingSession,
  refinedSession: MeetingSession
): TranscriptionReviewState {
  const usedOriginalIds = new Set<string>();
  const originalSegments = [...baseSession.segments].sort(compareSegments);
  const refinedSegments = [...refinedSession.segments].sort(compareSegments);
  const items: TranscriptionReviewItem[] = [];

  refinedSegments.forEach((refinedSegment, index) => {
    const originalMatches = originalSegments.filter(
      (segment) => !usedOriginalIds.has(segment.id) && segmentsOverlap(segment, refinedSegment)
    );

    originalMatches.forEach((segment) => usedOriginalIds.add(segment.id));
    items.push({
      id: `review-refined-${index}`,
      startMs: Math.min(refinedSegment.startMs, ...originalMatches.map((segment) => segment.startMs)),
      endMs: Math.max(refinedSegment.endMs, ...originalMatches.map((segment) => segment.endMs)),
      originalSegments: originalMatches,
      refinedSegments: [refinedSegment]
    });
  });

  originalSegments
    .filter((segment) => !usedOriginalIds.has(segment.id))
    .forEach((segment, index) => {
      items.push({
        id: `review-original-${index}`,
        startMs: segment.startMs,
        endMs: segment.endMs,
        originalSegments: [segment],
        refinedSegments: []
      });
    });

  items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));

  return {
    baseSession,
    refinedSession,
    items,
    choices: Object.fromEntries(
      items.map((item) => [item.id, item.refinedSegments.length > 0 ? 'refined' : 'original'])
    )
  };
}

function buildReviewedSession(review: TranscriptionReviewState): MeetingSession {
  const speakerMap = new Map([
    ...review.baseSession.speakers.map((speaker) => [speaker.id, speaker] as const),
    ...review.refinedSession.speakers.map((speaker) => [speaker.id, speaker] as const)
  ]);
  const segments = review.items
    .flatMap((item) => (review.choices[item.id] === 'original' ? item.originalSegments : item.refinedSegments))
    .sort(compareSegments);
  const selectedSpeakerIds = new Set(segments.map((segment) => segment.speakerId));
  const speakers = [...selectedSpeakerIds]
    .map((speakerId) => speakerMap.get(speakerId))
    .filter((speaker): speaker is SpeakerProfile => Boolean(speaker));
  const reviewedSession: MeetingSession = {
    ...review.baseSession,
    durationMs: Math.max(review.baseSession.durationMs, review.refinedSession.durationMs),
    speakers: speakers.length > 0 ? speakers : review.baseSession.speakers,
    segments,
    updatedAt: new Date().toISOString()
  };

  return {
    ...reviewedSession,
    transcriptText: buildTranscriptText(reviewedSession)
  };
}

function compareSegments(a: TranscriptSegment, b: TranscriptSegment): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id);
}

function segmentsOverlap(left: TranscriptSegment, right: TranscriptSegment): boolean {
  return Math.min(left.endMs, right.endMs) > Math.max(left.startMs, right.startMs);
}

function createIdlePreviewWorkerProgress(sessionId: string, workerIndex: number): TranscriptionProgressEvent {
  return {
    sessionId,
    mode: 'preview',
    stage: 'prepare',
    progress: 0,
    message: '대기 중',
    workerId: `preview-${workerIndex + 1}`,
    workerLabel: `미리보기 ${workerIndex + 1}`
  };
}

function normalizePreviewWorkerCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PREVIEW_WORKER_COUNT;
  }

  return Math.max(MIN_PREVIEW_WORKER_COUNT, Math.min(MAX_PREVIEW_WORKER_COUNT, Math.round(value)));
}

function readStoredPreviewWorkerCount(): number {
  try {
    const rawValue = window.localStorage.getItem(PREVIEW_WORKER_COUNT_STORAGE_KEY);

    if (rawValue === null) {
      return DEFAULT_PREVIEW_WORKER_COUNT;
    }

    return normalizePreviewWorkerCount(Number(rawValue));
  } catch {
    return DEFAULT_PREVIEW_WORKER_COUNT;
  }
}

function writeStoredPreviewWorkerCount(value: number): void {
  try {
    window.localStorage.setItem(PREVIEW_WORKER_COUNT_STORAGE_KEY, String(normalizePreviewWorkerCount(value)));
  } catch {
    // 설정 저장 실패는 녹음/전사 동작을 막지 않는다.
  }
}

function normalizeTranscriptionInferenceMode(value: unknown): TranscriptionInferenceMode {
  return value === 'contextual' || value === 'literal' ? value : DEFAULT_TRANSCRIPTION_INFERENCE_MODE;
}

function readStoredTranscriptionInferenceMode(): TranscriptionInferenceMode {
  try {
    return normalizeTranscriptionInferenceMode(window.localStorage.getItem(TRANSCRIPTION_INFERENCE_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_TRANSCRIPTION_INFERENCE_MODE;
  }
}

function writeStoredTranscriptionInferenceMode(value: TranscriptionInferenceMode): void {
  try {
    window.localStorage.setItem(TRANSCRIPTION_INFERENCE_MODE_STORAGE_KEY, normalizeTranscriptionInferenceMode(value));
  } catch {
    // 설정 저장 실패는 녹음/전사 동작을 막지 않는다.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
  const selectedSessionRef = useRef<MeetingSession | null>(null);
  const recordingStatusRef = useRef<RecordingStatus>(recordingStatus);
  const livePreviewRunIdRef = useRef(0);
  const livePreviewInFlightCountRef = useRef(0);
  const livePreviewSnapshotInFlightCountRef = useRef(0);
  const livePreviewLastQueuedEndRef = useRef(0);
  const livePreviewAcceptingSnapshotsRef = useRef(false);
  const livePreviewDrainAfterStopRef = useRef(false);
  const livePreviewProgressEnabledRef = useRef(false);
  const livePreviewQueueRef = useRef<LivePreviewQueueItem[]>([]);
  const stopRecordingPromptResolveRef = useRef<((choice: StopRecordingChoice) => void) | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentPlaybackTimeoutRef = useRef<number | null>(null);
  const [sessions, setSessions] = useState<MeetingSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<MeetingSession | null>(null);
  const [draftSession, setDraftSession] = useState<MeetingSession | null>(null);
  const [stopRequestedElapsedMs, setStopRequestedElapsedMs] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isStoppingAfterLivePreviewDrain, setIsStoppingAfterLivePreviewDrain] = useState(false);
  const [isLivePreviewing, setIsLivePreviewing] = useState(false);
  const [recorderSettings, setRecorderSettings] = useState<RecorderSettings>({
    sensitivity: 1.8,
    captureDistantSpeech: true,
    inputSource: 'microphone',
    liveTranscriptionEnabled: false,
    expectedSpeakerCount: 0,
    previewWorkerCount: readStoredPreviewWorkerCount(),
    transcriptionInferenceMode: readStoredTranscriptionInferenceMode()
  });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const [livePreviewProgress, setLivePreviewProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [livePreviewQueueStats, setLivePreviewQueueStats] = useState<LivePreviewQueueStats>({
    pendingCount: 0,
    activeCount: 0,
    maxParallel: DEFAULT_PREVIEW_WORKER_COUNT
  });
  const [livePreviewWorkerProgress, setLivePreviewWorkerProgress] = useState<Record<string, TranscriptionProgressEvent>>(
    {}
  );
  const [finalTranscriptionProgress, setFinalTranscriptionProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [transcriptionReview, setTranscriptionReview] = useState<TranscriptionReviewState | null>(null);
  const [stopRecordingPrompt, setStopRecordingPrompt] = useState<LivePreviewWorkStats | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  const activeSession = draftSession ?? selectedSession;
  const isBusy = isSaving || isReprocessing || isStoppingAfterLivePreviewDrain;
  const visibleStatus: RecordingStatus = isBusy ? 'saving' : recordingStatus;
  const previewWorkerCount = normalizePreviewWorkerCount(recorderSettings.previewWorkerCount);
  const transcriptionInferenceMode = normalizeTranscriptionInferenceMode(recorderSettings.transcriptionInferenceMode);
  const previewWorkerProgressList = Array.from({ length: previewWorkerCount }, (_unused, index) => {
    const workerId = `preview-${index + 1}`;
    return livePreviewWorkerProgress[workerId] ?? createIdlePreviewWorkerProgress(activeSession?.id ?? '', index);
  });

  const syncLivePreviewQueueStats = useCallback(() => {
    setLivePreviewQueueStats({
      pendingCount: livePreviewQueueRef.current.length,
      activeCount: livePreviewInFlightCountRef.current,
      maxParallel: previewWorkerCount
    });
  }, [previewWorkerCount]);

  useEffect(() => {
    syncLivePreviewQueueStats();
  }, [syncLivePreviewQueueStats]);

  const getLivePreviewWorkStats = useCallback(
    (): LivePreviewWorkStats => ({
      pendingCount: livePreviewQueueRef.current.length,
      activeCount: livePreviewInFlightCountRef.current,
      markerCount: livePreviewSnapshotInFlightCountRef.current
    }),
    []
  );

  const hasLivePreviewWork = useCallback((stats: LivePreviewWorkStats): boolean => {
    return stats.pendingCount > 0 || stats.activeCount > 0 || stats.markerCount > 0;
  }, []);

  const requestStopRecordingChoice = useCallback((stats: LivePreviewWorkStats): Promise<StopRecordingChoice> => {
    return new Promise((resolve) => {
      stopRecordingPromptResolveRef.current = resolve;
      setStopRecordingPrompt(stats);
    });
  }, []);

  const resolveStopRecordingPrompt = useCallback((choice: StopRecordingChoice): void => {
    stopRecordingPromptResolveRef.current?.(choice);
    stopRecordingPromptResolveRef.current = null;
    setStopRecordingPrompt(null);
  }, []);

  const discardLivePreviewWork = useCallback(() => {
    livePreviewAcceptingSnapshotsRef.current = false;
    livePreviewDrainAfterStopRef.current = false;
    livePreviewProgressEnabledRef.current = false;
    livePreviewRunIdRef.current += 1;
    livePreviewQueueRef.current = [];
    livePreviewInFlightCountRef.current = 0;
    livePreviewSnapshotInFlightCountRef.current = 0;
    livePreviewLastQueuedEndRef.current = 0;
    syncLivePreviewQueueStats();
    setLivePreviewWorkerProgress({});
    setIsLivePreviewing(false);
    setLivePreviewProgress(null);
  }, [syncLivePreviewQueueStats]);

  const isLivePreviewRunUsable = useCallback((runId: number): boolean => {
    return (
      livePreviewRunIdRef.current === runId &&
      (recordingStatusRef.current === 'recording' || livePreviewDrainAfterStopRef.current)
    );
  }, []);

  useEffect(() => {
    draftSessionRef.current = draftSession;
  }, [draftSession]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

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
      const currentSelected = selectedSessionRef.current;

      if (currentDraft?.id !== progress.sessionId && currentSelected?.id !== progress.sessionId) {
        return;
      }

      if (progress.mode === 'preview') {
        if (!livePreviewProgressEnabledRef.current) {
          return;
        }

        setLivePreviewProgress(progress);

        if (progress.workerId) {
          setLivePreviewWorkerProgress((currentProgress) => ({
            ...currentProgress,
            [progress.workerId as string]: progress
          }));
        }

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

  const processLivePreviewQueueItem = useCallback(
    async (sessionId: string, runId: number, queuedPreview: LivePreviewQueueItem) => {
      setIsLivePreviewing(true);
      setLivePreviewProgress({
        sessionId,
        mode: 'preview',
        stage: 'transcribe',
        progress: 0,
        message: '실시간 전사 작업 시작'
      });

      try {
        const expectedSpeakerCount = recorderSettings.expectedSpeakerCount;
        const speakerOptions =
          expectedSpeakerCount > 0
            ? {
                minSpeakers: expectedSpeakerCount,
                maxSpeakers: expectedSpeakerCount
              }
            : {};
        const payload = await transcribeRecordedAudio(sessionId, queuedPreview.snapshot, {
          mode: 'preview',
          includeAudioData: false,
          previewWorkerCount,
          transcriptionInferenceMode,
          ...speakerOptions
        });
        const previewResult = payload.result;

        if (
          payload.error &&
          isLivePreviewRunUsable(runId)
        ) {
          setAppError(`실시간 전사에 실패했습니다.\n${payload.error}`);
        }

        if (
          !previewResult ||
          !isLivePreviewRunUsable(runId)
        ) {
          return;
        }

        setDraftSession((currentSession) => {
          if (!currentSession || currentSession.id !== sessionId) {
            return currentSession;
          }

          const hasPreviewSegments = previewResult.segments.length > 0;
          const previewStartMs = Math.max(0, Math.round(queuedPreview.snapshot.startOffsetMs ?? 0));
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
            durationMs: Math.max(currentSession.durationMs, queuedPreview.snapshotEndMs),
            speakers: hasPreviewSegments
              ? mergeSpeakers(currentSession.speakers, previewResult.speakers)
              : currentSession.speakers,
            segments: nextSegments,
            updatedAt: new Date().toISOString()
          };

          return {
            ...nextSession,
            transcriptText: hasPreviewSegments ? buildTranscriptText(nextSession) : currentSession.transcriptText
          };
        });
      } finally {
        if (livePreviewRunIdRef.current === runId) {
          livePreviewInFlightCountRef.current = Math.max(0, livePreviewInFlightCountRef.current - 1);
          syncLivePreviewQueueStats();

          const hasPendingPreview =
            livePreviewInFlightCountRef.current > 0 || livePreviewQueueRef.current.length > 0;
          setIsLivePreviewing(hasPendingPreview);

          if (!hasPendingPreview) {
            setLivePreviewProgress(null);
          }
        }
      }
    },
    [
      isLivePreviewRunUsable,
      previewWorkerCount,
      recorderSettings.expectedSpeakerCount,
      syncLivePreviewQueueStats,
      transcriptionInferenceMode
    ]
  );

  const drainLivePreviewQueue = useCallback(
    (sessionId: string, runId: number) => {
      while (
        livePreviewInFlightCountRef.current < previewWorkerCount &&
        livePreviewQueueRef.current.length > 0 &&
        isLivePreviewRunUsable(runId)
      ) {
        const queuedPreview = livePreviewQueueRef.current.shift();

        if (!queuedPreview) {
          return;
        }

        livePreviewInFlightCountRef.current += 1;
        syncLivePreviewQueueStats();
        void processLivePreviewQueueItem(sessionId, runId, queuedPreview);
      }
    },
    [isLivePreviewRunUsable, previewWorkerCount, processLivePreviewQueueItem, syncLivePreviewQueueStats]
  );

  const waitForLivePreviewWorkToSettle = useCallback(
    async (sessionId: string, runId: number) => {
      while (isLivePreviewRunUsable(runId)) {
        drainLivePreviewQueue(sessionId, runId);

        const stats = getLivePreviewWorkStats();

        if (!hasLivePreviewWork(stats)) {
          return;
        }

        setIsLivePreviewing(true);
        setLivePreviewProgress({
          sessionId,
          mode: 'preview',
          stage: 'transcribe',
          progress: 0,
          message: `남은 실시간 전사 처리 중 · 대기 ${stats.pendingCount}개 · 처리 ${stats.activeCount}/${previewWorkerCount}`
        });
        await delay(LIVE_PREVIEW_STOP_DRAIN_POLL_MS);
      }
    },
    [drainLivePreviewQueue, getLivePreviewWorkStats, hasLivePreviewWork, isLivePreviewRunUsable, previewWorkerCount]
  );

  // 녹음 파일의 시간 marker만 큐에 넣고, 메인 프로세스가 해당 구간을 잘라 전사한다.
  const runLivePreview = useCallback(
    async (sessionId: string, runId: number) => {
      if (recordingStatusRef.current !== 'recording') {
        return;
      }

      if (livePreviewAcceptingSnapshotsRef.current) {
        livePreviewSnapshotInFlightCountRef.current += 1;

        try {
          const snapshot = await createRecordingSnapshot();

          if (
            snapshot &&
            livePreviewAcceptingSnapshotsRef.current &&
            livePreviewRunIdRef.current === runId &&
            recordingStatusRef.current === 'recording'
          ) {
            const queueItem = createContiguousPreviewQueueItem(snapshot, livePreviewLastQueuedEndRef.current);

            if (queueItem) {
              livePreviewQueueRef.current.push(queueItem);
              livePreviewLastQueuedEndRef.current = queueItem.snapshotEndMs;
              syncLivePreviewQueueStats();
            }
          }
        } finally {
          if (livePreviewRunIdRef.current === runId) {
            livePreviewSnapshotInFlightCountRef.current = Math.max(
              0,
              livePreviewSnapshotInFlightCountRef.current - 1
            );
          }
          syncLivePreviewQueueStats();
        }
      }

      drainLivePreviewQueue(sessionId, runId);
    },
    [createRecordingSnapshot, drainLivePreviewQueue, syncLivePreviewQueueStats]
  );

  useEffect(() => {
    if (recordingStatus !== 'recording' || !draftSession?.id || !recorderSettings.liveTranscriptionEnabled) {
      return;
    }

    const runId = livePreviewRunIdRef.current + 1;
    const sessionId = draftSession.id;

    livePreviewRunIdRef.current = runId;
    livePreviewLastQueuedEndRef.current = 0;
    livePreviewQueueRef.current = [];
    livePreviewInFlightCountRef.current = 0;
    livePreviewSnapshotInFlightCountRef.current = 0;
    livePreviewAcceptingSnapshotsRef.current = true;
    livePreviewProgressEnabledRef.current = true;
    setLivePreviewWorkerProgress({});
    syncLivePreviewQueueStats();

    const requestPreview = () => {
      void runLivePreview(sessionId, runId);
    };
    const initialTimerId = window.setTimeout(requestPreview, LIVE_PREVIEW_INITIAL_DELAY_MS);
    const intervalTimerId = window.setInterval(requestPreview, LIVE_PREVIEW_INTERVAL_MS);

    return () => {
      window.clearTimeout(initialTimerId);
      window.clearInterval(intervalTimerId);
      livePreviewAcceptingSnapshotsRef.current = false;

      if (livePreviewDrainAfterStopRef.current) {
        syncLivePreviewQueueStats();
        return;
      }

      livePreviewProgressEnabledRef.current = false;
      livePreviewRunIdRef.current += 1;
      livePreviewQueueRef.current = [];
      livePreviewLastQueuedEndRef.current = 0;
      livePreviewInFlightCountRef.current = 0;
      livePreviewSnapshotInFlightCountRef.current = 0;
      setLivePreviewWorkerProgress({});
      syncLivePreviewQueueStats();
      setIsLivePreviewing(false);
      setLivePreviewProgress(null);
    };
  }, [
    draftSession?.id,
    recorderSettings.liveTranscriptionEnabled,
    recordingStatus,
    runLivePreview,
    syncLivePreviewQueueStats
  ]);

  // 목록에서 선택한 회의의 상세 데이터를 불러온다.
  const handleSelectSession = useCallback(
    async (id: string) => {
      if (recordingStatus === 'recording') {
        return;
      }

      const session = await window.meetingRecorder.getSession(id);
      setTranscriptionReview(null);
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

  const handlePreviewWorkerCountChange = useCallback((previewWorkerCount: number) => {
    const normalizedPreviewWorkerCount = normalizePreviewWorkerCount(previewWorkerCount);
    writeStoredPreviewWorkerCount(normalizedPreviewWorkerCount);
    setRecorderSettings((currentSettings) => ({
      ...currentSettings,
      previewWorkerCount: normalizedPreviewWorkerCount
    }));
  }, []);

  const handleTranscriptionInferenceModeChange = useCallback((nextInferenceMode: TranscriptionInferenceMode) => {
    const normalizedInferenceMode = normalizeTranscriptionInferenceMode(nextInferenceMode);
    writeStoredTranscriptionInferenceMode(normalizedInferenceMode);
    setRecorderSettings((currentSettings) => ({
      ...currentSettings,
      transcriptionInferenceMode: normalizedInferenceMode
    }));
  }, []);

  // 마이크 녹음을 시작하고 오프라인 전사용 회의 초안을 만든다.
  const handleStartRecording = useCallback(async () => {
    setAppError(null);
    setStopRequestedElapsedMs(null);
    setLivePreviewProgress(null);
    setFinalTranscriptionProgress(null);
    setTranscriptionReview(null);

    try {
      const nextSession = createDraftMeetingSession();
      await startRecording(recorderSettings, nextSession.id);
      setSelectedSession(null);
      setDraftSession(nextSession);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '녹음을 시작할 수 없습니다.');
    }
  }, [recorderSettings, startRecording]);

  // 녹음을 종료하면 실시간 미리보기 내용 그대로 저장하고, 최종 고품질 보정은 사용자가 나중에 시작한다.
  const handleStopRecording = useCallback(async () => {
    const currentDraft = draftSessionRef.current;

    if (!currentDraft || isBusy) {
      return;
    }

    let shouldPreserveLivePreviewQueue = false;

    try {
      if (recorderSettings.liveTranscriptionEnabled) {
        livePreviewAcceptingSnapshotsRef.current = false;
      }

      const previewWorkStats = getLivePreviewWorkStats();
      const shouldAskHowToHandlePreviewWork =
        recorderSettings.liveTranscriptionEnabled && hasLivePreviewWork(previewWorkStats);
      const runId = livePreviewRunIdRef.current;

      shouldPreserveLivePreviewQueue = shouldAskHowToHandlePreviewWork;
      livePreviewDrainAfterStopRef.current = shouldPreserveLivePreviewQueue;
      livePreviewProgressEnabledRef.current = shouldPreserveLivePreviewQueue || livePreviewProgressEnabledRef.current;

      setStopRequestedElapsedMs(elapsedMs);
      setIsStoppingAfterLivePreviewDrain(shouldPreserveLivePreviewQueue);
      setIsSaving(!shouldPreserveLivePreviewQueue);
      setAppError(null);
      setFinalTranscriptionProgress(null);

      const recordedAudio = await stopRecording();

      if (shouldAskHowToHandlePreviewWork) {
        const remainingPreviewWorkStats = getLivePreviewWorkStats();
        const stopChoice = hasLivePreviewWork(remainingPreviewWorkStats)
          ? await requestStopRecordingChoice(remainingPreviewWorkStats)
          : 'drain';

        if (stopChoice === 'drain') {
          try {
            await waitForLivePreviewWorkToSettle(currentDraft.id, runId);
          } finally {
            setIsStoppingAfterLivePreviewDrain(false);
          }
        } else {
          discardLivePreviewWork();
        }
      }

      setIsSaving(true);
      setLivePreviewProgress(null);
      const latestDraft = draftSessionRef.current;

      if (!latestDraft) {
        discardLivePreviewWork();
        return;
      }

      const resultSession: MeetingSession = {
        ...latestDraft,
        durationMs: recordedAudio?.durationMs ?? latestDraft.durationMs,
        audioMimeType: recordedAudio?.mimeType ?? latestDraft.audioMimeType,
        updatedAt: new Date().toISOString()
      };
      const completedSession: MeetingSession = {
        ...resultSession,
        transcriptText: buildTranscriptText(resultSession),
        memo: latestDraft.memo
      };

      const savedSession = await window.meetingRecorder.saveSession({
        session: completedSession,
        audioRecordingId: recordedAudio?.recordingId,
        audioMimeType: recordedAudio?.mimeType
      });

      setDraftSession(null);
      setSelectedSession(savedSession);
      discardLivePreviewWork();
      await refreshSessions();

    } catch (error) {
      if (shouldPreserveLivePreviewQueue) {
        discardLivePreviewWork();
      }

      setAppError(error instanceof Error ? error.message : '회의 저장에 실패했습니다.');
    } finally {
      livePreviewDrainAfterStopRef.current = false;
      setIsStoppingAfterLivePreviewDrain(false);
      setIsSaving(false);
      setFinalTranscriptionProgress(null);
    }
  }, [
    discardLivePreviewWork,
    elapsedMs,
    getLivePreviewWorkStats,
    hasLivePreviewWork,
    isBusy,
    recorderSettings.liveTranscriptionEnabled,
    refreshSessions,
    requestStopRecordingChoice,
    stopRecording,
    waitForLivePreviewWorkToSettle
  ]);

  const handleStartReprocess = useCallback(async () => {
    const session = selectedSessionRef.current;

    if (!session?.audioFileName) {
      setAppError('최종 보정할 녹음 파일이 없습니다.');
      return;
    }

    setIsReprocessing(true);
    setAppError(null);
    setTranscriptionReview(null);
    setFinalTranscriptionProgress({
      sessionId: session.id,
      mode: 'final',
      stage: 'prepare',
      progress: 0,
      message: '최종 고품질 보정 준비 중'
    });

    try {
      const expectedSpeakerCount = recorderSettings.expectedSpeakerCount;
      const speakerOptions =
        expectedSpeakerCount > 0
          ? {
              minSpeakers: expectedSpeakerCount,
              maxSpeakers: expectedSpeakerCount
            }
          : {};
      const result = await window.meetingRecorder.transcribeSessionAudio({
        sessionId: session.id,
        transcriptionInferenceMode: FINAL_REPROCESS_INFERENCE_MODE,
        ...speakerOptions
      });
      const refinedSession: MeetingSession = {
        ...session,
        durationMs: result.durationMs ?? session.durationMs,
        speakers: result.speakers,
        segments: result.segments,
        updatedAt: new Date().toISOString(),
        transcriptText: ''
      };
      const nextRefinedSession = {
        ...refinedSession,
        transcriptText: buildTranscriptText(refinedSession)
      };

      setTranscriptionReview(createTranscriptionReviewState(session, nextRefinedSession));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '최종 고품질 보정에 실패했습니다.');
    } finally {
      setIsReprocessing(false);
      setFinalTranscriptionProgress(null);
    }
  }, [recorderSettings.expectedSpeakerCount]);

  const handleChooseReviewItem = useCallback((itemId: string, choice: TranscriptionReviewChoice) => {
    setTranscriptionReview((currentReview) =>
      currentReview
        ? {
            ...currentReview,
            choices: {
              ...currentReview.choices,
              [itemId]: choice
            }
          }
        : currentReview
    );
  }, []);

  const handleChooseAllReviewItems = useCallback((choice: TranscriptionReviewChoice) => {
    setTranscriptionReview((currentReview) =>
      currentReview
        ? {
            ...currentReview,
            choices: Object.fromEntries(
              currentReview.items.map((item) => [
                item.id,
                choice === 'refined' && item.refinedSegments.length === 0 ? 'original' : choice
              ])
            )
          }
        : currentReview
    );
  }, []);

  const handleApplyTranscriptionReview = useCallback(async () => {
    const review = transcriptionReview;

    if (!review) {
      return;
    }

    setIsSaving(true);
    setAppError(null);

    try {
      const reviewedSession = buildReviewedSession(review);
      const savedSession = await window.meetingRecorder.saveSession({
        session: reviewedSession,
        audioMimeType: reviewedSession.audioMimeType
      });
      setSelectedSession(savedSession);
      setTranscriptionReview(null);
      await refreshSessions();
    } catch (error) {
      setAppError(error instanceof Error ? error.message : '최종 보정 결과를 저장하지 못했습니다.');
    } finally {
      setIsSaving(false);
    }
  }, [refreshSessions, transcriptionReview]);

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
        setTranscriptionReview(null);
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
      setTranscriptionReview(null);
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
      {stopRecordingPrompt ? (
        <div className="dialogOverlay" role="presentation">
          <div
            aria-describedby="stopRecordingDialogDescription"
            aria-labelledby="stopRecordingDialogTitle"
            aria-modal="true"
            className="stopRecordingDialog"
            role="dialog"
          >
            <h2 id="stopRecordingDialogTitle">남은 미리보기 전사가 있습니다</h2>
            <p id="stopRecordingDialogDescription">
              대기 {stopRecordingPrompt.pendingCount}개 · 처리 중 {stopRecordingPrompt.activeCount}개
              {stopRecordingPrompt.markerCount > 0 ? ` · 준비 중 ${stopRecordingPrompt.markerCount}개` : ''}
            </p>
            <div className="dialogActions">
              <button className="ghostButton" type="button" onClick={() => resolveStopRecordingPrompt('immediate')}>
                바로 종료
              </button>
              <button className="primaryButton" type="button" onClick={() => resolveStopRecordingPrompt('drain')}>
                처리 후 종료
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
          disabled={recordingStatus === 'recording' || isBusy}
          sessions={sessions}
          onSelect={handleSelectSession}
        />
      </aside>

      <main className="workspace">
        <RecorderPanel
          captureDistantSpeech={recorderSettings.captureDistantSpeech}
          elapsedMs={stopRequestedElapsedMs ?? elapsedMs}
          error={appError ?? recorderError}
          inputLevel={inputLevel}
          inputSource={recorderSettings.inputSource}
          liveTranscriptionEnabled={recorderSettings.liveTranscriptionEnabled}
          expectedSpeakerCount={recorderSettings.expectedSpeakerCount}
          progressPercent={finalTranscriptionProgress?.progress}
          progressMessage={finalTranscriptionProgress?.message}
          processingLabel={
            isStoppingAfterLivePreviewDrain
              ? '미리보기 처리 후 종료 중'
              : isReprocessing
                ? '최종 고품질 보정 중'
                : isSaving
                  ? '저장 중'
                  : undefined
          }
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

        {transcriptionReview ? (
          <TranscriptionReviewPanel
            choices={transcriptionReview.choices}
            disabled={isBusy}
            items={transcriptionReview.items}
            onApply={handleApplyTranscriptionReview}
            onCancel={() => setTranscriptionReview(null)}
            onChoose={handleChooseReviewItem}
            onChooseAll={handleChooseAllReviewItems}
          />
        ) : null}

        <section className="contentGrid">
          <TranscriptPanel
            isLivePreviewing={isLivePreviewing}
            isRecording={recordingStatus === 'recording'}
            showLivePreviewStatus={recordingStatus === 'recording' || isStoppingAfterLivePreviewDrain}
            isRealtimeTranscriptionEnabled={recorderSettings.liveTranscriptionEnabled}
            canPlaySegments={Boolean(audioUrl && selectedSession && !draftSession)}
            memoDisabled={isSaving || isReprocessing || recordingStatus === 'recording'}
            playingSegmentId={playingSegmentId}
            previewProgress={livePreviewProgress}
            previewActiveWorkerCount={livePreviewQueueStats.activeCount}
            previewMaxWorkerCount={livePreviewQueueStats.maxParallel}
            previewQueuePendingCount={livePreviewQueueStats.pendingCount}
            previewWorkerProgress={previewWorkerProgressList}
            session={activeSession}
            onPlaySegment={handlePlaySegment}
            onSegmentMemoChange={handleUpdateSegmentMemo}
            onExport={selectedSession && !draftSession ? handleExportTranscript : undefined}
          />
          <div className="sideStack">
            <ProcessingSettingsPanel
              disabled={recordingStatus === 'recording' || isBusy}
              inferenceMode={transcriptionInferenceMode}
              maxWorkerCount={MAX_PREVIEW_WORKER_COUNT}
              minWorkerCount={MIN_PREVIEW_WORKER_COUNT}
              workerCount={previewWorkerCount}
              onInferenceModeChange={handleTranscriptionInferenceModeChange}
              onWorkerCountChange={handlePreviewWorkerCountChange}
            />
            <SessionManagementPanel
              allowDelete={Boolean(selectedSession && !draftSession && recordingStatus !== 'recording' && !isBusy)}
              canReprocess={Boolean(selectedSession?.audioFileName && !draftSession && recordingStatus !== 'recording')}
              disabled={isBusy}
              isReprocessing={isReprocessing}
              session={activeSession}
              transcriptionProgress={isReprocessing ? finalTranscriptionProgress : null}
              onDeleteSession={handleDeleteSession}
              onExportAudio={handleExportAudio}
              onReprocess={handleStartReprocess}
              onSaveDetails={handleSaveDetails}
            />
            <SpeakerEditor disabled={!activeSession || isBusy} session={activeSession} onRename={handleRenameSpeaker} />
          </div>
        </section>
        <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => setPlayingSegmentId(null)} />
      </main>
    </div>
  );
}
