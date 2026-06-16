import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingStatus } from '../../../shared/types';

export interface RecordedAudio {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const SNAPSHOT_FLUSH_TIMEOUT_MS = 300;

// 브라우저 MediaRecorder API를 React 상태로 감싼 녹음 훅이다.
export function useRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
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

  // MediaRecorder가 들고 있는 최신 청크를 짧게 비워 미리보기 스냅샷 누락을 줄인다.
  const flushPendingRecordingChunk = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state !== 'recording') {
      return;
    }

    await new Promise<void>((resolve) => {
      let isSettled = false;
      let timeoutId: number | undefined;

      const settle = () => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        recorder.removeEventListener('dataavailable', settle);

        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }

        resolve();
      };

      recorder.addEventListener('dataavailable', settle, { once: true });
      timeoutId = window.setTimeout(settle, SNAPSHOT_FLUSH_TIMEOUT_MS);

      try {
        recorder.requestData();
      } catch {
        settle();
      }
    });
  }, []);

  // 마이크 권한을 요청하고 MediaRecorder 녹음을 시작한다.
  const startRecording = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 환경에서는 마이크 녹음을 사용할 수 없습니다.');
    }

    setError(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsedMs(0);

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.start(1000);
      setStatus('recording');
    } catch (recordingError) {
      const message =
        recordingError instanceof Error ? recordingError.message : '마이크 권한을 확인할 수 없습니다.';
      setError(message);
      throw new Error(message);
    }
  }, [getSupportedMimeType]);

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
        () => {
          const mimeType = recorder.mimeType || getSupportedMimeType() || 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: mimeType });

          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
          chunksRef.current = [];
          setElapsedMs(durationMs);
          setStatus('idle');
          resolve({ blob, durationMs, mimeType });
        },
        { once: true }
      );

      recorder.stop();
    });
  }, [getSupportedMimeType]);

  // 녹음을 끊지 않고 현재까지 쌓인 오디오를 복사해 전사용 스냅샷을 만든다.
  const createRecordingSnapshot = useCallback(async (): Promise<RecordedAudio | null> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return null;
    }

    await flushPendingRecordingChunk();

    const activeRecorder = recorderRef.current;

    if (!activeRecorder || activeRecorder.state === 'inactive' || chunksRef.current.length === 0) {
      return null;
    }

    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = activeRecorder.mimeType || getSupportedMimeType() || 'audio/webm';
    const blob = new Blob([...chunksRef.current], { type: mimeType });

    return { blob, durationMs, mimeType };
  }, [flushPendingRecordingChunk, getSupportedMimeType]);

  return {
    status,
    elapsedMs,
    error,
    startRecording,
    stopRecording,
    createRecordingSnapshot
  };
}
