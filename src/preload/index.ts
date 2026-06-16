import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  MeetingRecorderApi,
  OfflineTranscriptionRequest,
  SaveMeetingSessionRequest,
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
  getAudioFile: (sessionId: string) => ipcRenderer.invoke('session:get-audio', sessionId),
  exportAudio: (sessionId: string) => ipcRenderer.invoke('session:export-audio', sessionId),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
  exportTranscript: (sessionId: string) =>
    ipcRenderer.invoke('session:export-transcript', sessionId),
  transcribeOffline: (request: OfflineTranscriptionRequest) =>
    ipcRenderer.invoke('transcription:offline', request),
  onTranscriptionProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, progress: Parameters<typeof listener>[0]) => {
      listener(progress);
    };

    ipcRenderer.on('transcription:progress', handler);
    return () => ipcRenderer.removeListener('transcription:progress', handler);
  }
};

contextBridge.exposeInMainWorld('meetingRecorder', meetingRecorderApi);
