// bin/cc-on-browser.mjs CLI 테스트 — 인자 파싱·사전 점검 분기.
// 모든 케이스가 서버 기동/claude spawn 이전에 종료되므로 실제 CLI를 절대 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildShortcutArguments,
  parseShortcutOutput,
  runShortcutCommand,
} from '../../bin/shortcut.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const BIN = path.join(root, 'bin', 'cc-on-browser.mjs');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// 포트 검사·백그라운드 진단은 bin의 client/dist 사전 점검 이후 단계라, 빌드 전
// 체크아웃에서는 도달 자체가 불가능하다 — 그 경우 명시적으로 skip한다
// (CI·release workflow는 빌드/pack 후 테스트하므로 실제로 실행된다).
const NEEDS_DIST_SKIP = existsSync(path.join(root, 'client', 'dist', 'index.html'))
  ? false
  : 'client/dist 필요 — npm run build 후 실행됩니다';

const runBin = (args, env = {}, { timeout = 10_000 } = {}) => new Promise((resolve) => {
  // 이 테스트 자체가 cc-on-browser가 띄운 CLI 안에서 돌 수 있다 — 데몬의 env
  // (레거시 CC_ON_BROWSER_DAEMON, 토큰)가 상속되면 분기가 오염되므로 소독한다.
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.CC_ON_BROWSER_DAEMON;
  delete cleanEnv.CC_ON_BROWSER_TOKEN;
  execFile(process.execPath, [BIN, ...args], {
    env: cleanEnv,
    timeout,
  }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});

test('--version prints the package version and exits 0', async () => {
  const r = await runBin(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('--help prints usage and exits 0', async () => {
  const r = await runBin(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: cc-on-browser/);
  assert.match(r.stdout, /--port/);
  assert.match(r.stdout, /--no-open/);
  assert.match(r.stdout, /CLAUDE_WEB_CLI_PATH/);
});

test('unknown option exits 1 and echoes the option with help', async () => {
  const r = await runBin(['--bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown option: --bogus/);
  assert.match(r.stderr, /Usage: cc-on-browser/);
});

test('non-numeric --port value exits 1', async () => {
  const r = await runBin(['--port', 'abc']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid --port value/);
});

test('-p without a value exits 1', async () => {
  const r = await runBin(['-p']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid --port value/);
});

test('out-of-range --port exits 1', async () => {
  const r = await runBin(['--port', '70000']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid --port value/);
});

test('occupied --port exits 1 before spawning the daemon', { skip: NEEDS_DIST_SKIP }, async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  try {
    const r = await runBin(['--port', String(busyPort)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
  } finally {
    blocker.close();
  }
});

// ----- 살아있는 데몬 재사용(재실행이 "포트 사용 중"으로 죽지 않는다) -----
// 데몬을 실제로 띄우지 않는다: 포트를 쥐고 /api/bootstrap을 흉내내는 최소 HTTP
// 서버 + 격리된 홈의 신원 파일로 부모의 판정 경로만 결정적으로 태운다.
// 홈 격리는 os.homedir()가 보는 env(HOME/USERPROFILE)를 갈아 끼워서 한다 —
// 그러지 않으면 테스트가 사용자의 실제 ~/.cc-on-browser 를 건드린다.

/** 신원 파일을 심을 격리된 홈. */
function isolatedHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccob-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// openBrowser가 실제로 어떤 URL로 불렸는지 관측하는 스파이.
// BROWSER를 node 자신으로 두고 NODE_OPTIONS=--require 로 훅을 심는다: 훅은 argv에
// 127.0.0.1이 실려 온 프로세스에서만 파일에 기록하므로 부모/데몬 프로세스에는 아무
// 영향이 없다(URL을 스크립트로 실행하려던 node는 그 뒤 실패해도 무해하다).
// 주의: node는 인수를 스크립트 경로로 정규화하므로 argv에는 원본 URL이 아니라
// `…\http:\127.0.0.1:8787\#token=…` 꼴이 담긴다(실측) — 그래서 토큰·포트 조각으로 본다.
function browserSpy(home) {
  const hook = path.join(home, 'browser-spy.cjs');
  const seen = path.join(home, 'opened-url.txt');
  writeFileSync(
    hook,
    'const a = process.argv.slice(1).join(" ");\n'
    + `if (a.includes("127.0.0.1")) { try { require("fs").writeFileSync(${JSON.stringify(seen)}, a); } catch {} }\n`,
  );
  return { seen, env: { BROWSER: process.execPath, NODE_OPTIONS: `--require ${JSON.stringify(hook)}` } };
}

/** 파일이 생길 때까지(최대 5초) 기다린 뒤 내용을 돌려준다 — 없으면 null. */
async function readWhenReady(file) {
  for (let i = 0; i < 50; i++) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return null;
}

// 스폰된 bin이 보는 os.tmpdir()도 홈과 함께 격리한다 — 실제 앱 기동은
// pasteCleanup을 켜므로(server.js 참조), 격리하지 않으면 이 테스트가 사용자
// %TEMP%에 쌓인 24시간 지난 붙여넣기 폴더를 실제로 지운다. 홈 아래에 두면
// isolatedHome의 t.after가 정리까지 함께 책임진다.
const isolatedTmp = (home) => {
  const dir = path.join(home, 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const homeEnv = (home) => ({
  HOME: home,
  USERPROFILE: home,
  // Node의 os.tmpdir()가 보는 이름은 플랫폼마다 다르다 — 셋 다 덮어야 확실히 격리된다.
  TMPDIR: isolatedTmp(home),
  TEMP: isolatedTmp(home),
  TMP: isolatedTmp(home),
  // 브라우저는 열지 않는다 — 존재하지 않는 명령이면 spawn이 'error'로 끝나고
  // openBrowser의 핸들러가 조용히 흡수한다.
  BROWSER: path.join(root, 'no-such-browser-binary-for-test'),
  // 재사용 판정 대기를 줄여 느린 CI에서도 execFile 타임아웃에 걸리지 않게.
  CC_ON_BROWSER_TEST_REUSE_MS: '600',
});

function writeRecord(home, record) {
  const dir = path.join(home, '.cc-on-browser');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `instance-${record.port}.json`), JSON.stringify(record));
}

/**
 * /api/bootstrap만 흉내내는 가짜 서버. 토큰이 맞으면 200 + {port: reportPort}.
 * reportPort를 실제 포트와 다르게 주면 "stale 파일 뒤의 남의 서버" 상황이 된다.
 */
async function fakeServer({ token, reportPort = null }) {
  const http = await import('node:http');
  const paths = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.headers['x-auth-token'] !== token) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ port: reportPort ?? srv.address().port }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    srv,
    paths,
    port: srv.address().port,
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('relaunch reuses a live daemon: opens a tab with the recorded token and exits 0', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const fake = await fakeServer({ token: 'tok-live' });
  const spy = browserSpy(home);
  try {
    writeRecord(home, { port: fake.port, token: 'tok-live', pid: 4242, version: '9.9.9' });
    const r = await runBin(['--port', String(fake.port)], { ...homeEnv(home), ...spy.env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      `Already running (v9.9.9) on port ${fake.port} — opened a new browser tab.`,
    );
    // 인증은 진짜 bootstrap endpoint로 확인해야 한다.
    assert.ok(fake.paths.includes('/api/bootstrap'), `probed paths: ${fake.paths.join(',')}`);
    // 그리고 브라우저는 "기록된 토큰이 실린 그 URL"로 열려야 한다 — stdout만 보면
    // openBrowser가 사라지거나 엉뚱한 토큰으로 열려도 통과한다(codex 지적).
    // 브라우저 자식은 detached로 떠나므로 부모가 이미 종료한 뒤에 기록될 수 있다.
    const opened = await readWhenReady(spy.seen);
    assert.ok(opened, 'openBrowser가 실제로 호출됐다');
    assert.ok(opened.includes(`127.0.0.1:${fake.port}`), `열린 주소의 포트: ${opened}`);
    assert.ok(opened.includes('token=tok-live'), `기록된 토큰으로 열린다: ${opened}`);
  } finally {
    await fake.close();
  }
});

// 신원 파일의 토큰에 헤더로 못 쓰는 문자가 있으면 http.get이 동기 throw한다 —
// 스택 트레이스가 아니라 평범한 "포트 사용 중" 진단으로 끝나야 한다.
test('a record with an unusable token degrades to the normal port error', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const fake = await fakeServer({ token: 'whatever' });
  try {
    writeRecord(home, { port: fake.port, token: 'bad\nvalue', pid: 1, version: '1.0.0' });
    const r = await runBin(['--port', String(fake.port)], homeEnv(home));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
    assert.doesNotMatch(r.stderr, /ERR_INVALID_CHAR|at Object|Error:/, '스택 트레이스를 뿜지 않는다');
  } finally {
    await fake.close();
  }
});

// 판정 도중 포트가 비면(직전 데몬이 종료를 마쳤다) 오류가 아니라 정상 기동으로 간다.
test('a port that frees up while probing falls through to a normal start', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const p = blocker.address().port;
  // 부모가 점유를 관측한 직후 포트를 놓아 준다.
  setTimeout(() => blocker.close(), 300);
  const r = await runBin(['--port', String(p)], {
    ...homeEnv(home),
    CC_ON_BROWSER_TEST_REUSE_MS: '2000',
    CC_ON_BROWSER_TEST_SKIP_DAEMON: '1', // 데몬은 띄우지 않는다
  });
  // 'busy'로 뭉갰다면 여기서 "already in use"가 났을 것이다. 정상 기동 경로로 갔으므로
  // 데몬 미스폰 진단이 나온다.
  assert.doesNotMatch(r.stderr, /already in use/);
  assert.match(r.stderr, /did not come up on port/);
});

test('relaunch does not reuse a server that rejects the recorded token', { skip: NEEDS_DIST_SKIP }, async (t) => {
  const home = isolatedHome(t);
  const fake = await fakeServer({ token: 'the-real-token' });
  try {
    writeRecord(home, { port: fake.port, token: 'stale-token', pid: 1, version: '1.0.0' });
    const r = await runBin(['--port', String(fake.port)], homeEnv(home));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
    assert.doesNotMatch(r.stdout, /Already running/);
  } finally {
    await fake.close();
  }
});

// 200을 주더라도 스스로 보고하는 포트가 다르면 우리 데몬이 아니다 — stale 파일 뒤에
// 우연히 다른 HTTP 서비스가 그 포트를 잡은 경우를 걸러낸다.
test('relaunch does not reuse a server whose reported port disagrees', { skip: NEEDS_DIST_SKIP }, async (t) => {
  const home = isolatedHome(t);
  const fake = await fakeServer({ token: 'tok-live', reportPort: 1 });
  try {
    writeRecord(home, { port: fake.port, token: 'tok-live', pid: 1, version: '1.0.0' });
    const r = await runBin(['--port', String(fake.port)], homeEnv(home));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
  } finally {
    await fake.close();
  }
});

// 포트가 비어 있으면 stale 신원 파일은 방해가 되지 않는다 — 정상 기동 경로로 가서
// (데몬 스폰만 생략) 파일은 새 데몬이 덮어쓴다.
test('a stale instance file does not block a normal start when the port is free', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const net = await import('node:net');
  // 비어 있는 포트 하나를 확보한 뒤 곧바로 놓아 준다.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  writeRecord(home, { port: freePort, token: 'stale', pid: 1, version: '0.0.1' });
  const r = await runBin(['--port', String(freePort)], {
    ...homeEnv(home),
    // 데몬은 띄우지 않는다 — 여기서 확인할 것은 "재사용으로 새지 않는다"까지다.
    CC_ON_BROWSER_TEST_SKIP_DAEMON: '1',
  });
  assert.doesNotMatch(r.stdout, /Already running/, 'stale 파일로 재사용 판정하지 않는다');
  // 데몬을 스폰하지 않았으니 기동 대기는 실패하는 게 정상 — 그 진단이 나와야 한다.
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not come up on port/);
});

test('CLAUDE_WEB_CLI_PATH pointing at a missing file exits 1 before boot', async () => {
  const missing = path.join(root, 'no-such-claude-binary-for-test');
  const r = await runBin([], { CLAUDE_WEB_CLI_PATH: missing });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist/);
  assert.ok(r.stderr.includes(missing));
});

// 백그라운드(기본) 모드의 CLI 진단 출력 — CC_ON_BROWSER_TEST_SKIP_DAEMON으로
// 데몬 스폰만 생략하고(--port 0 이라 대기·검사도 없음) 부모의 출력 경로를 검증한다.
// 실행 불가 파일(package.json)이라 프로브가 즉시 실패 → 실제 CLI는 여전히 미실행.
test('background mode warns when the claude CLI cannot be executed', { skip: NEEDS_DIST_SKIP }, async () => {
  const r = await runBin(['--port', '0'], {
    CC_ON_BROWSER_TEST_SKIP_DAEMON: '1',
    CLAUDE_WEB_CLI_PATH: path.join(root, 'package.json'),
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /random port/);
  assert.match(r.stderr, /WARNING: claude CLI not found/);
});

// 성공 경로 — 버전을 찍는 가짜 실행 파일로 'claude CLI: <ver>' 라인을 검증.
// Windows는 .cmd/.bat 스폰이 Node에서 차단되고 .exe 생성이 어려워 POSIX에서만 실행
// (CI ubuntu/macos가 커버).
test('background mode prints the probed claude CLI version', {
  skip: process.platform === 'win32' ? 'win32는 .cmd 스폰 제약 — CI POSIX가 커버' : NEEDS_DIST_SKIP,
}, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccob-bin-'));
  const fake = path.join(dir, 'fake-claude');
  writeFileSync(fake, '#!/bin/sh\necho 9.9.9-test\n');
  chmodSync(fake, 0o755);
  const r = await runBin(['--port', '0'], {
    CC_ON_BROWSER_TEST_SKIP_DAEMON: '1',
    CLAUDE_WEB_CLI_PATH: fake,
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /claude CLI: 9\.9\.9-test/);
});

// ----- 데몬 쪽: 신원 파일 발행 / 비발행 / 정리 -----
// 데몬을 직접(--daemon-worker) 띄운다 — pid를 우리가 알고 있으므로 확실히 정리할 수 있다.
// 브라우저는 열리지 않으므로 lifecycle의 최초 접속 유예가 남아도 우리가 먼저 죽인다.

/** 데몬을 스폰하고 조건이 참이 될 때까지 기다린 뒤 {child, ok} 반환. */
async function withDaemon(t, args, home, waitFor) {
  const env = { ...process.env, ...homeEnv(home) };
  delete env.CC_ON_BROWSER_TOKEN;
  const child = execFile(process.execPath, [BIN, ...args, '--daemon-worker'], { env }, () => {});
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await new Promise((r) => { setTimeout(r, 100); });
    ok = waitFor();
  }
  return { child, ok };
}

const recordPath = (home, p) => path.join(home, '.cc-on-browser', `instance-${p}.json`);
const recordFiles = (home) => {
  try {
    return readdirSync(path.join(home, '.cc-on-browser')).filter((f) => f.startsWith('instance-'));
  } catch {
    return [];
  }
};

async function freePort() {
  const net = await import('node:net');
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}

test('the daemon publishes its identity record once it is listening', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const p = await freePort();
  const { ok } = await withDaemon(t, ['--port', String(p)], home, () => existsSync(recordPath(home, p)));
  assert.ok(ok, '신원 파일이 발행된다');
  const rec = JSON.parse(readFileSync(recordPath(home, p), 'utf8'));
  assert.equal(rec.port, p);
  assert.equal(rec.version, pkg.version);
  assert.equal(typeof rec.token, 'string');
  assert.ok(rec.token.length >= 16);
  assert.equal(typeof rec.pid, 'number');
});

