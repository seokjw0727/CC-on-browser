// 브라우저 E2E 스모크 — fake CLI 스택(구독 미소모) 대상.
// 검증 범위(설계도 §2): ① 접속·부트스트랩 ② 새 세션 모달의 기본 권한 모드 =
// default 단언(v1.5.0 기본값 변경 회귀 방지) ③ 세션 시작→메시지 전송→최종 렌더된
// 마크다운 응답 확인 ④ 권한 다이얼로그 허용/거부 왕복 ⑤ 신뢰모드 시작 전용
// 게이팅(비신뢰 스폰의 컴포저에 신뢰모드 옵션 부재 · 신뢰 스폰의 전환/복귀).
// ⑥ 히스토리("지난 세션")가 사이드바를 떠나 새 세션 모달로 통합된 것 · 목록 표시 ·
// 삭제 확인 왕복 ⑦ 설정의 기본 권한 모드가 새 세션 모달 초기값이 되는 것.
// 부분 렌더(타자기 중간 상태) 관찰은 범위 밖 — fake delta가 사실상 연속 출력.
//
// ⑥의 히스토리는 global-setup이 e2e/.state/projects 에 시딩한 가짜 트랜스크립트다
// (FAKE_PROJECTS_ROOT 격리). 사용자의 실제 ~/.claude/projects 는 절대 열리지 않는다.
// 재개 시 스폰 인자(model/permissionMode) 계보는 client/test/store-reducer.test.js
// 단위 테스트가 담당한다 — 브라우저에서는 관측 지점이 없다.
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PROJECTS_ROOT = path.join(here, '.state', 'projects');

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

// 시드 트랜스크립트 복원 — global-setup과 같은 형태로 다시 쓴다.
// 파괴적 테스트(삭제)가 재시도될 때 전역 픽스처가 이미 지워져 있으면 결정적으로
// 실패하므로, 그 테스트는 자기가 쓸 시드를 스스로 되살린다.
function reseed({ dirName, rel, sessionId, title, ageMs }) {
  const cwd = path.resolve(root, rel);
  const dir = path.join(PROJECTS_ROOT, dirName);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary', cwd, sessionId }),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: title } }),
    ].join('\n') + '\n',
  );
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
}

const SEED_BETA = {
  dirName: 'e2e-seed-beta-dir',
  rel: 'client',
  sessionId: 'e2e-seed-beta',
  title: 'E2E 씨앗 베타',
  ageMs: 120_000,
};

// 새 세션 모달을 열고 기본 권한 모드를 단언한 뒤 세션을 시작한다.
// FAKE_PLATFORM=linux 강제로 cwd는 직접 입력 필드다(글로벌 셋업 참조).
// permissionMode를 넘기면 모달 셀렉트에서 그 모드를 골라 시작한다.
async function startSession(page, url, { permissionMode } = {}) {
  await page.goto(url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog).toBeVisible();
  const modeSelect = dialog.locator('label:has-text("권한 모드") select');
  // 공개 배포 기본값: 신뢰모드가 아니라 기본모드(default)여야 한다.
  await expect(modeSelect).toHaveValue('default');
  if (permissionMode) await modeSelect.selectOption(permissionMode);
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

test('신뢰모드 게이팅 — 비신뢰 스폰의 컴포저에는 신뢰모드 옵션이 없다', async ({ page }) => {
  // 새 세션 모달에는 신뢰모드 옵션이 있어야 한다(시작 시 진입 = 유일한 합법 경로).
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(
    dialog.locator('label:has-text("권한 모드") select option[value="bypassPermissions"]'),
  ).toHaveCount(1);
  await dialog.getByLabel('작업 디렉터리 경로').fill(process.cwd());
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();

  // 기본모드로 시작한 세션의 컴포저 셀렉트에는 신뢰모드 옵션이 없어야 한다.
  const composerMode = page.getByLabel('권한 모드');
  await expect(composerMode).toBeVisible();
  await expect(composerMode.locator('option[value="bypassPermissions"]')).toHaveCount(0);
  // 다른 모드 전환은 여전히 가능하다.
  await composerMode.selectOption('plan');
  await expect(composerMode).toHaveValue('plan');
});

test('신뢰모드 게이팅 — 신뢰 스폰 세션은 타 모드 전환 후 신뢰모드로 복귀할 수 있다', async ({ page }) => {
  await startSession(page, servers.echo.url, { permissionMode: 'bypassPermissions' });
  const composerMode = page.getByLabel('권한 모드');
  await expect(composerMode).toHaveValue('bypassPermissions');
  // 신뢰 스폰 세션에는 옵션이 유지된다 — 타 모드로 갔다가 복귀 가능.
  await composerMode.selectOption('plan');
  await expect(composerMode).toHaveValue('plan');
  await composerMode.selectOption('bypassPermissions');
  await expect(composerMode).toHaveValue('bypassPermissions');
});

test('지난 세션은 사이드바가 아니라 새 세션 모달에 있다', async ({ page }) => {
  await page.goto(servers.echo.url);
  // 사이드바에서 사라졌다(섹션 헤더·행 모두).
  await expect(page.locator('.sidebar').getByText('지난 세션')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toContainText('“+ 새 세션”에서 이어갈 수 있습니다');

  // 모달을 열면 시딩된 히스토리가 최신순으로 보인다.
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  const pastList = dialog.getByRole('group', { name: /지난 세션/ });
  await expect(pastList.locator('.past-row')).toHaveCount(2);
  await expect(pastList.locator('.past-row').first()).toContainText('E2E 씨앗 알파');
  await expect(pastList.locator('.past-row').nth(1)).toContainText('E2E 씨앗 베타');
});

test('설정의 기본 권한 모드가 새 세션 모달의 초기값이 된다', async ({ page }) => {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '설정' }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  await settings.getByLabel('기본 권한 모드').selectOption('plan');
  // 모델 목록은 CLI init 전이라 비어 있어야 하고, 셀렉트는 비활성이어야 한다.
  await expect(settings.getByLabel('기본 모델')).toBeDisabled();
  await settings.getByRole('button', { name: '닫기' }).click();
  await expect(settings).toBeHidden();

  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog.locator('label:has-text("권한 모드") select')).toHaveValue('plan');
});

