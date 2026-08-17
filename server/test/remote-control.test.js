// remote-control.js 테스트 — 순수 파서 + 자식 프로세스 수명주기.
// 파서 픽스처는 전부 실제 CLI(v2.1.220, win32) 캡처에서 그대로 가져온 문자열이다.
// 수명주기는 spawn/killTree/platform/타이머를 주입해 실제 프로세스 없이 결정적으로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRemoteControl,
  parseRemoteControlLine,
  parseRemoteUrl,
  sanitizeName,
  stripAnsi,
  MAX_NAME_LEN,
} from '../src/remote-control.js';

const ESC = String.fromCharCode(27);

// ---------- 순수 파서 ----------

test('stripAnsi가 재그리기 CSI를 지운다 (실측: ESC[6A ESC[J가 줄 머리에 붙는다)', () => {
  const line = `${ESC}[6A${ESC}[J·✔︎· Ready · CC-on-browser · master`;
  assert.equal(stripAnsi(line), '·✔︎· Ready · CC-on-browser · master');
});

test('상태 낱말 3종이 우리 상태로 매핑된다', () => {
  assert.equal(parseRemoteControlLine('·|· Connecting · CC-on-browser · master').state, 'starting');
  assert.equal(parseRemoteControlLine('·✔︎· Ready · CC-on-browser · master').state, 'ready');
  assert.equal(
    parseRemoteControlLine('·|· Reconnecting · retrying in 1.8s · disconnected 0s').state,
    'starting',
  );
});

test('모르는 줄은 아무 전이도 만들지 않는다 (null)', () => {
  assert.equal(parseRemoteControlLine('space to show QR code · w to toggle spawn mode'), null);
  assert.equal(parseRemoteControlLine('Spawn mode: same-dir'), null);
  assert.equal(parseRemoteControlLine(''), null);
  assert.equal(parseRemoteControlLine('·?· Bewildered · CC-on-browser'), null);
});

test('URL 줄에서 url과 environmentId를 함께 뽑는다 (환경 ID의 단일 진실)', () => {
  const line =
    'Code anywhere with the Claude mobile app or https://claude.ai/code?environment=env_012bxv7zcCiqYyN1d6FZTRbz';
  const patch = parseRemoteControlLine(line);
  assert.equal(patch.environmentId, 'env_012bxv7zcCiqYyN1d6FZTRbz');
  assert.equal(patch.url, 'https://claude.ai/code?environment=env_012bxv7zcCiqYyN1d6FZTRbz');
});

test('쿼리 순서가 바뀌어도 environment를 찾는다 (정규식이 아니라 URL 해석)', () => {
  const got = parseRemoteUrl('… https://claude.ai/code?foo=1&environment=env_abc123&bar=2');
  assert.equal(got.environmentId, 'env_abc123');
  // 원본을 그대로 보관한다 — 모르는 파라미터를 잃지 않기 위해
  assert.equal(got.url, 'https://claude.ai/code?foo=1&environment=env_abc123&bar=2');
});

test('엉뚱한 호스트·스킴·경로의 URL은 거부한다', () => {
  assert.equal(parseRemoteUrl('http://claude.ai/code?environment=env_a'), null); // https 아님
  assert.equal(parseRemoteUrl('https://evil.example/code?environment=env_a'), null);
  assert.equal(parseRemoteUrl('https://claude.ai/chat?environment=env_a'), null);
  assert.equal(parseRemoteUrl('https://claude.ai/code'), null); // environment 없음
  assert.equal(parseRemoteUrl('https://claude.ai/code?environment='), null); // 빈 값
});

test('Environment ID: 줄은 -v 전용 보조 출처로만 인정된다', () => {
  assert.equal(
    parseRemoteControlLine('Environment ID: env_012bxv7z').environmentId,
    'env_012bxv7z',
  );
});

test('Capacity 줄을 숫자로 읽는다', () => {
  const patch = parseRemoteControlLine(
    '    Capacity: 3/32 · New sessions will be created in the current directory',
  );
  assert.deepEqual(patch.capacity, { used: 3, max: 32 });
});