// 설계도의 "stale 파일 + 포트 비어 있음 → 정상 기동하며 파일을 덮어씀"의 뒷부분.
// 앞부분(재사용으로 새지 않는다)은 부모 쪽 테스트가, 덮어쓰기는 여기서 확인한다.
test('a stale record is overwritten by the daemon that takes the port', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const p = await freePort();
  writeRecord(home, { port: p, token: 'stale-token', pid: 1, version: '0.0.1' });

  const readRec = () => {
    try {
      return JSON.parse(readFileSync(recordPath(home, p), 'utf8'));
    } catch {
      return null;
    }
  };
  const { ok } = await withDaemon(t, ['--port', String(p)], home, () => readRec()?.token !== 'stale-token');
  assert.ok(ok, 'stale 기록이 새 데몬의 것으로 갈아끼워진다');
  const rec = readRec();
  assert.equal(rec.port, p);
  assert.equal(rec.version, pkg.version, '옛 버전 문자열이 남지 않는다');
  assert.notEqual(rec.pid, 1, '옛 pid가 남지 않는다');
});

test('the daemon does not publish for --port 0 (no stable file key)', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  // 서버가 확실히 떴을 시점까지 기다린 뒤 "아무 파일도 없음"을 단언한다.
  await withDaemon(t, ['--port', '0'], home, () => false);
  assert.deepEqual(recordFiles(home), []);
});

