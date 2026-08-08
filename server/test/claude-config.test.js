// Claude Code 설정(~/.claude/settings.json) 읽기·쓰기 모듈 + HTTP API 테스트.
//
// 모든 테스트는 임시 디렉터리 경로를 주입한다 — 개발자의 실제 ~/.claude/settings.json은
// 절대 열리지도 쓰이지도 않는다(이 파일이 손상되면 CLI 전체가 깨진다).
//
// 계약 요약(설계도 §2):
//  · 읽기: 없으면 exists=false + content='{}' 기준선
//  · 쓰기: JSON·최상위 객체 검증 → 직렬화 → mtime 낙관적 잠금 → 원자적 교체
//  · 실패한 쓰기가 큐를 오염시키지 않는다(충돌·파일 오류 뒤에도 다음 저장은 성공)
//  · HTTP: 200{ok,mtimeMs} / 400(형식) / 409(충돌) / 401(무토큰·오류 토큰) / 405(그 외 메서드)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import {
  EMPTY_CONFIG,
  defaultConfigPath,
  readClaudeConfig,
  writeClaudeConfig,
} from '../src/claude-config.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const TOKEN = 'cfg-token-xyz';

let tmpRoot = '';
let configPath = '';
let handle = null;
let base = '';

const api = (init = {}) =>
  fetch(`${base}/api/claude-config`, {
    ...init,
    headers: { 'x-auth-token': TOKEN, ...(init.headers || {}) },
  });