test('알려진 실패 문구는 error로 잡고 상태 낱말보다 우선한다', () => {
  const patch = parseRemoteControlLine('Error: You must be logged in to use Remote Control.');
  assert.match(patch.error, /must be logged in/);
  assert.equal(patch.state, undefined);
});

test('세션 이름 위생 — 개행·제어문자 제거, 길이 상한, 폴더명 폴백', () => {
  assert.equal(sanitizeName('my repo', 'C:/x/y'), 'my repo');
  assert.equal(sanitizeName('a\nb\tc', 'C:/x/y'), 'a b c');
  assert.equal(sanitizeName('x'.repeat(200), 'C:/x/y').length, MAX_NAME_LEN);
  assert.equal(sanitizeName('   ', 'C:/x/CC-on-browser'), 'CC-on-browser');
  assert.equal(sanitizeName(null, ''), 'cc-on-browser');
});

// ---------- 수명주기 ----------

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    // stdin에 쓰인 것을 그대로 모은다 — 동의 프롬프트 응답을 검사하기 위해.
    // 실제 자식처럼 EventEmitter이기도 하다(관리자가 'error'를 구독한다).
    this.stdinWrites = [];
    this.stdin = new EventEmitter();
    this.stdin.write = (s) => {
      this.stdinWrites.push(String(s));
      return true;
    };
  }

  /** 자식이 스스로 종료한 것으로 만든다. */
  die(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function harness({ platform = 'win32', autoKill = true, resolveCwd } = {}) {
  const spawned = [];
  const killed = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new FakeChild(1000 + spawned.length);
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const killTree = (pid, o) => {
    killed.push({ pid, ...o });
    if (autoKill) {
      const hit = spawned.find((s) => s.child.pid === pid);
      // 실제 taskkill처럼 비동기로 죽는다
      if (hit && hit.child.exitCode === null) queueMicrotask(() => hit.child.die(1, null));
    }
    return Promise.resolve();
  };
  // 주입 타이머 — stopGrace 만기를 실제 5초 기다리지 않고 재현한다.
  let timerSeq = 0;
  const timers = new Map();
  const setTimeoutFn = (cb) => {
    const id = ++timerSeq;
    timers.set(id, cb);
    return { id, unref() {} };
  };
  const clearTimeoutFn = (t) => {
    if (t && typeof t.id === 'number') timers.delete(t.id);
  };
  /** 현재 걸려 있는 타이머를 전부 발화(발화 중 새로 걸린 것도 다음 회차에 처리). */
  const fireTimers = () => {
    for (let round = 0; round < 5; round++) {
      const due = [...timers.entries()];
      if (due.length === 0) return;
      timers.clear();
      for (const [, cb] of due) cb();
    }
  };
  const rc = createRemoteControl({
    cliPath: 'claude',
    platform,
    spawnFn,
    killTree,
    // 실제 realpath처럼 끝 슬래시를 흡수한다 — cwd 정규화가 관리자의 중복 방지
    // 근거이므로, 그걸 안 하는 가짜 resolver를 쓰면 테스트가 제품을 잘못 고발한다.
    resolveCwd: resolveCwd ?? (async (p) => `CANON:${String(p).replace(/[\\/]+$/, '')}`),
    setTimeoutFn,
    clearTimeoutFn,
    now: () => 1_700_000_000_000,
  });
  return { rc, spawned, killed, fireTimers };
}

/**
 * 조건이 참이 될 때까지 마이크로태스크를 흘려 보낸다(상한 있음).
 * stop()은 realpath(await) 뒤에야 'stopping'을 찍으므로, 그 지점을 지나지 않은 채
 * 자식 이벤트를 쏘면 테스트가 실제와 다른 순서를 만든다.
 */
async function until(pred, label) {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  assert.fail(`조건이 성립하지 않았습니다: ${label}`);
}

test('start가 remote-control 인자로 spawn하고 canonical cwd를 키로 쓴다', async () => {
  const { rc, spawned } = harness();
  const st = await rc.start('C:/repo', { name: 'my repo' });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['remote-control', '--name', 'my repo', '-v']);
  assert.equal(spawned[0].opts.cwd, 'CANON:C:/repo');
  assert.equal(spawned[0].opts.windowsHide, true);
  // win32에서는 detached를 쓰지 않는다(taskkill /T가 트리를 처리)
  assert.equal(spawned[0].opts.detached, false);
  assert.equal(st.state, 'starting');
  assert.equal(st.cwd, 'CANON:C:/repo');
});

