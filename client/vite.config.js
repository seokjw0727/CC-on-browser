import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // vendor 분리(react / highlight.js / 마크다운 계열) — 전송량 절감이 아니라
    // 앱 코드만 바뀌는 잦은 업데이트에서 vendor 캐시를 재사용하기 위함(전후 실측:
    // 단일 514kB → app+vendor 3분할, gzip 총량 동등). Vite 8은 Rolldown 기반이라
    // rollupOptions.manualChunks 대신 advancedChunks를 쓴다.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'vendor-hljs', test: /node_modules[\\/]highlight\.js[\\/]/ },
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-md', test: /node_modules[\\/](marked|dompurify)[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
