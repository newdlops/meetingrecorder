import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Electron main/preload/renderer 번들 위치를 한곳에서 관리한다.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload'
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: '../../dist/renderer'
    }
  }
});