test('POSIX에서는 detached로 띄워 프로세스 그룹을 만든다', async () => {
  const { rc, spawned } = harness({ platform: 'linux' });
  await rc.start('/repo');
  assert.equal(spawned[0].opts.detached, true);
});

test('stdout을 먹고 ready·URL·capacity가 스냅샷에 반영된다', async () => {
  const { rc, spawned } = harness();
  const seen = [];
  rc.on('change', (s) => seen.push(s));
  await rc.start('C:/repo');
  const { child } = spawned[0];

  child.stdout.emit('data', 'Remote Control v2.1.220\nSpawn mode: same-dir\n');
  child.stdout.emit('data', `${ESC}[1A${ESC}[J·✔︎· Ready · CC-on-browser · master\n`);
  child.stdout.emit(
    'data',
    '    Capacity: 0/32 · New sessions will be created in the current directory\n'
      + 'Code anywhere with the Claude mobile app or https://claude.ai/code?environment=env_abc\n',
  );

  const [st] = rc.snapshot();
  assert.equal(st.state, 'ready');
  assert.equal(st.environmentId, 'env_abc');
  assert.equal(st.url, 'https://claude.ai/code?environment=env_abc');
  assert.deepEqual(st.capacity, { used: 0, max: 32 });
  assert.ok(seen.length >= 2, '변화가 있을 때만 change가 나간다');
});

test('청크 경계에서 줄이 쪼개져도 놓치지 않는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdout.emit('data', 'Code anywhere … https://claude.ai/code?environ');
  child.stdout.emit('data', 'ment=env_split\n');
  assert.equal(rc.snapshot()[0].environmentId, 'env_split');
});

test('중복 start는 새 프로세스를 만들지 않는다 (CLI가 막아 주지 않으므로 우리가 막는다)', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  await rc.start('C:/repo');
  await rc.start('C:/repo/');
  assert.equal(spawned.length, 1);
});

test('stop은 트리 종료를 요청하고 자식 close까지 기다린다', async () => {
  const { rc, spawned, killed } = harness();
  await rc.start('C:/repo');
  const st = await rc.stop('C:/repo');
  assert.equal(killed.length, 1);
  assert.equal(killed[0].pid, spawned[0].child.pid);
  assert.equal(killed[0].force, false);
  assert.equal(st.state, 'stopped');
  assert.equal(rc.hasLive(), false);
});

test('이미 죽은 자식에는 kill을 쏘지 않는다', async () => {
  const { rc, spawned, killed } = harness();
  await rc.start('C:/repo');
  spawned[0].child.die(0);
  await rc.stop('C:/repo');
  assert.equal(killed.length, 0);
});

test('stop 도중 start는 종료를 기다린 뒤 새 세대로 다시 띄운다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const stopping = rc.stop('C:/repo');
  const restarted = rc.start('C:/repo');
  await stopping;
  const st = await restarted;
  assert.equal(spawned.length, 2, '새 자식이 하나 더 떠야 한다');
  assert.equal(st.state, 'starting');
});

test('구세대 자식의 늦은 close는 현재 상태를 오염시키지 않는다', async () => {
  const { rc, spawned } = harness({ autoKill: false });
  await rc.start('C:/repo');
  const first = spawned[0].child;
  const stopping = rc.stop('C:/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  first.die(1); // stop 대기 중 실제 종료
  await stopping;
  await rc.start('C:/repo');
  // 구세대가 뒤늦게 한 번 더 close를 쏴도 새 엔트리는 starting을 유지해야 한다
  first.emit('close', 137, 'SIGKILL');
  assert.equal(rc.snapshot()[0].state, 'starting');
});

test('예기치 않은 종료는 exit code + stderr 꼬리를 담은 error가 된다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stderr.emit('data', 'something went wrong\n');
  child.die(3);
  const [st] = rc.snapshot();
  assert.equal(st.state, 'error');
  assert.match(st.error, /exit code 3/);
  assert.match(st.error, /something went wrong/);
});

