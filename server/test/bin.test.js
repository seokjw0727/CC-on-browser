// bin/cc-on-browser.mjs CLI 테스트 — 인자 파싱·사전 점검 분기.
// 모든 케이스가 서버 기동/claude spawn 이전에 종료되므로 실제 CLI를 절대 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const BIN = path.join(root, 'bin', 'cc-on-browser.mjs');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const runBin = (args, env = {}) => new Promise((resolve) => {
  // 이 테스트 자체가 cc-on-browser가 띄운 CLI 안에서 돌 수 있다 — 데몬의 env
  // (레거시 CC_ON_BROWSER_DAEMON, 토큰)가 상속되면 분기가 오염되므로 소독한다.
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.CC_ON_BROWSER_DAEMON;
  delete cleanEnv.CC_ON_BROWSER_TOKEN;
  execFile(process.execPath, [BIN, ...args], {
    env: cleanEnv,
    timeout: 10_000,
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

test('occupied --port exits 1 before spawning the daemon', async () => {
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
test('background mode warns when the claude CLI cannot be executed', async () => {
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
test('background mode prints the probed claude CLI version', { skip: process.platform === 'win32' }, async () => {
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
