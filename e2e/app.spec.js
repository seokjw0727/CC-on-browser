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
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

test('정보 모달 — 앱·데몬·CLI 버전을 bootstrap 한 번으로 채운다', async ({ page }) => {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '정보' }).click();
  const info = page.getByRole('dialog', { name: '정보' });
  await expect(info).toBeVisible();
  for (const label of ['앱(번들) 버전', '데몬 버전', 'Claude CLI 버전', '플랫폼', '포트']) {
    await expect(info.getByText(label, { exact: true })).toBeVisible();
  }
  // 포트는 실제로 떠 있는 서버의 것이라 반드시 값이 있다 — '알 수 없음'이면 배선이 끊긴 것.
  const port = new URL(servers.echo.url).port;
  await expect(info.locator('.info-value', { hasText: new RegExp(`^${port}$`) })).toBeVisible();

  // ----- 버전 배선 회귀 가드 -----
  // 왜 여기인가: 이 모달은 /api/bootstrap 응답으로만 채워지므로 **열람 자체가 bootstrap
  // 완료와 동기**다. 스큐를 토스트로 관측하지 않는 것도 의도적이다 — 에러 토스트는 6초
  // 뒤 스스로 사라져(Toasts.jsx의 TOAST_MS), 언제 재느냐에 따라 결과가 뒤집힌다.
  const valueOf = (label) =>
    info.locator('.info-row').filter({ has: page.getByText(label, { exact: true }) }).locator('.info-value');

  // ㉠ 서버가 자기 버전을 아예 안 실었는가 — 이번 회귀의 정확한 모양이다.
  //    실측: scripts/dev-fake.mjs가 startServer에 version을 넘기지 않아 bootstrap이
  //    version:null을 돌려줬고, 클라이언트가 그걸 "구버전 데몬"으로 판정해 매 페이지
  //    로드마다 거짓 스큐 에러 토스트를 띄웠다. 그 토스트가 채팅 상단 "이전 메시지 더
  //    보기" 버튼을 덮어 윈도잉 E2E의 클릭을 흔들었다(릴리스 3회 차단).
  //    이 단언은 번들 신선도와 무관하다 — 값의 존재만 본다.
  await expect(valueOf('데몬 버전')).not.toHaveText(/^알 수 없음$/);

  // ㉡ 사용자에게 보이는 결과까지: 스큐 경고가 없어야 한다. 배너는 토스트와 달리
  //    사라지지 않으므로 시간 경합이 없다. 다만 이 단언은 client/dist가 지금
  //    package.json 버전으로 빌드돼 있음을 전제한다 — 번들 버전은 빌드 시각에 박힌다.
  //    (ci.yml은 e2e 앞에 npm run build를, release.yml은 npm pack을 먼저 돌리므로 CI는
  //     항상 만족한다. 로컬에서 버전을 올린 뒤 빌드를 건너뛰면 여기서 걸린다 — 의도된 신호다.)
  await expect(valueOf('데몬 버전')).toHaveText(await valueOf('앱(번들) 버전').innerText());
  await expect(info.locator('.info-skew')).toHaveCount(0);

  await expect(info.getByRole('link', { name: /GitHub/ })).toHaveAttribute('rel', /noopener/);
  await info.getByRole('button', { name: '닫기' }).click();
  await expect(info).toBeHidden();
});

test('설정 모달 — 네 탭이 있고 선택된 탭의 패널만 보인다', async ({ page }) => {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '설정' }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  await expect(settings.getByRole('tab')).toHaveCount(4);
  // 기본 선택은 테마 — 세션 탭의 컨트롤은 아직 숨어 있어야 한다.
  await expect(settings.getByRole('tab', { name: '테마' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByLabel('기본 권한 모드')).toBeHidden();
  await settings.getByRole('tab', { name: '세션' }).click();
  await expect(settings.getByLabel('기본 권한 모드')).toBeVisible();
  // 업데이트 확인은 버튼을 눌러야만 나간다 — 탭에 들어가는 것만으로는 아무 일도 없다.
  await settings.getByRole('tab', { name: '업데이트' }).click();
  await expect(settings.getByRole('button', { name: '확인', exact: true })).toBeVisible();
  await expect(settings.locator('.update-status')).toBeEmpty();
});

test('설정의 기본 권한 모드가 새 세션 모달의 초기값이 된다', async ({ page }) => {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '설정' }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  // 기본값은 '세션' 탭으로 들어갔다(테마·플러그인·업데이트와 성격이 달라 분리).
  await settings.getByRole('tab', { name: '세션' }).click();
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

// ----- 채팅 목록 윈도잉(client/src/lib/chat-window.js) 계약 -----
// bulk 시나리오가 한 프롬프트에 assistant 메시지 500개를 뱉는다 — CLI→서버→WS→리듀서
// 경로를 그대로 통과시켜야 실제 회귀를 잡는다(페이지 상태 직접 주입은 그 경로를 건너뛴다).
// 기본 창 200개이므로 500개는 창 경계를 넘긴다.
// 창에 들어온 아이템 수 — 창 200개는 assistant 메시지뿐 아니라 사용자 발화·
// 턴 사용량 아이템도 함께 센다(리듀서가 만드는 message 아이템 단위가 창의 단위다).
const winItems = (page) => page.locator('.msg-list > *:not(.load-earlier)');
// 본문만 본다 — 메시지 div에는 시각 꼬리표(.msg-time)도 함께 들어 있어
// 전체 텍스트를 단언하면 시각까지 딸려 온다.
const bulkMsgs = (page) => page.locator('.msg-list .msg-assistant .markdown-body');

// prompt에 'raw'가 들어가면 fake CLI가 미지 이벤트를 하나 더 흘린다(디버그 토글 관측용).
// 그 아이템은 디버그가 꺼져 있으면 렌더되지 않으므로 보이는 개수가 하나 줄어든다.
async function startBulkSession(page, { prompt = 'bulk', visible = 200 } = {}) {
  await startSession(page, servers.bulk.url);
  const input = page.getByLabel('메시지 입력');
  await input.fill(prompt);
  await input.press('Enter');
  // 창 상한이 곧 관측 지점 — 500개를 보내도 창 200개에서 멈춰야 한다.
  await expect(winItems(page)).toHaveCount(visible);
}

test('윈도잉 — 500개를 받아도 기본 창 200개만 DOM에 남고 "더 보기"가 나타난다', async ({ page }) => {
  await startBulkSession(page);
  // 창의 첫 메시지는 300번(=500-200)이어야 한다 — 꼬리 200개.
  await expect(bulkMsgs(page).first()).toHaveText('bulk-301');
  await expect(bulkMsgs(page).last()).toHaveText('bulk-499');
  // 창 밖 302개 = 전체 502 - 창 200.
  await expect(page.locator('.load-earlier-btn').first()).toContainText('302');
  // 하단 자동 고정은 유지된다(대량 유입이 "사용자 스크롤"로 오인되지 않아야 한다).
  expect(
    await page.evaluate(() => {
      const el = document.querySelector('.chat-scroll');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }),
  ).toBe(true);
});

test('윈도잉 — "더 보기"는 한 단계만 열고 읽던 위치를 유지한다', async ({ page }) => {
  await startBulkSession(page);
  // 버튼이 보이는 위치까지 올린다(사용자가 버튼을 보고 누르는 상황).
  await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0; });
  // 타자기 출력이 끝나야 높이가 확정된다 — 진행 중에 재면 위치가 계속 움직인다.
  await expect(bulkMsgs(page).first()).toHaveText('bulk-301');
  await expect(page.getByText('bulk-305', { exact: true })).toHaveText('bulk-305');
  const anchorTop = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('.msg-list .msg-assistant .markdown-body')]
        .find((e) => e.innerText.trim() === 'bulk-305');
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    });
  const before = await anchorTop();
  await page.locator('.load-earlier-btn').first().click();
  // 전체가 아니라 한 단계(200개)만 더 — 창 400개.
  await expect(winItems(page)).toHaveCount(400);
  await expect(bulkMsgs(page).first()).toHaveText('bulk-101');
  // 위에 200개가 붙어도 읽던 메시지는 화면에서 움직이지 않는다.
  expect(Math.abs((await anchorTop()) - before)).toBeLessThanOrEqual(4);
  // 새로 드러난 과거 메시지는 등장 애니메이션을 타지 않는다.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('.msg-list .msg-enter')].filter((e) =>
        /^bulk-1\d\d$/.test(e.innerText.trim()),
      ).length,
    ),
  ).toBe(0);
});

