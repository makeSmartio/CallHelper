import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(clientDir, '../server');

export default defineConfig(({ mode }) => {
  const serverEnv = loadEnv(mode, serverDir, '');
  const backendPort =
    process.env.BACKEND_PORT || serverEnv.PORT || '3001';
  const clientPort = Number(process.env.CLIENT_PORT || serverEnv.CLIENT_PORT || 5173);
  const backendTarget = `http://127.0.0.1:${backendPort}`;

  return {
    plugins: [react()],
    envDir: clientDir,
    define: {
      'import.meta.env.VITE_BACKEND_PORT': JSON.stringify(backendPort),
    },
    server: {
      host: '0.0.0.0',
      port: clientPort,
      strictPort: true,
      hmr: {
        path: '/vite-hmr',
      },
      proxy: {
        '/health': { target: backendTarget, changeOrigin: true },
        '/sessions': { target: backendTarget, changeOrigin: true },
        '/llm-logs': { target: backendTarget, changeOrigin: true },
        '/enroll': { target: backendTarget, changeOrigin: true },
        '/copilot-ws': { target: backendTarget, ws: true, changeOrigin: true },
      },
    },
  };
});
