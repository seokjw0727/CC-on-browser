// worktree 브랜치 칩과 그 패널의 E2E — fake CLI 'echo' 스택 대상. 조회 전용 계약을
// 브라우저에서 확인한다. 패널로 들어가는 문은 사이드바 하단 버튼이 아니라 입력창 아래
// 칩이다(v1.11.2 다음 변경) — 그 자리와 라벨 자체도 여기서 함께 못박는다.
//
// 이 스택의 세션 cwd는 이 레포 자신(process.cwd())이라, 패널이 상대하는 것은 픽스처가
// 아니라 **실제 git 저장소**다. 그래서 여기서만 증명되는 것이 있다: git 하위 프로세스가
// 실제로 돌고, 그 출력이 서버 파서를 지나, 레인 좌표가 SVG로 그려지기까지의 전 구간.
// 파서·레이아웃 자체의 경계 조건은 server/test/git-api.test.js가 따로 못박는다.
//
// 연결 worktree(git worktree add)는 만들지 않는다 — 개발자의 실제 레포에 부수효과를
// 남기지 않기 위해서다. 그 조합은 서버 테스트가 임시 repo에서 검증한다.
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const servers = JSON.parse(
  readFileSync(new URL('./.state/servers.json', import.meta.url), 'utf8'),
);

