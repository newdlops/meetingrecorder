import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecoverableRecordingFile } from './recordingFileService';
import type {
  DeleteSessionResult,
  MeetingSession,
  MeetingSessionSummary,
  SaveMeetingSessionRequest,
  SegmentMemoUpdateRequest,
  SessionDetailsUpdateRequest,
  SpeakerUpdateRequest
} from '../shared/types';
import { buildTranscriptText, formatTranscriptDocument } from '../shared/transcriptFormatter';

const SESSION_FILE_NAME = 'session.json';
const TRANSCRIPT_FILE_NAME = 'transcript.txt';

interface StoredSessionAudioFile {
  filePath: string;
  audioMimeType: string;
  durationMs: number;
}

// 회의 세션의 파일 저장과 조회를 책임지는 저장소 클래스다.
export class MeetingSessionStore {
  constructor(private readonly baseDirectory: string) {}

  // 앱 시작 시 저장 루트 폴더를 준비한다.
  async init(): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true });
  }

  // 비정상 종료 뒤 복구 폴더에 남은 녹음 파일을 회의 세션으로 승격한다.
  async recoverInterruptedRecordings(recordings: RecoverableRecordingFile[]): Promise<string[]> {
    const handledRecordingIds: string[] = [];

    await this.init();

    for (const recording of recordings) {
      assertSafeSessionId(recording.recordingId);

      const existingSession = await this.readSession(recording.recordingId);

      if (existingSession?.audioFileName) {
        handledRecordingIds.push(recording.recordingId);
        continue;
      }

      const recoveredAt = new Date().toISOString();
      const startedAt = normalizeIsoDate(recording.startedAt) ?? recoveredAt;
      const audioFileName = getAudioFileName(recording.audioMimeType);
      const sessionDirectory = this.getSessionDirectory(recording.recordingId);
      const audioPath = path.join(sessionDirectory, audioFileName);
      const session = normalizeSession({
        id: recording.recordingId,
        title: buildRecoveredSessionTitle(startedAt),
        createdAt: startedAt,
        updatedAt: recoveredAt,
        durationMs: recording.durationMs,
        audioFileName,
        audioMimeType: recording.audioMimeType,
        speakers: [],
        segments: [],
        transcriptText: '',
        memo: '예상치 못한 종료 후 복구된 녹음입니다. 필요한 경우 최종 고품질 보정을 시작하세요.'
      });

      await mkdir(sessionDirectory, { recursive: true });
      await moveFile(recording.filePath, audioPath);
      await this.writeSession(session);
      handledRecordingIds.push(recording.recordingId);
    }

    return handledRecordingIds;
  }

  // 저장된 회의 목록을 최신 수정순으로 반환한다.
  async listSessions(): Promise<MeetingSessionSummary[]> {
    await this.init();

    const entries = await readdir(this.baseDirectory, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.readSession(entry.name))
    );

    return sessions
      .filter((session): session is MeetingSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toSummary);
  }

  // 단일 회의 세션의 전체 데이터를 읽는다.
  async getSession(id: string): Promise<MeetingSession | null> {
    assertSafeSessionId(id);
    return this.readSession(id);
  }

  // 회의 JSON, 오디오 파일, 텍스트 스냅샷을 함께 저장한다.
  async saveSession(request: SaveMeetingSessionRequest, audioFilePath?: string): Promise<MeetingSession> {
    const session = request.session;
    assertSafeSessionId(session.id);

    if (session.audioFileName && !isSafeAudioFileName(session.audioFileName)) {
      throw new Error('잘못된 녹음 파일명입니다.');
    }

    const sessionDirectory = this.getSessionDirectory(session.id);
    await mkdir(sessionDirectory, { recursive: true });

    const normalizedSession = normalizeSession({
      ...session,
      audioFileName:
        request.audioData || audioFilePath
          ? getAudioFileName(request.audioMimeType ?? session.audioMimeType)
          : session.audioFileName,
      audioMimeType: request.audioMimeType ?? session.audioMimeType,
      updatedAt: new Date().toISOString()
    });

    if (audioFilePath) {
      const audioPath = this.getAudioFilePath(
        normalizedSession.id,
        normalizedSession.audioFileName ?? getAudioFileName(request.audioMimeType)
      );
      await copyFileAtomically(audioFilePath, audioPath);
    }

    if (request.audioData) {
      const audioPath = this.getAudioFilePath(
        normalizedSession.id,
        normalizedSession.audioFileName ?? getAudioFileName(request.audioMimeType)
      );
      await writeBinaryFileAtomically(audioPath, Buffer.from(request.audioData));
    }

    await this.writeSession(normalizedSession);

    return normalizedSession;
  }

  // 저장된 회의에서 화자 이름만 수정하고 파일에 반영한다.
  async updateSpeakerName(request: SpeakerUpdateRequest): Promise<MeetingSession> {
    assertSafeSessionId(request.sessionId);
    const session = await this.readSession(request.sessionId);

    if (!session) {
      throw new Error('회의 세션을 찾을 수 없습니다.');
    }

    const updatedSession: MeetingSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      speakers: session.speakers.map((speaker) =>
        speaker.id === request.speakerId ? { ...speaker, name: request.name.trim() } : speaker
      )
    };
    const previousGeneratedText = buildTranscriptText(session);
    const nextTranscriptText =
      session.transcriptText.trim() === previousGeneratedText.trim()
        ? buildTranscriptText(updatedSession)
        : session.transcriptText;

    await this.writeSession({ ...updatedSession, transcriptText: nextTranscriptText });

    return { ...updatedSession, transcriptText: nextTranscriptText };
  }

  // 제목, 전사 텍스트, 메모처럼 사용자가 직접 편집하는 세션 정보를 저장한다.
  async updateSessionDetails(request: SessionDetailsUpdateRequest): Promise<MeetingSession> {
    assertSafeSessionId(request.sessionId);
    const session = await this.readSession(request.sessionId);

    if (!session) {
      throw new Error('회의 세션을 찾을 수 없습니다.');
    }

    const title = request.title?.trim();
    const updatedSession: MeetingSession = {
      ...session,
      title: title || session.title,
      transcriptText: request.transcriptText ?? session.transcriptText,
      memo: request.memo ?? session.memo,
      updatedAt: new Date().toISOString()
    };

    await this.writeSession(updatedSession);
    return updatedSession;
  }

  // 전사 문장 하나에 연결된 메모를 저장한다.
  async updateSegmentMemo(request: SegmentMemoUpdateRequest): Promise<MeetingSession> {
    assertSafeSessionId(request.sessionId);
    const session = await this.readSession(request.sessionId);

    if (!session) {
      throw new Error('회의 세션을 찾을 수 없습니다.');
    }

    const updatedSession: MeetingSession = {
      ...session,
      segments: session.segments.map((segment) =>
        segment.id === request.segmentId ? { ...segment, memo: request.memo } : segment
      ),
      updatedAt: new Date().toISOString()
    };

    await this.writeSession(updatedSession);
    return updatedSession;
  }

  // 사용자가 고른 위치로 텍스트 회의록을 내보낸다.
  async exportTranscript(sessionId: string, targetPath: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session) {
      throw new Error('내보낼 회의 세션을 찾을 수 없습니다.');
    }

    await writeFile(targetPath, formatTranscriptDocument(session), 'utf-8');
  }

  async getAudioFileReference(sessionId: string): Promise<StoredSessionAudioFile> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session?.audioFileName) {
      throw new Error('최종 보정할 녹음 파일이 없습니다.');
    }

    return {
      filePath: this.getAudioFilePath(sessionId, session.audioFileName),
      audioMimeType: session.audioMimeType ?? getAudioFileMimeType(session.audioFileName),
      durationMs: session.durationMs
    };
  }

  // 사용자가 고른 위치로 원본 녹음 파일을 복사한다.
  async exportAudio(sessionId: string, targetPath: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session?.audioFileName) {
      throw new Error('내보낼 녹음 파일이 없습니다.');
    }

    await copyFile(this.getAudioFilePath(sessionId, session.audioFileName), targetPath);
  }

  // 세션 폴더 전체를 삭제해 녹음 파일, JSON, 텍스트 스냅샷을 함께 제거한다.
  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    assertSafeSessionId(sessionId);
    await rm(this.getSessionDirectory(sessionId), { recursive: true, force: true });
    return { deleted: true };
  }

  // 세션 ID에 해당하는 폴더 경로를 반환한다.
  private getSessionDirectory(id: string): string {
    return path.join(this.baseDirectory, id);
  }

  // 세션 JSON 파일 경로를 반환한다.
  private getSessionFilePath(id: string): string {
    return path.join(this.getSessionDirectory(id), SESSION_FILE_NAME);
  }

  // 세션 폴더 안의 안전한 오디오 파일 경로만 반환한다.
  private getAudioFilePath(id: string, audioFileName: string): string {
    assertSafeSessionId(id);
    assertSafeAudioFileName(audioFileName);

    const sessionDirectory = path.resolve(this.getSessionDirectory(id));
    const audioPath = path.resolve(sessionDirectory, audioFileName);

    if (path.dirname(audioPath) !== sessionDirectory) {
      throw new Error('잘못된 녹음 파일 경로입니다.');
    }

    return audioPath;
  }

  // 파일이 없거나 손상된 세션은 제외하되 원인을 진단 로그로 남긴다.
  private async readSession(id: string): Promise<MeetingSession | null> {
    try {
      assertSafeSessionId(id);
      const raw = await readFile(this.getSessionFilePath(id), 'utf-8');
      const storedSession = JSON.parse(raw) as MeetingSession;

      if (!storedSession || typeof storedSession !== 'object' || storedSession.id !== id) {
        throw new Error('세션 ID가 폴더 ID와 일치하지 않습니다.');
      }

      const session = normalizeSession(storedSession);

      if (storedSession.audioFileName && storedSession.audioFileName !== session.audioFileName) {
        console.warn(
          `[MeetingSessionStore] 세션 ${JSON.stringify(id)}의 안전하지 않은 audioFileName을 ${JSON.stringify(
            session.audioFileName
          )}(으)로 정규화했습니다.`
        );
      }

      return session;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }

      console.warn(
        `[MeetingSessionStore] 세션 ${JSON.stringify(id)}을(를) 읽지 못했습니다: ${describeError(error)}`
      );
      return null;
    }
  }

  // 세션 JSON과 사람이 읽는 텍스트 파일을 동일한 내용으로 저장한다.
  private async writeSession(session: MeetingSession): Promise<void> {
    assertSafeSessionId(session.id);
    const normalizedSession = normalizeSession(session);
    const serializedSession = JSON.stringify(normalizedSession, null, 2);
    const transcriptDocument = formatTranscriptDocument(normalizedSession);

    await writeTextFileAtomically(this.getSessionFilePath(normalizedSession.id), serializedSession);
    await writeTextFileAtomically(
      path.join(this.getSessionDirectory(normalizedSession.id), TRANSCRIPT_FILE_NAME),
      transcriptDocument
    );
  }
}

