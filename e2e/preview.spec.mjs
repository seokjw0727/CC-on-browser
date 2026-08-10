// 결과물 미리보기 사이드 패널 E2E — fake CLI 'preview' 시나리오 대상.
//
// 이 시나리오는 이벤트만 흉내 내지 않고 **격리된 cwd에 진짜 HTML+CSS를 쓴다**
// (global-setup의 previewCwd). 미리보기는 디스크의 실제 파일을 티켓 URL로 여는
// 기능이라, 파일이 없으면 아무것도 검증되지 않기 때문이다.
//
// 검증 범위: ① 턴이 끝나면 클릭 없이 패널이 자동으로 열리고 sandbox iframe이 실제
// HTML을 렌더(같은 디렉터리 CSS까지 적용) ② 닫으면 그 턴은 조용하다 ③ 도구 카드의
// "미리보기" 버튼으로 수동 재열림 ④ 같은 파일을 다시 Edit하면 자동 새로고침 ⑤ 닫기.
//
// 여기서 증명되지 않는 것: **여는 시점**이 result 하나뿐이라는 것. fake CLI는
// tool_use·tool_result·result를 연달아 뱉으므로 브라우저에서 그 사이를 가를 창이 없다
// (tool_use 시점에 열어도 이 스펙은 통과한다). 그 계약과 억제(suppressed) 수명은
// client/test/store-reducer.test.js가 이벤트 단위로 검증한다.
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

// fake CLI는 산출물 파일의 존재 여부로 Write(V1)/Edit(V2)를 가른다 — 이전 시도가
// 남긴 파일이 있으면 재시도의 첫 턴이 곧장 Edit/V2로 시작해 시나리오가 어긋난다.
// global-setup은 실행당 한 번만 도므로 정리는 스펙이 직접 해야 한다.
function resetArtifacts() {
  for (const name of ['preview-artifact.html', 'preview-artifact.css']) {
    rmSync(path.join(servers.previewCwd, name), { force: true });
  }
}

async function startPreviewSession(page) {
  await page.goto(servers.preview.url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog).toBeVisible();
  // FAKE_PLATFORM=linux라 cwd는 직접 입력 필드다(global-setup 참조).
  await dialog.getByLabel('작업 디렉터리 경로').fill(servers.previewCwd);
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
}

/** 프롬프트를 보내고 **턴이 끝날 때까지** 기다린다(중단 버튼 → 전송 버튼 복귀). */
async function sendAndSettle(page, text) {
  const input = page.getByLabel('메시지 입력');
  await input.fill(text);
  await input.press('Enter');
  // 자동 열림은 턴 종료(result) 시점의 동작이다 — 도구 결과 시점에 우연히 통과하지
  // 않도록, 어서션 전에 idle 복귀를 반드시 통과시킨다.
  await expect(page.getByRole('button', { name: '전송' })).toBeVisible();
}

test('미리보기 패널: 턴 종료 자동 표시 → 닫기 → 수동 재열림 → 재수정 자동 갱신', async ({ page }) => {
  resetArtifacts();
  await startPreviewSession(page);

  // ① 턴이 끝나면 **클릭 없이** 패널이 열린다. 보내기 전에는 닫혀 있어야 어서션이
  //    공허하지 않다(새 세션이 패널을 물고 시작하면 무엇을 해도 통과한다).
  const panel = page.getByRole('complementary', { name: '결과물 미리보기' });
  await expect(panel).toBeHidden();

  await sendAndSettle(page, '결과물 만들어줘');
  await expect(panel).toBeVisible();
  // 헤더의 파일명(경로 줄에도 같은 문자열이 있어 클래스로 좁힌다)
  await expect(panel.locator('.preview-name')).toHaveText('preview-artifact.html');

  const frame = panel.locator('iframe.preview-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-modals');
  // 티켓 URL로 열려야 한다 — 앱 토큰이 URL에 실리면 안 된다.
  const src = await frame.getAttribute('src');
  expect(src).toMatch(/^\/preview\/[0-9a-f]{32}\//);
  expect(src).not.toMatch(/token/i);

  await expect(page.frameLocator('iframe.preview-frame').locator('#head')).toHaveText('PREVIEW-V1');
  // 같은 디렉터리의 CSS가 같은 티켓 스코프에서 로드됐는가(상대 리소스 계약).
  await expect(page.frameLocator('iframe.preview-frame').locator('#head'))
    .toHaveCSS('color', 'rgb(0, 128, 0)');

  // ② 닫으면 닫힌 채로 있는다.
  await panel.getByRole('button', { name: '미리보기 닫기' }).click();
  await expect(panel).toBeHidden();

  // ③ 도구 카드의 버튼으로 수동 재열림 — 자동 열림이 수동 경로를 대체하지 않는다.
  //    exact — '미리보기 닫기'가 부분 일치로 함께 잡히지 않게(지금은 패널이 닫혀 있어
  //    충돌하지 않지만, 순서를 바꾸면 조용히 깨질 자리다).
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.preview-name')).toHaveText('preview-artifact.html');

  // ④ 같은 파일을 다시 수정하면(두 번째 턴은 Edit) 미리보기가 자동 갱신된다.
  //    패널을 다시 열면서 iframe이 remount되므로 로케이터를 새로 잡는다.
  await sendAndSettle(page, '고쳐줘');
  await expect(page.frameLocator('iframe.preview-frame').locator('#head')).toHaveText('PREVIEW-V2');

  // ⑤ 닫기.
  await panel.getByRole('button', { name: '미리보기 닫기' }).click();
  await expect(panel).toBeHidden();
});
