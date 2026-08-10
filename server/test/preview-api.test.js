// 결과물 미리보기 — 티켓 저장소 단위 테스트 + 실서버 HTTP 계약 테스트.
//
// 두 층으로 나눈 이유: TTL 만료·LRU 축출은 가짜 시계를 주입해야 결정적으로 검증되고
// (실시간으로 30분을 기다릴 수 없다), 인증·라우팅·헤더·상태코드는 실제 서버를 띄워야
// 의미가 있다(SPA fallback보다 먼저 가로채는지 등은 라우터를 통과해야 드러난다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPreviewApi } from '../src/preview-api.js';
import { startServer } from '../src/server.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const TOKEN = 'preview-token-abc';

// ---------------------------------------------------------------- 단위: 티켓 저장소

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-prev-'));
  const cwd = path.join(root, 'work');
  await fs.mkdir(path.join(cwd, 'sub'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'a.html'), '<h1>A</h1>');
  await fs.writeFile(path.join(cwd, 'sub', 's.css'), 'h1{color:red}');
  await fs.writeFile(path.join(root, 'outside.txt'), 'secret');
  return { root, cwd, cleanup: () => rmTemp(root) };
}

// Windows는 서빙이 방금 닫은 파일 핸들이 잠깐 남아 rmdir이 EBUSY로 튄다(CI 실측) —
// e2e/global-setup의 .state 정리와 같은 이유·같은 처방이다. 재시도는 노드가 해 준다.
const rmTemp = (p) => fs.rm(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

test('티켓: 발급 → 파일 자신과 같은 스코프의 하위 리소스를 연다', async () => {
  const fx = await makeFixture();
  try {
    const api = createPreviewApi();
    const t = await api.issue({ sessionKey: 's_1', cwd: fx.cwd, filePath: path.join(fx.cwd, 'a.html') });
    assert.match(t.url, /^\/preview\/[0-9a-f]{32}\/a\.html$/);
    assert.equal(t.name, 'a.html');
    assert.ok(api.resolveRequest(t.url).target.endsWith('a.html'));
    const sub = api.resolveRequest(`/preview/${t.ticket}/sub/s.css`);
    assert.ok(sub.target.endsWith(path.join('sub', 's.css')));
  } finally {
    await fx.cleanup();
  }
});

test('티켓: 세션 cwd 밖 · 상대경로 · UNC · 없는 파일은 거부', async () => {
  const fx = await makeFixture();
  try {
    const api = createPreviewApi();
    const issue = (filePath, cwd = fx.cwd) => api.issue({ sessionKey: 's_1', cwd, filePath });
    await assert.rejects(issue(path.join(fx.root, 'outside.txt')), (e) => e.status === 403);
    await assert.rejects(issue('relative/a.html'), (e) => e.status === 400);
    await assert.rejects(issue('\\\\server\\share\\a.html'), (e) => e.status === 400);
    await assert.rejects(issue(path.join(fx.cwd, 'nope.html')), (e) => e.code === 'ENOENT');
    // 디렉터리는 정규 파일이 아니다
    await assert.rejects(issue(path.join(fx.cwd, 'sub')), (e) => e.status === 415);
    // 라이브 세션이 아니면(cwd 없음) 404
    await assert.rejects(issue(path.join(fx.cwd, 'a.html'), null), (e) => e.status === 404);
  } finally {
    await fx.cleanup();
  }
});

test('티켓: 스코프 탈출 시도(.. · 인코딩 · 드라이브 · 빈 세그먼트)는 전부 거부', async () => {
  const fx = await makeFixture();
  try {
    const api = createPreviewApi();
    const t = await api.issue({ sessionKey: 's_1', cwd: fx.cwd, filePath: path.join(fx.cwd, 'sub', 's.css') });
    const bad = [
      `/preview/${t.ticket}/../a.html`,
      `/preview/${t.ticket}/..%2Fa.html`,
      `/preview/${t.ticket}/%2e%2e/a.html`,
      `/preview/${t.ticket}/..%5Ca.html`,
      `/preview/${t.ticket}/C:/Windows/win.ini`,
      `/preview/${t.ticket}//s.css`,
      `/preview/${t.ticket}/%zz`,
    ];
    for (const url of bad) {
      assert.throws(() => api.resolveRequest(url), (e) => e.status === 400, url);
    }
    assert.throws(() => api.resolveRequest('/preview/deadbeef/x'), (e) => e.status === 404);
    assert.throws(
      () => api.resolveRequest('/preview/00000000000000000000000000000000/x'),
      (e) => e.status === 404,
    );
  } finally {
    await fx.cleanup();
  }
});

// 이 테스트는 platform 플래그(비교 정책)만이 아니라 **파일시스템 자체가** 대소문자를
// 무시해야 성립한다 — issue()가 격리 판정 전에 cwd를 realpath하기 때문이다. 대소문자를
// 구분하는 fs(리눅스 CI)에서는 철자를 바꾼 경로가 애초에 존재하지 않아 ENOENT로 죽는다.
// 그래서 정책을 상수로 짐작하지 않고 tmpdir에서 실제로 한 번 확인하고 건너뛴다
// (Windows·macOS에서는 그대로 돈다).
const CASE_INSENSITIVE_FS = await (async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-case-'));
  try {
    await fs.realpath(dir.toUpperCase());
    return true;
  } catch {
    return false;
  } finally {
    await rmTemp(dir);
  }
})();