// 회의 목록에 필요한 요약 데이터만 추린다.
function toSummary(session: MeetingSession): MeetingSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    durationMs: session.durationMs,
    speakerCount: session.speakers.length,
    segmentCount: session.segments.length,
    audioFileName: session.audioFileName
  };
}

// 오래된 세션 파일에 없는 필드를 현재 앱 모델에 맞게 채운다.
function normalizeSession(session: MeetingSession): MeetingSession {
  const normalizedSession = {
    ...session,
    audioFileName: normalizeAudioFileName(session.audioFileName),
    segments: (session.segments ?? []).map((segment) => ({ ...segment, memo: segment.memo ?? '' })),
    memo: session.memo ?? '',
    transcriptText: session.transcriptText ?? ''
  };

  return {
    ...normalizedSession,
    transcriptText: normalizedSession.transcriptText || buildTranscriptText(normalizedSession)
  };
}

// 이전 버전이 저장한 경로 포함 파일명도 세션 폴더 안의 베이스 파일명으로 정규화한다.
function normalizeAudioFileName(audioFileName: unknown): string | undefined {
  if (typeof audioFileName !== 'string' || audioFileName.includes('\0')) {
    return undefined;
  }

  const fileName = path.posix.basename(audioFileName.replace(/\\/g, '/'));
  return isSafeAudioFileName(fileName) ? fileName : undefined;
}

