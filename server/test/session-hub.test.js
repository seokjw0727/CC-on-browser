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

// ── CLI 세션 이름 (~/.claude/sessions의 name) ───────────────────────────────
// 조회기는 주입한다 — 실제 홈 디렉터리를 읽지 않기 위해서이고, 늦게 쓰이는 이름
// 파일이나 조회 실패 같은 경로를 시간에 기대지 않고 재현하기 위해서다.

function makeNamedHub(lookupSessionName) {
  return new SessionHub({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    lookupSessionName,
  });
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('sessionId가 확정되면 CLI 세션 이름을 sessionName으로 방송한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const asked = [];
  const hub = makeNamedHub(async (id) => {
    asked.push(id);
    return 'cc-on-browser-ca';
  });
  const seen = [];
  hub.on('broadcast', (m) => m.type === 'sessionName' && seen.push(m));

  const { key } = await hub.startSession({ cwd: process.cwd() });
  // 이름 조회는 init 이벤트에서 시작되므로 startSession이 돌아오기 전에 끝날 수 있다.
  // 그 경우 방송은 아직 세션을 모르는 탭에서 버려지므로, 서버는 cliNameOf로 메운다.
  const named = hub.cliNameOf(key);
  const broadcast = await waitFor(() => seen.length > 0, 2000);
  assert.ok(named || broadcast, '이름은 접근자나 방송 중 최소 한 쪽으로 전달돼야 한다');
  assert.equal(hub.cliNameOf(key).cliName, 'cc-on-browser-ca');
  assert.equal(hub.cliNameOf(key).sessionId, 'fake-session-1');
  assert.deepEqual([...new Set(asked)], ['fake-session-1'], '같은 id로는 한 번만 조회한다');
  // 재접속 리플레이도 이름을 실어야 한다 — 링버퍼 밖의 정보라서.
  const replay = hub.attachReplay(key, 0);
  assert.equal(replay.cliName, 'cc-on-browser-ca');
  assert.equal(replay.cliNameSessionId, 'fake-session-1');
  await hub.stopAll();
});

test('이름 조회가 실패하거나 비어 있어도 세션은 정상 동작한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  for (const lookup of [
    async () => { throw new Error('boom'); },
    () => { throw new Error('동기 throw'); }, // CLI 이벤트 핸들러로 새면 안 된다
    async () => null,
    async () => '   ',
  ]) {
    const hub = makeNamedHub(lookup);
    const { key } = await hub.startSession({ cwd: process.cwd() });
    assert.equal(hub.cliNameOf(key), null);
    assert.equal(hub.attachReplay(key, 0).cliName, null);
    assert.equal(hub.hasLiveSessions(), true, '이름 실패가 세션을 죽이면 안 된다');
    await hub.stopAll();
  }
});

test('이름이 늦게 쓰여도 이후 이벤트에서 다시 조회해 잡아낸다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  let ready = false;
  const hub = makeNamedHub(async () => (ready ? 'late-name' : null));
  const seen = [];
  hub.on('broadcast', (m) => m.type === 'sessionName' && seen.push(m));

  const { key } = await hub.startSession({ cwd: process.cwd() });
  assert.equal(hub.cliNameOf(key), null, '아직 이름 파일이 없다');
  ready = true;
  // 재조회는 간격을 두고 일어난다(CLI_NAME_RETRY_MS) — 그 뒤 이벤트가 흐르면 잡힌다.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  hub.sendText(key, '안녕');
  const got = await waitFor(() => seen.length > 0, 4000);
  assert.ok(got, '늦게 쓰인 이름을 결국 방송해야 한다');
  assert.equal(seen[0].cliName, 'late-name');
  assert.equal(hub.cliNameOf(key).cliName, 'late-name');
  await hub.stopAll();
});

test('세션이 조용해도 예약된 재조회가 늦게 쓰인 이름을 잡아낸다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  let ready = false;
  const hub = makeNamedHub(async () => (ready ? 'idle-late-name' : null));
  const seen = [];
  hub.on('broadcast', (m) => m.type === 'sessionName' && seen.push(m));

  const { key } = await hub.startSession({ cwd: process.cwd() });
  assert.equal(hub.cliNameOf(key), null);
  ready = true;
  // 여기서부터 CLI 이벤트를 **하나도** 만들지 않는다 — 타이머만으로 잡아야 한다.
  const got = await waitFor(() => seen.length > 0, 12_000);
  assert.ok(got, '이벤트 없이도 예약된 재조회가 이름을 찾아야 한다');
  assert.equal(hub.cliNameOf(key).cliName, 'idle-late-name');
  await hub.stopAll();
});