test('티켓: cwd 철자의 대소문자가 달라도 정상 파일은 거부되지 않는다', {
  skip: CASE_INSENSITIVE_FS ? false : '대소문자를 구분하는 파일시스템 — 철자를 바꾼 cwd가 존재하지 않는다',
}, async () => {
  const fx = await makeFixture();
  try {
    // 격리 판정을 "대소문자 구분"으로만 바꾸면 여기서 오탐(403)이 난다.
    // (대소문자만 다른 **별개** 디렉터리를 오인하지 않는 쪽은 dev/ino 확인이 맡는데,
    //  그 상황은 디렉터리별 대소문자 구분이 켜진 Windows에서만 만들 수 있어 이식성
    //  있는 테스트로 재현할 수 없다 — 여기서는 오탐이 없다는 쪽만 고정한다.)
    const api = createPreviewApi({ platform: 'win32' });
    const t = await api.issue({
      sessionKey: 's_1',
      cwd: fx.cwd.toUpperCase(),
      filePath: path.join(fx.cwd, 'a.html'),
    });
    assert.match(t.url, /^\/preview\/[0-9a-f]{32}\//);
  } finally {
    await fx.cleanup();
  }
});

test('티켓: TTL 만료 · LRU 축출(최근 사용은 살아남음) · 세션 폐기', async () => {
  const fx = await makeFixture();
  try {
    let clock = 1_000;
    const api = createPreviewApi({ now: () => clock, ttlMs: 5_000, maxTickets: 2 });
    const mk = (key = 's_1') =>
      api.issue({ sessionKey: key, cwd: fx.cwd, filePath: path.join(fx.cwd, 'a.html') });

    // LRU: t1을 쓴 뒤 t3을 발급하면 손 안 댄 t2가 밀려난다.
    const t1 = await mk();
    const t2 = await mk();
    api.resolveRequest(t1.url);
    await mk();
    assert.doesNotThrow(() => api.resolveRequest(t1.url), 'recently used ticket survives');
    assert.throws(() => api.resolveRequest(t2.url), (e) => e.status === 404);

    // TTL: 시계를 넘기면 전부 사라진다.
    clock += 5_001;
    assert.equal(api.size, 0);

    // 세션 폐기: 그 세션의 티켓만 즉시 무효.
    const mine = await mk('s_A');
    const other = await mk('s_B');
    assert.equal(api.revokeSession('s_A'), 1);
    assert.throws(() => api.resolveRequest(mine.url), (e) => e.status === 404);
    assert.doesNotThrow(() => api.resolveRequest(other.url));
  } finally {
    await fx.cleanup();
  }
});

test('티켓: 바이트 상한을 넘는 파일은 413', async () => {
  const fx = await makeFixture();
  try {
    const api = createPreviewApi({ maxBytes: 8 });
    const big = path.join(fx.cwd, 'big.txt');
    await fs.writeFile(big, 'x'.repeat(64));
    const t = await api.issue({ sessionKey: 's_1', cwd: fx.cwd, filePath: big });
    const { entry, target } = api.resolveRequest(t.url);
    await assert.rejects(api.readForResponse(target, entry.root), (e) => e.status === 413);

    // 상한 이하는 그대로 읽힌다.
    const okApi = createPreviewApi({ maxBytes: 1024 });
    const t2 = await okApi.issue({ sessionKey: 's_1', cwd: fx.cwd, filePath: path.join(fx.cwd, 'sub', 's.css') });
    const r2 = okApi.resolveRequest(t2.url);
    const { body } = await okApi.readForResponse(r2.target, r2.entry.root);
    assert.equal(body.toString(), 'h1{color:red}');
  } finally {
    await fx.cleanup();
  }
});

// ------------------------------------------------------------ 통합: 실서버 HTTP 계약

let handle = null;
let base = '';
let wsBase = '';
let fx = null;
let staticDir = '';
let sessionKey = null;
let ws = null;

/** 세션 하나를 띄우고 key를 돌려준다 — 티켓 발급은 라이브 세션에만 허용되므로 필요. */
function startLiveSession(cwd) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${wsBase}/ws?token=${TOKEN}`);
    const timer = setTimeout(() => reject(new Error('timeout starting session')), 15_000);
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'started') {
        clearTimeout(timer);
        resolve({ key: msg.key, sock });
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
    sock.on('error', reject);
    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'start', startId: 'p1', cwd, permissionMode: 'default' }));
    });
  });
}

before(async () => {
  fx = await makeFixture();
  staticDir = path.join(fx.root, 'dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>ccob-spa</title>');
  handle = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot: path.join(fx.root, 'projects'),
    staticDir,
    quotaFetcher: async () => null,
  });
  base = `http://127.0.0.1:${handle.port}`;
  wsBase = `ws://127.0.0.1:${handle.port}`;
  const live = await startLiveSession(fx.cwd);
  sessionKey = live.key;
  ws = live.sock;
});