test('윈도잉 — "모두 불러오기"는 하단으로 돌아와도 유지되고, "↓ 최신으로"가 창을 되돌린다', async ({ page }) => {
  await startBulkSession(page);
  await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0; });
  await page.locator('.load-earlier-btn.subtle').click();
  // 전부 = 사용자 발화 1 + assistant 500 + 턴 사용량 1
  await expect(winItems(page)).toHaveCount(502);
  // 버튼이 사라진 자리에 안내가 남고 포커스가 그리로 옮겨간다(키보드 접근성).
  const done = page.locator('.load-earlier.done');
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();

  // 하단으로 내려가도 펼친 상태가 풀리면 안 된다 — 풀리면 Ctrl+F 복원 계약이 깨진다.
  await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    el.scrollTop = el.scrollHeight;
  });
  await expect(winItems(page)).toHaveCount(502);
  // 다만 접는 버튼은 하단에서도 남아 있어야 한다 — 펼친 동안은 대화 전체가 DOM에
  // 있는데 되돌리는 조작이 이것뿐이라, 숨기면 접으려고 위로 스크롤해야 한다.
  await expect(page.locator('.jump-latest')).toHaveText('최근 200개만 보기');
  await page.locator('.jump-latest').click();
  await expect(winItems(page)).toHaveCount(200);

  // 위로 읽는 중에는 같은 버튼이 "최신으로" 역할을 한다.
  await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0; });
  await expect(page.locator('.jump-latest')).toContainText('최신으로');
  await page.locator('.jump-latest').click();
  await expect(winItems(page)).toHaveCount(200);
});

test('윈도잉 — /clear는 이전 대화를 위로 숨기고, "모두 불러오기"로 되살아난다', async ({ page }) => {
  await startBulkSession(page);
  await expect(bulkMsgs(page).first()).toHaveText('bulk-301'); // 타자기 출력 종료 대기
  // 턴이 끝나기 전에는 컴포저가 전송을 거부한다(idle 불변식) — 상태 점이 대기가 될 때까지.
  await expect(page.locator('.sess-dot.st-idle').first()).toHaveAttribute('aria-label', '상태: 대기');

  const input = page.getByLabel('메시지 입력');
  // 후행 공백으로 커맨드 드롭다운을 닫는다 — 열려 있으면 Enter가 "항목 선택"으로 삼켜진다.
  await input.fill('/clear ');
  await input.press('Enter');

  // 초기화 구분선이 창의 **첫 아이템**이 된다 = 그 위 502개가 전부 숨었다.
  const divider = page.locator('.msg-cleared');
  await expect(divider).toBeVisible();
  await expect(winItems(page).first()).toHaveClass(/msg-cleared/);
  await expect(bulkMsgs(page)).toHaveCount(0); // 이전 대화는 DOM에 남지 않는다
  // 숨긴 것이지 지운 게 아니다 — 기존 버튼이 그 개수를 그대로 안내한다.
  await expect(page.locator('.load-earlier-btn').first()).toContainText('502');

  // "모두 불러오기" — 숨었던 기록이 그대로 되살아난다.
  await page.locator('.load-earlier-btn.subtle').click();
  await expect(bulkMsgs(page).first()).toHaveText('bulk-0');
  await expect(bulkMsgs(page)).toHaveCount(500);
  await expect(divider).toBeVisible(); // 구분선은 제자리(과거와 현재 사이)

  // 하단으로 돌아와도 펼친 상태는 유지되고, 접기 버튼 문구는 **접었을 때 남는 것**을
  // 말한다 — 경계가 있으므로 "최근 200개"가 아니라 "최근 대화".
  await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    el.scrollTop = el.scrollHeight;
  });
  await expect(bulkMsgs(page)).toHaveCount(500);
  await expect(page.locator('.jump-latest')).toHaveText('최근 대화만 보기');

  // 접으면 다시 경계 아래로.
  await page.locator('.jump-latest').click();
  await expect(bulkMsgs(page)).toHaveCount(0);
  await expect(winItems(page).first()).toHaveClass(/msg-cleared/);
});