test('이미 파싱한 구체적 오류를 나중의 종료 사유가 덮지 않는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdout.emit('data', 'You must be logged in to use Remote Control.\n');
  child.die(1);
  const [st] = rc.snapshot();
  assert.equal(st.state, 'error');
  assert.match(st.error, /must be logged in/);
  assert.doesNotMatch(st.error, /exit code/);
});

test('stopping 중 도착한 늦은 Ready 줄이 상태를 되살리지 못한다', async () => {
  const { rc, spawned } = harness({ autoKill: false });
  await rc.start('C:/repo');
  const { child } = spawned[0];
  const stopping = rc.stop('C:/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  child.stdout.emit('data', '·✔︎· Ready · CC-on-browser · master\n');
  child.die(1);
  await stopping;
  assert.equal(rc.snapshot()[0].state, 'stopped');
});

test('hasLive는 starting·ready·stopping을 살아 있는 것으로 센다', async () => {
  const { rc, spawned } = harness({ autoKill: false });
  assert.equal(rc.hasLive(), false);
  await rc.start('C:/repo');
  assert.equal(rc.hasLive(), true, 'starting');
  spawned[0].child.stdout.emit('data', '·✔︎· Ready · x\n');
  assert.equal(rc.hasLive(), true, 'ready');
  const stopping = rc.stop('C:/repo');
  assert.equal(rc.hasLive(), true, 'stopping — 정리 중에 데몬이 먼저 죽으면 안 된다');
  spawned[0].child.die(1);
  await stopping;
  assert.equal(rc.hasLive(), false);
});

test('closeAll은 모든 자식을 정리하고 이후 start를 거부한다', async () => {
  const { rc, killed } = harness();
  await rc.start('C:/a');
  await rc.start('C:/b');
  await rc.closeAll();
  assert.equal(killed.length, 2);
  assert.equal(rc.hasLive(), false);
  await assert.rejects(() => rc.start('C:/c'), /closed/);
});

// ---------- codex Stage-4가 재현한 누수 경로 ----------

test('error 상태라도 자식이 살아 있으면 stop이 실제로 죽인다', async () => {
  const { rc, spawned, killed } = harness();
  await rc.start('C:/repo');
  // 자식은 살아 있는 채로 오류 문구만 뱉는 경우
  spawned[0].child.stdout.emit('data', 'You must be logged in to use Remote Control.\n');
  assert.equal(rc.snapshot()[0].state, 'error');
  assert.equal(rc.hasLive(), true, '자식이 살아 있으므로 데몬은 계속 붙잡아야 한다');
  await rc.stop('C:/repo');
  assert.equal(killed.length, 1, 'error라고 조용히 넘어가면 자식이 고아가 된다');
  assert.equal(rc.hasLive(), false);
});

test('error 상태에서 재시작하면 옛 자식을 먼저 죽인다 (고아 방지)', async () => {
  const { rc, spawned, killed } = harness();
  await rc.start('C:/repo');
  spawned[0].child.stdout.emit('data', 'Remote Control session expired.\n');
  await rc.start('C:/repo');
  assert.equal(killed.length, 1, '옛 자식이 정리돼야 한다');
  assert.equal(spawned.length, 2);
});

test('closeAll 중이던 start는 새 자식을 만들지 못한다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const { rc, spawned } = harness({
    resolveCwd: async (p) => {
      if (first) {
        first = false;
        await gate; // 첫 start를 canonicalize 도중에 붙잡아 둔다
      }
      return `CANON:${p}`;
    },
  });
  const starting = rc.start('C:/repo');
  const closing = rc.closeAll();
  release();
  await assert.rejects(() => starting, /closed/);
  await closing;
  assert.equal(spawned.length, 0);
  assert.equal(rc.hasLive(), false);
});

test('한 번의 stop 도중 재시작 요청이 겹쳐도 자식은 하나만 남는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const stopping = rc.stop('C:/repo');
  const a = rc.start('C:/repo');
  const b = rc.start('C:/repo');
  await Promise.all([stopping, a, b]);
  assert.equal(spawned.length, 2, '원본 1 + 재시작 1');
  assert.equal(rc.snapshot().length, 1);
});

