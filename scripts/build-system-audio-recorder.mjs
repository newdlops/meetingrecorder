import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS가 아닌 개발 환경에서는 시스템 오디오 헬퍼를 만들 수 없으므로 빌드를 건너뛴다.
if (process.platform !== 'darwin') {
  console.log('macOS가 아니므로 시스템 오디오 녹음 헬퍼 빌드를 건너뜁니다.');
  process.exit(0);
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(rootDir, 'native/macos-system-audio-recorder/SystemAudioRecorder.swift');
const plistPath = resolve(rootDir, 'native/macos-system-audio-recorder/Info.plist');
const buildDir = resolve(rootDir, 'native/macos-system-audio-recorder/build');
const appBundlePath = resolve(buildDir, 'SystemAudioRecorder.app');
const contentsDir = resolve(appBundlePath, 'Contents');
const macosDir = resolve(contentsDir, 'MacOS');
const outputPath = resolve(macosDir, 'SystemAudioRecorder');
const appPlistPath = resolve(contentsDir, 'Info.plist');
const helperBundleId = 'com.meetingrecorder.system-audio-recorder';

// Swift 모듈 캐시는 샌드박스에서도 쓸 수 있는 임시 경로로 고정한다.
rmSync(appBundlePath, { recursive: true, force: true });
rmSync(resolve(buildDir, 'SystemAudioRecorder'), { force: true });
mkdirSync(macosDir, { recursive: true });
copyFileSync(plistPath, appPlistPath);
const compileResult = spawnSync(
  '/usr/bin/swiftc',
  [
    '-parse-as-library',
    sourcePath,
    '-o',
    outputPath,
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'AVFoundation',
    '-framework',
    'CoreMedia',
    '-framework',
    'CoreAudio',
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    plistPath
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH ?? '/tmp/meeting-recorder-clang-cache'
    }
  }
);

if (compileResult.error) {
  console.error(compileResult.error.message);
  process.exit(1);
}

if (compileResult.status !== 0) {
  process.exit(compileResult.status ?? 1);
}

// TCC가 개발 헬퍼를 안정적인 앱 번들로 인식하도록 번들 전체를 ad-hoc 서명한다.
const signResult = spawnSync(
  '/usr/bin/codesign',
  ['--force', '--deep', '--sign', '-', '--identifier', helperBundleId, appBundlePath],
  { stdio: 'inherit' }
);

if (signResult.error) {
  console.error(signResult.error.message);
  process.exit(1);
}

process.exit(signResult.status ?? 1);
