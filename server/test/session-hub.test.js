// session-hub의 **종료 계약** 전용 테스트.
// 나머지 허브 동작(리플레이·권한·브로드캐스트)은 server.integration.test.js가 실 경로로
// 덮으므로, 여기서는 데몬이 내려갈 때만 도는 경로 — 새 세션 차단과 실사망 대기 — 만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SessionHub } from '../src/session-hub.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

function makeHub() {
  return new SessionHub({ cliPath: process.execPath, cliArgsPrefix: [fakeCliPath] });
}

function alive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return;
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('beginClosing() 이후에는 새 세션을 받지 않는다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const hub = makeHub();
  hub.beginClosing();
  await assert.rejects(
    () => hub.startSession({ cwd: process.cwd() }),
    /shutting down/,
    '종료 중 시작된 세션은 stopAll의 순회 밖에서 태어나 고아가 된다',
  );
  await hub.stopAll();
});

test('stopAll()은 EOF를 무시하는 세션이 실제로 죽을 때까지 기다린다', async () => {
  process.env.FAKE_SCENARIO = 'hang';
  const hub = makeHub();
  const { initInfo } = await hub.startSession({ cwd: process.cwd() });
  const { pid } = initInfo;
  assert.ok(pid, 'fake CLI가 진단 필드로 pid를 보고해야 한다');
  assert.equal(alive(pid), true);

  const allDead = await hub.stopAll();
  assert.equal(allDead, true, 'stopAll은 전 세션의 사망을 확인하고 true를 돌려준다');
  // 핵심 계약: stopAll이 resolve된 **시점에** 이미 죽어 있어야 한다. 예전처럼 kill을
  // 예약만 하고 반환하면, 호출측의 process.exit()가 그 예약을 통째로 버린다.
  assert.equal(alive(pid), false);
});

test('stopAll()은 이미 종료된 세션이 섞여 있어도 정상 완료한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const hub = makeHub();
  const a = await hub.startSession({ cwd: process.cwd() });
  const b = await hub.startSession({ cwd: process.cwd() });
  hub.stop(a.key);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(await hub.stopAll(), true);
  await waitDead(a.initInfo.pid);
  await waitDead(b.initInfo.pid);
});

test('초기화에 실패한 세션의 프로세스도 남지 않는다', async () => {
  process.env.FAKE_SCENARIO = 'start-fail';
  const hub = makeHub();
  // 장부에서 지워진 뒤에도 정리를 끝내고 나서 거부해야 한다 — 그러지 않으면
  // 아무도 죽일 수 없는 프로세스가 남는다.
  await assert.rejects(() => hub.startSession({ cwd: process.cwd() }));
  assert.equal(hub.hasLiveSessions(), false);
  await hub.stopAll();
});
