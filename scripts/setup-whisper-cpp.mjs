#!/usr/bin/env node
import {
  closeSync,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.MEETING_RECORDER_WHISPER_CPP_VERSION ?? 'v1.9.0';
const defaultSourceArchiveUrl = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${version}.tar.gz`;
const sourceArchiveUrl =
  process.env.MEETING_RECORDER_WHISPER_CPP_SOURCE_URL ??
  defaultSourceArchiveUrl;
const defaultModelUrl =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin';
const modelUrl =
  process.env.MEETING_RECORDER_WHISPER_CPP_MODEL_URL ??
  defaultModelUrl;
const modelSha256 =
  process.env.MEETING_RECORDER_WHISPER_CPP_MODEL_SHA256 ??
  (modelUrl === defaultModelUrl ? '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2' : undefined);
const sourceSha256 =
  process.env.MEETING_RECORDER_WHISPER_CPP_SOURCE_SHA256 ??
  (version === 'v1.9.0' && sourceArchiveUrl === defaultSourceArchiveUrl
    ? '58252617f539320c42f8f40052433bce0556f78977d3f47f0ddcfe31a4722146'
    : undefined);
const executableName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const bundledBinaryPath = path.join(repoRoot, 'engines/whisper.cpp/bin', executableName);
const bundledLibraryDirectory = path.join(repoRoot, 'engines/whisper.cpp/lib');
const bundledModelPath = path.join(repoRoot, 'engines/models/whisper.cpp/ggml-large-v3.bin');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function assertCommand(command, installHint) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });

  if (result.status !== 0) {
    throw new Error(`${command} is required. ${installHint}`);
  }
}

function captureCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }

  return result.stdout;
}

function fileExists(filePath, minBytes = 1) {
  if (!existsSync(filePath)) {
    return false;
  }

  const stats = statSync(filePath);
  return stats.isFile() && stats.size >= minBytes;
}

function executableExists(filePath) {
  if (!fileExists(filePath, 1024)) {
    return false;
  }

  if (process.platform === 'win32') {
    return true;
  }

  return (statSync(filePath).mode & 0o111) !== 0;
}

function executableRuns(filePath) {
  if (!executableExists(filePath)) {
    return false;
  }

  const result = spawnSync(filePath, ['--help'], { stdio: 'ignore' });
  return result.status === 0;
}

function calculateFileSha256(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, 'r');

  try {
    let bytesRead = 0;

    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }

  return hash.digest('hex');
}

function verifyFileSha256(filePath, expectedSha256, description) {
  if (!expectedSha256) {
    throw new Error(`${description} SHA-256 is required for a custom URL or version`);
  }

  const actualSha256 = calculateFileSha256(filePath);

  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${description} checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`
    );
  }
}