test('--no-open (foreground) does not publish an identity record', {
  skip: NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const p = await freePort();
  const env = { ...process.env, ...homeEnv(home) };
  delete env.CC_ON_BROWSER_TOKEN;
  const child = execFile(process.execPath, [BIN, '--no-open', '--port', String(p)], { env }, () => {});
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } });
  let printed = '';
  child.stdout.on('data', (d) => { printed += d; });
  for (let i = 0; i < 60 && !/#token=/.test(printed); i++) {
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.match(printed, /#token=/, '포그라운드 서버가 URL을 출력했다');
  assert.deepEqual(recordFiles(home), [], '--no-open은 신원 파일을 남기지 않는다');
});

// 정상 종료(SIGTERM → shutdown)가 자기 기록을 지우는지. Windows는 신호가 없어
// (Stop-Process = TerminateProcess) 핸들러가 돌지 않으므로 POSIX CI가 커버한다.
test('a clean shutdown removes the daemon\'s own record', {
  skip: process.platform === 'win32'
    ? 'win32는 실제 신호가 없어 종료 핸들러가 돌지 않는다 — CI POSIX가 커버'
    : NEEDS_DIST_SKIP,
}, async (t) => {
  const home = isolatedHome(t);
  const p = await freePort();
  const { child, ok } = await withDaemon(t, ['--port', String(p)], home, () => existsSync(recordPath(home, p)));
  assert.ok(ok);
  child.kill('SIGTERM');
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    await new Promise((r) => { setTimeout(r, 100); });
    gone = !existsSync(recordPath(home, p));
  }
  assert.ok(gone, '종료 시 자기 기록을 지운다');
});

