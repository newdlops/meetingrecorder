import { dialog, ipcMain } from 'electron';
import type { LocalTranscriptionService } from './localTranscriptionService';
import type { MeetingSessionStore } from './sessionStore';
import type {
  OfflineTranscriptionRequest,
  SaveMeetingSessionRequest,
  SpeakerUpdateRequest
} from '../shared/types';

// 렌더러와 메인 프로세스 사이의 IPC 엔드포인트를 등록한다.
export function registerIpcHandlers(
  store: MeetingSessionStore,
  transcriptionService: LocalTranscriptionService
): void {
  ipcMain.handle('session:list', async () => store.listSessions());

  ipcMain.handle('session:get', async (_event, id: string) => store.getSession(id));

  ipcMain.handle('session:save', async (_event, request: SaveMeetingSessionRequest) =>
    store.saveSession(request)
  );

  ipcMain.handle('session:update-speaker', async (_event, request: SpeakerUpdateRequest) =>
    store.updateSpeakerName(request)
  );

  ipcMain.handle('session:export-transcript', async (_event, sessionId: string) => {
    const result = await dialog.showSaveDialog({
      title: '회의록 저장',
      defaultPath: 'meeting-transcript.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await store.exportTranscript(sessionId, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('transcription:offline', async (_event, request: OfflineTranscriptionRequest) =>
    transcriptionService.transcribe(request)
  );
}
