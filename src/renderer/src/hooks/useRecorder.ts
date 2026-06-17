import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingStatus, TranscriptionInferenceMode } from '../../../shared/types';

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
  previewWorkerCount: number;
  transcriptionInferenceMode: TranscriptionInferenceMode;
}

const PREVIEW_SEGMENT_MS = 5_000;
const PCM_SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FLUSH_INTERVAL_MS = 1_000;

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

function encodePcm16(samples: Float32Array, inputSampleRate: number): Uint8Array {
  const ratio = inputSampleRate / PCM_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Uint8Array(outputLength * PCM_BYTES_PER_SAMPLE);
  const view = new DataView(output.buffer);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(index * ratio));
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex] ?? 0));
    view.setInt16(index * PCM_BYTES_PER_SAMPLE, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return output;
}

// 브라우저 Web Audio API를 React 상태로 감싼 녹음 훅이다.
export function useRecorder() {
  const streamRef = useRef<MediaStream | null>(null);
  const systemRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const pcmProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const livePreviewEnabledRef = useRef(false);
  const previewMarkerInFlightRef = useRef(false);
  const nextPreviewStartMsRef = useRef(0);
  const recordingIdRef = useRef('');
  const recordingChunksRef = useRef<Uint8Array[]>([]);
  const recordingByteLengthRef = useRef(0);
  const lastPcmFlushAtRef = useRef(0);
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

  const queueRecordingBytes = useCallback((audioData: Uint8Array): void => {
    const recordingId = recordingIdRef.current;

    if (!recordingId || audioData.byteLength === 0) {
      return;
    }

    chunkWriteQueueRef.current = chunkWriteQueueRef.current
      .then(async () => {
        await window.meetingRecorder.appendRecordingChunk({ recordingId, audioData });
      })
      .catch((writeError) => {
        const message = writeError instanceof Error ? writeError.message : '녹음 파일을 저장하지 못했습니다.';
        setError(message);
        throw new Error(message);
      });
  }, []);

  const flushRecordingPcm = useCallback((): void => {
    if (recordingChunksRef.current.length === 0) {
      return;
    }

    const audioData = concatUint8Arrays(recordingChunksRef.current);
    recordingChunksRef.current = [];
    recordingByteLengthRef.current = 0;
    lastPcmFlushAtRef.current = Date.now();
    queueRecordingBytes(audioData);
  }, [queueRecordingBytes]);

  const handlePcmSamples = useCallback(
    (samples: Float32Array, inputSampleRate: number): void => {
      const audioData = encodePcm16(samples, inputSampleRate);
      recordingChunksRef.current.push(audioData);
      recordingByteLengthRef.current += audioData.byteLength;

      if (Date.now() - lastPcmFlushAtRef.current >= PCM_FLUSH_INTERVAL_MS) {
        flushRecordingPcm();
      }
    },
    [flushRecordingPcm]
  );

  // 녹음 중 실시간 전사 미리보기 청크 생성을 켜거나 끈다.
  const setLiveTranscriptionPreviewEnabled = useCallback(
    (enabled: boolean): void => {
      livePreviewEnabledRef.current = enabled;
      nextPreviewStartMsRef.current = enabled ? Math.max(0, Date.now() - startedAtRef.current) : 0;
    },
    []
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

  const startPcmCapture = useCallback((): void => {
    const audioContext = audioContextRef.current;
    const gainNode = gainNodeRef.current;

    if (!audioContext || !gainNode) {
      throw new Error('마이크 오디오 그래프를 준비하지 못했습니다.');
    }

    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    pcmProcessorRef.current = processor;
    lastPcmFlushAtRef.current = Date.now();

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      handlePcmSamples(input, audioContext.sampleRate);
    };

    gainNode.connect(processor);
    processor.connect(audioContext.destination);
  }, [handlePcmSamples]);

  // 선택된 입력 권한을 요청하고 PCM WAV 녹음을 시작한다.
  const startRecording = useCallback(async (settings: RecorderSettings, recordingId: string): Promise<void> => {
    setError(null);
    recordingIdRef.current = recordingId;
    chunkWriteQueueRef.current = Promise.resolve();
    recordingChunksRef.current = [];
    recordingByteLengthRef.current = 0;
    previewMarkerInFlightRef.current = false;
    nextPreviewStartMsRef.current = 0;

    try {
      livePreviewEnabledRef.current = settings.liveTranscriptionEnabled;

      if (settings.inputSource === 'system') {
        await window.meetingRecorder.startRecordingFile({
          recordingId,
          audioMimeType: 'audio/wav',
          externalWriter: true
        });
        await window.meetingRecorder.startSystemAudioCapture(recordingId);
        systemRecordingRef.current = true;
        startedAtRef.current = Date.now();
        nextPreviewStartMsRef.current = 0;
        setElapsedMs(0);
        setInputLevel(0);
        setStatus('recording');
        return;
      }

      const stream = await createMicrophoneInputStream(settings);
      await createProcessedStream(stream, settings);
      await window.meetingRecorder.startRecordingFile({ recordingId, audioMimeType: 'audio/wav' });
      streamRef.current = stream;
      startedAtRef.current = Date.now();
      nextPreviewStartMsRef.current = 0;
      setElapsedMs(0);
      setInputLevel(0);
      startPcmCapture();
      startInputLevelMeter();
      setStatus('recording');
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
    startPcmCapture,
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
        livePreviewEnabledRef.current = false;
        previewMarkerInFlightRef.current = false;
        nextPreviewStartMsRef.current = 0;
        recordingIdRef.current = '';
        recordingChunksRef.current = [];
        recordingByteLengthRef.current = 0;
        chunkWriteQueueRef.current = Promise.resolve();
        setElapsedMs(resolvedDurationMs);
        setInputLevel(0);
        setStatus('idle');
      }
    }

    const recordingId = recordingIdRef.current;

    if (!recordingId) {
      setStatus('idle');
      return null;
    }

    const durationMs = Date.now() - startedAtRef.current;

    try {
      pcmProcessorRef.current?.disconnect();

      if (pcmProcessorRef.current) {
        pcmProcessorRef.current.onaudioprocess = null;
      }

      flushRecordingPcm();
      await chunkWriteQueueRef.current;
      const recordingFile = await window.meetingRecorder.completeRecordingFile({
        recordingId,
        audioMimeType: 'audio/wav',
        durationMs
      });

      if (levelFrameRef.current) {
        window.cancelAnimationFrame(levelFrameRef.current);
        levelFrameRef.current = null;
      }

      await audioContextRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      pcmProcessorRef.current = null;
      audioContextRef.current = null;
      gainNodeRef.current = null;
      analyserNodeRef.current = null;
      recordingIdRef.current = '';
      livePreviewEnabledRef.current = false;
      previewMarkerInFlightRef.current = false;
      nextPreviewStartMsRef.current = 0;
      recordingChunksRef.current = [];
      recordingByteLengthRef.current = 0;
      chunkWriteQueueRef.current = Promise.resolve();
      setElapsedMs(durationMs);
      setInputLevel(0);
      setStatus('idle');

      return {
        recordingId: recordingFile.recordingId,
        durationMs: recordingFile.durationMs,
        mimeType: recordingFile.audioMimeType
      };
    } catch (error) {
      setStatus('idle');
      throw error;
    }
  }, [flushRecordingPcm]);

  // 녹음을 끊지 않고 active 녹음 파일의 다음 5초 구간을 전사용 marker로 꺼낸다.
  const createRecordingSnapshot = useCallback(async (): Promise<RecordedAudio | null> => {
    if (previewMarkerInFlightRef.current) {
      return null;
    }

    const recordingId = recordingIdRef.current;

    if (!livePreviewEnabledRef.current || !recordingId) {
      return null;
    }

    previewMarkerInFlightRef.current = true;

    try {
      if (!systemRecordingRef.current) {
        flushRecordingPcm();
        await chunkWriteQueueRef.current;
      }

      const startOffsetMs = nextPreviewStartMsRef.current;
      const endOffsetMs = startOffsetMs + PREVIEW_SEGMENT_MS;
      const elapsedMs = Math.max(0, Date.now() - startedAtRef.current);

      if (elapsedMs < endOffsetMs) {
        return null;
      }

      nextPreviewStartMsRef.current = endOffsetMs;

      return {
        recordingId,
        durationMs: PREVIEW_SEGMENT_MS,
        mimeType: 'audio/wav',
        startOffsetMs
      };
    } finally {
      previewMarkerInFlightRef.current = false;
    }
  }, [flushRecordingPcm]);

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
