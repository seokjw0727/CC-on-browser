// 브라우저 E2E 스모크 — fake CLI 스택(구독 미소모) 대상.
// 검증 범위(설계도 §2): ① 접속·부트스트랩 ② 새 세션 모달의 기본 권한 모드 =
// default 단언(v1.5.0 기본값 변경 회귀 방지) ③ 세션 시작→메시지 전송→최종 렌더된
// 마크다운 응답 확인 ④ 권한 다이얼로그 허용/거부 왕복.
// 부분 렌더(타자기 중간 상태) 관찰은 범위 밖 — fake delta가 사실상 연속 출력.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

// 새 세션 모달을 열고 기본 권한 모드를 단언한 뒤 세션을 시작한다.
// FAKE_PLATFORM=linux 강제로 cwd는 직접 입력 필드다(글로벌 셋업 참조).
async function startSession(page, url) {
  await page.goto(url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog).toBeVisible();
  // 공개 배포 기본값: 신뢰모드가 아니라 기본모드(default)여야 한다.
  await expect(dialog.locator('label:has-text("권한 모드") select')).toHaveValue('default');
  await dialog.getByLabel('작업 디렉터리 경로').fill(process.cwd());
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  // 세션 초기화 완료 = 컴포저 입력이 활성화됨.
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
}

test('접속→새 세션(기본모드 default)→스트리밍 마크다운 응답', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const input = page.getByLabel('메시지 입력');
  await input.fill('hello from e2e **굵게**');
  await input.press('Enter');
  // 사용자 말풍선 + fake CLI의 echo 응답이 마크다운으로 렌더된다(굵게 → <strong>).
  await expect(page.getByText(/echo: hello from e2e/).first()).toBeVisible();
  await expect(page.locator('strong', { hasText: '굵게' }).first()).toBeVisible();
});

test('권한 다이얼로그 — 허용/거부 왕복', async ({ page }) => {
  await startSession(page, servers.permission.url);
  const input = page.getByLabel('메시지 입력');

  // 1턴: 허용 — 기본모드에서 도구 실행 전 확인이 뜨는 것 자체가 회귀 방지 대상.
  await input.fill('write something');
  await input.press('Enter');
  const permDialog = page.getByRole('dialog', { name: '도구 사용 권한 요청' });
  await expect(permDialog).toBeVisible();
  await expect(permDialog).toContainText('Write');
  await permDialog.getByRole('button', { name: '허용' }).click();
  await expect(permDialog).toBeHidden();

  // 2턴: 거부 — 다이얼로그가 다시 뜨고, 거부 후 닫히며 입력이 계속 가능해야 한다.
  await input.fill('write again');
  await input.press('Enter');
  await expect(permDialog).toBeVisible();
  await permDialog.getByRole('button', { name: '거부' }).click();
  await expect(permDialog).toBeHidden();
  await expect(input).toBeEnabled();
});
