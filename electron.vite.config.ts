import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const developmentCspPlugin = {
  name: 'meeting-recorder-development-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    return html.replace(
      "connect-src 'self';",
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:*;"
    );
  }
};

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
    plugins: [react(), developmentCspPlugin],
    build: {
      outDir: resolve(__dirname, 'dist/renderer')
    }
  }
});
