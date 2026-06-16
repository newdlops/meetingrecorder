import type { MeetingSession, SpeakerProfile } from '../../../shared/types';

const SPEAKER_COLORS = ['#1f7a8c', '#b45f06', '#4f6f52', '#6d597a'];

// 새 회의 초안에 기본 화자 목록을 만든다.
function createDefaultSpeakers(): SpeakerProfile[] {
  return SPEAKER_COLORS.slice(0, 3).map((color, index) => ({
    id: `speaker-${index + 1}`,
    name: `화자 ${index + 1}`,
    color
  }));
}

// 저장 폴더명으로 쓰기 안전한 세션 ID를 만든다.
function createSessionId(): string {
  return `meeting-${crypto.randomUUID()}`;
}

// 녹음 시작 시점의 회의 세션 초안을 생성한다.
export function createDraftMeetingSession(now = new Date()): MeetingSession {
  const isoTime = now.toISOString();
  const title = `회의 ${now.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })}`;

  return {
    id: createSessionId(),
    title,
    createdAt: isoTime,
    updatedAt: isoTime,
    durationMs: 0,
    speakers: createDefaultSpeakers(),
    segments: []
  };
}