async function startSession(page, cwd = process.cwd()) {
  await page.goto(servers.echo.url);
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 세션' });
  await expect(dialog).toBeVisible();
  // FAKE_PLATFORM=linux라 cwd는 직접 입력 필드다(global-setup 참조).
  await dialog.getByLabel('작업 디렉터리 경로').fill(cwd);
  await dialog.getByRole('button', { name: '세션 시작' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('메시지 입력')).toBeEnabled();
}

// 칩의 접근성 이름은 'worktree — <브랜치>'다. 앞머리만 보고 찾는 이유는 그 뒤가
// 저장소 상태에 따라 달라지기 때문이다(CI는 태그를 체크아웃해 detached다) — 이름
// 전체를 못박으면 브랜치가 바뀔 때마다 테스트가 깨진다.
const chip = (page) => page.getByRole('button', { name: /^worktree/ });

const openPanel = async (page) => {
  await chip(page).click();
  const modal = page.getByRole('dialog', { name: 'worktree' });
  await expect(modal).toBeVisible();
  return modal;
};

/**
 * 칩이 **첫 조회를 끝낼 때까지** 기다린다 — 라벨이 자리표시자를 벗어나는 순간이 그것이다.
 * 갱신을 세는 테스트는 반드시 이걸 먼저 통과해야 한다: 마운트 직후의 조회까지 세면
 * 아무 일도 일어나지 않아도 개수가 늘어 테스트가 공허해진다(codex 지적).
 */
const settleChip = async (page) => {
  await expect(chip(page).locator('.wt-chip-label')).not.toHaveText('worktree');
};

test('worktree 패널이 실제 저장소의 커밋 그래프와 카드를 그린다', async ({ page }) => {
  await startSession(page);
  const modal = await openPanel(page);

  // ① 저장소 최상위 경로 — "무엇을 보고 있는가"가 먼저 보여야 한다.
  await expect(modal.locator('.wt-root')).toContainText('CC-on-browser');

  // ② 커밋 그래프: 노드 수와 목록 줄 수가 서로 맞아야 한다. 하나라도 어긋나면
  //    SVG 좌표와 옆 줄글이 다른 커밋을 가리키고 있다는 뜻이다.
  //
  //    이력 깊이는 가정하지 않는다 — CI는 actions/checkout의 기본 얕은 클론이라
  //    커밋이 정확히 하나다. 그것도 패널이 다뤄야 할 정상적인 저장소 모양이다.
  const nodes = modal.locator('.wt-graph .wt-node');
  const commits = modal.locator('.wt-commit');
  await expect(nodes.first()).toBeVisible();
  expect(await nodes.count()).toBe(await commits.count());
  expect(await commits.count()).toBeGreaterThan(0);

  // 첫 줄은 최신 커밋이고, 짧은 sha와 제목을 모두 갖는다.
  const firstSha = modal.locator('.wt-commit').first().locator('.wt-sha');
  await expect(firstSha).toHaveText(/^[0-9a-f]{7,}$/);
  await expect(modal.locator('.wt-commit').first().locator('.wt-subject')).not.toBeEmpty();

  // ③ worktree 카드 — 이 레포는 주 worktree 하나뿐이다.
  const cards = modal.locator('.wt-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first().locator('.wt-badge.main')).toHaveText('주 worktree');
  await expect(cards.first().locator('.wt-branch')).not.toBeEmpty();
  // 상태는 색만으로 말하지 않는다 — 점 옆에 반드시 글자가 선다.
  await expect(cards.first().locator('.wt-state')).toHaveText(/깨끗함|변경 \d+\+?/);

  // ④ HEAD 커밋에는 태그가 붙고, 그 태그가 카드 제목과 같은 것을 가리킨다.
  //    같음이 아니라 포함으로 보는 이유: 브랜치가 없는 detached 상태(CI는 태그를
  //    체크아웃하므로 항상 이쪽이다)에서는 카드가 'abc1234 (detached)'로 쓰고
  //    그래프 태그는 'abc1234'만 단다.
  const label = (await cards.first().locator('.wt-branch').innerText()).trim();
  const tag = (await modal.locator('.wt-tag').first().innerText()).trim();
  expect(tag.length).toBeGreaterThan(0);
  expect(label).toContain(tag);
});

test('지금 열려 있는 세션이 그 worktree 카드에 실행 중으로 실린다', async ({ page }) => {
  await startSession(page);
  const modal = await openPanel(page);

  // 세션 cwd가 곧 이 레포이므로, 방금 시작한 세션이 주 worktree 카드에 잡혀야 한다.
  // 이 판정은 서버가 realpath로 내린 것이고(클라이언트는 경로를 비교하지 않는다),
  // 이름은 사이드바와 같은 함수로 클라이언트가 정한다 — 그 두 갈래가 만나는 지점이다.
  // 개수를 1로 못박지 않는 이유: 이 파일의 테스트들은 서버 한 대를 공유하고 각자
  // 세션을 시작하므로, 앞선 테스트의 세션도 같은 레포에서 여전히 살아 있다.
  const liveChip = modal.locator('.wt-card .wt-session.live');
  await expect(liveChip.first()).toBeVisible();
  await expect(liveChip.first().locator('.wt-session-tag')).toHaveText('실행 중');
  await expect(liveChip.first()).toHaveAttribute('title', '실행 중인 세션');
  // 실행 중 세션이 붙은 카드는 눈에 띄게 강조된다.
  await expect(modal.locator('.wt-card.has-live').first()).toBeVisible();
});

test('조회 전용이다 — 생성·삭제·정리 버튼이 없다', async ({ page }) => {
  await startSession(page);
  const modal = await openPanel(page);

  await expect(modal.locator('.wt-card')).not.toHaveCount(0);
  // 패널 안의 버튼은 '새로 고침'과 모달 '닫기'뿐이어야 한다. 관리 기능이 슬그머니
  // 들어오면(이번 범위가 아니다) 여기서 먼저 걸린다.
  const labels = await modal.getByRole('button').allInnerTexts();
  const meaningful = labels.map((t) => t.trim()).filter(Boolean);
  expect(meaningful).toEqual(['새로 고침']);
  for (const word of ['삭제', '제거', '정리', '생성', '추가', 'prune', 'remove']) {
    await expect(modal.getByRole('button', { name: new RegExp(word, 'i') })).toHaveCount(0);
  }
});

test('세션이 없으면 오류가 아니라 안내를 보여 준다', async ({ page }) => {
  // 세션을 시작하지 않고 곧장 연다 — 서버는 no-session을 200으로 돌려주므로
  // 화면은 실패가 아니라 "무엇을 하면 되는지"를 말해야 한다.
  await page.goto(servers.echo.url);
  const modal = await openPanel(page);
  await expect(modal.locator('.wt-note')).toContainText('실행 중인 세션이 없습니다');
  await expect(modal.locator('.wt-error')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: '다시 확인' })).toBeVisible();
});