function downloadFile(url, targetPath, description, expectedSha256) {
  if (!expectedSha256) {
    throw new Error(`${description} SHA-256 is required for a custom URL or version`);
  }

  if (fileExists(targetPath, 1024 * 1024)) {
    try {
      verifyFileSha256(targetPath, expectedSha256, description);
      console.log(`skip ${description}: ${path.relative(repoRoot, targetPath)}`);
      return;
    } catch {
      console.log(`redownload ${description}: checksum mismatch`);
      rmSync(targetPath, { force: true });
    }
  }

  assertCommand('curl', 'Install curl or provide a local file.');
  mkdirSync(path.dirname(targetPath), { recursive: true });
  console.log(`download ${description}`);

  const args = [
    '-L',
    '--fail',
    '--retry',
    '5',
    '--retry-delay',
    '5',
    '--retry-all-errors',
    '--retry-connrefused'
  ];

  if (process.env.HF_TOKEN && url.includes('huggingface.co')) {
    args.push('--header', `Authorization: Bearer ${process.env.HF_TOKEN}`);
  }

  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.download`;
  rmSync(temporaryPath, { force: true });

  try {
    args.push('--output', temporaryPath, url);
    run('curl', args);
    verifyFileSha256(temporaryPath, expectedSha256, description);
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function validateTarArchive(archivePath) {
  const entries = captureCommand('tar', ['-tzf', archivePath]).split(/\r?\n/).filter(Boolean);
  const verboseEntries = captureCommand('tar', ['-tvzf', archivePath]).split(/\r?\n/).filter(Boolean);

  if (entries.length === 0 || entries.length !== verboseEntries.length) {
    throw new Error('whisper.cpp source archive has an invalid file listing');
  }

  for (const [index, entryName] of entries.entries()) {
    const parts = entryName.split('/').filter(Boolean);
    const strippedName = parts.slice(1).join('/');
    const normalizedName = path.posix.normalize(strippedName || '.');
    const entryType = verboseEntries[index]?.[0];

    if (
      entryName.startsWith('/') ||
      parts.includes('..') ||
      path.posix.isAbsolute(normalizedName) ||
      normalizedName === '..' ||
      normalizedName.startsWith('../') ||
      (entryType !== '-' && entryType !== 'd')
    ) {
      throw new Error(`unsafe whisper.cpp source archive entry: ${entryName}`);
    }
  }
}

function copyBundledBinary(sourcePath) {
  if (!fileExists(sourcePath, 1024)) {
    throw new Error(`whisper.cpp binary not found: ${sourcePath}`);
  }

  mkdirSync(path.dirname(bundledBinaryPath), { recursive: true });
  copyFileSync(sourcePath, bundledBinaryPath);

  if (process.platform !== 'win32') {
    chmodSync(bundledBinaryPath, 0o755);
  }

  console.log(`whisper.cpp binary ready: ${path.relative(repoRoot, bundledBinaryPath)}`);
}

function listFiles(directoryPath) {
  const files = [];

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    }
  }

  return files;
}

function copyMacosRuntimeLibraries(buildDirectory) {
  if (process.platform !== 'darwin') {
    return;
  }

  mkdirSync(bundledLibraryDirectory, { recursive: true });

  for (const libraryPath of listFiles(buildDirectory).filter((filePath) => filePath.endsWith('.dylib'))) {
    copyFileSync(libraryPath, path.join(bundledLibraryDirectory, path.basename(libraryPath)));
  }
}

function getMacosRpaths(binaryPath) {
  const result = spawnSync('otool', ['-l', binaryPath], { encoding: 'utf-8' });

  if (result.status !== 0) {
    return [];
  }

  const rpaths = [];
  const lines = result.stdout.split(/\r?\n/);

  for (const line of lines) {
    const match = line.trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/);

    if (match) {
      rpaths.push(match[1]);
    }
  }

  return rpaths;
}

function fixMacosRuntimePaths() {
  if (process.platform !== 'darwin') {
    return;
  }

  for (const rpath of getMacosRpaths(bundledBinaryPath)) {
    run('install_name_tool', ['-delete_rpath', rpath, bundledBinaryPath]);
  }

  run('install_name_tool', ['-add_rpath', '@loader_path/../lib', bundledBinaryPath]);
}

function findBuiltBinary(buildDirectory) {
  const candidates = [
    path.join(buildDirectory, 'bin', executableName),
    path.join(buildDirectory, 'bin', 'Release', executableName),
    path.join(buildDirectory, 'examples', 'cli', executableName)
  ];
  const found = candidates.find((candidatePath) => executableExists(candidatePath));

  if (!found) {
    throw new Error(`built whisper-cli was not found under ${buildDirectory}`);
  }

  return found;
}

function buildWhisperCpp() {
  assertCommand('cmake', 'Install CMake or set MEETING_RECORDER_WHISPER_CPP_BINARY to an existing whisper-cli.');

  const workRoot = path.join(tmpdir(), `meeting-recorder-whisper-cpp-${version}`);
  const sourceDirectory = path.join(workRoot, 'source');
  const buildDirectory = path.join(workRoot, 'build');
  const archivePath = path.join(workRoot, 'whisper-cpp.tar.gz');

  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(sourceDirectory, { recursive: true });
  downloadFile(sourceArchiveUrl, archivePath, `whisper.cpp ${version} source`, sourceSha256);
  validateTarArchive(archivePath);
  run('tar', ['-xzf', archivePath, '-C', sourceDirectory, '--strip-components', '1']);
  run('cmake', ['-S', sourceDirectory, '-B', buildDirectory, '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', buildDirectory, '--config', 'Release', '-j', String(Math.max(1, cpus().length - 1))]);
  rmSync(bundledLibraryDirectory, { recursive: true, force: true });
  copyMacosRuntimeLibraries(buildDirectory);
  copyBundledBinary(findBuiltBinary(buildDirectory));
  fixMacosRuntimePaths();
  rmSync(workRoot, { recursive: true, force: true });
}

function prepareBinary() {
  const explicitBinary = process.env.MEETING_RECORDER_WHISPER_CPP_BINARY;

  if (explicitBinary) {
    copyBundledBinary(path.resolve(explicitBinary));
    return;
  }

  if (executableRuns(bundledBinaryPath)) {
    console.log(`skip whisper.cpp binary: ${path.relative(repoRoot, bundledBinaryPath)}`);
    return;
  }

  if (existsSync(bundledBinaryPath)) {
    console.log(`rebuild whisper.cpp binary: ${path.relative(repoRoot, bundledBinaryPath)} is not runnable`);
  }

  buildWhisperCpp();
}

function main() {
  prepareBinary();
  if (!executableRuns(bundledBinaryPath)) {
    throw new Error(`bundled whisper.cpp binary is not runnable: ${path.relative(repoRoot, bundledBinaryPath)}`);
  }
  downloadFile(modelUrl, bundledModelPath, 'whisper.cpp full precision large-v3 model', modelSha256);
  console.log('whisper.cpp bundle ready');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
