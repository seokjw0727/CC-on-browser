// bin/cc-on-browser.mjs CLI 테스트 — 인자 파싱·사전 점검 분기.
// 모든 케이스가 서버 기동/claude spawn 이전에 종료되므로 실제 CLI를 절대 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const BIN = path.join(root, 'bin', 'cc-on-browser.mjs');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const runBin = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
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

test('CLAUDE_WEB_CLI_PATH pointing at a missing file exits 1 before boot', async () => {
  const missing = path.join(root, 'no-such-claude-binary-for-test');
  const r = await runBin([], { CLAUDE_WEB_CLI_PATH: missing });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist/);
  assert.ok(r.stderr.includes(missing));
});
