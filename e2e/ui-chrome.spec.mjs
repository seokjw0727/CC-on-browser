// 화면 크롬(입력창 주변·상단 컨트롤·모서리 테마) E2E — fake CLI 'echo' 스택 대상.
//
// 검증 범위: ① 컴포저에서 workspace(레포) pill이 사라졌고 새 세션은 사이드바로만
// 들어간다 ② 권한 모드 셀렉트가 입력 상자(.composer-input) 안쪽 우측 상단에 있으며
// 거기서도 실제로 모드가 바뀐다 ③ 설정의 '모서리'가 data-shape를 뒤집고
// 새로고침 뒤에도 유지되며 색 테마와 서로를 덮지 않는다.
//
// ②는 두 번 이사했다: 컴포저 하단 pill 행 → 메인 우측 상단(.main-top-right) →
// 입력 상자 안쪽(2026-08-31, 사용자 요청). 지금 .main-top-right에 남은 것은 사이드바를
// 접었을 때의 세션 이름 배지뿐이라, 오버레이 관련 좌표 계약도 그 배지를 대상으로 한다.
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

test('컴포저에 workspace pill이 없고 권한 모드는 입력 상자 안쪽 우측 상단에 있다', async ({ page }) => {
  await startSession(page);

  // ① 컴포저 안에는 레포 pill도, 그것을 담던 상단 행도 남아 있지 않다.
  const composer = page.locator('.composer-shell');
  await expect(composer).toBeVisible();
  await expect(page.locator('.repo-pill')).toHaveCount(0);
  await expect(page.locator('.composer-top')).toHaveCount(0);

  // ② 권한 모드는 **입력 상자 안**에 있고, 여전히 유일하게 라벨로 잡힌다.
  //    떠나 온 자리(.main-top-right)에는 남아 있지 않아야 한다 — 이중 마운트 방지.
  const mode = page.getByLabel('권한 모드');
  await expect(mode).toBeVisible();
  await expect(page.locator('.composer-input').getByLabel('권한 모드')).toHaveCount(1);
  await expect(page.locator('.main-top-right').getByLabel('권한 모드')).toHaveCount(0);

  // 좌표로 "안쪽 우측 상단"을 못박는다. 기준은 셸이 아니라 **입력 상자**여야 한다 —
  // 셸 기준으로만 재면 입력 영역 위(GOAL 배지 자리)나 한참 아래로 내려가도 통과한다
  // (codex 지적). .composer-input 안이면 그 부모인 셸 안인 것은 자동으로 따라온다.
  // 예전 계약은 "컴포저 **위쪽**에 떠 있다"(셀렉트 아래끝 < 셸 위끝)였다 — 뒤집힌 자리다.
  const input = page.locator('.composer-input');
  const modeBox = await mode.boundingBox();
  const inputBox = await input.boundingBox();
  const TOL = 2; // 레이아웃 반올림 여유(top:0/right:0이라 원래는 정확히 0이다)
  // 세로: 입력 영역의 위쪽 모서리에 붙어 있고, 아래로 삐져나오지 않는다.
  expect(Math.abs(modeBox.y - inputBox.y)).toBeLessThanOrEqual(TOL);
  expect(modeBox.y + modeBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height + TOL);
  // 가로: 오른쪽 끝에 붙어 있다. 한쪽만 보면 오른쪽으로 넘쳐도(음수) 통과하므로
  // 절댓값으로 본다(codex 지적).
  expect(
    Math.abs(inputBox.x + inputBox.width - (modeBox.x + modeBox.width)),
  ).toBeLessThanOrEqual(TOL);

  // 글자가 셀렉트 밑으로 파고들지 않도록 textarea가 오른쪽을 비워 둔다.
  const padRight = await page
    .getByLabel('메시지 입력')
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
  expect(padRight).toBeGreaterThanOrEqual(modeBox.width);

  // ③ 새 위치에서도 실제로 모드가 바뀐다(낙관적 갱신 + 토스트).
  await mode.selectOption('plan');
  await expect(mode).toHaveValue('plan');
  await expect(page.getByText('권한 모드 변경: 플랜모드')).toBeVisible();
});

test('좁은 창에서 미리보기 오버레이가 세션 이름 배지를 덮지 않는다', async ({ page }) => {
  // 오버레이 미리보기는 position:fixed·z-index 20으로 우측을 통째로 덮는다.
  // .app.preview-overlay .main-top-right의 오른쪽 오프셋이 그 자리를 피하게 해 준다.
  // 권한 모드가 입력 상자로 옮겨 간 뒤 이 띠에 남은 것은 세션 이름 배지뿐이라,
  // 이제 이 계약이 지키는 것은 조작 가능성이 아니라 배지의 가독성이다.
  // (입력 상자 쪽은 전송 버튼과 마찬가지로 오버레이 밑에 들어간다 — 오버레이가 열린
  //  좁은 창에서 컴포저 우측이 가려지는 것은 이 변경 이전부터의 기존 제약이다.)
  await page.setViewportSize({ width: 900, height: 760 }); // < PREVIEW_OVERLAY_MAX_VW
  await startSession(page);

  // 배지는 사이드바를 접었을 때만 뜬다(펼쳐져 있으면 세션 목록이 같은 정보를 보여 준다).
  await page.getByRole('button', { name: '사이드바 접기' }).click();
  const badge = page.locator('.session-name-badge');
  await expect(badge).toBeVisible();

  // 오버레이 상태를 직접 만든다 — 실제 산출물 생성은 preview.spec.mjs가 검증한다.
  await page.evaluate(() => {
    document.querySelector('.app').classList.add('preview-overlay');
    document.querySelector('.app').style.setProperty('--preview-width', '480px');
  });

  const box = await badge.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(900 - 480);
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