// ----- --shortcut (Windows 무콘솔 런처 바로가기) -----
// 실제 .lnk를 만들지 않는다: PowerShell을 주입한 가짜 spawn으로 대체해 출력 파싱과
// 부분 성공/전체 실패 판정만 검증한다(실 생성은 Windows 수동 스모크가 커버).

/** stdout에 한 줄 JSON들을 내보내고 code로 끝나는 가짜 powershell 자식. */
function fakePowerShell(lines, { code = 0, stderr = '' } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (lines.length) child.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

/** log/logError를 한 버퍼로 모아 문구를 단언한다. */
const collect = () => {
  const out = [];
  return { out, log: (...a) => out.push(a.join(' ')) };
};

const scTmp = () => mkdtempSync(path.join(os.tmpdir(), 'ccob-sc-'));

test('--help mentions --shortcut', async () => {
  const r = await runBin(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--shortcut/);
});

// 진짜 진입점을 통과하는 순서 테스트 — --shortcut이 "서버를 띄울 때만 필요한" 사전
// 점검들보다 앞에서 처리되는지. 일부러 CLI 경로와 포트를 둘 다 망가뜨려도 그 진단이
// 아니라 바로가기 경로의 메시지가 나와야 한다. CC_ON_BROWSER_TEST_PLATFORM으로
// 비-Windows 경로를 밟아 이 기계에 실제 .lnk를 만들지 않는다.
test('--shortcut is handled before every runtime preflight', async () => {
  const r = await runBin(['--shortcut', '--port', '70000'], {
    CC_ON_BROWSER_TEST_PLATFORM: 'linux',
    CLAUDE_WEB_CLI_PATH: path.join(root, 'no-such-claude-binary-for-test'),
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Windows-only \(detected: linux\)/);
  assert.doesNotMatch(r.stderr, /Invalid --port value/, '포트 검사보다 앞이어야 한다');
  assert.doesNotMatch(r.stderr, /does not exist/, 'CLI 경로 검사보다 앞이어야 한다');
});

test('buildShortcutArguments quotes the vbs and node paths for wscript', () => {
  const sep = String.fromCharCode(92); // 백슬래시 — 소스에 이스케이프를 늘리지 않는다
  const vbs = `C:${sep}Program Files${sep}app${sep}bin${sep}cc-on-browser-silent.vbs`;
  const node = `C:${sep}Program Files${sep}nodejs${sep}node.exe`;
  assert.equal(
    buildShortcutArguments({ vbsPath: vbs, nodeExe: node }),
    `//nologo "${vbs}" "${node}"`,
  );
});

test('parseShortcutOutput keeps JSON lines and drops noise', () => {
  const parsed = parseShortcutOutput(
    ['some warning text', '{"name":"Desktop","ok":true,"path":"D:/x.lnk"}', 'not json', '{bad json']
      .join('\r\n'),
  );
  assert.deepEqual(parsed, [{ name: 'Desktop', ok: true, path: 'D:/x.lnk' }]);
});

test('--shortcut on non-Windows exits 1 with an explanation', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'linux',
    log,
    logError: log,
  });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /Windows-only \(detected: linux\)/);
});