test('윈도잉 — raw 디버그 토글이 memo에 삼켜지지 않는다', async ({ page }) => {
  // Message가 memo라 store의 debugRaw 변화가 prop으로 내려가지 않으면 기존 메시지가
  // 다시 그려지지 않는다. 토글 → 즉시 반영이 계약이다.
  // 'raw' 프롬프트로 미지 구조화 이벤트를 유도한다 → kind:'raw' 아이템(기본 숨김).
  await startBulkSession(page, { prompt: 'raw', visible: 199 });
  // 턴이 끝날 때까지 기다린다 — fake CLI는 bulk 500개 → raw 프로브 → result 순서라,
  // 여기서 기다리지 않으면 창 개수 199는 "raw가 숨겨져서"가 아니라 "아직 안 와서"
  // 맞아떨어질 수 있고(스트리밍 중 198개 지점), 그러면 아래 토글은 기존 메시지를
  // 드러내는 게 아니라 새로 도착한 메시지를 그리는 것이라 memo 계약을 검증하지
  // 못한다(codex 지적). 사용량 아이템은 result 이후에만 생긴다.
  await expect(page.locator('.msg-list .msg-usage')).toHaveCount(1);
  await expect(winItems(page)).toHaveCount(199);
  await expect(page.locator('.msg-raw')).toHaveCount(0);

  await page.getByRole('button', { name: '설정' }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  await settings.getByRole('tab', { name: '세션' }).click();
  await settings.getByRole('switch', { name: '디버그 메시지 표시' }).click();
  await settings.getByRole('button', { name: '닫기' }).click();
  // 토글 직후, 새 메시지 없이 기존 raw 이벤트가 드러나야 한다.
  await expect(page.locator('.msg-raw').first()).toBeVisible();
});

test('세션 전환 — 되돌아온 세션의 기존 메시지는 등장 애니를 다시 타지 않는다', async ({ page }) => {
  // 등장 워터마크는 ref라 "렌더 중 리셋"이 통하지 않는다. 렌더 중 setState는 그 렌더를
  // 폐기하고 다시 렌더하는데, 실제로 커밋되는 그 두 번째 렌더에서는 전환 감지 플래그가
  // 이미 false다. 워터마크가 이전 세션 값으로 남으면 돌아온 세션의 기존 대화가 통째로
  // "새 메시지"로 판정돼 애니가 재생된다 — 창 안 메시지 수만큼.
  await startBulkSession(page); // 세션 A: 502개(창 200)
  // 여기서 msg-enter가 0인지는 단언하지 않는다 — 방금 도착한 200개는 실제로 새
  // 메시지라 클래스가 붙어 있는 게 맞고, 그게 벗겨지는 건 이후 ChatView 렌더가
  // 우연히 한 번 더 도는지에 달려 있어 환경마다 다르다(로컬 0 / CI 200).
  // 관측 기준선은 아래에서 B로 전환한 뒤 잡는다.

  // 세션 B를 같은 페이지에서 새로 연다 — 메시지 0개라 워터마크가 A보다 훨씬 작아진다.
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await dialog.getByLabel('작업 디렉터리 경로').fill(process.cwd());
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
  await expect(page.locator('.sess-row.live')).toHaveCount(2);

  // msg-enter는 다음 렌더에서 떨어지는 일시적 클래스다 — 재시도형 단언으로 나중에 세면
  // 이미 0이라 회귀를 놓친다. 전환 직전에 관측기를 심어 "한 번이라도 붙었는지"를 본다.
  await page.evaluate(() => {
    window.__maxEnter = 0;
    const tick = () => {
      const n = document.querySelectorAll('.msg-list .msg-enter').length;
      if (n > window.__maxEnter) window.__maxEnter = n;
    };
    window.__enterObs = new MutationObserver(tick);
    window.__enterObs.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    tick();
  });
  // 기준선 — B 화면에는 애니 대상이 없어야 한다. 여기가 0이 아니면 아래 단언은
  // 회귀가 아니라 오염된 기준선을 보고 실패하는 것이다.
  expect(await page.evaluate(() => window.__maxEnter)).toBe(0);

  // A로 되돌아간다(비활성 라이브 행 = A).
  await page.locator('.sess-row.live:not(.active) .sess-main').click();
  await expect(bulkMsgs(page).last()).toHaveText('bulk-499');
  await expect(winItems(page)).toHaveCount(200);
  expect(await page.evaluate(() => window.__maxEnter)).toBe(0);
});

// 입력창 위 배지 정리(2026-07-30 요청) — 울트라코드·권한 상승 배지는 사라지고
// 목표만 'GOAL' 한 단어로 남는다. 단언이 무의미해지지 않도록 신뢰모드와 울트라코드를
// **실제로 활성화한 뒤** 배지 부재를 확인한다(codex 지적).
test('컴포저 배지 — 울트라코드·신뢰모드 배지 없음, 목표는 GOAL + hover/포커스 툴팁', async ({ page }) => {
  await startSession(page, servers.echo.url, { permissionMode: 'bypassPermissions' });
  await expect(page.getByLabel('권한 모드')).toHaveValue('bypassPermissions');

  // 노력 수준을 울트라코드로 — 슬라이더를 최상위로 밀면 **재시작 없이** 즉시 적용된다
  // (End 키 = ARIA slider 규약. 팝오버가 열리면 슬라이더로 포커스가 간다).
  await page.locator('.model-menu-btn').nth(1).click();
  const slider = page.getByRole('slider', { name: '노력 수준' });
  await expect(slider).toBeFocused();
  await slider.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', '울트라코드');
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
  await expect(page.locator('.model-menu-btn').nth(1)).toContainText('울트라코드');
  // 런타임 적용이라 세션이 그대로 이어진다 — 신뢰모드도 당연히 유지된다.
  await expect(page.getByLabel('권한 모드')).toHaveValue('bypassPermissions');
  await page.keyboard.press('Escape'); // 팝오버 닫기(다음 단계의 입력 조작과 겹치지 않게)

  // 목표 설정 — 인자가 붙으면 `/` 드롭다운이 닫히므로 Enter가 그대로 전송된다.
  const input = page.getByLabel('메시지 입력');
  await input.fill('/goal 리팩터 마무리');
  await input.press('Enter');

  const goalBadge = page.locator('.mode-badge.goal');
  await expect(goalBadge).toHaveText('GOAL');
  await expect(goalBadge).toHaveAttribute('data-tip', '활성 목표: 리팩터 마무리');
  // 둘 다 활성인데도 배지는 없다 = 안내 배지가 제거됐다.
  await expect(page.locator('.mode-badge.ultra')).toHaveCount(0);
  await expect(page.locator('.mode-badge.perm')).toHaveCount(0);

  // hover로 목표 전문이 실제로 뜬다 — data-tip 값만 보면 툴팁 배선이 끊겨도 통과한다.
  await goalBadge.hover();
  await expect(page.locator('#app-tooltip')).toContainText('리팩터 마무리');

  // 키보드로도 읽을 수 있어야 한다. 프로그램적 focus()가 아니라 키보드 이동이어야
  // :focus-visible이 걸려 툴팁이 뜬다. DOM 인접성에 못 박지 않도록 입력창에서
  // 역방향 탭을 제한 횟수만큼 밟아 배지에 닿는지로 확인한다.
  await input.focus();
  for (let i = 0; i < 6 && !(await goalBadge.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Shift+Tab');
  }
  await expect(goalBadge).toBeFocused();
  await expect(page.locator('#app-tooltip')).toContainText('리팩터 마무리');
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

test('원격 제어 — 사이드바 우클릭으로 켜고 끄며, 실패 사유가 토스트로 뜬다', async ({ page }) => {
  // 가짜 CLI는 FAKE_RC 기본값(fail)으로 로그인 실패 문구를 내고 즉시 종료한다.
  // 여기서 보는 것은 "메뉴가 실제로 서버까지 명령을 보내고, 돌아온 상태가 UI 세 곳
  // (메뉴 라벨·행 아이콘·토스트)에 같은 사실로 나타나는가"다 — 실제 claude.ai
  // 연결은 e2e에서 만들지 않는다. 컴포저 pill은 제거됐으므로 관측 지점도 여기뿐이다.
  await startSession(page, servers.echo.url);
  const row = page.locator('.sess-row.live').first();
  const menu = page.getByRole('menu', { name: '세션 메뉴' });
  const remoteIcon = row.getByRole('img', { name: /원격 제어/ });

  // 컴포저에는 원격 제어 컨트롤이 하나도 남아 있지 않다(이 작업의 수용 기준).
  await expect(page.locator('.remote-pill')).toHaveCount(0);

  // 원격 제어 상태는 **서버가** 들고 있어 페이지를 새로 열어도 남는다 — 앞선
  // 실행이 켜 둔 채 끝났을 수 있으므로 먼저 꺼짐으로 맞춘다.
  await row.click({ button: 'right' });
  const turnOff = menu.getByRole('menuitem', { name: '원격 제어 끄기' });
  if (await turnOff.count()) {
    await turnOff.click();
    await expect(remoteIcon).toHaveCount(0, { timeout: 15_000 });
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(menu).toHaveCount(0);
  await expect(remoteIcon).toHaveCount(0);

  // 꺼진 상태에서는 "켜기"
  await row.click({ button: 'right' });
  const turnOn = menu.getByRole('menuitem', { name: '원격 제어 켜기' });
  await expect(turnOn).toBeEnabled();
  await turnOn.click();
  await expect(menu).toHaveCount(0);
  // 낙관적 갱신을 하지 않으므로, 즉시 보이는 피드백은 "보냈다"는 토스트뿐이다.
  await expect(
    page.locator('.toast-text').filter({ hasText: '원격 제어를 켜는 중입니다' }),
  ).toBeVisible();

  // 명령이 서버까지 갔다는 증거 ① — 실패 사유가 CLI 원문 그대로 토스트에 실린다.
  // (pill 팝오버가 하던 일을 store.jsx의 상태 전이 감시가 이어받았다.)
  await expect(
    page.locator('.toast-text').filter({ hasText: 'logged in' }),
  ).toBeVisible({ timeout: 15_000 });
  // 증거 ② — 행에 원격 제어 표시가 붙는다(실패도 "켜져 있는 상태"다).
  await expect(remoteIcon).toHaveCount(1);

  // 켜진(=실패로 붙잡힌) 상태에서는 같은 자리가 "끄기"로 뒤집히고, 사유를 다시 볼 수 있다
  await row.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '원격 제어 켜기' })).toHaveCount(0);
  const offItem = menu.getByRole('menuitem', { name: '원격 제어 끄기' });
  await expect(offItem).toHaveAttribute('data-tip', /logged in/);
  await offItem.click();
  // 끄면 실패 상태까지 정리된다 — 행 표시가 사라진다
  await expect(remoteIcon).toHaveCount(0, { timeout: 15_000 });

  // 그리고 메뉴도 다시 "켜기"로 돌아와 있다(막다른 길이 없다)
  await row.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '원격 제어 켜기' })).toBeVisible();
  // 주소가 없는 실패 상태에서는 "열기" 항목이 뜨지 않는다(ready 경로는 단위 테스트가 덮는다)
  await expect(menu.getByRole('menuitem', { name: 'claude.ai/code에서 열기' })).toHaveCount(0);
});

