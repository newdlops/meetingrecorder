#!/usr/bin/env node
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.MEETING_RECORDER_WHISPER_CPP_VERSION ?? 'v1.9.0';
const sourceArchiveUrl =
  process.env.MEETING_RECORDER_WHISPER_CPP_SOURCE_URL ??
  `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${version}.tar.gz`;
const modelUrl =
  process.env.MEETING_RECORDER_WHISPER_CPP_MODEL_URL ??
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';
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

function downloadFile(url, targetPath, description) {
  if (fileExists(targetPath, 1024 * 1024)) {
    console.log(`skip ${description}: ${path.relative(repoRoot, targetPath)}`);
    return;
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

  args.push('--output', targetPath, url);
  run('curl', args);
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
  downloadFile(sourceArchiveUrl, archivePath, `whisper.cpp ${version} source`);
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
  downloadFile(modelUrl, bundledModelPath, 'whisper.cpp full precision large-v3 model');
  console.log('whisper.cpp bundle ready');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
