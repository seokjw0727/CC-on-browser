// 화면 크롬(입력창 주변·상단 컨트롤·모서리 테마) E2E — fake CLI 'echo' 스택 대상.
//
// 검증 범위: ① 컴포저에서 workspace(레포) pill이 사라졌고 새 세션은 사이드바로만
// 들어간다 ② 권한 모드 셀렉트가 컴포저를 떠나 메인 우측 상단(.main-top-right)에
// 있으며 거기서도 실제로 모드가 바뀐다 ③ 설정의 '모서리'가 data-shape를 뒤집고
// 새로고침 뒤에도 유지되며 색 테마와 서로를 덮지 않는다.
//
// 여기서 증명되지 않는 것: 각 모서리 값이 만들어 내는 실제 픽셀. 토큰이 빠짐없이
// 재정의됐는지는 client/test/ui-shape.test.js가 CSS를 직접 읽어 검사한다.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

async function startSession(page) {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog).toBeVisible();
  // FAKE_PLATFORM=linux라 cwd는 직접 입력 필드다(global-setup 참조).
  await dialog.getByLabel('작업 디렉터리 경로').fill(process.cwd());
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
}

/** 사이드바 하단 설정 모달을 열고 '테마' 탭 패널을 돌려준다. */
async function openThemeSettings(page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '설정' });
  await expect(modal).toBeVisible();
  await modal.getByRole('tab', { name: '테마' }).click();
  return modal;
}

test('컴포저에 workspace pill이 없고 권한 모드는 메인 우측 상단에 있다', async ({ page }) => {
  await startSession(page);

  // ① 컴포저 안에는 레포 pill도, 그것을 담던 상단 행도 남아 있지 않다.
  const composer = page.locator('.composer-shell');
  await expect(composer).toBeVisible();
  await expect(page.locator('.repo-pill')).toHaveCount(0);
  await expect(page.locator('.composer-top')).toHaveCount(0);
  await expect(composer.getByLabel('권한 모드')).toHaveCount(0);

  // ② 권한 모드는 메인 우측 상단 묶음 안에 있고, 여전히 유일하게 라벨로 잡힌다.
  const mode = page.getByLabel('권한 모드');
  await expect(mode).toBeVisible();
  await expect(page.locator('.main-top-right').getByLabel('권한 모드')).toHaveCount(1);

  // 컴포저 위쪽에 떠 있다 — 위치가 바뀌었다는 것을 좌표로 못박는다.
  const modeBox = await mode.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(modeBox.y + modeBox.height).toBeLessThan(composerBox.y);

  // ③ 새 위치에서도 실제로 모드가 바뀐다(낙관적 갱신 + 토스트).
  await mode.selectOption('plan');
  await expect(mode).toHaveValue('plan');
  await expect(page.getByText('권한 모드 변경: 플랜모드')).toBeVisible();
});

test('좁은 창에서 미리보기 오버레이가 권한 모드를 덮지 않는다', async ({ page }) => {
  // 오버레이 미리보기는 position:fixed·z-index 20으로 우측을 통째로 덮는다.
  // 배지 시절엔 미관 문제였지만 지금은 조작 컨트롤이라 클릭이 막히면 기능 상실.
  await page.setViewportSize({ width: 900, height: 760 }); // < PREVIEW_OVERLAY_MAX_VW
  await startSession(page);
  const mode = page.getByLabel('권한 모드');
  await expect(mode).toBeVisible();

  // 오버레이 상태를 직접 만든다 — 실제 산출물 생성은 preview.spec.mjs가 검증한다.
  await page.evaluate(() => {
    document.querySelector('.app').classList.add('preview-overlay');
    document.querySelector('.app').style.setProperty('--preview-width', '480px');
  });

  const box = await mode.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(900 - 480);
  // 실제로 눌리는지 — 덮여 있으면 Playwright의 actionability 검사가 막는다.
  await mode.selectOption('acceptEdits', { timeout: 5000 });
  await expect(mode).toHaveValue('acceptEdits');
});

test('모서리 스타일: 기본 둥근 → 각진 전환 → 새로고침 유지, 색 테마와 독립', async ({ page }) => {
  await startSession(page);
  const html = page.locator('html');

  // 기본값은 지금까지의 둥근(pill) 모양이다.
  await expect(html).toHaveAttribute('data-shape', 'pill');

  const modal = await openThemeSettings(page);
  const shapeGroup = modal.getByRole('group', { name: '모서리 스타일 선택' });
  await expect(shapeGroup).toBeVisible();

  await shapeGroup.getByRole('button', { name: '각진' }).click();
  await expect(html).toHaveAttribute('data-shape', 'square');
  await expect(shapeGroup.getByRole('button', { name: '각진' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 토큰이 실제로 갈아끼워졌는지 — 계산된 값으로 확인한다.
  await expect(page.locator('.composer-shell')).not.toHaveCSS('border-radius', '18px');

  // 색 테마를 바꿔도 모서리는 그대로여야 한다(두 축은 서로 독립).
  await modal.getByRole('group', { name: '테마 선택' }).getByRole('button', { name: '라이트' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(html).toHaveAttribute('data-shape', 'square');

  // 새로고침 뒤에도 유지 — 첫 페인트부터 걸려 있어야 한다(index.html 인라인 부트스트랩).
  await page.reload();
  await expect(html).toHaveAttribute('data-shape', 'square');
  await expect(html).toHaveAttribute('data-theme', 'light');

  // 원복 — 뒤 테스트가 기본값을 전제해도 깨지지 않게 한다.
  const back = await openThemeSettings(page);
  await back.getByRole('group', { name: '모서리 스타일 선택' })
    .getByRole('button', { name: '둥근' }).click();
  await back.getByRole('group', { name: '테마 선택' })
    .getByRole('button', { name: '다크' }).click();
  await expect(html).toHaveAttribute('data-shape', 'pill');
});
