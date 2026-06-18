#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvRoot = path.join(repoRoot, '.venv-stt');
const errors = [];

function resolvePath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function displayPath(filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function addError(message) {
  errors.push(message);
}

function requireFile(relativePath, options = {}) {
  const filePath = resolvePath(relativePath);
  const minBytes = options.minBytes ?? 1;

  if (!existsSync(filePath)) {
    addError(`missing file: ${relativePath}`);
    return;
  }

  const stats = statSync(filePath);

  if (!stats.isFile()) {
    addError(`not a file: ${relativePath}`);
    return;
  }

  if (stats.size < minBytes) {
    addError(`file is too small: ${relativePath}`);
  }

  if (options.executable && process.platform !== 'win32' && (stats.mode & 0o111) === 0) {
    addError(`file is not executable: ${relativePath}`);
  }
}

function requireDirectory(relativePath) {
  const directoryPath = resolvePath(relativePath);

  if (!existsSync(directoryPath)) {
    addError(`missing directory: ${relativePath}`);
    return false;
  }

  if (!statSync(directoryPath).isDirectory()) {
    addError(`not a directory: ${relativePath}`);
    return false;
  }

  return true;
}

function assertPortableSymlink(relativePath) {
  const filePath = resolvePath(relativePath);

  if (!existsSync(filePath)) {
    return;
  }

  const stats = lstatSync(filePath);

  if (!stats.isSymbolicLink()) {
    return;
  }

  const target = readlinkSync(filePath);

  if (path.isAbsolute(target)) {
    addError(`absolute symlink is not portable: ${relativePath} -> ${target}`);
    return;
  }

  const resolvedTarget = path.resolve(path.dirname(filePath), target);

  if (!resolvedTarget.startsWith(`${venvRoot}${path.sep}`) && resolvedTarget !== venvRoot) {
    addError(`symlink points outside bundled venv: ${relativePath} -> ${target}`);
  }
}

function findSitePackageDirectories() {
  const roots = [path.join(venvRoot, 'lib'), path.join(venvRoot, 'Lib')].filter((rootPath) => existsSync(rootPath));
  const sitePackages = [];
  const visit = (directoryPath, depth) => {
    if (depth > 4) {
      return;
    }

    if (path.basename(directoryPath) === 'site-packages') {
      sitePackages.push(directoryPath);
      return;
    }

    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(directoryPath, entry.name), depth + 1);
      }
    }
  };

  for (const rootPath of roots) {
    visit(rootPath, 0);
  }

  return sitePackages;
}

function requirePythonPackage(sitePackages, packageName) {
  const found = sitePackages.some((sitePackagePath) => {
    const packagePath = path.join(sitePackagePath, packageName);
    return existsSync(packagePath);
  });

  if (!found) {
    addError(`missing Python package in .venv-stt: ${packageName}`);
  }
}

function requireExtraResource(fromPath) {
  const packageJson = JSON.parse(readFileSync(resolvePath('package.json'), 'utf-8'));
  const extraResources = packageJson.build?.extraResources ?? [];
  const found = extraResources.some((entry) => entry?.from === fromPath);

  if (!found) {
    addError(`package.json build.extraResources does not include: ${fromPath}`);
  }
}

function verifyPythonRuntime() {
  if (!requireDirectory('.venv-stt')) {
    return;
  }

  if (process.platform === 'win32') {
    requireFile('.venv-stt/Scripts/python.exe', { executable: true, minBytes: 1024 * 1024 });
    return;
  }

  requireFile('.venv-stt/bin/python', { executable: true });
  requireFile('.venv-stt/bin/python3', { executable: true });
  assertPortableSymlink('.venv-stt/bin/python');
  assertPortableSymlink('.venv-stt/bin/python3');
  assertPortableSymlink('.venv-stt/bin/python3.11');
}

function verifyPythonPackages() {
  const sitePackages = findSitePackageDirectories();

  if (sitePackages.length === 0) {
    addError('missing Python site-packages under .venv-stt');
    return;
  }

  for (const packageName of ['whisperx', 'faster_whisper', 'ctranslate2', 'sherpa_onnx', 'torch', 'huggingface_hub']) {
    requirePythonPackage(sitePackages, packageName);
  }
}

function verifyEngineFiles() {
  requireFile('engines/offline-whisperx/persistent_worker.py');
  requireFile('engines/offline-whisperx/worker.py');
  requireFile('engines/offline-whisperx/diarization.py');
  requireFile('engines/offline-whisperx/quality_transcription.py');
  requireFile('engines/offline-whisperx/requirements.txt');
}

function verifyModelFiles() {
  requireFile('engines/models/whisper/faster-whisper-large-v3/model.bin', { minBytes: 1024 * 1024 });
  requireFile('engines/models/whisper/faster-whisper-large-v3/config.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/tokenizer.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/vocabulary.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/preprocessor_config.json');
  requireFile('engines/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx', {
    minBytes: 1024 * 1024
  });
  requireFile('engines/models/diarization/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx', {
    minBytes: 1024 * 1024
  });
}

function verifyPackagingConfig() {
  requireExtraResource('engines/offline-whisperx');
  requireExtraResource('engines/models');
  requireExtraResource('.venv-stt');
}

verifyPythonRuntime();
verifyPythonPackages();
verifyEngineFiles();
verifyModelFiles();
verifyPackagingConfig();

if (errors.length > 0) {
  console.error('Bundled offline engine is not ready:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error('\nRun `npm run setup:standalone` on the release build machine, then retry packaging.');
  process.exit(1);
}

console.log(`bundled offline engine ready: ${displayPath(venvRoot)}, engines/models`);