// 세션 사이에 이름이 섞이지 않는가 — 이름은 sessionId로만 이어지므로, 엔트리마다
// 독립적으로 결정돼야 한다. (/clear로 **같은 엔트리의** id가 바뀌는 경우의 reset은
// 가짜 CLI가 항상 같은 session_id를 보고해 여기서 재현할 수 없다 — 클라이언트 쪽
// 계약은 client/test/store-reducer.test.js의 reset 테스트가 덮는다.)
test('이름은 세션 엔트리마다 독립이다 — 한 세션의 이름이 다른 세션으로 새지 않는다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  let served = 0;
  const hub = makeNamedHub(async () => (++served === 1 ? 'first-name' : null));

  const a = await hub.startSession({ cwd: process.cwd() });
  await waitFor(() => hub.cliNameOf(a.key) != null, 3000);
  assert.equal(hub.cliNameOf(a.key).cliName, 'first-name');

  // 두 번째 세션은 이름을 못 찾는다 — 첫 세션의 이름을 물려받으면 안 된다.
  const b = await hub.startSession({ cwd: process.cwd() });
  assert.equal(hub.cliNameOf(b.key), null);
  assert.equal(hub.attachReplay(b.key, 0).cliName, null);
  // 첫 세션의 이름은 그대로 남는다
  assert.equal(hub.attachReplay(a.key, 0).cliName, 'first-name');
  await hub.stopAll();
});

// 회귀: 이벤트가 쏟아져도 재시도 예산이 순식간에 소진되면 안 된다. 그 시도들은 전부
// 리더의 같은 캐시를 보므로 결과가 같고, 예산만 잃은 채 타이머 경로까지 함께 막힌다.
test('이벤트 폭주가 이름 재시도 예산을 태우지 않는다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  let ready = false;
  const at = [];
  const hub = makeNamedHub(async () => {
    at.push(Date.now());
    return ready ? 'burst-safe-name' : null;
  });
  const seen = [];
  hub.on('broadcast', (m) => m.type === 'sessionName' && seen.push(m));

  const { key } = await hub.startSession({ cwd: process.cwd() });
  // 한 턴에 여러 이벤트를 만든다(사용자 에코 + 스트림 + result).
  for (let i = 0; i < 5; i++) hub.sendText(key, `버스트 ${i}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // 예약 간격(CLI_NAME_RETRY_MS)이 지키는 것: 1.2초 동안 시도는 한 줌이어야 한다.
  assert.ok(at.length <= 2, `이벤트 폭주로 시도가 ${at.length}회 — 예산이 소진되고 있다`);

  // 이제 이름이 쓰였다 — 예산이 남아 있으므로 예약된 재조회가 결국 찾아낸다.
  ready = true;
  const got = await waitFor(() => seen.length > 0, 12_000);
  assert.ok(got, '폭주 뒤에도 재조회가 살아 있어 이름을 찾아야 한다');
  assert.equal(hub.cliNameOf(key).cliName, 'burst-safe-name');
  await hub.stopAll();
});

// 회귀: 이름을 **한 번도 못 찾은 채** 세션 id가 바뀌면(/clear·포크), 소진된 재시도
// 예산을 새 id가 물려받아 영영 조회되지 않았다. 판정 기준이 '성공한 id'가 아니라
// '마지막으로 시도한 id'여야 하는 이유다.
test('예산을 다 쓴 뒤 id가 바뀌면 새 id를 처음부터 다시 조회한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  process.env.FAKE_FORK_SESSION_ID = 'forked-session-2';
  const asked = [];
  const hub = new SessionHub({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    // 예산 소진을 초 단위로 기다리지 않도록 좁힌다 — 계약은 그대로다.
    cliNameRetryMs: 40,
    cliNameMaxTries: 2,
    lookupSessionName: async (id) => {
      asked.push(id);
      return id === 'forked-session-2' ? 'forked-name' : null; // 첫 id는 끝내 없다
    },
  });
  const seen = [];
  hub.on('broadcast', (m) => m.type === 'sessionName' && seen.push(m));

  try {
    const { key } = await hub.startSession({ cwd: process.cwd() });
    // 첫 id로 예산(2회)을 모두 소진시킨다.
    await waitFor(() => asked.filter((i) => i === 'fake-session-1').length >= 2, 3000);
    assert.equal(hub.cliNameOf(key), null);

    // 두 턴을 돌려 CLI가 새 id를 보고하게 한다.
    hub.sendText(key, '첫 턴');
    await waitFor(() => false, 300);
    hub.sendText(key, '둘째 턴 — 여기서 id가 바뀐다');

    const found = await waitFor(() => seen.some((m) => m.cliName === 'forked-name'), 8000);
    assert.ok(found, '소진된 예산이 새 id의 조회를 막으면 안 된다');
    assert.ok(asked.includes('forked-session-2'), '새 id로 실제 조회가 일어나야 한다');
    assert.equal(hub.cliNameOf(key).cliName, 'forked-name');
    assert.equal(hub.cliNameOf(key).sessionId, 'forked-session-2');
  } finally {
    delete process.env.FAKE_FORK_SESSION_ID;
    await hub.stopAll();
  }
});
