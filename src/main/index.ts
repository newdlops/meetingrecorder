import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipcHandlers';
import { LocalTranscriptionService } from './localTranscriptionService';
import { RecordingFileService } from './recordingFileService';
import { MeetingSessionStore } from './sessionStore';
import { SystemAudioCaptureService } from './systemAudioCaptureService';
import { LOCAL_RENDERER_SCHEME, LOCAL_RENDERER_URL, resolveLocalRendererFile } from './localRendererUrl';
import { MEETING_AUDIO_SCHEME, parseMeetingAudioUrl } from '../shared/meetingAudioUrl';

let mainWindow: BrowserWindow | null = null;
let transcriptionService: LocalTranscriptionService | null = null;
let recordingFileService: RecordingFileService | null = null;
let systemAudioCaptureService: SystemAudioCaptureService | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  },
  {
    scheme: MEETING_AUDIO_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true
    }
  }
]);

// Electron 창을 만들고 렌더러 진입점을 로드한다.
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '회의 속기록',
    backgroundColor: '#f5f7f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event) => {
    event.preventDefault();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadURL(LOCAL_RENDERER_URL);
  }
}

// 앱 데이터 폴더 아래에 회의 저장소를 만들고 IPC를 연결한다.
async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const store = new MeetingSessionStore(path.join(userDataPath, 'meetings'));
  recordingFileService = new RecordingFileService(path.join(userDataPath, 'recording-recovery'));
  transcriptionService = new LocalTranscriptionService(undefined, recordingFileService);
  systemAudioCaptureService = new SystemAudioCaptureService();
  await store.init();
  await recordingFileService.init();
  const recoveredRecordings = await recordingFileService.listRecoverableRecordings();
  const handledRecoveredRecordingIds = await store.recoverInterruptedRecordings(recoveredRecordings);

  await Promise.all(handledRecoveredRecordingIds.map((recordingId) => recordingFileService.discard(recordingId)));
  const rendererRoot = path.join(__dirname, '../renderer');
  protocol.handle(LOCAL_RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const filePath = resolveLocalRendererFile(request.url, rendererRoot);
      return net.fetch(pathToFileURL(filePath).toString(), {
        method: request.method,
        headers: request.headers
      });
    } catch (error) {
      console.error('렌더러 자산 요청을 처리하지 못했습니다.', error);
      return new Response('Renderer asset not found', { status: 404 });
    }
  });
  protocol.handle(MEETING_AUDIO_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    let sessionId = '';

    try {
      sessionId = parseMeetingAudioUrl(request.url);
    } catch {
      return new Response('Invalid meeting audio URL', { status: 400 });
    }

    try {
      const audioFile = await store.getAudioFileReference(sessionId);
      return net.fetch(pathToFileURL(audioFile.filePath).toString(), {
        method: request.method,
        headers: request.headers
      });
    } catch (error) {
      console.error('회의 오디오 스트리밍 요청을 처리하지 못했습니다.', error);
      return new Response('Meeting audio file not found', { status: 404 });
    }
  });
  registerIpcHandlers(
    store,
    transcriptionService,
    recordingFileService,
    systemAudioCaptureService,
    (event) => Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame)
  );
  createMainWindow();
  transcriptionService.warmUp().catch((error) => console.error(error));
}

app.whenReady().then(bootstrap);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  transcriptionService?.shutdown();
  recordingFileService?.shutdown().catch((error) => console.error(error));
  systemAudioCaptureService?.shutdown().catch((error) => console.error(error));
});
