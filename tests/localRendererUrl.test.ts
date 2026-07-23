import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  LOCAL_RENDERER_URL,
  resolveLocalRendererFile
} from '../src/main/localRendererUrl';

const rendererRoot = path.resolve('/tmp/meeting-recorder-renderer');

test('로컬 렌더러 URL을 앱 자산 경로로 제한한다', () => {
  assert.equal(
    resolveLocalRendererFile(LOCAL_RENDERER_URL, rendererRoot),
    path.join(rendererRoot, 'index.html')
  );
  assert.equal(
    resolveLocalRendererFile('meeting-app://app/assets/index.js', rendererRoot),
    path.join(rendererRoot, 'assets', 'index.js')
  );
});

test('외부 host, query, 경로 이탈 렌더러 URL을 거부한다', () => {
  for (const url of [
    'meeting-app://external/index.html',
    'meeting-app://app/index.html?path=secret',
    'meeting-app://app/%2E%2E%2F%2E%2E%2Fsecret'
  ]) {
    assert.throws(() => resolveLocalRendererFile(url, rendererRoot), /잘못된|벗어났/);
  }
});