test('노력 수준 변경 — 세션 재시작 없이 즉시 적용된다', async ({ page }) => {
  // 이 프로젝트의 회귀 하나를 못박는다: 구버전 데몬이 남아 setEffort를 모르면
  // 클라이언트가 ack 타임아웃 뒤 --resume 재시작으로 폴백해, 사용자에겐 "노력 수준을
  // 바꿨더니 세션이 새로 떴다"로 보였다. 가짜 CLI는 apply_flag_settings를 지원하므로
  // 여기서는 런타임 채널이 실제로 성립하는지(=재시작이 없는지)를 본다.
  await startSession(page, servers.echo.url);
  const input = page.getByLabel('메시지 입력');
  // 재시작이 일어나면 대화가 새 탭으로 이월되므로, 먼저 흔적을 하나 남겨 둔다.
  await input.fill('노력 수준 전 메시지');
  await input.press('Enter');
  await expect(page.getByText(/echo: 노력 수준 전 메시지/).first()).toBeVisible();

  // 사이드바 행 버튼의 접근 이름에도 세션 제목이 실려 /노력/에 걸린다 — 컴포저로 한정한다.
  const picker = page.locator('.composer-foot').getByRole('button', { name: /노력/ });
  await picker.click();
  const slider = page.getByRole('slider', { name: '노력 수준' });
  await expect(slider).toBeVisible();
  const before = await slider.getAttribute('aria-valuenow');

  // 키보드로 한 칸 올린다(드래그보다 결정적이다). 커밋은 180ms 디바운스 뒤에 나간다.
  await slider.focus();
  await slider.press('ArrowRight');

  // 성공 토스트 = 런타임 채널로 적용됐다는 뜻. 폴백이면 "세션을 재시작합니다"가 뜬다.
  await expect(
    page.locator('.toast-text').filter({ hasText: '노력 수준 변경' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.toast-text').filter({ hasText: '재시작' }),
  ).toHaveCount(0);

  // 표시도 실제로 올라갔다(서버의 effortSet 방송이 반영된 결과)
  await expect(slider).not.toHaveAttribute('aria-valuenow', before ?? '0');

  // 그리고 세션은 그대로다 — 재시작이었다면 이 메시지가 새 탭으로 옮겨지며
  // 사이드바 행도 갈렸을 것이다. 대화가 남아 있고 행은 하나뿐이어야 한다.
  await page.keyboard.press('Escape');
  await expect(page.getByText(/echo: 노력 수준 전 메시지/).first()).toBeVisible();
  await expect(page.locator('.sess-row.live')).toHaveCount(1);
  // 이어서 보낸 메시지도 같은 세션에서 답한다
  await input.fill('노력 수준 후 메시지');
  await input.press('Enter');
  await expect(page.getByText(/echo: 노력 수준 후 메시지/).first()).toBeVisible();
});

test('모델 변경 — CLI가 수용한 뒤에 피커가 바뀌고, 이후 턴에도 저 혼자 되돌아가지 않는다', async ({ page }) => {
  // 회귀 못박기: 예전 컴포저는 소켓 write가 성공하면 곧바로 피커를 바꿨다(낙관 갱신).
  // CLI가 그 모델을 거부해도 화면만 새 모델로 남았고, 반대로 진행 중 턴이 보고하는
  // 이전 모델을 그대로 수확해 사용자가 고른 값이 저절로 되돌아가기도 했다. 이제 표시는
  // 서버의 modelSet 방송(=CLI 수용) 하나로만 바뀐다.
  await startSession(page, servers.echo.url);
  const input = page.getByLabel('메시지 입력');
  const modelPill = page.locator('.model-menu-btn').first();
  // 먼저 한 턴을 돌린다. 모델 라벨은 CLI의 init/assistant 보고가 도착해야 채워지므로
  // 세션 시작 직후에 바로 단언하면 아직 '모델'인 순간을 잡는다 — 같은 이유로 재개 테스트도
  // 'ping'을 먼저 보낸다. 겸사겸사 이 메시지가 아래에서 '재시작이 아니었다'의 증거가 된다.
  await input.fill('모델 변경 전 메시지');
  await input.press('Enter');
  await expect(page.getByText(/echo: 모델 변경 전 메시지/).first()).toBeVisible();
  // 기본 스폰(--model 생략) = 가짜 CLI 카탈로그의 default 행 → Opus.
  await expect(modelPill).toContainText('Opus');

  await modelPill.click();
  await page.getByRole('menuitemradio', { name: /Sonnet/ }).click();

  // 성공 토스트는 ack를 받았다는 뜻이고, 라벨 변경은 리듀서가 그 방송을 반영했다는 뜻이다.
  // 콜론까지 포함해 맞춘다 — 실패 토스트도 '모델 변경이 적용됐는지…'로 시작해 부분 일치로는
  // 둘을 구별하지 못한다(토스트 종류는 부모 요소에만 붙는다).
  await expect(
    page.locator('.toast:not(.error) .toast-text').filter({ hasText: '모델 변경: ' }),
  ).toBeVisible({ timeout: 15_000 });
  // 실패 안내가 함께 뜨지 않았는지도 확인한다. 전역 오류 토스트 수를 세면 이 테스트가
  // 무관한 토스트에 흔들린다(과거 릴리스를 세 번 막은 실패 양상이 정확히 그것이었다) —
  // 이 창구의 실패 문구만 좁혀서 본다.
  await expect(
    page.locator('.toast.error .toast-text')
      .filter({ hasText: /모델(을 바꾸지 못했습니다| 변경이 적용됐는지)/ }),
  ).toHaveCount(0);
  await expect(modelPill).toContainText('Sonnet');

  // 그리고 다음 턴이 끝나도 그대로다 — assistant가 보고하는 모델을 수확하는 경로가
  // 사용자의 선택을 덮지 않는지 본다(가짜 CLI는 set_model 이후 새 모델을 보고한다).
  await input.fill('모델 변경 후 메시지');
  await input.press('Enter');
  await expect(page.getByText(/echo: 모델 변경 후 메시지/).first()).toBeVisible();
  await expect(modelPill).toContainText('Sonnet');
  // 재시작이 아니라 런타임 변경이다 — 재시작이었다면 대화가 새 탭으로 옮겨지며 사이드바
  // 행이 갈렸을 것이다. 변경 전 대화가 그대로 남아 있고 행은 하나여야 한다.
  await expect(page.getByText(/echo: 모델 변경 전 메시지/).first()).toBeVisible();
  await expect(page.locator('.sess-row.live')).toHaveCount(1);
});

test('메시지 타임스탬프 — 사용자 메시지와 답변에 HH:MM이 붙는다', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const input = page.getByLabel('메시지 입력');
  await input.fill('시각 표시 확인');
  await input.press('Enter');
  await expect(page.getByText(/echo: 시각 표시 확인/).first()).toBeVisible();

  // 사용자 말풍선과 어시스턴트 답변 각각에 <time>이 하나씩
  const userTime = page.locator('.msg-user .msg-time');
  const asstTime = page.locator('.msg-assistant .msg-time');
  await expect(userTime.first()).toBeVisible();
  await expect(asstTime.first()).toBeVisible();
  await expect(userTime.first()).toHaveText(/^\d{2}:\d{2}$/);
  await expect(asstTime.first()).toHaveText(/^\d{2}:\d{2}$/);
  // 접근성: 기계가 읽을 ISO도 함께 실린다
  await expect(asstTime.first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);

  // 시각은 사용자·어시스턴트 메시지에만 — 총 개수가 그 메시지 수와 같다
  await expect(page.locator('.msg-time')).toHaveCount(
    await page.locator('.msg-user, .msg-assistant').count(),
  );
});

test('메시지 타임스탬프 — 사용자·어시스턴트 메시지에만 정확히 하나씩 붙는다', async ({ page }) => {
  // echo 시나리오만으로는 "제외"가 공허하게 통과한다(codex 지적) — 다른 종류의 아이템이
  // 함께 있는 권한 시나리오에서, 시각의 총 개수가 사용자+어시스턴트 메시지 수와
  // 정확히 같은지를 본다. 이 불변식은 어떤 아이템 종류가 더 생겨도 유지돼야 한다.
  await startSession(page, servers.permission.url);
  const input = page.getByLabel('메시지 입력');
  await input.fill('write something');
  await input.press('Enter');
  const permDialog = page.getByRole('dialog', { name: '도구 사용 권한 요청' });
  await expect(permDialog).toBeVisible();
  await permDialog.getByRole('button', { name: '허용' }).click();
  await expect(permDialog).toBeHidden();
  await expect(page.locator('.msg-user').first()).toBeVisible();

  // 사용자/어시스턴트 외의 아이템(턴 사용량 등)이 실제로 함께 있는 상태여야 의미가 있다
  const stamped = await page.locator('.msg-user, .msg-assistant').count();
  const others = await page.locator('.msg-list > *:not(.load-earlier)').count() - stamped;
  expect(others).toBeGreaterThan(0);

  await expect(page.locator('.msg-time')).toHaveCount(stamped);
  await expect(page.locator('.msg-user .msg-time')).toHaveCount(
    await page.locator('.msg-user').count(),
  );
});

test('실행 중 도크 — 입력창 박스 밖에 뜨고, 항목을 펼쳐 대화로 이동한다', async ({ page }) => {
  await startSession(page, servers.bgtask.url);
  const input = page.getByLabel('메시지 입력');
  await input.fill('백그라운드로 돌려줘');
  await input.press('Enter');

  const dock = page.locator('.running-dock');
  await expect(dock).toBeVisible();
  await expect(dock.locator('.dock-count')).toContainText('실행 중 1개');
  await expect(dock.locator('.dock-label')).toHaveText('sleep 40');
  await expect(dock.locator('.dock-item .dock-detail')).toHaveText('백그라운드 셸');

  // 위치 — 입력창(textarea) **아래**이면서, 입력 박스(.composer-shell) **밖**이어야 한다
  const inputBox = await input.boundingBox();
  const dockBox = await dock.boundingBox();
  expect(dockBox.y).toBeGreaterThan(inputBox.y);
  await expect(page.locator('.composer-shell .running-dock')).toHaveCount(0);

  // 행 클릭 = 펼치기(점프가 아니다). aria-controls는 패널이 실재할 때만 건다.
  const item = dock.locator('.dock-item');
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await item.click();
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  const panel = dock.locator('.dock-panel');
  await expect(panel).toBeVisible();
  await expect(item).toHaveAttribute('aria-controls', await panel.getAttribute('id'));

  // 점프는 상세 안의 명시적 버튼으로만 — 해당 도구 카드로 이동 + 잠깐 강조
  await dock.locator('.dock-jump').click();
  const flashed = page.locator('.msg-jump-flash');
  await expect(flashed).toHaveCount(1);
  await expect(flashed.locator('.tool-card')).toBeVisible();
  // 대상이 화면 안에 들어와 있다
  const cardBox = await flashed.boundingBox();
  expect(cardBox.y).toBeGreaterThan(0);

  // 점프는 패널을 닫지 않는다. 포커스가 **패널 안**(방금 누른 이동 버튼)에 있는
  // 상태에서 Esc를 눌러야 "포커스를 행으로 되돌린다"는 계약이 실제로 검증된다.
  await expect(panel).toBeVisible();
  await expect(dock.locator('.dock-jump')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(item).toBeFocused();
  // 닫힌 뒤에는 가리킬 패널이 없으므로 aria-controls도 떨어진다(IDREF 유령 방지)
  await expect(item).not.toHaveAttribute('aria-controls', /./);
});

test('세션 우클릭 메뉴 — 이름 변경이 사이드바 행에 반영된다', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const row = page.locator('.sess-row.live').first();
  await expect(row).toBeVisible();

  // 우클릭 → 메뉴 → 이름 변경 → 입력 → Enter
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '세션 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '이름 변경' }).click();
  const input = page.getByLabel('세션 이름');
  await expect(input).toBeFocused();
  // 편집 중이라고 세션이 멈추는 것은 아니다 — 상태 점은 색·라벨을 그대로 유지한다.
  await expect(row.locator('.sess-dot.st-idle')).toHaveAttribute('aria-label', '상태: 대기');
  await input.fill('내가 붙인 이름');
  await input.press('Enter');

  await expect(row.locator('.sess-main')).toContainText('내가 붙인 이름');
  // 사이드바를 접으면 상단 배지도 같은 이름을 쓴다(제목 규칙 단일화)
  await page.getByRole('button', { name: '사이드바 접기' }).click();
  await expect(page.locator('.session-name-badge')).toContainText('내가 붙인 이름');
});

test('세션 우클릭 메뉴 — 키보드로 다룰 수 있다(첫 항목 포커스·화살표·Esc)', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const row = page.locator('.sess-row.live').first();
  await row.click({ button: 'right' });

  const menu = page.getByRole('menu', { name: '세션 메뉴' });
  await expect(menu).toBeVisible();
  // 열리면 곧바로 첫 항목에 포커스가 있어야 한다 — 여기가 어긋나면 화살표·Esc가
  // 전부 먹지 않는다(메뉴가 아직 숨겨진 동안 focus()가 실패하던 회귀 방지).
  await expect(menu.getByRole('menuitem', { name: '이름 변경' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // 원격 제어 항목의 라벨은 서버 상태에 따라 켜기/끄기로 뒤집힌다(앞선 테스트가
  // 같은 서버에 켜 둔 채 끝날 수 있다) — 여기서 보는 것은 순서·포커스뿐이다.
  await expect(menu.getByRole('menuitem', { name: /^원격 제어/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '세션 종료' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: '이름 변경' })).toBeFocused();
  // Esc로 닫히고, 포커스는 메뉴를 연 행으로 돌아온다
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(row.locator('.sess-main')).toBeFocused();
});

test('세션 우클릭 메뉴 — Esc는 이름 변경을 취소하고, 닫기는 세션을 종료한다', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const row = page.locator('.sess-row.live').first();

  // 우클릭을 못 쓰는 키보드 사용자의 진입점 — 행 버튼에 포커스한 뒤 Shift+F10.
  // (⋯ 버튼은 제거됐고, 이것이 남은 유일한 대체 경로다.)
  await row.locator('.sess-main').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: '세션 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '이름 변경' }).click();
  const input = page.getByLabel('세션 이름');
  await input.fill('버려질 이름');
  await input.press('Escape');
  await expect(page.getByLabel('세션 이름')).toHaveCount(0);
  await expect(row.locator('.sess-main')).not.toContainText('버려질 이름');

  // 닫기(세션 종료) → 회색 종료 점 → 유예 후 목록에서 사라짐
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '세션 종료' }).click();
  await expect(page.locator('.sess-row.live .sess-dot.st-exited')).toBeVisible();
  await expect(page.locator('.sess-row.live')).toHaveCount(0, { timeout: 10_000 });
});

