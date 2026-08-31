// 사용량 한도 알림 E2E — 설정 토글부터 실제 Notification 발송까지 한 줄로 잇는다.
//
// 단위 테스트(client/test/limit-notify.test.js)는 판정 규칙을 고정하지만, 그 규칙이
// 폴링 → reducer → effect → 설정 관문을 거쳐 **실제로 화면에서** 발동하는지는 증명하지
// 못한다. 여기서 확인하는 것이 그 배선이다.
//
// 두 가지를 갈아 끼운다.
//   · window.Notification — 진짜 OS 알림을 띄우지 않고 호출을 기록만 한다.
//     권한 대화상자도 함께 사라지므로 grantPermissions가 필요 없다.
//   · /api/usage — 사용률을 테스트가 직접 몬다. 가짜 CLI는 구독 OAuth 토큰이 없어
//     quota가 늘 null이라, 스텁 없이는 한도 전이를 만들 수 없다.
//
// 60초 폴링은 page.clock으로 앞당긴다(실시간 대기 금지 — 테스트 상한이 45초다).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

const POLL_MS = 60_000; // App.jsx의 USAGE_POLL_MS와 같은 값

const zeroWindow = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  entries: 0,
};

/**
 * /api/usage를 테스트가 쥔다. 돌려주는 setter로 사용률을 바꾸면 다음 폴링부터 반영된다.
 * fetchedAt/resetsAt은 고정값이다 — 시계를 앞당기므로 Date.now()에 기대면 안 된다.
 */
async function stubUsage(page, initial) {
  const util = { five: initial.five, seven: initial.seven };
  await page.route('**/api/usage*', async (route) => {
    await route.fulfill({
      json: {
        now: 1_700_000_000_000,
        fiveHour: { ...zeroWindow },
        sevenDay: { ...zeroWindow },
        quota: {
          fiveHour: { utilization: util.five, resetsAt: 1_700_003_600_000 },
          sevenDay: { utilization: util.seven, resetsAt: 1_700_600_000_000 },
          fetchedAt: 1_700_000_000_000,
        },
      },
    });
  });
  return (next) => Object.assign(util, next);
}

/**
 * Notification을 기록용 가짜로 바꿔 둔다(내비게이션 전에 걸어야 App보다 먼저 선다).
 *
 * grants가 있으면 requestPermission()이 그 배열을 순서대로 돌려준다 — 프롬프트를 한 번
 * 무시했다가(default) 나중에 허용하는(granted) 흐름을 만들 수 있다.
 */
async function captureNotifications(page, permission = 'granted', grants = null) {
  await page.addInitScript(
    ({ perm, seq }) => {
      const sent = [];
      function FakeNotification(title, opts) {
        sent.push({ title, ...(opts ?? {}) });
      }
      FakeNotification.permission = perm;
      const queue = seq ? [...seq] : null;
      FakeNotification.requestPermission = async () => {
        const next = queue && queue.length ? queue.shift() : FakeNotification.permission;
        FakeNotification.permission = next;
        return next;
      };
      Object.defineProperty(window, 'Notification', {
        value: FakeNotification,
        configurable: true,
        writable: true,
      });
      window.__sentNotifications = sent;
    },
    { perm: permission, seq: grants },
  );
}

const readSent = (page) => page.evaluate(() => window.__sentNotifications ?? []);

/** 사이드바 하단 설정 모달을 열고 '세션' 탭 패널을 돌려준다. */
async function openSessionSettings(page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '설정' });
  await expect(modal).toBeVisible();
  await modal.getByRole('tab', { name: '세션' }).click();
  return modal;
}

test('설정 — 한도 알림은 기본 꺼짐이고, 켜면 새로고침 뒤에도 남는다', async ({ page }) => {
  await captureNotifications(page);
  await stubUsage(page, { five: 10, seven: 10 });
  await page.goto(servers.echo.url);

  const modal = await openSessionSettings(page);
  const toggle = modal.getByRole('switch', { name: '사용량 한도 알림' });
  await expect(toggle).toBeVisible();
  // 알림은 사용자가 먼저 요청해야 한다 — 기본값이 켜짐이면 첫 실행부터 권한을 묻는다.
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('ccob-limit-notify'))).toBe('1');

  await page.reload();
  const modal2 = await openSessionSettings(page);
  const toggle2 = modal2.getByRole('switch', { name: '사용량 한도 알림' });
  await expect(toggle2).toHaveAttribute('aria-checked', 'true');

  // 끄면 켜짐의 흔적(키)까지 지운다
  await toggle2.click();
  await expect(toggle2).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => localStorage.getItem('ccob-limit-notify'))).toBeNull();
});

