// Playwright E2E 설정 — fake CLI 스택(scripts/dev-fake.mjs) 기반 브라우저 스모크.
// 실제 claude CLI를 실행하지 않으므로 구독을 소모하지 않는다.
// 서버 2대(echo·permission)는 global-setup이 스폰하고 teardown이 정리한다.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.mjs',
  globalTeardown: './e2e/global-teardown.mjs',
  // 세션 시작·스트리밍 완료까지 여유 — CI 콜드 스타트 감안.
  timeout: 45_000,
  expect: { timeout: 15_000 },
  // 같은 파일 안에서 순차 실행 — 서버 2대를 공유하므로 결정적 순서 유지.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