test('사이드바 세션 행 — 버튼 없이 이름 + 상태 점만, 행 클릭은 메뉴를 닫는다', async ({ page }) => {
  await startSession(page, servers.echo.url);
  const row = page.locator('.sess-row.live').first();
  await expect(row).toBeVisible();

  // 행에 남는 것은 세션 버튼 하나뿐 — ⋯·✕과 상태 텍스트 배지는 전부 사라졌다.
  await expect(row.locator('.session-more')).toHaveCount(0);
  await expect(row.locator('.session-stop')).toHaveCount(0);
  await expect(row.locator('.badge')).toHaveCount(0);
  await expect(row.locator('button')).toHaveCount(1);

  // 상태는 점의 색으로만 — 화면 텍스트는 없고 라벨은 보조기술에 남는다.
  const dot = row.locator('.sess-dot');
  await expect(dot).toHaveClass(/\bst-idle\b/);
  await expect(dot).toHaveAttribute('aria-label', '상태: 대기');
  await expect(row.locator('.sess-main')).not.toContainText('대기');

  // 메뉴가 열린 채 같은 행을 좌클릭하면 닫힌다(⋯ 토글용 예외 제거 회귀 방지).
  // 메뉴는 커서 지점에서 아래·오른쪽으로 펼쳐지므로, 행 오른쪽 아래에서 열고
  // 왼쪽 위를 눌러야 메뉴가 클릭을 가로채지 않는다.
  const box = await row.boundingBox();
  await row.click({ button: 'right', position: { x: box.width - 4, y: box.height - 2 } });
  const menu = page.getByRole('menu', { name: '세션 메뉴' });
  await expect(menu).toBeVisible();
  await row.locator('.sess-main').click({ position: { x: 2, y: 2 } });
  await expect(menu).toHaveCount(0);
  // 클릭이 메뉴에 먹히지 않고 행 버튼까지 닿았다는 증거 — 세션 전환 자체는
  // 세션이 둘인 앞쪽 테스트가 검증한다(여기선 행이 하나뿐이라 무의미하다).
  await expect(row.locator('.sess-main')).toBeFocused();
});