test('종료에 실패하면 stopped가 아니라 error로 보고하고 계속 붙잡는다', async () => {
  const { rc, spawned, fireTimers } = harness({ autoKill: false });
  await rc.start('C:/repo');
  const stopping = rc.stop('C:/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  fireTimers(); // 1차 유예 만기 → force
  fireTimers(); // 2차 유예 만기 → 포기
  await stopping;
  const [st] = rc.snapshot();
  assert.equal(st.state, 'error');
  assert.match(st.error, /종료하지 못했습니다/);
  assert.equal(spawned[0].child.exitCode, null, '자식은 여전히 살아 있다');
  assert.equal(rc.hasLive(), true, '살아 있는 자식을 두고 데몬이 내려가면 안 된다');
});

test('POSIX는 리더 close 후에도 그룹에 강제 시그널을 한 번 더 보낸다', async () => {
  const { rc, spawned, killed } = harness({ platform: 'linux', autoKill: false });
  await rc.start('/repo');
  const stopping = rc.stop('/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  spawned[0].child.die(0); // 그룹 리더만 종료
  await stopping;
  assert.deepEqual(killed.map((k) => k.force), [false, true],
    '리더가 죽어도 그룹에 남은 워커를 쓸어야 한다');
});

test('stop은 realpath가 실패해도 시작에 쓰인 원본 경로로 대상을 찾는다', async () => {
  let alive = true;
  const { rc, killed } = harness({
    resolveCwd: async (p) => {
      if (!alive) throw new Error('ENOENT');
      return `CANON:${p}`;
    },
  });
  await rc.start('C:/link');
  alive = false; // 심볼릭 링크가 지워진 상황
  await rc.stop('C:/link');
  assert.equal(killed.length, 1, '경로가 사라졌다고 자식을 놓아 주면 안 된다');
});

test('큰 청크의 앞부분 줄이 잘려 나가지 않는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const filler = `${'x'.repeat(200)}\n`.repeat(400); // 80KB 남짓
  spawned[0].child.stdout.emit(
    'data',
    '·✔︎· Ready · CC-on-browser · master\n'
      + 'Code anywhere … https://claude.ai/code?environment=env_big\n'
      + filler,
  );
  const [st] = rc.snapshot();
  assert.equal(st.state, 'ready');
  assert.equal(st.environmentId, 'env_big');
});

test('close 시점의 미종결 마지막 줄도 파싱된다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdout.emit('data', 'Error: You must be logged in to use Remote Control.'); // 개행 없음
  child.die(1);
  assert.match(rc.snapshot()[0].error, /must be logged in/);
});

test('stderr 폭주는 꼬리 줄 수와 줄 길이가 상한된다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  for (let i = 0; i < 100; i++) child.stderr.emit('data', `${'e'.repeat(5000)}\n`);
  child.stderr.emit('data', 'y'.repeat(100_000)); // 개행 없는 폭주
  child.die(9);
  const [st] = rc.snapshot();
  // 꼬리 3줄 × 줄당 200자 + 문구 → 넉넉히 잡아도 1KB 미만
  assert.ok(st.error.length < 1024, `error 길이 ${st.error.length}`);
});

test('세션 이름은 URL·오류 문구를 주입할 수 없게 좁게 걸러진다', () => {
  assert.equal(
    sanitizeName('https://claude.ai/code?environment=evil', 'C:/x'),
    'https claude.ai code environment evil'.replace(/\s+/g, ' '),
  );
  // 걸러진 이름에는 '://'가 남지 않으므로 파서가 URL로 보지 않는다
  assert.equal(parseRemoteUrl(sanitizeName('https://claude.ai/code?environment=evil', 'C:/x')), null);
});

test("'Ready'라는 이름의 브랜치가 거짓 ready를 만들지 않는다", () => {
  const patch = parseRemoteControlLine('·|· Connecting · CC-on-browser · Ready');
  assert.equal(patch.state, 'starting', '뒤쪽 칸의 낱말은 상태가 아니다');
});

test('포트가 붙은 claude.ai는 거부한다', () => {
  assert.equal(parseRemoteUrl('https://claude.ai:444/code?environment=env_a'), null);
});

// ---------- v2.1.233 동의 프롬프트 / stderr 오류 (2026-08-17 실측) ----------

