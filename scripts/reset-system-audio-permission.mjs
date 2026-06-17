import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultBundleIds = [
  'com.meetingrecorder.system-audio-recorder',
  'com.meetingrecorder.app'
];
const electronBundleIds = ['com.github.Electron', 'Electron'];
const services = ['ScreenCapture', 'All'];
const args = new Set(process.argv.slice(2));
const bundleIds = [...defaultBundleIds];
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helperAppPath = resolve(rootDir, 'native/macos-system-audio-recorder/build/SystemAudioRecorder.app');
const lsregisterPath =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

if (args.has('--include-electron')) {
  bundleIds.push(...electronBundleIds);
}

function runTccutil(service, bundleId) {
  const tccArgs = bundleId ? ['reset', service, bundleId] : ['reset', service];
  const result = spawnSync('/usr/bin/tccutil', tccArgs, {
    encoding: 'utf8'
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('').trim();

  if (result.error) {
    console.error(result.error.message);
    return false;
  }

  if (result.status === 0) {
    console.log(`reset ${service}${bundleId ? ` for ${bundleId}` : ''}`);
    return true;
  }

  console.warn(`skip ${service}${bundleId ? ` for ${bundleId}` : ''}: ${output || `exit ${result.status}`}`);
  return false;
}

function registerHelperApp() {
  if (!existsSync(helperAppPath)) {
    console.warn('시스템 오디오 헬퍼 앱 번들이 없습니다. 먼저 npm run build:system-audio를 실행하세요.');
    return;
  }

  const result = spawnSync(lsregisterPath, ['-f', helperAppPath], {
    encoding: 'utf8'
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('').trim();

  if (result.error) {
    console.warn(`헬퍼 앱 등록 실패: ${result.error.message}`);
    return;
  }

  if (result.status !== 0) {
    console.warn(`헬퍼 앱 등록 실패: ${output || `exit ${result.status}`}`);
  }
}

if (process.platform !== 'darwin') {
  console.log('macOS가 아니므로 TCC 초기화를 건너뜁니다.');
  process.exit(0);
}

registerHelperApp();

if (args.has('--all')) {
  runTccutil('ScreenCapture');
} else {
  for (const service of services) {
    for (const bundleId of bundleIds) {
      runTccutil(service, bundleId);
    }
  }
}

console.log('시스템 오디오를 다시 시작하면 macOS가 권한을 다시 물어봅니다.');
console.log('개발 중 권한 팝업을 피하려면 npm run dev:mock-system-audio를 사용하세요.');
console.log('여전히 Electron 항목으로 거절된다면 npm run reset:system-audio-permission -- --include-electron을 실행하세요.');
console.log('예전 standalone 헬퍼의 거절 상태가 남아 있을 때만 npm run reset:system-audio-permission -- --all을 사용하세요.');