// 설정 편집기 열기 — 세 시나리오가 공유한다. 각 테스트는 먼저 설정 파일을 자기
// 손으로 시딩/리셋한다(앞 테스트가 남긴 내용에 기대면 재시도·필터 실행에서 깨진다).
const CONFIG_FILE = path.join(here, '.state', 'claude-config', 'settings.json');

function seedConfig(content) {
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  if (content === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, content);
}

async function openConfigEditor(page) {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '설정' }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  await settings.getByRole('tab', { name: '세션' }).click();
  await settings.getByRole('button', { name: '편집' }).click();
  const editor = page.getByRole('dialog', { name: 'Claude Code Config 편집' });
  await expect(editor).toBeVisible();
  return editor;
}

test('설정 → Claude Code Config(JSON 탭) — 편집·저장이 파일에 반영되고 충돌은 거부된다', async ({ page }) => {
  seedConfig(null); // 파일 없음 상태에서 시작
  const editor = await openConfigEditor(page);

  await editor.getByRole('tab', { name: 'JSON' }).click();
  const area = editor.getByLabel('settings.json 내용');
  // 아직 파일이 없으므로 빈 객체가 기준선이다
  await expect(area).toHaveValue('{}');
  // 변경 전에는 저장이 잠겨 있다
  await expect(editor.getByRole('button', { name: '저장' })).toBeDisabled();

  // 잘못된 JSON은 저장되지 않고 문법 오류를 알린다
  await area.fill('{ "model": ');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect(editor.getByRole('alert')).toContainText('JSON 문법 오류');

  // 올바른 JSON은 저장되고 토스트로 알린다
  await area.fill('{ "model": "opus" }');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('Claude Code 설정을 저장했습니다.', { exact: false })).toBeVisible();

  // 실제 파일에 반영됐는지 확인 — 격리된 e2e 설정 파일(global-setup의 FAKE_CLAUDE_CONFIG)
  const configFile = CONFIG_FILE;
  expect(readFileSync(configFile, 'utf8')).toBe('{ "model": "opus" }');

  // 저장 뒤 기준선이 갱신돼 연속 저장이 자기 자신과 충돌하지 않는다.
  // 두 번째 저장은 토스트로 기다릴 수 없다 — 첫 저장의 토스트가 아직 떠 있으면
  // .first()가 그 옛 토스트에 즉시 매칭돼, 쓰기가 끝나기 전에 파일을 읽는다.
  // "저장됐다"의 정의 자체인 파일 내용으로 직접 기다린다.
  await area.fill('{ "model": "sonnet" }');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect.poll(() => readFileSync(configFile, 'utf8')).toBe('{ "model": "sonnet" }');

  // 외부에서 파일이 바뀌면(다른 편집기·CLI) 덮어쓰지 않고 409로 막는다
  writeFileSync(configFile, '{ "changed": "outside" }');
  await area.fill('{ "model": "haiku" }');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect(editor.getByRole('alert')).toContainText('다른 곳에서 파일이 바뀌었습니다');
  expect(readFileSync(configFile, 'utf8')).toBe('{ "changed": "outside" }');

  // 저장하지 않은 변경이 있으면 한 번에 닫히지 않는다
  await editor.getByRole('button', { name: '닫기' }).first().click();
  await expect(editor.getByRole('alert', { includeHidden: false }).last()).toContainText('저장하지 않은 변경');
  await editor.getByRole('button', { name: '변경 버리고 닫기' }).click();
  await expect(editor).toBeHidden();
});

