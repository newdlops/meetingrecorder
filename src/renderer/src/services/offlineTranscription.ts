import type { OfflineTranscriptionResult } from '../../../shared/types';
import type { RecordedAudio } from '../hooks/useRecorder';

export interface OfflineTranscriptionPayload {
  audioData?: Uint8Array;
  result?: OfflineTranscriptionResult;
  error?: string;
}

// 녹음된 오디오를 메인 프로세스의 로컬 전사 엔진으로 보내고 결과를 받는다.
export async function transcribeRecordedAudio(
  sessionId: string,
  recordedAudio: RecordedAudio | null
): Promise<OfflineTranscriptionPayload> {
  if (!recordedAudio) {
    return {};
  }

  const audioBuffer = await recordedAudio.blob.arrayBuffer();
  const audioData = new Uint8Array(audioBuffer);

  try {
    const result = await window.meetingRecorder.transcribeOffline({
      sessionId,
      audioData,
      audioMimeType: recordedAudio.mimeType
    });

    return { audioData, result };
  } catch (error) {
    return {
      audioData,
      error: error instanceof Error ? error.message : '오프라인 전사 엔진 실행에 실패했습니다.'
    };
  }
}
