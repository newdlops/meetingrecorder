// 앱 전역에서 공유하는 회의/전사/IPC 타입을 정의한다.

export type RecordingStatus = 'idle' | 'recording' | 'saving';

export interface SpeakerProfile {
  id: string;
  name: string;
  color: string;
}

export interface TranscriptSegment {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  isOverlapped: boolean;
  overlapGroupId?: string;
}

export interface MeetingSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  audioFileName?: string;
  audioMimeType?: string;
  speakers: SpeakerProfile[];
  segments: TranscriptSegment[];
}

export interface MeetingSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  speakerCount: number;
  segmentCount: number;
  audioFileName?: string;
}

export interface SaveMeetingSessionRequest {
  session: MeetingSession;
  audioData?: Uint8Array;
  audioMimeType?: string;
}

export interface SpeakerUpdateRequest {
  sessionId: string;
  speakerId: string;
  name: string;
}

export interface ExportTranscriptResult {
  canceled: boolean;
  filePath?: string;
}

export interface OfflineTranscriptionRequest {
  sessionId: string;
  audioData: Uint8Array;
  audioMimeType: string;
  minSpeakers?: number;
  maxSpeakers?: number;
}

export interface OfflineTranscriptionResult {
  speakers: SpeakerProfile[];
  segments: TranscriptSegment[];
  language?: string;
  durationMs?: number;
  engineName: string;
}

export interface MeetingRecorderApi {
  listSessions(): Promise<MeetingSessionSummary[]>;
  getSession(id: string): Promise<MeetingSession | null>;
  saveSession(request: SaveMeetingSessionRequest): Promise<MeetingSession>;
  updateSpeakerName(request: SpeakerUpdateRequest): Promise<MeetingSession>;
  exportTranscript(sessionId: string): Promise<ExportTranscriptResult>;
  transcribeOffline(request: OfflineTranscriptionRequest): Promise<OfflineTranscriptionResult>;
}
