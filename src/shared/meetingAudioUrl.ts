export const MEETING_AUDIO_SCHEME = 'meeting-audio';

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function createMeetingAudioUrl(sessionId: string): string {
  assertSafeMeetingSessionId(sessionId);
  return `${MEETING_AUDIO_SCHEME}://session/${encodeURIComponent(sessionId)}`;
}

export function parseMeetingAudioUrl(value: string): string {
  const requestUrl = new URL(value);

  if (
    requestUrl.protocol !== `${MEETING_AUDIO_SCHEME}:` ||
    requestUrl.hostname !== 'session' ||
    requestUrl.username ||
    requestUrl.password ||
    requestUrl.port ||
    requestUrl.search ||
    requestUrl.hash ||
    !/^\/[^/]+$/.test(requestUrl.pathname)
  ) {
    throw new Error('잘못된 회의 오디오 URL입니다.');
  }

  let sessionId = '';

  try {
    sessionId = decodeURIComponent(requestUrl.pathname.slice(1));
  } catch {
    throw new Error('잘못된 회의 세션 ID입니다.');
  }

  assertSafeMeetingSessionId(sessionId);
  return sessionId;
}

function assertSafeMeetingSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('잘못된 회의 세션 ID입니다.');
  }
}