test('알림 — 5시간 창이 100%에 닿으면 뜨고, 풀리면 해제 알림이 뜬다', async ({ page }) => {
  await captureNotifications(page);
  await page.clock.install();
  const setUtil = await stubUsage(page, { five: 97, seven: 20 });
  await page.goto(servers.echo.url);

  const modal = await openSessionSettings(page);
  await modal.getByRole('switch', { name: '사용량 한도 알림' }).click();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  // 첫 폴링(97%)은 기준선일 뿐이다 — 여기서 뜨면 켤 때마다 알림이 온다.
  expect(await readSent(page)).toEqual([]);

  setUtil({ five: 100 });
  await page.clock.fastForward(POLL_MS + 1_000);
  await expect.poll(() => readSent(page)).toHaveLength(1);
  const [hit] = await readSent(page);
  expect(hit.title).toBe('5시간 사용량 한도 도달');
  expect(hit.body).toContain('5시간 창');
  expect(hit.tag).toBe('ccob-limit-fiveHour');

  // 같은 값이 다시 와도 다시 알리지 않는다(폴링마다 재알림 금지)
  await page.clock.fastForward(POLL_MS + 1_000);
  await page.clock.fastForward(POLL_MS + 1_000);
  expect(await readSent(page)).toHaveLength(1);

  // 창이 초기화되면 해제 알림 — tag가 같아 낡은 '도달' 알림을 밀어낸다
  setUtil({ five: 2 });
  await page.clock.fastForward(POLL_MS + 1_000);
  await expect.poll(() => readSent(page)).toHaveLength(2);
  const [, release] = await readSent(page);
  expect(release.title).toBe('5시간 사용량 한도 해제');
  expect(release.tag).toBe('ccob-limit-fiveHour');
});

test('알림 — 설정이 꺼져 있으면 한도에 닿아도 오지 않는다', async ({ page }) => {
  await captureNotifications(page);
  await page.clock.install();
  const setUtil = await stubUsage(page, { five: 97, seven: 20 });
  await page.goto(servers.echo.url);

  // 토글을 건드리지 않는다(기본 꺼짐)
  setUtil({ five: 100 });
  await page.clock.fastForward(POLL_MS + 1_000);
  await page.clock.fastForward(POLL_MS + 1_000);
  expect(await readSent(page)).toEqual([]);
});

test('권한 프롬프트를 닫으면 안내와 재요청 버튼이 뜨고, 허용하면 그 자리에서 되살아난다', async ({ page }) => {
  // 프롬프트를 Esc/X로 닫으면 'denied'가 아니라 'default'로 남는다. 이때 설정은 이미
  // 켜져 있고 토글은 '꺼짐 → 켜짐'에서만 권한을 물으므로, 재요청 경로가 없으면 이 조합은
  // 영구히 무음이 된다 — 적대적 리뷰가 유일하게 확인한 결함이 이것이었다.
  await captureNotifications(page, 'default', ['default', 'granted']);
  await page.clock.install();
  const setUtil = await stubUsage(page, { five: 97, seven: 20 });
  await page.goto(servers.echo.url);

  const modal = await openSessionSettings(page);
  const toggle = modal.getByRole('switch', { name: '사용량 한도 알림' });
  await toggle.click();
  // 설정은 저장됐으므로 스위치는 켜진 채로 둔다 — 거짓말하지 않되, 왜 조용한지 밝힌다.
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const note = modal.getByText(/아직 알림 권한을 받지 못했습니다/);
  await expect(note).toBeVisible();

  // 이 상태에서는 한도에 닿아도 발송하지 않는다(권한이 없으므로)
  setUtil({ five: 100 });
  await page.clock.fastForward(POLL_MS + 1_000);
  expect(await readSent(page)).toEqual([]);

  // 재요청 버튼으로 허용을 받으면 안내가 사라지고, 이후 전이부터 알림이 나간다
  await modal.getByRole('button', { name: '권한 요청' }).click();
  await expect(note).toBeHidden();
  await page.keyboard.press('Escape');

  setUtil({ five: 30 }); // 100 → 30, 해제 전이
  await page.clock.fastForward(POLL_MS + 1_000);
  await expect.poll(() => readSent(page)).toHaveLength(1);
  expect((await readSent(page))[0].title).toBe('5시간 사용량 한도 해제');
});

test('알림 — 권한이 없으면 설정을 켜도 발송하지 않는다', async ({ page }) => {
  await captureNotifications(page, 'denied');
  await page.clock.install();
  const setUtil = await stubUsage(page, { five: 97, seven: 20 });
  await page.goto(servers.echo.url);

  const modal = await openSessionSettings(page);
  const toggle = modal.getByRole('switch', { name: '사용량 한도 알림' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // 차단된 상태를 사용자에게 알려 주는 안내가 뜬다 — 조용히 죽으면 안 된다
  await expect(modal.getByText(/알림을 차단/)).toBeVisible();
  await page.keyboard.press('Escape');

  setUtil({ five: 100 });
  await page.clock.fastForward(POLL_MS + 1_000);
  await page.clock.fastForward(POLL_MS + 1_000);
  expect(await readSent(page)).toEqual([]);
});
