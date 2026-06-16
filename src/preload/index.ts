import { contextBridge, ipcRenderer } from 'electron';
import type {
  MeetingRecorderApi,
  OfflineTranscriptionRequest,
  SaveMeetingSessionRequest,
  SpeakerUpdateRequest
} from '../shared/types';

// 렌더러에 노출할 최소한의 안전한 API만 구성한다.
const meetingRecorderApi: MeetingRecorderApi = {
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (id: string) => ipcRenderer.invoke('session:get', id),
  saveSession: (request: SaveMeetingSessionRequest) => ipcRenderer.invoke('session:save', request),
  updateSpeakerName: (request: SpeakerUpdateRequest) =>
    ipcRenderer.invoke('session:update-speaker', request),
  exportTranscript: (sessionId: string) =>
    ipcRenderer.invoke('session:export-transcript', sessionId),
  transcribeOffline: (request: OfflineTranscriptionRequest) =>
    ipcRenderer.invoke('transcription:offline', request)
};

contextBridge.exposeInMainWorld('meetingRecorder', meetingRecorderApi);