after(async () => {
  try { ws?.close(); } catch { /* noop */ }
  await handle?.close();
  await fx?.cleanup();
});

const ticketUrl = (p, key = sessionKey) =>
  `${base}/api/preview-ticket?key=${encodeURIComponent(key)}&path=${encodeURIComponent(p)}`;

/** 요청 라인을 접지 않고 그대로 보내는 GET — fetch()는 경로를 미리 정규화한다. */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, method: 'GET', path: rawPath },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: 티켓 발급은 인증을 요구한다', async () => {
  const p = path.join(fx.cwd, 'a.html');
  const noToken = await fetch(ticketUrl(p));
  assert.equal(noToken.status, 401);
  const badOrigin = await fetch(ticketUrl(p), {
    headers: { 'x-auth-token': TOKEN, origin: 'http://evil.example' },
  });
  assert.equal(badOrigin.status, 401);
});

test('HTTP: 발급 → 서빙(헤더 계약) → 상대 리소스', async () => {
  const res = await fetch(ticketUrl(path.join(fx.cwd, 'a.html')), {
    headers: { 'x-auth-token': TOKEN },
  });
  assert.equal(res.status, 200);
  const { url, ticket } = await res.json();
  assert.match(url, /^\/preview\/[0-9a-f]{32}\/a\.html$/);

  // 서빙은 토큰 없이 — 티켓 자체가 capability다.
  const served = await fetch(`${base}${url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(served.headers.get('cache-control'), 'no-store');
  assert.equal(served.headers.get('access-control-allow-origin'), '*');
  // 새 탭으로 직접 열어도 앱 오리진 권한이 없도록 CSP sandbox가 붙는다.
  assert.equal(served.headers.get('content-security-policy'), 'sandbox allow-scripts allow-modals');
  assert.equal(await served.text(), '<h1>A</h1>');

  // 같은 티켓으로 하위 리소스도 열린다(HTML의 상대 참조 계약).
  const css = await fetch(`${base}/preview/${ticket}/sub/s.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  // 텍스트/HTML이 아닌 응답에는 sandbox CSP를 붙이지 않는다(불필요한 제약).
  assert.equal(css.headers.get('content-security-policy'), null);
});

test('HTTP: cwd 밖 파일은 403, 라이브가 아닌 세션은 404', async () => {
  const outside = await fetch(ticketUrl(path.join(fx.root, 'outside.txt')), {
    headers: { 'x-auth-token': TOKEN },
  });
  assert.equal(outside.status, 403);
  const dead = await fetch(ticketUrl(path.join(fx.cwd, 'a.html'), 's_nonexistent'), {
    headers: { 'x-auth-token': TOKEN },
  });
  assert.equal(dead.status, 404);
});

test('HTTP: 잘못된 미리보기 경로는 SPA fallback(index.html)으로 새지 않는다', async () => {
  for (const p of ['/preview/deadbeef/x', '/preview/00000000000000000000000000000000/x.html']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
    const body = await res.text();
    assert.ok(!body.includes('ccob-spa'), `${p} leaked the SPA shell`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', `${p} missing CORS on error`);
  }
  // 비교 기준 — /preview/가 아닌 미지 경로는 여전히 SPA로 떨어진다(기존 계약 유지).
  const spa = await fetch(`${base}/some/app/route`);
  assert.equal(spa.status, 200);
  assert.ok((await spa.text()).includes('ccob-spa'));
});

test('HTTP: 티켓 스코프 탈출 시도는 거부되고 오류에 경로가 실리지 않는다', async () => {
  const res = await fetch(ticketUrl(path.join(fx.cwd, 'sub', 's.css')), {
    headers: { 'x-auth-token': TOKEN },
  });
  const { ticket } = await res.json();
  // 원본 요청 라인 기준으로 판정한다 — URL 정규화가 접어 버리기 전에 거부해야 한다.
  const escaped = await fetch(`${base}/preview/${ticket}/..%2Fa.html`);
  assert.equal(escaped.status, 400);
  const missing = await fetch(`${base}/preview/${ticket}/nope.css`);
  assert.equal(missing.status, 404);
  const body = await missing.text();
  assert.ok(!body.includes(fx.cwd), 'error body leaked the absolute session path');
});

test('HTTP: URL 정규화가 접두사를 지워도 SPA로 새지 않는다(원본 경로로 라우팅)', async () => {
  const res = await fetch(ticketUrl(path.join(fx.cwd, 'a.html')), {
    headers: { 'x-auth-token': TOKEN },
  });
  const { ticket } = await res.json();
  // fetch()는 보내기 전에 경로를 스스로 접으므로 이 경우를 재현할 수 없다 —
  // 요청 라인을 그대로 싣는 http.request로 보낸다. 서버가 정규화된 pathname으로만
  // 라우팅하면 '/a.html'이 되어 정적 SPA fallback(200)으로 떨어진다.
  for (const p of [
    `/preview/${ticket}/%2e%2e/%2e%2e/a.html`,
    `/preview/${ticket}/../../a.html`,
  ]) {
    const r = await rawGet(p);
    assert.equal(r.status, 400, p);
    assert.ok(!r.body.includes('ccob-spa'), `${p} leaked the SPA shell`);
  }
});

test('HTTP: 모르는 확장자는 렌더 대신 다운로드로 유도한다', async () => {
  const bin = path.join(fx.cwd, 'blob.dat');
  await fs.writeFile(bin, Buffer.from([0, 1, 2, 3]));
  const res = await fetch(ticketUrl(bin), { headers: { 'x-auth-token': TOKEN } });
  const { url } = await res.json();
  const served = await fetch(`${base}${url}`);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.headers.get('content-disposition') ?? '', /^attachment;/);
});

test('HTTP: 세션이 끝나면 그 세션의 티켓이 즉시 무효화된다', async () => {
  const live = await startLiveSession(fx.cwd);
  const res = await fetch(ticketUrl(path.join(fx.cwd, 'a.html'), live.key), {
    headers: { 'x-auth-token': TOKEN },
  });
  const { url } = await res.json();
  assert.equal((await fetch(`${base}${url}`)).status, 200);

  live.sock.send(JSON.stringify({ type: 'stop', key: live.key }));
  // exit 방송이 폐기를 돌릴 때까지 잠깐 기다린다.
  for (let i = 0; i < 100; i += 1) {
    if ((await fetch(`${base}${url}`)).status === 404) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await fetch(`${base}${url}`)).status, 404);
  try { live.sock.close(); } catch { /* noop */ }
});