// 저장 → 새 mtime을 돌려받아 다음 저장의 기준선으로 쓴다(에디터와 같은 흐름).
async function put(body, headers) {
  const res = await api({
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-cfg-'));
  // 일부러 아직 만들지 않은 하위 디렉터리를 가리킨다 — 부모 생성 경로까지 검증.
  configPath = path.join(tmpRoot, '.claude', 'settings.json');
  handle = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot: path.join(tmpRoot, 'projects'),
    claudeConfigPath: configPath,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('기본 경로는 홈의 .claude/settings.json이다', () => {
  assert.equal(defaultConfigPath('/home/u'), path.join('/home/u', '.claude', 'settings.json'));
});

test('파일이 없으면 exists=false와 빈 객체 기준선을 준다', async () => {
  const read = await readClaudeConfig(configPath);
  assert.equal(read.exists, false);
  assert.equal(read.content, EMPTY_CONFIG);
  assert.equal(read.mtimeMs, null);
  assert.equal(read.path, configPath);
});

test('GET /api/claude-config — 인증 필요(무토큰·오류 토큰은 401)', async () => {
  const noToken = await fetch(`${base}/api/claude-config`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${base}/api/claude-config`, { headers: { 'x-auth-token': 'nope' } });
  assert.equal(badToken.status, 401);
  const ok = await api();
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).exists, false);
});

test('PUT — 잘못된 토큰이면 파일에 손대기 전에 401', async () => {
  const res = await api({
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-auth-token': 'nope' },
    body: JSON.stringify({ content: '{"model":"x"}', expectedMtimeMs: null }),
  });
  assert.equal(res.status, 401);
  assert.equal((await readClaudeConfig(configPath)).exists, false); // 아무것도 쓰이지 않았다
});

test('PUT — 새 파일을 만들고(부모 디렉터리 포함) 새 mtime을 돌려준다', async () => {
  const content = '{\n  "model": "opus",\n  "permissions": { "allow": [] }\n}';
  const { status, body } = await put({ content, expectedMtimeMs: null });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.mtimeMs, 'number');

  const read = await readClaudeConfig(configPath);
  assert.equal(read.exists, true);
  assert.equal(read.content, content); // 원문(들여쓰기 포함) 그대로 보존
  assert.equal(read.mtimeMs, body.mtimeMs);
});

test('PUT — 잘못된 JSON·최상위 비객체는 400이고 기존 파일을 건드리지 않는다', async () => {
  const before = await readClaudeConfig(configPath);
  const broken = await put({ content: '{ "a": ', expectedMtimeMs: before.mtimeMs });
  assert.equal(broken.status, 400);
  const array = await put({ content: '[1,2]', expectedMtimeMs: before.mtimeMs });
  assert.equal(array.status, 400);
  const nul = await put({ content: 'null', expectedMtimeMs: before.mtimeMs });
  assert.equal(nul.status, 400);
  assert.deepEqual(await readClaudeConfig(configPath), before);
});

test('PUT — 본문 형식 위반(content 누락·타입 오류·기준 mtime 누락)은 400', async () => {
  assert.equal((await put({ expectedMtimeMs: null })).status, 400);
  assert.equal((await put({ content: 42 })).status, 400);
  assert.equal((await put({ content: '{}', expectedMtimeMs: 'x' })).status, 400);
  // 기준 mtime 생략은 "새로 만들기"로 해석되지 않는다 — 반드시 명시해야 한다
  assert.equal((await put({ content: '{}' })).status, 400);
  // 무한대·NaN 같은 비유한 수도 거부(JSON에는 1e999가 Infinity로 들어온다)
  const infinite = await api({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{"content":"{}","expectedMtimeMs":1e999}',
  });
  assert.equal(infinite.status, 400);
  const notJson = await api({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(notJson.status, 400);
});

test('PUT — 기준 mtime이 어긋나면 409(다른 곳에서 수정됨)', async () => {
  const before = await readClaudeConfig(configPath);
  const stale = await put({ content: '{"stale":true}', expectedMtimeMs: before.mtimeMs - 1000 });
  assert.equal(stale.status, 409);
  // 파일이 이미 있는데 "없음"(null)을 기대해도 충돌이다
  const asNew = await put({ content: '{"stale":true}', expectedMtimeMs: null });
  assert.equal(asNew.status, 409);
  assert.equal((await readClaudeConfig(configPath)).content, before.content);
});

test('충돌·오류 뒤에도 다음 저장은 정상 성공한다(쓰기 큐가 오염되지 않는다)', async () => {
  const before = await readClaudeConfig(configPath);
  await put({ content: '{"x":1}', expectedMtimeMs: before.mtimeMs - 1 }); // 409
  await put({ content: '{ broken', expectedMtimeMs: before.mtimeMs }); // 400
  const ok = await put({ content: '{"recovered":true}', expectedMtimeMs: before.mtimeMs });
  assert.equal(ok.status, 200);
  assert.equal((await readClaudeConfig(configPath)).content, '{"recovered":true}');
});

test('동시 저장은 직렬화되어 하나만 성공한다(마지막 쓰기 승리 방지)', async () => {
  const before = await readClaudeConfig(configPath);
  const results = await Promise.all([
    put({ content: '{"who":"a"}', expectedMtimeMs: before.mtimeMs }),
    put({ content: '{"who":"b"}', expectedMtimeMs: before.mtimeMs }),
    put({ content: '{"who":"c"}', expectedMtimeMs: before.mtimeMs }),
  ]);
  const ok = results.filter((r) => r.status === 200);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 2);
  // 승자의 내용이 그대로 파일에 남아 있다
  const after = await readClaudeConfig(configPath);
  assert.match(after.content, /^\{"who":"[abc]"\}$/);
  assert.equal(after.mtimeMs, ok[0].body.mtimeMs);
});

test('본문이 1MB를 넘으면 소켓을 끊기 전에 413으로 답한다', async () => {
  const res = await api({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: `{"pad":"${'x'.repeat(1024 * 1024 + 16)}"}`, expectedMtimeMs: null }),
  });
  assert.equal(res.status, 413);
});

test('연속 저장은 mtime이 매번 증가해 낡은 기준선이 통과하지 못한다', async () => {
  // 시간 해상도가 거친 파일시스템에서도 성공한 쓰기마다 버전이 달라져야 한다.
  let cur = await readClaudeConfig(configPath);
  const seen = new Set([cur.mtimeMs]);
  for (let i = 0; i < 5; i += 1) {
    const r = await put({ content: `{"n":${i}}`, expectedMtimeMs: cur.mtimeMs });
    assert.equal(r.status, 200);
    assert.equal(seen.has(r.body.mtimeMs), false, '같은 mtime이 두 번 나오면 안 된다');
    seen.add(r.body.mtimeMs);
    cur = await readClaudeConfig(configPath);
  }
  // 첫 기준선으로 되돌아가 저장하려 하면 충돌이어야 한다
  const stale = await put({ content: '{"stale":1}', expectedMtimeMs: [...seen][0] });
  assert.equal(stale.status, 409);
});

test('mtime이 같아도 내용이 바뀌었으면 충돌로 막는다(같은 ms 외부 수정)', async () => {
  // 파일시스템 시간 해상도(ms)보다 빠른 외부 수정은 mtime만으로 구분되지 않는다.
  // 저장 직후 mtime을 그대로 유지한 채 내용만 바꿔치기해 그 경로를 재현한다.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-cfg-hash-'));
  const target = path.join(dir, 'settings.json');
  const saved = await writeClaudeConfig('{"mine":true}', null, target);
  const stamp = new Date(saved.mtimeMs);
  await fs.writeFile(target, '{"theirs":true}');
  await fs.utimes(target, stamp, stamp); // 외부 수정이 같은 ms에 일어난 상황
  await assert.rejects(
    () => writeClaudeConfig('{"mine":2}', saved.mtimeMs, target),
    (err) => err.code === 'ECONFLICT',
  );
  assert.equal(await fs.readFile(target, 'utf8'), '{"theirs":true}'); // 덮이지 않았다
  await fs.rm(dir, { recursive: true, force: true });
});

test('실제 쓰기 실패 뒤에도 같은 경로의 다음 저장이 성공한다(큐 회복)', async () => {
  // 400(검증 실패)은 큐에 들어가기 전에 걸러지므로 큐 회복을 증명하지 못한다.
  // 여기서는 큐 안에서 진짜 파일시스템 오류를 내고(부모가 디렉터리가 아님),
  // 원인을 고친 뒤 다음 저장이 정상 성공하는지 본다.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-cfg-fail-'));
  const parent = path.join(dir, 'parent');
  const target = path.join(parent, 'settings.json');
  await fs.writeFile(parent, 'not a directory'); // mkdir/open이 ENOTDIR로 실패한다
  await assert.rejects(() => writeClaudeConfig('{"a":1}', null, target));
  // 원인 제거 — 같은 경로의 큐가 앞선 거부로 오염됐다면 여기서도 실패한다
  await fs.rm(parent);
  const ok = await writeClaudeConfig('{"a":2}', null, target);
  assert.equal(typeof ok.mtimeMs, 'number');
  assert.equal((await readClaudeConfig(target)).content, '{"a":2}');
  await fs.rm(dir, { recursive: true, force: true });
});

test('메서드 계약 — 그 외 메서드는 405 + Allow: GET, PUT', async () => {
  const res = await api({ method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, PUT');
});

test('심볼릭 링크·비정규 파일은 읽기·쓰기 모두 거부한다', async () => {
  const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-cfg-link-'));
  const target = path.join(linkDir, 'real.json');
  const link = path.join(linkDir, 'settings.json');
  await fs.writeFile(target, '{"real":true}');
  try {
    await fs.symlink(target, link);
  } catch {
    // Windows에서 개발자 모드/권한이 없으면 심볼릭 링크를 만들 수 없다 — 그 환경에서는
    // 검증할 대상이 없으므로 건너뛴다(디렉터리로 같은 계약을 확인한다).
    await fs.rm(linkDir, { recursive: true, force: true });
    const dirAsConfig = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-cfg-dir-'));
    const asDir = path.join(dirAsConfig, 'settings.json');
    await fs.mkdir(asDir);
    await assert.rejects(() => readClaudeConfig(asDir), /not a regular file/);
    await fs.rm(dirAsConfig, { recursive: true, force: true });
    return;
  }
  await assert.rejects(() => readClaudeConfig(link), /not a regular file/);
  await assert.rejects(() => writeClaudeConfig('{"a":1}', null, link), /not a regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), '{"real":true}'); // 링크 대상은 무사
  await fs.rm(linkDir, { recursive: true, force: true });
});

test('임시 파일은 남지 않는다(성공·실패 모두)', async () => {
  const dir = path.dirname(configPath);
  const before = await readClaudeConfig(configPath);
  await put({ content: '{"tmp":1}', expectedMtimeMs: before.mtimeMs });
  await put({ content: '{ broken', expectedMtimeMs: null });
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.filter((f) => f.includes('.tmp')), []);
});
