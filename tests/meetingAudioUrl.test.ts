import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingAudioUrl, parseMeetingAudioUrl } from '../src/shared/meetingAudioUrl';

test('안전한 세션 ID의 오디오 URL을 왕복 변환한다', () => {
  const sessionId = 'meeting-abc_123';
  const url = createMeetingAudioUrl(sessionId);

  assert.equal(url, 'meeting-audio://session/meeting-abc_123');
  assert.equal(parseMeetingAudioUrl(url), sessionId);
});

test('경로 이탈, 추가 경로, query가 있는 오디오 URL을 거부한다', () => {
  for (const url of [
    'meeting-audio://session/%2E%2E%2Fsecret',
    'meeting-audio://session/meeting-safe/extra',
    'meeting-audio://session/meeting-safe?file=secret',
    'meeting-audio://other/meeting-safe'
  ]) {
    assert.throws(() => parseMeetingAudioUrl(url), /잘못된/);
  }

  assert.throws(() => createMeetingAudioUrl('../secret'), /잘못된/);
});
