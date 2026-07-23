import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MeetingSessionStore } from '../src/main/sessionStore';
import type { MeetingSession } from '../src/shared/types';

function createSession(id: string, overrides: Partial<MeetingSession> = {}): MeetingSession {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();

  return {
    id,
    title: '테스트 회의',
    createdAt: now,
    updatedAt: now,
    durationMs: 1_000,
    speakers: [],
    segments: [],
    transcriptText: '',
    memo: '',
    ...overrides
  };
}

test('세션과 오디오를 세션 폴더 안에 원자적으로 저장한다', async (context) => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'meeting-session-store-test-'));
  context.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const store = new MeetingSessionStore(baseDirectory);
  const sessionId = 'meeting-safe';

  const saved = await store.saveSession({
    session: createSession(sessionId),
    audioData: new Uint8Array([1, 2, 3]),
    audioMimeType: 'audio/wav'
  });
  const audio = await store.getAudioFileReference(sessionId);
  const entries = await readdir(path.join(baseDirectory, sessionId));

  assert.equal(saved.audioFileName, 'recording.wav');
  assert.equal(path.dirname(audio.filePath), path.resolve(baseDirectory, sessionId));
  assert.deepEqual([...entries].sort(), ['recording.wav', 'session.json', 'transcript.txt']);
  assert.deepEqual(new Uint8Array(await readFile(audio.filePath)), new Uint8Array([1, 2, 3]));
  assert.equal(entries.some((entry) => entry.endsWith('.tmp')), false);
});

test('렌더러가 보낸 경로형 또는 비오디오 파일명을 거부한다', async (context) => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'meeting-session-store-test-'));
  context.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const store = new MeetingSessionStore(baseDirectory);

  await assert.rejects(
    store.saveSession({
      session: createSession('meeting-traversal', { audioFileName: '../../outside.wav' })
    }),
    /잘못된 녹음 파일명/
  );
  await assert.rejects(
    store.saveSession({
      session: createSession('meeting-non-audio', { audioFileName: 'session.json' })
    }),
    /잘못된 녹음 파일명/
  );
});

test('이전 세션의 경로형 파일명도 세션 폴더 안으로 제한한다', async (context) => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'meeting-session-store-test-'));
  context.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const store = new MeetingSessionStore(baseDirectory);
  const sessionId = 'meeting-legacy';
  const sessionDirectory = path.join(baseDirectory, sessionId);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  context.after(() => {
    console.warn = originalWarn;
  });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    path.join(sessionDirectory, 'session.json'),
    JSON.stringify(createSession(sessionId, { audioFileName: '../../outside.wav' })),
    'utf-8'
  );

  const storedSession = await store.getSession(sessionId);
  const audio = await store.getAudioFileReference(sessionId);

  assert.equal(storedSession?.audioFileName, 'outside.wav');
  assert.equal(audio.filePath, path.resolve(sessionDirectory, 'outside.wav'));
});
