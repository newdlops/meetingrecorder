import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingStatus } from '../../../shared/types';

export interface RecordedAudio {
  blob?: Blob;
  recordingId?: string;
  durationMs: number;
  mimeType: string;
  startOffsetMs?: number;
}

export type RecorderInputSource = 'microphone' | 'system';

export interface RecorderSettings {
  sensitivity: number;
  captureDistantSpeech: boolean;
  inputSource: RecorderInputSource;
  liveTranscriptionEnabled: boolean;
  expectedSpeakerCount: number;
}

const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const PREVIEW_SEGMENT_MS = 5_000;

// 브라우저 MediaRecorder API를 React 상태로 감싼 녹음 훅이다.
export function useRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const systemRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const previewRecorderRef = useRef<MediaRecorder | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewMimeTypeRef = useRef('');
  const livePreviewEnabledRef = useRef(false);
  const previewChunksRef = useRef<BlobPart[]>([]);
  const latestPreviewRef = useRef<RecordedAudio | null>(null);
  const consumedPreviewKeyRef = useRef('');
  const previewStartedAtRef = useRef(0);
  const recordingIdRef = useRef('');
  const recordingMimeTypeRef = useRef('');
  const chunkWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const levelFrameRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'recording') {
      return;
    }

    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);

    return () => window.clearInterval(timer);
  }, [status]);

  // 현재 Chromium 환경에서 지원하는 오디오 MIME 타입을 고른다.
  const getSupportedMimeType = useCallback((): string => {
    return MIME_TYPE_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
  }, []);

  // 사용자가 조절한 감도 값을 현재 녹음 그래프의 gain에 즉시 반영한다.
  const updateSensitivity = useCallback((nextSensitivity: number): void => {
    const normalizedSensitivity = Math.min(4, Math.max(0.5, nextSensitivity));
    const gainNode = gainNodeRef.current;

    if (gainNode) {
      gainNode.gain.setTargetAtTime(normalizedSensitivity, gainNode.context.currentTime, 0.03);
    }
  }, []);

  // 마이크 입력을 증폭하고 레벨을 측정할 수 있는 Web Audio 그래프로 연결한다.
  const createProcessedStream = useCallback(
    async (stream: MediaStream, settings: RecorderSettings): Promise<MediaStream> => {
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const gainNode = audioContext.createGain();
      const analyserNode = audioContext.createAnalyser();
      const destination = audioContext.createMediaStreamDestination();

      analyserNode.fftSize = 1024;
      gainNode.gain.value = settings.sensitivity;
      source.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(destination);

      audioContextRef.current = audioContext;
      gainNodeRef.current = gainNode;
      analyserNodeRef.current = analyserNode;
      updateSensitivity(settings.sensitivity);
      await audioContext.resume();

      return destination.stream;
    },
    [updateSensitivity]
  );

  // 입력 레벨을 계속 측정해 사용자가 감도 효과를 바로 확인할 수 있게 한다.
  const startInputLevelMeter = useCallback((): void => {
    const analyserNode = analyserNodeRef.current;

    if (!analyserNode) {
      return;
    }

    const samples = new Uint8Array(analyserNode.fftSize);
    const updateLevel = () => {
      analyserNode.getByteTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => {
          const centered = (sample - 128) / 128;
          return sum + centered * centered;
        }, 0) / samples.length
      );

      const nextLevel = Math.min(100, Math.round(rms * 260));
      setInputLevel(nextLevel);
      levelFrameRef.current = window.requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }, []);

  const queueRecordingChunk = useCallback((chunk: Blob): void => {
    const recordingId = recordingIdRef.current;

    if (!recordingId) {
      return;
    }

    chunkWriteQueueRef.current = chunkWriteQueueRef.current
      .then(async () => {
        const audioData = new Uint8Array(await chunk.arrayBuffer());
        await window.meetingRecorder.appendRecordingChunk({ recordingId, audioData });
      })
      .catch((writeError) => {
        const message = writeError instanceof Error ? writeError.message : '녹음 파일을 저장하지 못했습니다.';
        setError(message);
        throw new Error(message);
      });
  }, []);

  const stopPreviewRecorder = useCallback((): void => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }

    if (previewRecorderRef.current?.state === 'recording') {
      previewRecorderRef.current.stop();
    }
  }, []);

  // 실시간 미리보기는 독립 MediaRecorder 조각으로 만들어 중간 WebM 조각 디코딩 문제를 피한다.
  const startPreviewSegment = useCallback((): void => {
    const stream = previewStreamRef.current;

    if (!stream || !livePreviewEnabledRef.current || systemRecordingRef.current) {
      return;
    }

    if (previewRecorderRef.current?.state === 'recording') {
      return;
    }

    const mimeType = previewMimeTypeRef.current || recordingMimeTypeRef.current || 'audio/webm';
    const previewRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const segmentStartedAt = Date.now();

    previewRecorderRef.current = previewRecorder;
    previewStartedAtRef.current = segmentStartedAt;
    previewChunksRef.current = [];

    previewRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        previewChunksRef.current.push(event.data);
      }
    });

    previewRecorder.addEventListener(
      'stop',
      () => {
        if (previewTimerRef.current) {
          window.clearTimeout(previewTimerRef.current);
          previewTimerRef.current = null;
        }

        if (previewRecorderRef.current === previewRecorder) {
          previewRecorderRef.current = null;
        }

        const chunks = previewChunksRef.current;
        previewChunksRef.current = [];

        if (chunks.length > 0 && livePreviewEnabledRef.current) {
          const durationMs = Date.now() - segmentStartedAt;
          latestPreviewRef.current = {
            blob: new Blob(chunks, { type: previewRecorder.mimeType || mimeType }),
            durationMs,
            mimeType: previewRecorder.mimeType || mimeType,
            startOffsetMs: Math.max(0, segmentStartedAt - startedAtRef.current)
          };
        }

        if (livePreviewEnabledRef.current && recorderRef.current?.state === 'recording') {
          window.setTimeout(startPreviewSegment, 0);
        }
      },
      { once: true }
    );

    previewRecorder.start();
    previewTimerRef.current = window.setTimeout(() => {
      if (previewRecorder.state === 'recording') {
        previewRecorder.stop();
      }
    }, PREVIEW_SEGMENT_MS);
  }, []);

  // 녹음 중 실시간 전사 미리보기 청크 생성을 켜거나 끈다.
  const setLiveTranscriptionPreviewEnabled = useCallback(
    (enabled: boolean): void => {
      livePreviewEnabledRef.current = enabled;
      latestPreviewRef.current = null;
      consumedPreviewKeyRef.current = '';
      previewChunksRef.current = [];
      previewStartedAtRef.current = enabled ? Date.now() : 0;

      if (systemRecordingRef.current) {
        void window.meetingRecorder.resetSystemAudioSnapshot();
        return;
      }

      if (!enabled) {
        stopPreviewRecorder();
        return;
      }

      startPreviewSegment();
    },
    [startPreviewSegment, stopPreviewRecorder]
  );

  // 마이크 권한을 요청하고 녹음 품질 옵션을 적용한 입력 스트림을 가져온다.
  const createMicrophoneInputStream = useCallback(async (settings: RecorderSettings): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 환경에서는 마이크 녹음을 사용할 수 없습니다.');
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: !settings.captureDistantSpeech,
        noiseSuppression: !settings.captureDistantSpeech,
        autoGainControl: true
      }
    });
  }, []);

  // 선택된 입력 권한을 요청하고 MediaRecorder 녹음을 시작한다.
  const startRecording = useCallback(async (settings: RecorderSettings, recordingId: string): Promise<void> => {
    setError(null);
    recordingIdRef.current = recordingId;
    recordingMimeTypeRef.current = '';
    chunkWriteQueueRef.current = Promise.resolve();

    try {
      livePreviewEnabledRef.current = settings.liveTranscriptionEnabled;
      previewChunksRef.current = [];
      previewStartedAtRef.current = 0;

      if (settings.inputSource === 'system') {
        await window.meetingRecorder.startRecordingFile({ recordingId, audioMimeType: 'audio/wav' });
        await window.meetingRecorder.startSystemAudioCapture();
        systemRecordingRef.current = true;
        latestPreviewRef.current = null;
        consumedPreviewKeyRef.current = '';
        recordingMimeTypeRef.current = 'audio/wav';
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setInputLevel(0);
        setStatus('recording');
        return;
      }

      const stream = await createMicrophoneInputStream(settings);
      const processedStream = await createProcessedStream(stream, settings);
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(processedStream, mimeType ? { mimeType } : undefined);
      const resolvedMimeType = recorder.mimeType || mimeType || 'audio/webm';

      await window.meetingRecorder.startRecordingFile({ recordingId, audioMimeType: resolvedMimeType });
      streamRef.current = stream;
      previewStreamRef.current = processedStream;
      recorderRef.current = recorder;
      previewMimeTypeRef.current = resolvedMimeType;
      recordingMimeTypeRef.current = resolvedMimeType;
      latestPreviewRef.current = null;
      consumedPreviewKeyRef.current = '';
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setInputLevel(0);

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          queueRecordingChunk(event.data);
        }
      });

      recorder.start(1000);
      startInputLevelMeter();
      setStatus('recording');
      if (settings.liveTranscriptionEnabled) {
        startPreviewSegment();
      }
    } catch (recordingError) {
      if (recordingIdRef.current) {
        void window.meetingRecorder.discardRecordingFile(recordingIdRef.current);
      }

      const message =
        recordingError instanceof Error ? recordingError.message : '녹음 권한을 확인할 수 없습니다.';
      setError(message);
      throw new Error(message);
    }
  }, [
    createMicrophoneInputStream,
    createProcessedStream,
    getSupportedMimeType,
    queueRecordingChunk,
    startPreviewSegment,
    startInputLevelMeter
  ]);

  // 녹음을 멈추고 누적된 오디오 Blob과 녹음 길이를 반환한다.
  const stopRecording = useCallback(async (): Promise<RecordedAudio | null> => {
    if (systemRecordingRef.current) {
      const fallbackDurationMs = Date.now() - startedAtRef.current;
      let resolvedDurationMs = fallbackDurationMs;
      const recordingId = recordingIdRef.current;

      try {
        const result = await window.meetingRecorder.stopSystemAudioCaptureToRecordingFile(recordingId);
        const mimeType = result.audioMimeType || 'audio/wav';
        const durationMs = result.durationMs || fallbackDurationMs;
        resolvedDurationMs = durationMs;

        return {
          recordingId: result.recordingId,
          durationMs,
          mimeType
        };
      } finally {
        systemRecordingRef.current = false;
        latestPreviewRef.current = null;
        consumedPreviewKeyRef.current = '';
        livePreviewEnabledRef.current = false;
        previewStartedAtRef.current = 0;
        previewChunksRef.current = [];
        recordingIdRef.current = '';
        recordingMimeTypeRef.current = '';
        setElapsedMs(resolvedDurationMs);
        setInputLevel(0);
        setStatus('idle');
      }
    }

    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      setStatus('idle');
      return null;
    }

    const durationMs = Date.now() - startedAtRef.current;

    return new Promise((resolve, reject) => {
      recorder.addEventListener(
        'stop',
        async () => {
          try {
            const mimeType = recorder.mimeType || recordingMimeTypeRef.current || getSupportedMimeType() || 'audio/webm';
            const recordingId = recordingIdRef.current;
            stopPreviewRecorder();
            await chunkWriteQueueRef.current;
            const recordingFile = await window.meetingRecorder.completeRecordingFile({
              recordingId,
              audioMimeType: mimeType,
              durationMs
            });

            if (levelFrameRef.current) {
              window.cancelAnimationFrame(levelFrameRef.current);
              levelFrameRef.current = null;
            }

            await audioContextRef.current?.close();
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            previewStreamRef.current = null;
            recorderRef.current = null;
            audioContextRef.current = null;
            gainNodeRef.current = null;
            analyserNodeRef.current = null;
            previewMimeTypeRef.current = '';
            recordingIdRef.current = '';
            recordingMimeTypeRef.current = '';
            livePreviewEnabledRef.current = false;
            previewStartedAtRef.current = 0;
            previewChunksRef.current = [];
            latestPreviewRef.current = null;
            setElapsedMs(durationMs);
            setInputLevel(0);
            setStatus('idle');
            resolve({
              recordingId: recordingFile.recordingId,
              durationMs: recordingFile.durationMs,
              mimeType: recordingFile.audioMimeType
            });
          } catch (error) {
            reject(error);
          }
        },
        { once: true }
      );

      recorder.stop();
    });
  }, [getSupportedMimeType, stopPreviewRecorder]);

  // 녹음을 끊지 않고 가장 최근 5초 미리보기 조각을 전사용 스냅샷으로 꺼낸다.
  const createRecordingSnapshot = useCallback(async (): Promise<RecordedAudio | null> => {
    if (!livePreviewEnabledRef.current) {
      return null;
    }

    if (systemRecordingRef.current) {
      const snapshot = await window.meetingRecorder.createSystemAudioSnapshot();

      if (!snapshot) {
        return null;
      }

      if (!snapshot.audioData) {
        return null;
      }

      const audioBytes =
        snapshot.audioData instanceof Uint8Array ? snapshot.audioData : new Uint8Array(snapshot.audioData);
      const mimeType = snapshot.audioMimeType || 'audio/wav';

      return {
        blob: new Blob([audioBytes], { type: mimeType }),
        durationMs: snapshot.durationMs,
        mimeType,
        startOffsetMs: snapshot.startOffsetMs
      };
    }

    const snapshot = latestPreviewRef.current;

    if (!snapshot) {
      return null;
    }

    if (!snapshot.blob) {
      return null;
    }

    const snapshotKey = `${snapshot.startOffsetMs ?? 0}-${snapshot.durationMs}-${snapshot.blob.size}`;

    if (snapshotKey === consumedPreviewKeyRef.current) {
      return null;
    }

    consumedPreviewKeyRef.current = snapshotKey;
    return snapshot;
  }, []);

  return {
    status,
    elapsedMs,
    inputLevel,
    error,
    startRecording,
    stopRecording,
    createRecordingSnapshot,
    setLiveTranscriptionPreviewEnabled,
    updateSensitivity
  };
}
