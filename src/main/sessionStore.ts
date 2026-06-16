import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioFilePayload,
  DeleteSessionResult,
  MeetingSession,
  MeetingSessionSummary,
  SaveMeetingSessionRequest,
  SessionDetailsUpdateRequest,
  SpeakerUpdateRequest
} from '../shared/types';
import { buildTranscriptText, formatTranscriptDocument } from '../shared/transcriptFormatter';

const SESSION_FILE_NAME = 'session.json';
const AUDIO_FILE_NAME = 'recording.webm';
const TRANSCRIPT_FILE_NAME = 'transcript.txt';

// 회의 세션의 파일 저장과 조회를 책임지는 저장소 클래스다.
export class MeetingSessionStore {
  constructor(private readonly baseDirectory: string) {}

  // 앱 시작 시 저장 루트 폴더를 준비한다.
  async init(): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true });
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
  async saveSession(request: SaveMeetingSessionRequest): Promise<MeetingSession> {
    const session = request.session;
    assertSafeSessionId(session.id);

    const sessionDirectory = this.getSessionDirectory(session.id);
    await mkdir(sessionDirectory, { recursive: true });

    const normalizedSession = normalizeSession({
      ...session,
      audioFileName: request.audioData ? AUDIO_FILE_NAME : session.audioFileName,
      audioMimeType: request.audioMimeType ?? session.audioMimeType,
      updatedAt: new Date().toISOString()
    });

    if (request.audioData) {
      const audioPath = path.join(sessionDirectory, AUDIO_FILE_NAME);
      await writeFile(audioPath, Buffer.from(request.audioData));
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

  // 사용자가 고른 위치로 텍스트 회의록을 내보낸다.
  async exportTranscript(sessionId: string, targetPath: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session) {
      throw new Error('내보낼 회의 세션을 찾을 수 없습니다.');
    }

    await writeFile(targetPath, formatTranscriptDocument(session), 'utf-8');
  }

  // 저장된 녹음 파일을 렌더러가 재생할 수 있도록 바이트로 읽어 반환한다.
  async getAudioFile(sessionId: string): Promise<AudioFilePayload | null> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session?.audioFileName) {
      return null;
    }

    const audioPath = path.join(this.getSessionDirectory(session.id), session.audioFileName);
    const audioData = await readFile(audioPath);

    return {
      fileName: session.audioFileName,
      audioMimeType: session.audioMimeType,
      audioData: new Uint8Array(audioData)
    };
  }

  // 사용자가 고른 위치로 원본 녹음 파일을 복사한다.
  async exportAudio(sessionId: string, targetPath: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session?.audioFileName) {
      throw new Error('내보낼 녹음 파일이 없습니다.');
    }

    await copyFile(path.join(this.getSessionDirectory(session.id), session.audioFileName), targetPath);
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

  // 파일이 없거나 손상된 세션은 목록에서 조용히 제외한다.
  private async readSession(id: string): Promise<MeetingSession | null> {
    try {
      assertSafeSessionId(id);
      const raw = await readFile(this.getSessionFilePath(id), 'utf-8');
      return normalizeSession(JSON.parse(raw) as MeetingSession);
    } catch {
      return null;
    }
  }

  // 세션 JSON과 사람이 읽는 텍스트 파일을 동일한 내용으로 저장한다.
  private async writeSession(session: MeetingSession): Promise<void> {
    await writeFile(this.getSessionFilePath(session.id), JSON.stringify(session, null, 2), 'utf-8');
    await writeFile(
      path.join(this.getSessionDirectory(session.id), TRANSCRIPT_FILE_NAME),
      formatTranscriptDocument(session),
      'utf-8'
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
    memo: session.memo ?? '',
    transcriptText: session.transcriptText ?? ''
  };

  return {
    ...normalizedSession,
    transcriptText: normalizedSession.transcriptText || buildTranscriptText(normalizedSession)
  };
}

// 세션 ID가 경로 밖으로 나가지 못하도록 허용 문자를 제한한다.
function assertSafeSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('잘못된 회의 세션 ID입니다.');
  }
}