test('stdin을 연 채로 띄운다 (ignore면 동의 프롬프트에서 즉시 EOF로 죽는다)', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  assert.deepEqual(spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('개행 없는 동의 프롬프트에 y로 답하고 이후 Ready까지 간다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  // 실측 캡처 그대로 — 안내문은 개행으로 끝나지만 프롬프트 줄은 개행이 없다.
  child.stdout.emit('data', '\nTake this session with you …\n\n');
  child.stdout.emit('data', 'Enable Remote Control? (y/n) ');
  assert.deepEqual(child.stdinWrites, ['y\n'], '개행을 기다리면 영원히 못 답한다');
  child.stdout.emit('data', '\n·|· Connecting · CC-on-browser · master\n');
  assert.equal(rc.snapshot()[0].state, 'starting');
  child.stdout.emit('data', `${ESC}[1A${ESC}[J·✔︎· Ready · CC-on-browser · master\n`);
  assert.equal(rc.snapshot()[0].state, 'ready');
});

test('프롬프트가 재그리기로 여러 번 와도 응답은 한 번뿐이다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdout.emit('data', 'Enable Remote Control? (y/n) ');
  child.stdout.emit('data', `${ESC}[1A${ESC}[JEnable Remote Control? (y/n) `);
  // 두 번째 'y'는 런타임 단축키(space·w 같은)로 해석될 수 있다 — 반드시 1회.
  assert.deepEqual(child.stdinWrites, ['y\n']);
});

test('청크 경계로 프롬프트가 쪼개져도 답한다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdout.emit('data', 'Enable Remote ');
  assert.deepEqual(child.stdinWrites, []);
  child.stdout.emit('data', 'Control? (y/n) ');
  assert.deepEqual(child.stdinWrites, ['y\n']);
});

test('stdin write가 던져도 시작 절차가 깨지지 않는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stdin.write = () => { throw new Error('EPIPE'); };
  child.stdout.emit('data', 'Enable Remote Control? (y/n) ');
  child.stdout.emit('data', '\n·✔︎· Ready · CC-on-browser · master\n');
  assert.equal(rc.snapshot()[0].state, 'ready');
});

test('stderr의 workspace 신뢰 오류가 구체적 사유로 올라온다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  const { child } = spawned[0];
  child.stderr.emit(
    'data',
    'Error: Workspace not trusted. Please run `claude` in C:/repo first to review'
      + ' and accept the workspace trust dialog.\n',
  );
  const [st] = rc.snapshot();
  assert.equal(st.state, 'error');
  assert.match(st.error, /Workspace not trusted/);
  assert.match(st.error, /accept the workspace trust dialog/, '사용자가 할 일이 문구에 남아야 한다');
  // 뒤이은 종료가 이 구체적 사유를 일반 문구로 덮지 않는다
  child.die(1);
  assert.match(rc.snapshot()[0].error, /Workspace not trusted/);
  assert.doesNotMatch(rc.snapshot()[0].error, /exit code/);
});

// 아래 두 개만 **진짜 프로세스**를 띄운다. 주입 harness는 우리가 만든 FakeChild를
// 상대하므로 stdio 옵션이 틀려도 통과한다 — 이 회귀(stdin: 'ignore')는 실제 spawn으로만
// 잡힌다. CLI 자리에는 실 출력을 미러하는 fake-cli.mjs를 세운다.
const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

/** 조건이 참이 될 때까지 실제 시간으로 폴링(상한 있음). */
async function waitUntil(pred, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`조건이 성립하지 않았습니다: ${label}`);
}

/** fake-cli를 실제로 띄우는 관리자 + 일회용 cwd. */
async function realHarness(fakeRcMode) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccob-rc-'));
  const rc = createRemoteControl({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    // 자식이 환경을 물려받는다 — 모드는 env로 넘긴다(fake-cli 계약).
    stopGraceMs: 2_000,
  });
  const prev = process.env.FAKE_RC;
  process.env.FAKE_RC = fakeRcMode;
  const cleanup = async () => {
    await rc.closeAll();
    if (prev === undefined) delete process.env.FAKE_RC;
    else process.env.FAKE_RC = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  };
  return { rc, dir, cleanup };
}

