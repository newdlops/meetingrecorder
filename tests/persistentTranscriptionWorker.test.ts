import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PersistentTranscriptionWorker,
  type PersistentTranscriptionJob,
  type PersistentWorkerConfig
} from '../src/main/persistentTranscriptionWorker';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-transcription-worker.mjs'
);

function createJob(): PersistentTranscriptionJob {
  return {
    request: {
      sessionId: 'meeting-worker-test',
      audioMimeType: 'audio/wav',
      mode: 'final'
    },
    audioPath: '/tmp/fake-audio.wav',
    transcribeOnly: false
  };
}

function createConfig(behavior: string, overrides: Partial<PersistentWorkerConfig> = {}): PersistentWorkerConfig {
  return {
    pythonPath: process.execPath,
    workerPath: fixturePath,
    args: [behavior],
    env: { ...process.env },
    timeout: 1_000,
    readyTimeout: 1_000,
    ...overrides
  };
}

test('상주 worker 결과를 받고 정상 종료한다', async (context) => {
  const worker = new PersistentTranscriptionWorker(async () => createConfig('success'));
  context.after(() => worker.shutdown());

  const result = await worker.transcribe(createJob());

  assert.equal(result.engineName, 'fake-worker');
  assert.deepEqual(result.speakers, []);
  assert.deepEqual(result.segments, []);
});

test('동시 warm-up과 전사 요청이 하나의 초기화만 공유한다', async (context) => {
  let createConfigCount = 0;
  const worker = new PersistentTranscriptionWorker(async () => {
    createConfigCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return createConfig('success');
  });
  context.after(() => worker.shutdown());

  const [unused, result] = await Promise.all([worker.warmUp(), worker.transcribe(createJob())]);

  assert.equal(unused, undefined);
  assert.equal(result.engineName, 'fake-worker');
  assert.equal(createConfigCount, 1);
});

test('설정 생성 중 shutdown되면 worker를 시작하지 않는다', async () => {
  let releaseConfig: (() => void) | undefined;
  const configBarrier = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  const worker = new PersistentTranscriptionWorker(async () => {
    await configBarrier;
    return createConfig('success');
  });
  const warmUp = worker.warmUp();

  worker.shutdown();
  releaseConfig?.();

  await assert.rejects(warmUp, /전사 엔진이 종료/);
});

test('준비 메시지가 없는 worker를 timeout으로 종료한다', async () => {
  const worker = new PersistentTranscriptionWorker(async () =>
    createConfig('never-ready', { readyTimeout: 50 })
  );

  await assert.rejects(worker.warmUp(), /준비 시간이 초과/);
  worker.shutdown();
});

test('작업 timeout 뒤 worker를 재시작해 다음 요청을 처리한다', async (context) => {
  let startCount = 0;
  const worker = new PersistentTranscriptionWorker(async () => {
    const behavior = startCount === 0 ? 'hang' : 'success';
    startCount += 1;
    return createConfig(behavior, { timeout: 300 });
  });
  context.after(() => worker.shutdown());

  await assert.rejects(worker.transcribe(createJob()), /실행 시간이 초과/);
  const result = await worker.transcribe(createJob());

  assert.equal(startCount, 2);
  assert.equal(result.engineName, 'fake-worker');
});
