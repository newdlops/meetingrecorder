import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  MeetingRecorderApi,
  OfflineTranscriptionRequest,
  RecordingChunkAppendRequest,
  RecordingFileCompleteRequest,
  RecordingFileStartRequest,
  SaveMeetingSessionRequest,
  SegmentMemoUpdateRequest,
  SessionAudioTranscriptionRequest,
  SessionDetailsUpdateRequest,
  SpeakerUpdateRequest
} from '../shared/types';

// 렌더러에 노출할 최소한의 안전한 API만 구성한다.
const meetingRecorderApi: MeetingRecorderApi = {
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (id: string) => ipcRenderer.invoke('session:get', id),
  saveSession: (request: SaveMeetingSessionRequest) => ipcRenderer.invoke('session:save', request),
  updateSpeakerName: (request: SpeakerUpdateRequest) =>
    ipcRenderer.invoke('session:update-speaker', request),
  updateSessionDetails: (request: SessionDetailsUpdateRequest) =>
    ipcRenderer.invoke('session:update-details', request),
  updateSegmentMemo: (request: SegmentMemoUpdateRequest) =>
    ipcRenderer.invoke('session:update-segment-memo', request),
  getAudioFile: (sessionId: string) => ipcRenderer.invoke('session:get-audio', sessionId),
  exportAudio: (sessionId: string) => ipcRenderer.invoke('session:export-audio', sessionId),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
  exportTranscript: (sessionId: string) =>
    ipcRenderer.invoke('session:export-transcript', sessionId),
  startRecordingFile: (request: RecordingFileStartRequest) =>
    ipcRenderer.invoke('recording-file:start', request),
  appendRecordingChunk: (request: RecordingChunkAppendRequest) =>
    ipcRenderer.invoke('recording-file:append', request),
  completeRecordingFile: (request: RecordingFileCompleteRequest) =>
    ipcRenderer.invoke('recording-file:complete', request),
  discardRecordingFile: (recordingId: string) =>
    ipcRenderer.invoke('recording-file:discard', recordingId),
  startSystemAudioCapture: (recordingId?: string) => ipcRenderer.invoke('system-audio:start', recordingId),
  stopSystemAudioCapture: () => ipcRenderer.invoke('system-audio:stop'),
  stopSystemAudioCaptureToRecordingFile: (recordingId: string) =>
    ipcRenderer.invoke('system-audio:stop-to-recording-file', recordingId),
  createSystemAudioSnapshot: () => ipcRenderer.invoke('system-audio:snapshot'),
  resetSystemAudioSnapshot: () => ipcRenderer.invoke('system-audio:reset-snapshot'),
  transcribeOffline: (request: OfflineTranscriptionRequest) =>
    ipcRenderer.invoke('transcription:offline', request),
  transcribeSessionAudio: (request: SessionAudioTranscriptionRequest) =>
    ipcRenderer.invoke('transcription:session-audio', request),
  onTranscriptionProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, progress: Parameters<typeof listener>[0]) => {
      listener(progress);
    };

    ipcRenderer.on('transcription:progress', handler);
    return () => ipcRenderer.removeListener('transcription:progress', handler);
  }
};

contextBridge.exposeInMainWorld('meetingRecorder', meetingRecorderApi);