test('Config 일반 탭 — 폼으로 고친 값이 파일에 반영되고 모르는 키는 보존된다', async ({ page }) => {
  // 폼이 다루지 않는 hooks가 있는 파일로 시작 — 저장 뒤에도 그대로여야 한다.
  seedConfig('{"hooks":{"Stop":[{"x":1}]},"model":"opus"}');
  const editor = await openConfigEditor(page);

  // 기본 탭이 폼(일반)이다
  await expect(editor.getByRole('tab', { name: '일반' })).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByLabel('모델')).toHaveValue('opus');
  // 폼이 다루지 않는 키는 "그 외 항목"으로 알리기만 한다
  await expect(editor.getByText('그 외 항목')).toBeVisible();

  await editor.getByLabel('모델').fill('sonnet');
  await editor.getByLabel('기본 권한 모드').selectOption('plan');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('Claude Code 설정을 저장했습니다.', { exact: false })).toBeVisible();

  const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  expect(saved.model).toBe('sonnet');
  expect(saved.permissions.defaultMode).toBe('plan');
  expect(saved.hooks).toEqual({ Stop: [{ x: 1 }] }); // 모르는 키 보존

  // 폼 → JSON 탭: 같은 원문을 본다(탭마다 상태가 갈리지 않는다)
  await editor.getByRole('tab', { name: 'JSON' }).click();
  await expect(editor.getByLabel('settings.json 내용')).toHaveValue(/"defaultMode": "plan"/);

  // JSON 탭에서 고친 값이 폼에 그대로 나타난다(반대 방향)
  await editor.getByLabel('settings.json 내용').fill('{"model":"haiku"}');
  await editor.getByRole('tab', { name: '일반' }).click();
  await expect(editor.getByLabel('모델')).toHaveValue('haiku');

  // 최상위가 객체가 아니면 폼은 값을 건드리지 않고 JSON 탭으로 보낸다.
  // 패널 셋은 항상 DOM에 있고 보이지 않는 쪽만 hidden이라(탭의 aria-controls가
  // 실재해야 한다) 안내 문구는 패널 범위로 좁혀 찾는다.
  await editor.getByRole('tab', { name: 'JSON' }).click();
  await editor.getByLabel('settings.json 내용').fill('[1,2]');
  await editor.getByRole('tab', { name: '일반' }).click();
  const generalPanel = editor.locator('#cfg-panel-general');
  await expect(generalPanel.getByText('폼으로 다룰 수 없습니다', { exact: false })).toBeVisible();
  await expect(editor.getByLabel('모델')).toHaveCount(0);
  // 안내 버튼은 포커스를 원문 편집기로 넘긴다(누른 버튼이 사라지므로)
  await generalPanel.getByRole('button', { name: 'JSON 탭으로 이동' }).click();
  await expect(editor.getByLabel('settings.json 내용')).toBeFocused();
});