test('--shortcut reports partial success (one location fails) and still exits 0', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'win32',
    tmpdir: scTmp(),
    spawnFn: fakePowerShell([
      '{"name":"Desktop","ok":true,"path":"D:/Desktop/Claude Code on Browser.lnk"}',
      '{"name":"StartMenu","ok":false,"path":"","error":"access denied"}',
      '{"name":"WshEnabled","ok":true,"path":"","error":""}',
    ]),
    log,
    logError: log,
  });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /created {2}Desktop/);
  assert.match(text, /FAILED {3}StartMenu access denied/);
});

test('--shortcut exits 1 when every location fails', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'win32',
    tmpdir: scTmp(),
    spawnFn: fakePowerShell([
      '{"name":"Desktop","ok":false,"path":"","error":"nope"}',
      '{"name":"StartMenu","ok":false,"path":"","error":"nope"}',
    ]),
    log,
    logError: log,
  });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /No shortcut could be created/);
});

test('--shortcut warns when Windows Script Host is disabled by policy', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'win32',
    tmpdir: scTmp(),
    spawnFn: fakePowerShell([
      '{"name":"Desktop","ok":true,"path":"D:/x.lnk"}',
      '{"name":"StartMenu","ok":true,"path":"D:/y.lnk"}',
      '{"name":"WshEnabled","ok":false,"path":"","error":""}',
    ]),
    log,
    logError: log,
  });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /Windows Script Host is disabled/);
});

