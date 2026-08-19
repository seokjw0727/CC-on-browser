import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 클라이언트 번들에 자기 버전을 박아 넣는다 — 서버(/api/bootstrap)가 보고하는
// 버전과 견줘 "구 데몬 + 새 번들" 스큐를 화면에서 알려 주기 위함(lib/app-version.js).
// 출처는 루트 package.json 하나 — client/package.json은 버전을 따로 올리지 않는다.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