test('git 저장소가 아닌 디렉터리도 오류가 아니라 다른 안내를 보여 준다', async ({ page }) => {
  // "세션 없음"과 "비-git 저장소"는 사용자가 할 일이 서로 달라, 화면이 반드시
  // 구분해서 말해야 한다(설계도 §1 "조용한 빈 화면 금지").
  // 반드시 레포 **밖**이어야 한다 — e2e/.state는 이 레포 안이라, 거기 만든 디렉터리는
  // git이 CC-on-browser 저장소의 일부로 보고 정상 목록을 돌려준다(이 테스트가 처음
  // 이렇게 짜여 헛돌았다). 삭제는 최선 노력으로만 한다: Windows는 실행 중인 프로세스의
  // cwd를 잠그고, fake CLI가 방금 여기서 떴다.
  const plain = mkdtempSync(path.join(os.tmpdir(), 'ccob-e2e-plain-'));
  try {
    await startSession(page, plain);
    const modal = await openPanel(page);
    await expect(modal.locator('.wt-note')).toContainText('git 저장소가 아닙니다');
    await expect(modal.locator('.wt-error')).toHaveCount(0);
    await expect(modal.locator('.wt-card')).toHaveCount(0);
  } finally {
    try { rmSync(plain, { recursive: true, force: true }); } catch { /* 잠긴 cwd */ }
  }
});

test('Esc와 배경 클릭으로 닫히고 포커스가 버튼으로 돌아온다', async ({ page }) => {
  await startSession(page);
  const trigger = chip(page);

  // ① Esc
  const modal = await openPanel(page);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();

  // ② 배경 클릭 — 오버레이의 **여백**을 눌러야 한다. 대화상자 위를 누르면 닫히지
  //    않는 것이 정상이라, 좌표를 주지 않으면 가운데(=대화상자)를 눌러 헛돈다.
  await openPanel(page);
  await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('턴이 끝날 때와 패널을 닫을 때 칩이 브랜치를 다시 읽는다', async ({ page }) => {
  // 이 칩은 늘 떠 있으므로 "열 때 한 번"으로는 부족하다 — Claude가 턴 도중 브랜치를
  // 갈아탔다면 사용자가 패널을 열기 전부터 라벨이 틀려 있다. 그래서 턴 종료와 패널
  // 닫기를 갱신 신호로 삼았고, 여기서는 그 요청이 실제로 다시 나가는지를 본다.
  await startSession(page);
  await settleChip(page); // 마운트 조회를 흘려보낸 **뒤**부터 센다

  let calls = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/branch') calls += 1;
  });

  // ① 턴 종료(중단 버튼 → 전송 버튼 복귀)
  const input = page.getByLabel('메시지 입력');
  await input.fill('안녕');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '전송' })).toBeVisible();
  await expect.poll(() => calls, { message: '턴이 끝나면 브랜치를 다시 읽어야 한다' })
    .toBeGreaterThan(0);

  // ② 패널을 닫을 때 — 패널을 보고 닫은 시점의 브랜치가 칩에도 반영되어야 한다.
  const beforeClose = calls;
  const modal = await openPanel(page);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect.poll(() => calls, { message: '패널을 닫으면 브랜치를 다시 읽어야 한다' })
    .toBeGreaterThan(beforeClose);
});

test('브랜치 칩은 입력창 아래에 있고 사이드바에는 없다', async ({ page }) => {
  // 이 작업의 요점 자체를 못박는다: 패널로 들어가는 문이 사이드바 하단 버튼 행에서
  // 컴포저 아래로 **옮겨졌다**(복제된 것이 아니다).
  await startSession(page);

  const trigger = chip(page);
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toBeVisible();

  // ① 자리 — 컴포저 도크 안, 입력 상자 **밖**이자 아래다.
  await expect(page.locator('.composer-dock .wt-chip-row .wt-chip')).toHaveCount(1);
  await expect(page.locator('.composer-shell .wt-chip')).toHaveCount(0);
  const inputBox = await page.getByLabel('메시지 입력').boundingBox();
  const chipBox = await trigger.boundingBox();
  expect(chipBox.y).toBeGreaterThan(inputBox.y + inputBox.height - 1);

  // ② 사이드바 하단 버튼 행에는 더 이상 없다 — 통계·설정·정보 셋만 남는다.
  await expect(page.locator('.sidebar-foot').getByRole('button', { name: /worktree/ }))
    .toHaveCount(0);

  // ③ 라벨은 이 저장소의 실제 HEAD를 말한다. CI는 얕은 클론에 태그 체크아웃이라
  //    detached일 수 있으므로 브랜치명을 못박지 않고, 패널이 같은 값을 말하는지로 본다.
  const label = (await trigger.locator('.wt-chip-label').innerText()).trim();
  expect(label).not.toBe('');
  const modal = await openPanel(page);
  const card = modal.locator('.wt-card').first();
  expect((await card.locator('.wt-branch').innerText()).trim()).toContain(
    label.replace(' (detached)', ''),
  );
});
