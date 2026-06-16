import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MeetingSession,
  MeetingSessionSummary,
  SaveMeetingSessionRequest,
  SpeakerUpdateRequest
} from '../shared/types';

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

    const normalizedSession: MeetingSession = {
      ...session,
      audioFileName: request.audioData ? AUDIO_FILE_NAME : session.audioFileName,
      audioMimeType: request.audioMimeType ?? session.audioMimeType,
      updatedAt: new Date().toISOString()
    };

    if (request.audioData) {
      const audioPath = path.join(sessionDirectory, AUDIO_FILE_NAME);
      await writeFile(audioPath, Buffer.from(request.audioData));
    }

    await writeFile(
      path.join(sessionDirectory, SESSION_FILE_NAME),
      JSON.stringify(normalizedSession, null, 2),
      'utf-8'
    );
    await writeFile(
      path.join(sessionDirectory, TRANSCRIPT_FILE_NAME),
      formatTranscript(normalizedSession),
      'utf-8'
    );

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

    await writeFile(
      this.getSessionFilePath(updatedSession.id),
      JSON.stringify(updatedSession, null, 2),
      'utf-8'
    );
    await writeFile(
      path.join(this.getSessionDirectory(updatedSession.id), TRANSCRIPT_FILE_NAME),
      formatTranscript(updatedSession),
      'utf-8'
    );

    return updatedSession;
  }

  // 사용자가 고른 위치로 텍스트 회의록을 내보낸다.
  async exportTranscript(sessionId: string, targetPath: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const session = await this.readSession(sessionId);

    if (!session) {
      throw new Error('내보낼 회의 세션을 찾을 수 없습니다.');
    }

    await writeFile(targetPath, formatTranscript(session), 'utf-8');
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
      return JSON.parse(raw) as MeetingSession;
    } catch {
      return null;
    }
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

// 저장된 전사 데이터를 사람이 읽기 쉬운 텍스트 파일로 변환한다.
function formatTranscript(session: MeetingSession): string {
  const speakerMap = new Map(session.speakers.map((speaker) => [speaker.id, speaker.name]));
  const header = [`# ${session.title}`, `생성: ${session.createdAt}`, `수정: ${session.updatedAt}`, ''];
  const lines = session.segments.map((segment) => {
    const speakerName = speakerMap.get(segment.speakerId) ?? '알 수 없는 화자';
    const overlapLabel = segment.isOverlapped ? ' [동시 발화]' : '';
    return `[${formatTime(segment.startMs)} - ${formatTime(segment.endMs)}] ${speakerName}${overlapLabel}: ${segment.text}`;
  });

  return [...header, ...lines, ''].join('\n');
}

// 밀리초 시간을 텍스트 회의록용 mm:ss 형식으로 바꾼다.
function formatTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// 세션 ID가 경로 밖으로 나가지 못하도록 허용 문자를 제한한다.
function assertSafeSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('잘못된 회의 세션 ID입니다.');
  }
}
