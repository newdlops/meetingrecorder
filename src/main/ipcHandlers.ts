import { dialog, ipcMain } from 'electron';
import type { LocalTranscriptionService } from './localTranscriptionService';
import type { RecordingFileService } from './recordingFileService';
import type { MeetingSessionStore } from './sessionStore';
import type { SystemAudioCaptureService } from './systemAudioCaptureService';
import type {
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

// 렌더러와 메인 프로세스 사이의 IPC 엔드포인트를 등록한다.
export function registerIpcHandlers(
  store: MeetingSessionStore,
  transcriptionService: LocalTranscriptionService,
  recordingFileService: RecordingFileService,
  systemAudioCaptureService: SystemAudioCaptureService
): void {
  ipcMain.handle('session:list', async () => store.listSessions());

  ipcMain.handle('session:get', async (_event, id: string) => store.getSession(id));

  ipcMain.handle('session:save', async (_event, request: SaveMeetingSessionRequest) => {
    const audioFilePath = request.audioRecordingId
      ? recordingFileService.getCompletedFile(request.audioRecordingId).filePath
      : undefined;
    const savedSession = await store.saveSession(request, audioFilePath);

    if (request.audioRecordingId) {
      await recordingFileService.discard(request.audioRecordingId);
    }

    return savedSession;
  });

  ipcMain.handle('session:update-speaker', async (_event, request: SpeakerUpdateRequest) =>
    store.updateSpeakerName(request)
  );

  ipcMain.handle('session:update-details', async (_event, request: SessionDetailsUpdateRequest) =>
    store.updateSessionDetails(request)
  );

  ipcMain.handle('session:update-segment-memo', async (_event, request: SegmentMemoUpdateRequest) =>
    store.updateSegmentMemo(request)
  );

  ipcMain.handle('session:get-audio', async (_event, sessionId: string) => store.getAudioFile(sessionId));

  ipcMain.handle('session:export-audio', async (_event, sessionId: string) => {
    const session = await store.getSession(sessionId);
    const defaultName = session?.audioFileName ?? 'recording.webm';
    const result = await dialog.showSaveDialog({
      title: '녹음 파일 저장',
      defaultPath: defaultName,
      filters: [{ name: 'Audio', extensions: ['webm', 'mp4', 'wav', 'm4a'] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await store.exportAudio(sessionId, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('session:delete', async (_event, sessionId: string) => store.deleteSession(sessionId));

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

  ipcMain.handle('recording-file:start', async (_event, request: RecordingFileStartRequest) =>
    recordingFileService.start(request)
  );

  ipcMain.handle('recording-file:append', async (_event, request: RecordingChunkAppendRequest) =>
    recordingFileService.appendChunk(request)
  );

  ipcMain.handle('recording-file:complete', async (_event, request: RecordingFileCompleteRequest) =>
    recordingFileService.complete(request)
  );

  ipcMain.handle('recording-file:discard', async (_event, recordingId: string) =>
    recordingFileService.discard(recordingId)
  );

  ipcMain.handle('system-audio:start', async (_event, recordingId?: string) => {
    const outputPath = recordingId ? recordingFileService.getActiveFilePath(recordingId) : undefined;
    return systemAudioCaptureService.start(outputPath);
  });

  ipcMain.handle('system-audio:stop', async () => systemAudioCaptureService.stop());

  ipcMain.handle('system-audio:stop-to-recording-file', async (_event, recordingId: string) => {
    const outputPath = recordingFileService.getActiveFilePath(recordingId);
    const result = await systemAudioCaptureService.stopToFile(outputPath);
    return recordingFileService.complete({
      recordingId,
      audioMimeType: result.audioMimeType,
      durationMs: result.durationMs
    });
  });

  ipcMain.handle('system-audio:snapshot', async () => systemAudioCaptureService.createSnapshot());

  ipcMain.handle('system-audio:reset-snapshot', async () => systemAudioCaptureService.resetSnapshot());

  ipcMain.handle('transcription:offline', async (event, request: OfflineTranscriptionRequest) =>
    transcriptionService.transcribe(request, (progress) => {
      event.sender.send('transcription:progress', progress);
    })
  );

  ipcMain.handle('transcription:session-audio', async (event, request: SessionAudioTranscriptionRequest) => {
    const audioFile = await store.getAudioFileReference(request.sessionId);

    return transcriptionService.transcribeStoredAudioFile(
      {
        sessionId: request.sessionId,
        audioMimeType: audioFile.audioMimeType,
        audioDurationMs: audioFile.durationMs,
        mode: 'final',
        minSpeakers: request.minSpeakers,
        maxSpeakers: request.maxSpeakers,
        transcriptionInferenceMode: request.transcriptionInferenceMode
      },
      audioFile.filePath,
      (progress) => {
        event.sender.send('transcription:progress', progress);
      }
    );
  });
}
