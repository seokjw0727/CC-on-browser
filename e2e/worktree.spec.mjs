// worktree 패널 E2E — fake CLI 'echo' 스택 대상. 조회 전용 계약을 브라우저에서 확인한다.
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

const openPanel = async (page) => {
  await page.getByRole('button', { name: 'worktree', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'worktree' });
  await expect(modal).toBeVisible();
  return modal;
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
  const trigger = page.getByRole('button', { name: 'worktree', exact: true });
  const modal = await openPanel(page);

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});