test('Config 플러그인 탭 — 켬/끔과 항목 제거가 enabledPlugins에 반영된다', async ({ page }) => {
  // 설치 목록에 없는 찌꺼기 항목을 하나 넣어 둔다(정리 경로 확인).
  seedConfig('{"enabledPlugins":{"gone@old-market":true}}');
  const editor = await openConfigEditor(page);
  await editor.getByRole('tab', { name: '플러그인' }).click();

  // 설치 목록(global-setup 픽스처) + 설정에만 남은 항목이 함께 보인다
  await expect(editor.getByText('미설치')).toBeVisible();
  // 스코프가 둘인 항목은 설치 배지를 각각 보여 준다
  await expect(editor.getByText('사용자 v2.0.0')).toBeVisible();
  await expect(editor.getByText('프로젝트 v1.9.0')).toBeVisible();

  // 설정에 항목이 없는 행은 스위치 대신 켜기·끄기 중에서 고른다
  // ("끔"과 "설정 없음"은 다르므로 스위치 하나로는 표현할 수 없다)
  await editor.getByRole('button', { name: '켜기: e2e-alpha@e2e-market' }).click();
  const alpha = editor.getByRole('switch', { name: '플러그인 사용: e2e-alpha@e2e-market' });
  await expect(alpha).toHaveAttribute('aria-checked', 'true');

  // 찌꺼기 항목은 ✕로 제거한다(끔과 다르다 — 키 자체가 사라진다)
  await editor.getByRole('button', { name: '설정에서 항목 제거: gone@old-market' }).click();

  await editor.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('Claude Code 설정을 저장했습니다.', { exact: false })).toBeVisible();
  expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))).toEqual({
    enabledPlugins: { 'e2e-alpha@e2e-market': true },
  });
});

test('Config — 설치 목록 조회가 실패해도 나머지 편집은 막히지 않는다', async ({ page }) => {
  seedConfig('{"model":"opus","enabledPlugins":{"kept@m":true}}');
  // 목록 조회만 죽인다(설정 로드는 정상) — 두 요청이 서로 독립임을 보는 게 목적이다.
  await page.route('**/api/claude-plugins', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  const editor = await openConfigEditor(page);

  await editor.getByRole('tab', { name: '플러그인' }).click();
  await expect(editor.getByText('설치 목록을 불러오지 못했습니다', { exact: false })).toBeVisible();
  // 설정에 기록된 항목은 목록 없이도 계속 다룰 수 있다
  await expect(editor.getByRole('switch', { name: /kept@m/ })).toHaveAttribute('aria-checked', 'true');

  // 일반 탭도 평소대로 — 폼으로 고쳐 저장까지 된다
  await editor.getByRole('tab', { name: '일반' }).click();
  await editor.getByLabel('모델').fill('sonnet');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('Claude Code 설정을 저장했습니다.', { exact: false })).toBeVisible();
  expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).model).toBe('sonnet');
});