function assertSafeAudioFileName(fileName: string): void {
  if (!isSafeAudioFileName(fileName)) {
    throw new Error('잘못된 녹음 파일명입니다.');
  }
}

function isSafeAudioFileName(fileName: unknown): fileName is string {
  return (
    typeof fileName === 'string' &&
    fileName.length > 0 &&
    fileName !== '.' &&
    fileName !== '..' &&
    !fileName.includes('\0') &&
    !/[\\/]/.test(fileName) &&
    !path.posix.isAbsolute(fileName) &&
    !path.win32.isAbsolute(fileName) &&
    /\.(wav|webm|mp4|m4a)$/i.test(fileName)
  );
}

function getAudioFileName(mimeType?: string): string {
  if (mimeType?.includes('wav')) {
    return 'recording.wav';
  }

  if (mimeType?.includes('mp4') || mimeType?.includes('m4a')) {
    return 'recording.mp4';
  }

  return 'recording.webm';
}

function getAudioFileMimeType(fileName: string): string {
  if (fileName.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (fileName.endsWith('.mp4')) {
    return 'audio/mp4';
  }

  return 'audio/webm';
}

// 완성된 내용이 중간 상태로 노출되지 않도록 같은 폴더에 쓴 뒤 원자적으로 교체한다.
async function writeTextFileAtomically(targetPath: string, contents: string): Promise<void> {
  await replaceFileAtomically(targetPath, (temporaryPath) => writeFile(temporaryPath, contents, 'utf-8'));
}

async function writeBinaryFileAtomically(targetPath: string, contents: Buffer): Promise<void> {
  await replaceFileAtomically(targetPath, (temporaryPath) => writeFile(temporaryPath, contents));
}

async function copyFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
  await replaceFileAtomically(targetPath, (temporaryPath) => copyFile(sourcePath, temporaryPath));
}

async function replaceFileAtomically(
  targetPath: string,
  writeTemporaryFile: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let renamed = false;

  try {
    await writeTemporaryFile(temporaryPath);
    await rename(temporaryPath, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (error) {
        console.warn(
          `[MeetingSessionStore] 임시 파일 ${JSON.stringify(temporaryPath)}을(를) 정리하지 못했습니다: ${describeError(
            error
          )}`
        );
      }
    }
  }
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }

    await copyFile(sourcePath, targetPath);
    await rm(sourcePath, { force: true });
  }
}

function isCrossDeviceRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EXDEV'
  );
}

function normalizeIsoDate(value: string): string | undefined {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildRecoveredSessionTitle(startedAt: string): string {
  const date = new Date(startedAt);

  return `복구된 회의 ${date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const errorCode = 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
    return errorCode ? `${error.name} [${errorCode}]: ${error.message}` : `${error.name}: ${error.message}`;
  }

  return String(error);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

// 세션 ID가 경로 밖으로 나가지 못하도록 허용 문자를 제한한다.
function assertSafeSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('잘못된 회의 세션 ID입니다.');
  }
}