test('실 프로세스: 동의 프롬프트를 넘어 ready·URL까지 간다 (stdio 회귀 방지)', async () => {
  const { rc, dir, cleanup } = await realHarness('prompt-ok');
  try {
    await rc.start(dir, { name: 'rc real' });
    // stdin이 ignore면 fake-cli가 EOF에서 exit 0으로 죽어 여기서 error로 굳는다.
    await waitUntil(() => rc.snapshot()[0]?.state === 'ready', 'ready 도달');
    const [st] = rc.snapshot();
    assert.equal(st.error, null);
    assert.equal(st.environmentId, 'env_fake123');
    assert.match(st.url, /^https:\/\/claude\.ai\/code\?environment=env_fake123$/);
  } finally {
    await cleanup();
  }
});

test('실 프로세스: stderr로만 오는 신뢰 오류가 사유와 함께 표면화된다', async () => {
  const { rc, dir, cleanup } = await realHarness('untrusted');
  try {
    await rc.start(dir);
    await waitUntil(() => rc.snapshot()[0]?.state === 'error', 'error 도달');
    const [st] = rc.snapshot();
    assert.match(st.error, /Workspace not trusted/);
    assert.match(st.error, /accept the workspace trust dialog/);
  } finally {
    await cleanup();
  }
});

test('중지 중 도착한 stderr 오류가 최종 상태를 가로채지 않는다', async () => {
  const { rc, spawned } = harness({ autoKill: false });
  await rc.start('C:/repo');
  const { child } = spawned[0];
  const stopping = rc.stop('C:/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  child.stderr.emit('data', 'Error: Workspace not trusted.\n');
  child.die(1);
  await stopping;
  const [st] = rc.snapshot();
  assert.equal(st.state, 'stopped', '사용자가 끈 것이다 — 실패로 보이면 안 된다');
  assert.equal(st.error, null);
});

test('나중에 온 Environment ID 줄이 URL에서 얻은 id를 덮지 않는다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  spawned[0].child.stdout.emit(
    'data',
    'Code anywhere … https://claude.ai/code?environment=env_real\nEnvironment ID: env_stale\n',
  );
  const [st] = rc.snapshot();
  assert.equal(st.environmentId, 'env_real');
  assert.equal(st.url, 'https://claude.ai/code?environment=env_real');
});

test('자식이 이미 죽은 error 항목을 stop하면 꺼짐으로 확정되고 오류가 지워진다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  spawned[0].child.stdout.emit('data', 'You must be logged in to use Remote Control.\n');
  spawned[0].child.die(1);
  assert.equal(rc.snapshot()[0].state, 'error');
  await rc.stop('C:/repo');
  const [st] = rc.snapshot();
  // error로 남겨 두면 UI가 그 항목을 '켜진 것'으로 보고 시작 버튼을 주지 않아
  // 죽은 항목에서 영원히 못 빠져나온다
  assert.equal(st.state, 'stopped');
  assert.equal(st.error, null);
});

test('꺼진 뒤에는 같은 cwd로 다시 시작할 수 있다', async () => {
  const { rc, spawned } = harness();
  await rc.start('C:/repo');
  spawned[0].child.stdout.emit('data', 'You must be logged in to use Remote Control.\n');
  spawned[0].child.die(1);
  await rc.stop('C:/repo');
  const st = await rc.start('C:/repo');
  assert.equal(st.state, 'starting');
  assert.equal(spawned.length, 2);
});

test('옛 자식을 못 죽였으면 재시작을 거부한다 (재시도 버튼이 고아 생성기가 되지 않게)', async () => {
  const { rc, spawned, fireTimers } = harness({ autoKill: false });
  await rc.start('C:/repo');
  const stopping = rc.stop('C:/repo');
  await until(() => rc.snapshot()[0].state === 'stopping', 'stopping 진입');
  fireTimers();
  fireTimers(); // 두 단계 유예 모두 만기 → 종료 실패
  await stopping;
  assert.equal(rc.snapshot()[0].state, 'error');

  await assert.rejects(() => rc.start('C:/repo'), /다시 시작할 수 없습니다/);
  assert.equal(spawned.length, 1, '새 자식을 띄우면 옛 자식을 장부에서 놓친다');
  assert.equal(rc.hasLive(), true, '살아 있는 자식은 계속 붙잡아야 한다');
});
