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
  memo?: string;
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
  transcriptText: string;
  memo: string;
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
  audioRecordingId?: string;
  audioMimeType?: string;
}

export interface SpeakerUpdateRequest {
  sessionId: string;
  speakerId: string;
  name: string;
}

export interface SessionDetailsUpdateRequest {
  sessionId: string;
  title?: string;
  transcriptText?: string;
  memo?: string;
}

export interface SegmentMemoUpdateRequest {
  sessionId: string;
  segmentId: string;
  memo: string;
}

export interface ExportTranscriptResult {
  canceled: boolean;
  filePath?: string;
}

export interface SystemAudioCaptureResult {
  audioData?: Uint8Array;
  audioMimeType: string;
  durationMs: number;
  startOffsetMs?: number;
}

export interface RecordingFileStartRequest {
  recordingId: string;
  audioMimeType: string;
  externalWriter?: boolean;
}

export interface RecordingChunkAppendRequest {
  recordingId: string;
  audioData: Uint8Array;
}

export interface RecordingFileCompleteRequest {
  recordingId: string;
  audioMimeType: string;
  durationMs: number;
}

export interface RecordingFileResult {
  recordingId: string;
  audioMimeType: string;
  durationMs: number;
}

export interface DeleteSessionResult {
  deleted: boolean;
}

// 최종 저장용 전사와 녹음 중 미리보기 전사를 구분한다.
export type OfflineTranscriptionMode = 'final' | 'preview';

export type TranscriptionInferenceMode = 'literal' | 'contextual';

export type TranscriptionEngine = 'whisperx' | 'whisperCpp';

export type TranscriptionProgressStage =
  | 'prepare'
  | 'model'
  | 'audio'
  | 'transcribe'
  | 'align'
  | 'diarize'
  | 'save'
  | 'done';

export interface OfflineTranscriptionRequest {
  sessionId: string;
  audioData?: Uint8Array;
  audioRecordingId?: string;
  audioMimeType: string;
  audioDurationMs?: number;
  audioStartOffsetMs?: number;
  audioEndOffsetMs?: number;
  mode?: OfflineTranscriptionMode;
  minSpeakers?: number;
  maxSpeakers?: number;
  previewWorkerCount?: number;
  transcriptionEngine?: TranscriptionEngine;
  transcriptionInferenceMode?: TranscriptionInferenceMode;
}

export interface SessionAudioTranscriptionRequest {
  sessionId: string;
  minSpeakers?: number;
  maxSpeakers?: number;
  transcriptionEngine?: TranscriptionEngine;
  transcriptionInferenceMode?: TranscriptionInferenceMode;
}

export interface OfflineTranscriptionResult {
  speakers: SpeakerProfile[];
  segments: TranscriptSegment[];
  language?: string;
  durationMs?: number;
  engineName: string;
}

export interface TranscriptionProgressEvent {
  sessionId: string;
  mode: OfflineTranscriptionMode;
  stage: TranscriptionProgressStage;
  progress: number;
  message: string;
  workerId?: string;
  workerLabel?: string;
}

export interface MeetingRecorderApi {
  listSessions(): Promise<MeetingSessionSummary[]>;
  getSession(id: string): Promise<MeetingSession | null>;
  saveSession(request: SaveMeetingSessionRequest): Promise<MeetingSession>;
  updateSpeakerName(request: SpeakerUpdateRequest): Promise<MeetingSession>;
  updateSessionDetails(request: SessionDetailsUpdateRequest): Promise<MeetingSession>;
  updateSegmentMemo(request: SegmentMemoUpdateRequest): Promise<MeetingSession>;
  getAudioUrl(sessionId: string): string;
  exportAudio(sessionId: string): Promise<ExportTranscriptResult>;
  deleteSession(sessionId: string): Promise<DeleteSessionResult>;
  exportTranscript(sessionId: string): Promise<ExportTranscriptResult>;
  startRecordingFile(request: RecordingFileStartRequest): Promise<void>;
  appendRecordingChunk(request: RecordingChunkAppendRequest): Promise<void>;
  completeRecordingFile(request: RecordingFileCompleteRequest): Promise<RecordingFileResult>;
  discardRecordingFile(recordingId: string): Promise<void>;
  startSystemAudioCapture(recordingId?: string): Promise<void>;
  stopSystemAudioCaptureToRecordingFile(recordingId: string): Promise<RecordingFileResult>;
  transcribeOffline(request: OfflineTranscriptionRequest): Promise<OfflineTranscriptionResult>;
  transcribeSessionAudio(request: SessionAudioTranscriptionRequest): Promise<OfflineTranscriptionResult>;
  onTranscriptionProgress(listener: (event: TranscriptionProgressEvent) => void): () => void;
}