// 가짜 spawn이 인수·생성된 .ps1을 실제로 들여다본다 — 그러지 않으면 q() 이스케이프,
// BOM, System32\wscript.exe 경로, 임시파일 정리가 깨져도 테스트가 초록으로 통과한다.
test('--shortcut generates a PowerShell script with the right target and cleans it up', async () => {
  const bs = String.fromCharCode(92);
  const { log } = collect();
  let seen = null;
  const spy = (exe, argv) => {
    const file = argv[argv.indexOf('-File') + 1];
    seen = { exe, argv, file, script: readFileSync(file, 'utf8') };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(
        '{"name":"Desktop","ok":true,"path":"D:/x.lnk"}\n'
        + '{"name":"StartMenu","ok":true,"path":"D:/y.lnk"}\n',
      ));
      child.emit('close', 0);
    });
    return child;
  };
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: '9.9.9',
    platform: 'win32',
    nodeExe: `C:${bs}Program Files${bs}nodejs${bs}node.exe`,
    tmpdir: scTmp(),
    spawnFn: spy,
    log,
    logError: log,
  });
  assert.equal(code, 0);
  assert.equal(seen.exe, 'powershell.exe');
  assert.ok(seen.argv.includes('-NoProfile') && seen.argv.includes('-NonInteractive'));
  // PowerShell 5.1이 비-ASCII를 UTF-8로 읽도록 BOM을 붙인다.
  assert.equal(seen.script.charCodeAt(0), 0xfeff, 'UTF-8 BOM');
  // 경로 구분자는 정확히 한 개여야 한다 — psScript가 템플릿 리터럴이라 이스케이프를
  // 하나 더 넣으면 레지스트리 경로·exe 경로가 조용히 어긋난다.
  assert.match(seen.script, /'System32\\wscript\.exe'/, 'wscript.exe를 TargetPath로 삼는다');
  assert.match(
    seen.script,
    /'\\SOFTWARE\\Microsoft\\Windows Script Host\\Settings'/,
    '레지스트리 경로에 이중 백슬래시가 없다',
  );
  assert.match(seen.script, /GetFolderPath\('Desktop'\)/, '셸 폴더 API로 해석(OneDrive 리다이렉트 대응)');
  assert.match(seen.script, /GetFolderPath\('Programs'\)/);
  assert.ok(seen.script.includes('//nologo'), 'Arguments에 //nologo가 실린다');
  assert.ok(seen.script.includes('cc-on-browser-silent.vbs'));
  assert.ok(seen.script.includes('HKCU:') && seen.script.includes('HKLM:'), 'WSH 정책은 양쪽 하이브 확인');
  assert.equal(existsSync(seen.file), false, '임시 .ps1은 삭제된다');
});

