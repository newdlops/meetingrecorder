import type { OfflineTranscriptionMode, OfflineTranscriptionResult } from '../../../shared/types';
import type { RecordedAudio } from '../hooks/useRecorder';

export interface OfflineTranscriptionPayload {
  audioData?: Uint8Array;
  result?: OfflineTranscriptionResult;
  error?: string;
}

// 최종 저장과 녹음 중 미리보기 요청의 전사 방식을 구분한다.
export interface TranscribeRecordedAudioOptions {
  mode?: OfflineTranscriptionMode;
  includeAudioData?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
}

// 녹음된 오디오를 메인 프로세스의 로컬 전사 엔진으로 보내고 결과를 받는다.
export async function transcribeRecordedAudio(
  sessionId: string,
  recordedAudio: RecordedAudio | null,
  options: TranscribeRecordedAudioOptions = {}
): Promise<OfflineTranscriptionPayload> {
  if (!recordedAudio) {
    return {};
  }

  const shouldIncludeAudioData = options.includeAudioData ?? true;
  let audioData: Uint8Array | undefined;

  try {
    if (recordedAudio.blob) {
      const audioBuffer = await recordedAudio.blob.arrayBuffer();
      audioData = new Uint8Array(audioBuffer);
    }

    const result = await window.meetingRecorder.transcribeOffline({
      sessionId,
      audioData,
      audioRecordingId: recordedAudio.recordingId,
      audioMimeType: recordedAudio.mimeType,
      audioDurationMs: recordedAudio.durationMs,
      audioStartOffsetMs: recordedAudio.startOffsetMs,
      audioEndOffsetMs:
        typeof recordedAudio.startOffsetMs === 'number'
          ? recordedAudio.startOffsetMs + recordedAudio.durationMs
          : undefined,
      mode: options.mode ?? 'final',
      minSpeakers: options.minSpeakers,
      maxSpeakers: options.maxSpeakers
    });

    return { audioData: shouldIncludeAudioData ? audioData : undefined, result };
  } catch (error) {
    return {
      audioData: shouldIncludeAudioData ? audioData : undefined,
      error: error instanceof Error ? error.message : '오프라인 전사 엔진 실행에 실패했습니다.'
    };
  }
}