test('지난 세션 재개 — 모달에서 고른 모델·권한 모드가 실제 스폰에 반영된다', async ({ page }) => {
  // 모델 목록은 CLI init이 알려주므로, 먼저 세션을 한 번 시작해 카탈로그를 채운다.
  await startSession(page, servers.echo.url);
  const composerMode = page.getByLabel('권한 모드');
  const modelPill = page.locator('.model-menu-btn').first();
  // 표시 모델은 assistant 응답이 실어 보내므로 한 턴을 돌린다.
  // 기본 스폰(--model 생략) = fake CLI 카탈로그의 default 행 → Opus.
  await page.getByLabel('메시지 입력').fill('ping');
  await page.getByLabel('메시지 입력').press('Enter');
  await expect(modelPill).toContainText('Opus');

  // 이제 모달에서 모델·모드를 골라 지난 세션을 재개한다.
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await dialog.locator('label:has-text("모델") select').selectOption('sonnet');
  await dialog.locator('label:has-text("권한 모드") select').selectOption('plan');
  await dialog.locator('.past-resume', { hasText: 'E2E 씨앗 알파' }).click();
  await expect(dialog).toBeHidden();

  // 재개된 세션의 컴포저가 두 선택을 모두 반영해야 한다.
  // - 모델: fake CLI가 --model에서 자기 보고 모델을 파생하므로, 피커 라벨이
  //   Sonnet으로 바뀌는 것은 인자가 CLI까지 도달했다는 종단 증거다.
  // - 권한 모드: 여기서 보이는 값은 클라이언트가 start 옵션으로 시딩한 것이라
  //   "모달 선택 → WS start 페이로드"까지의 배선을 증명한다. 그 뒤(start →
  //   --permission-mode argv)는 server.integration.test.js가 argv로 단언한다.
  const input = page.getByLabel('메시지 입력');
  await expect(input).toBeEnabled();
  await expect(composerMode).toHaveValue('plan');
  await input.fill('ping');
  await input.press('Enter');
  await expect(modelPill).toContainText('Sonnet');
});

// 파괴적 — 시딩된 히스토리를 실제로 지우므로 이 파일의 마지막에 둔다.
// 자기 시드를 먼저 되살려 재시도(CI retries)에도 결정적으로 동작한다.
test('지난 세션 삭제 — 확인 후 목록에서 사라진다', async ({ page }) => {
  reseed(SEED_BETA);
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  const pastList = dialog.getByRole('group', { name: /지난 세션/ });
  await expect(pastList.locator('.past-row')).toHaveCount(2);

  await pastList.getByRole('button', { name: '세션 삭제: E2E 씨앗 베타' }).click();
  const confirm = page.getByRole('dialog', { name: '세션 삭제 확인' });
  await expect(confirm).toContainText('되돌릴 수 없습니다');
  await confirm.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(confirm).toBeHidden();

  await expect(pastList.locator('.past-row')).toHaveCount(1);
  await expect(pastList).not.toContainText('E2E 씨앗 베타');
});