// 중간에 죽어 뒤쪽 대상 결과가 안 나온 경우 — 성공으로 삼켜선 안 된다.
test('--shortcut reports a target PowerShell never got to (no silent success)', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'win32',
    tmpdir: scTmp(),
    spawnFn: fakePowerShell(
      ['{"name":"Desktop","ok":true,"path":"D:/x.lnk"}'],
      { code: 1, stderr: 'COM exception' },
    ),
    log,
    logError: log,
  });
  assert.equal(code, 0, '쓸 수 있는 바로가기가 하나 생겼으니 0');
  const text = out.join('\n');
  assert.match(text, /created {2}Desktop/);
  assert.match(text, /FAILED {3}StartMenu/, '보고되지 않은 대상은 실패로 표시된다');
  assert.match(text, /COM exception/, '프로세스 오류도 남긴다');
});

test('--shortcut exits 1 when PowerShell yields no parsable result', async () => {
  const { out, log } = collect();
  const code = await runShortcutCommand({
    pkgRoot: root,
    version: pkg.version,
    platform: 'win32',
    tmpdir: scTmp(),
    spawnFn: fakePowerShell([], { code: 1, stderr: 'powershell blew up' }),
    log,
    logError: log,
  });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /produced no result/);
  assert.match(out.join('\n'), /powershell blew up/);
});

// 패키지에 실제로 동봉되는지 — files:["bin/"]가 .vbs까지 싣는다는 전제를 못 박는다.
test('the silent launcher ships inside bin/ and points at the real entry point', () => {
  const vbs = path.join(root, 'bin', 'cc-on-browser-silent.vbs');
  assert.ok(existsSync(vbs), 'bin/cc-on-browser-silent.vbs 존재');
  const src = readFileSync(vbs, 'utf8');
  assert.match(src, /cc-on-browser\.mjs/);
  // 창 숨김(0) + 대기(True): 대기해야 부모 Node의 실패를 MsgBox로 알릴 수 있다.
  assert.match(src, /shell\.Run\(cmd, 0, True\)/);
  assert.match(src, /If rc <> 0 Then/, '실패를 삼키지 않고 알린다');
  // WSH는 .vbs를 시스템 ANSI 코드페이지로 읽는다 — 비-ASCII 문자열은 깨진다.
  // eslint 없이도 회귀를 잡도록 소스 전체를 ASCII로 강제한다.
  assert.ok(/^[\x00-\x7F]*$/.test(src), 'VBS 소스는 ASCII만 담는다(MsgBox 깨짐 방지)');
  // package.json의 files에 bin/이 있어야 전역 설치본에 .vbs가 따라간다.
  assert.ok(pkg.files.includes('bin/'));
});
