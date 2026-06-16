import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingStatus } from '../../../shared/types';

export interface RecordedAudio {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  startOffsetMs?: number;
}

export interface RecorderSettings {
  sensitivity: number;
  captureDistantSpeech: boolean;
}

const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const PREVIEW_SEGMENT_MS = 5_000;
// 너무 낮게 잡아 작은 발화는 살리고, 완전 무음/작은 잡음 조각만 전사에서 제외한다.
const MIN_PREVIEW_PEAK_LEVEL = 4;
const MIN_PREVIEW_AVERAGE_LEVEL = 1.2;

// 브라우저 MediaRecorder API를 React 상태로 감싼 녹음 훅이다.
export function useRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const previewRecorderRef = useRef<MediaRecorder | null>(null);
  const previewChunksRef = useRef<BlobPart[]>([]);
  const latestPreviewRef = useRef<RecordedAudio | null>(null);
  const consumedPreviewKeyRef = useRef('');
  const previewStartedAtRef = useRef(0);
  const previewTimerRef = useRef<number | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  const segmentPeakLevelRef = useRef(0);
  const segmentLevelSumRef = useRef(0);
  const segmentLevelCountRef = useRef(0);
  const chunksRef = useRef<BlobPart[]>([]);
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
      segmentPeakLevelRef.current = Math.max(segmentPeakLevelRef.current, nextLevel);
      segmentLevelSumRef.current += nextLevel;
      segmentLevelCountRef.current += 1;
      setInputLevel(nextLevel);
      levelFrameRef.current = window.requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }, []);

  // 녹음 중 미리보기 전사용으로 5초 단위의 독립 오디오 조각을 만든다.
  const startPreviewSegment = useCallback((stream: MediaStream, mimeType: string): void => {
    if (status !== 'recording' && recorderRef.current?.state !== 'recording') {
      return;
    }

    const previewRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    previewRecorderRef.current = previewRecorder;
    previewChunksRef.current = [];
    previewStartedAtRef.current = Date.now();
    segmentPeakLevelRef.current = 0;
    segmentLevelSumRef.current = 0;
    segmentLevelCountRef.current = 0;

    previewRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        previewChunksRef.current.push(event.data);
      }
    });

    previewRecorder.addEventListener(
      'stop',
      () => {
        const chunks = previewChunksRef.current;
        const segmentStartedAt = previewStartedAtRef.current;
        const averageLevel =
          segmentLevelCountRef.current > 0 ? segmentLevelSumRef.current / segmentLevelCountRef.current : 0;
        const hasSpeech =
          segmentPeakLevelRef.current >= MIN_PREVIEW_PEAK_LEVEL ||
          averageLevel >= MIN_PREVIEW_AVERAGE_LEVEL;

        if (chunks.length > 0 && hasSpeech) {
          const segmentDurationMs = Date.now() - segmentStartedAt;
          const startOffsetMs = Math.max(0, segmentStartedAt - startedAtRef.current);
          latestPreviewRef.current = {
            blob: new Blob(chunks, { type: previewRecorder.mimeType || mimeType || 'audio/webm' }),
            durationMs: segmentDurationMs,
            mimeType: previewRecorder.mimeType || mimeType || 'audio/webm',
            startOffsetMs
          };
        }

        if (recorderRef.current?.state === 'recording') {
          startPreviewSegment(stream, mimeType);
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
  }, [status]);

  // 마이크 권한을 요청하고 MediaRecorder 녹음을 시작한다.
  const startRecording = useCallback(async (settings: RecorderSettings): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 환경에서는 마이크 녹음을 사용할 수 없습니다.');
    }

    setError(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !settings.captureDistantSpeech,
          noiseSuppression: !settings.captureDistantSpeech,
          autoGainControl: true
        }
      });
      const processedStream = await createProcessedStream(stream, settings);
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(processedStream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      recorderRef.current = recorder;
      latestPreviewRef.current = null;
      consumedPreviewKeyRef.current = '';
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setInputLevel(0);

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.start(1000);
      startInputLevelMeter();
      setStatus('recording');
      startPreviewSegment(processedStream, mimeType);
    } catch (recordingError) {
      const message =
        recordingError instanceof Error ? recordingError.message : '마이크 권한을 확인할 수 없습니다.';
      setError(message);
      throw new Error(message);
    }
  }, [createProcessedStream, getSupportedMimeType, startInputLevelMeter, startPreviewSegment]);

  // 녹음을 멈추고 누적된 오디오 Blob과 녹음 길이를 반환한다.
  const stopRecording = useCallback(async (): Promise<RecordedAudio | null> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      setStatus('idle');
      return null;
    }

    const durationMs = Date.now() - startedAtRef.current;

    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        async () => {
          const mimeType = recorder.mimeType || getSupportedMimeType() || 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: mimeType });

          if (previewTimerRef.current) {
            window.clearTimeout(previewTimerRef.current);
            previewTimerRef.current = null;
          }

          if (previewRecorderRef.current?.state === 'recording') {
            previewRecorderRef.current.stop();
          }

          if (levelFrameRef.current) {
            window.cancelAnimationFrame(levelFrameRef.current);
            levelFrameRef.current = null;
          }

          await audioContextRef.current?.close();
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
          audioContextRef.current = null;
          gainNodeRef.current = null;
          analyserNodeRef.current = null;
          previewRecorderRef.current = null;
          latestPreviewRef.current = null;
          chunksRef.current = [];
          setElapsedMs(durationMs);
          setInputLevel(0);
          setStatus('idle');
          resolve({ blob, durationMs, mimeType });
        },
        { once: true }
      );

      recorder.stop();
    });
  }, [getSupportedMimeType]);

  // 녹음을 끊지 않고 가장 최근 5초 미리보기 조각을 전사용 스냅샷으로 꺼낸다.
  const createRecordingSnapshot = useCallback(async (): Promise<RecordedAudio | null> => {
    const snapshot = latestPreviewRef.current;

    if (!snapshot) {
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
    updateSensitivity
  };
}
