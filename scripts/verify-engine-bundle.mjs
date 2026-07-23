#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvRoot = path.join(repoRoot, '.venv-stt');
const whisperCppBinaryRelativePath =
  process.platform === 'win32' ? 'engines/whisper.cpp/bin/whisper-cli.exe' : 'engines/whisper.cpp/bin/whisper-cli';
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

function requireExecutableRuns(relativePath, args = ['--help']) {
  const filePath = resolvePath(relativePath);

  if (!existsSync(filePath)) {
    return;
  }

  const result = spawnSync(filePath, args, { stdio: 'ignore' });

  if (result.status !== 0) {
    addError(`executable does not run: ${relativePath}`);
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

function verifyPythonPackageVersions() {
  const pythonPath = resolvePath(
    process.platform === 'win32' ? '.venv-stt/Scripts/python.exe' : '.venv-stt/bin/python'
  );
  const lockPath = resolvePath('engines/offline-whisperx/requirements-lock.txt');

  if (!existsSync(pythonPath) || !existsSync(lockPath)) {
    return;
  }

  const verificationScript = [
    'import importlib.metadata as metadata',
    'import pathlib',
    'import sys',
    'errors = []',
    'for line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():',
    '    value = line.strip()',
    '    if not value or value.startswith("#"):',
    '        continue',
    '    name, expected = value.split("==", 1)',
    '    try:',
    '        actual = metadata.version(name)',
    '    except metadata.PackageNotFoundError:',
    '        errors.append(f"{name}: missing (expected {expected})")',
    '        continue',
    '    if actual != expected:',
    '        errors.append(f"{name}: {actual} (expected {expected})")',
    'print("\\n".join(errors))',
    'raise SystemExit(1 if errors else 0)'
  ].join('\n');
  const result = spawnSync(pythonPath, ['-c', verificationScript, lockPath], { encoding: 'utf-8' });

  if (result.status !== 0) {
    addError(`Python packages do not match requirements-lock.txt:\n${result.stdout.trim() || result.stderr.trim()}`);
  }
}

function verifyEngineFiles() {
  requireFile('engines/offline-whisperx/persistent_worker.py');
  requireFile('engines/offline-whisperx/worker.py');
  requireFile('engines/offline-whisperx/diarization.py');
  requireFile('engines/offline-whisperx/quality_transcription.py');
  requireFile('engines/offline-whisperx/whisper_cpp_transcription.py');
  requireFile('engines/offline-whisperx/requirements.txt');
  requireFile('engines/offline-whisperx/requirements-lock.txt');
  requireFile(whisperCppBinaryRelativePath, { executable: true, minBytes: 1024 });
  requireExecutableRuns(whisperCppBinaryRelativePath);
}

function verifyModelFiles() {
  requireFile('engines/models/whisper/faster-whisper-large-v3/model.bin', { minBytes: 1024 * 1024 });
  requireFile('engines/models/whisper/faster-whisper-large-v3/config.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/tokenizer.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/vocabulary.json');
  requireFile('engines/models/whisper/faster-whisper-large-v3/preprocessor_config.json');
  requireFile('engines/models/whisper.cpp/ggml-large-v3.bin', { minBytes: 100 * 1024 * 1024 });
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
  requireExtraResource('engines/whisper.cpp');
  requireExtraResource('.venv-stt');
}

verifyPythonRuntime();
verifyPythonPackages();
verifyPythonPackageVersions();
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
