import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipcHandlers';
import { LocalTranscriptionService } from './localTranscriptionService';
import { MeetingSessionStore } from './sessionStore';

let mainWindow: BrowserWindow | null = null;

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
      sandbox: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// 앱 데이터 폴더 아래에 회의 저장소를 만들고 IPC를 연결한다.
async function bootstrap(): Promise<void> {
  const store = new MeetingSessionStore(path.join(app.getPath('userData'), 'meetings'));
  const transcriptionService = new LocalTranscriptionService();
  await store.init();
  registerIpcHandlers(store, transcriptionService);
  createMainWindow();
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
