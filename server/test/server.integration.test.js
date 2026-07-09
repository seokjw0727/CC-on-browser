import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const TOKEN = 'test-token-abc123';

let handle = null;
let port = 0;
let base = '';
let wsBase = '';
let tmpRoot = '';
let projectsRoot = '';
let staticDir = '';

// 테스트 간 공유 상태 (node:test는 파일 내 테스트를 순차 실행)
let echoKey = null;
let echoEvents = [];

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.cursor = 0;
    this.bus = new EventEmitter();
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      this.bus.emit('msg');
    });
  }

  static async connect(url, opts) {
    const ws = new WebSocket(url, opts);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  async next(pred, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const msg = this.messages[this.cursor++];
        if (pred(msg)) return msg;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for message: ${pred}`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.bus.off('msg', onMsg);
          reject(new Error(`timeout waiting for message: ${pred}`));
        }, remaining);
        const onMsg = () => {
          clearTimeout(timer);
          resolve();
        };
        this.bus.once('msg', onMsg);
      });
    }
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

function waitClosed(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.on('error', () => {}); // 401 응답은 error 후 close
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-int-'));
  projectsRoot = path.join(tmpRoot, 'projects');
  const projDir = path.join(projectsRoot, 'C--fake-proj');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(
    path.join(projDir, '11111111-1111-1111-1111-111111111111.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: 'C:\\fake',
      message: { role: 'user', content: [{ type: 'text', text: '제목이 될 텍스트' }] },
    }) + '\n' +
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_int_1',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25, cache_creation_input_tokens: 10 },
      },
    }) + '\n',
  );
  staticDir = path.join(tmpRoot, 'dist');
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>ccob-test</title>');

  handle = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    // 테스트는 네트워크 금지 — 공식 사용률은 고정 스텁으로 주입
    quotaFetcher: async () => ({
      fiveHour: { utilization: 46, resetsAt: 1783365599000 },
      sevenDay: { utilization: 28, resetsAt: 1783835999000 },
      fetchedAt: 1,
    }),
  });
  port = handle.port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  if (handle) await handle.close();
  // Windows에서 kill 직후 자식 프로세스 핸들 해제가 늦어 EBUSY가 날 수 있다 — 재시도로 흡수.
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('(a) wrong token websocket is closed immediately', async () => {
  const ws = new WebSocket(`${wsBase}/ws?token=WRONG`);
  await waitClosed(ws);
});

test('(g) spoofed Origin websocket is rejected; valid origin accepted', async () => {
  const bad = new WebSocket(`${wsBase}/ws?token=${TOKEN}`, {
    headers: { Origin: 'http://evil.example' },
  });
  await waitClosed(bad);

  const good = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  good.close();
});

test('(b)(c) start -> started(initInfo); send -> stream events with monotonic seq -> result', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);

  client.send({
    type: 'start', startId: 'cl_1', cwd: tmpRoot,
    model: null, permissionMode: null, resumeSessionId: null,
  });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_1');
  assert.ok(started.key.startsWith('s_'));
  assert.ok(Array.isArray(started.initInfo.models));
  assert.equal(started.initInfo.account.email, 'fake@example.com');
  echoKey = started.key;

  client.send({ type: 'send', key: echoKey, text: 'hello' });
  const result = await client.next(
    (m) => m.type === 'event' && m.key === echoKey && m.payload.type === 'result',
  );
  assert.equal(result.payload.result, 'echo: hello');

  const events = client.messages.filter((m) => m.type === 'event' && m.key === echoKey);
  const seqs = events.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `seq must be monotonic: ${seqs.join(',')}`);
  }
  const types = events.map((e) => e.payload.type);
  assert.equal(types.filter((t) => t === 'stream_event').length, 3);
  assert.ok(types.includes('assistant'));
  assert.ok(types.includes('result'));

  echoEvents = events;
  client.close();
});

test('(e) reconnect + attach(afterSeq) replays ring buffer', async () => {
  assert.ok(echoKey, 'echo test must run first');
  assert.ok(echoEvents.length >= 3);
  const afterSeq = echoEvents[1].seq; // 두 번째 이벤트 이후부터 리플레이 기대
  const expected = echoEvents.filter((e) => e.seq > afterSeq);

  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'attach', key: echoKey, afterSeq });
  const last = expected[expected.length - 1];
  await client.next(
    (m) => m.type === 'event' && m.key === echoKey && m.seq === last.seq,
  );
  const replayed = client.messages.filter((m) => m.type === 'event' && m.key === echoKey);
  assert.deepEqual(
    replayed.map((e) => ({ seq: e.seq, payload: e.payload })),
    expected.map((e) => ({ seq: e.seq, payload: e.payload })),
  );
  client.close();
});

test('(d) permission round-trip: allow -> tool_result -> result; deny -> result', async () => {
  process.env.FAKE_SCENARIO = 'permission';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_2', cwd: tmpRoot });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_2');
  const key = started.key;

  // allow
  client.send({ type: 'send', key, text: 'do write' });
  const permReq = await client.next((m) => m.type === 'permission_request' && m.key === key);
  assert.equal(permReq.toolName, 'Write');
  assert.ok(permReq.requestId);
  assert.ok(permReq.toolUseId);

  client.send({
    type: 'permission', key, requestId: permReq.requestId,
    behavior: 'allow', updatedInput: permReq.input, message: null,
  });
  await client.next(
    (m) => m.type === 'permission_resolved' && m.key === key && m.requestId === permReq.requestId,
  );
  const toolResultEvent = await client.next(
    (m) => m.type === 'event' && m.key === key && m.payload.type === 'user',
  );
  const toolResult = toolResultEvent.payload.message.content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, permReq.toolUseId);
  const allowResult = await client.next(
    (m) => m.type === 'event' && m.key === key && m.payload.type === 'result',
  );
  assert.equal(allowResult.payload.result, 'permission allowed');

  // deny (멀티턴)
  client.send({ type: 'send', key, text: 'do write again' });
  const permReq2 = await client.next(
    (m) => m.type === 'permission_request' && m.key === key && m.requestId !== permReq.requestId,
  );
  client.send({
    type: 'permission', key, requestId: permReq2.requestId,
    behavior: 'deny', updatedInput: null, message: '테스트 거부',
  });
  const denyResult = await client.next(
    (m) => m.type === 'event' && m.key === key && m.payload.type === 'result'
      && m.payload.result === 'permission denied',
  );
  assert.equal(denyResult.payload.is_error, false);
  client.close();
});

test('(d2) allow with updatedPermissions is forwarded to CLI', async () => {
  process.env.FAKE_SCENARIO = 'permission';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_2p', cwd: tmpRoot });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_2p');
  const key = started.key;

  client.send({ type: 'send', key, text: 'do write' });
  const permReq = await client.next((m) => m.type === 'permission_request' && m.key === key);
  assert.ok(Array.isArray(permReq.suggestions) && permReq.suggestions.length > 0,
    'fake-cli must offer at least one permission suggestion');

  client.send({
    type: 'permission', key, requestId: permReq.requestId,
    behavior: 'allow', updatedInput: permReq.input,
    updatedPermissions: permReq.suggestions,
  });
  const allowResult = await client.next(
    (m) => m.type === 'event' && m.key === key && m.payload.type === 'result',
  );
  // fake-cli는 수신한 권한 응답을 echo_response로 되돌려준다 (픽스처 전용 필드)
  const echoed = allowResult.payload.echo_response;
  assert.ok(echoed, 'fake-cli must echo the received permission response');
  assert.equal(echoed.behavior, 'allow');
  assert.deepEqual(echoed.updatedPermissions, permReq.suggestions);
  client.close();
});

test('setThinking: 엄격 검증 — 강제변환성 무효 입력은 error, 유효 입력은 CLI 왕복', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_tk', cwd: tmpRoot });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_tk');
  const key = started.key;

  // 무효 입력 — Number() 강제변환이었다면 ""/false/[]가 0(사고 끔)으로 둔갑했을 값들 포함
  for (const bad of ['', '0', false, [], -1, 1.5]) {
    client.send({ type: 'setThinking', key, maxThinkingTokens: bad });
    const err = await client.next((m) => m.type === 'error' && m.key === key);
    assert.match(err.message, /invalid maxThinkingTokens/);
  }

  // 유효 입력 — null(기본)/0(끔)/양의 정수는 error 없이 CLI까지 왕복
  for (const good of [null, 0, 10000]) {
    client.send({ type: 'setThinking', key, maxThinkingTokens: good });
  }
  // 마커 프로브를 에코 턴 "앞"에 둔다 — 유효 입력이 하나라도 거부됐다면 그 error가
  // 마커 error보다 먼저 도착해 아래 본문 단언이 실패한다(순서 보장, next가 프레임을
  // 소비해 증거가 사라지는 문제 차단).
  client.send({ type: 'setThinking', key, maxThinkingTokens: 'FINAL_MARKER' });
  const finalErr = await client.next((m) => m.type === 'error' && m.key === key);
  assert.match(finalErr.message, /FINAL_MARKER/);
  // 에코 턴 라운드트립으로 파이프라인 건강까지 확인
  client.send({ type: 'send', key, text: 'after thinking' });
  await client.next((m) => m.type === 'event' && m.key === key && m.payload?.type === 'result');
  // 버퍼 전수 계수: 이 키의 error 프레임은 정확히 7개(무효 6 + 마커 1) — 늦게 도착한
  // 잠복 error까지 잡는다.
  const errCount = client.messages.filter((m) => m.type === 'error' && m.key === key).length;
  assert.equal(errCount, 7);
  client.close();
});

test('crash scenario propagates exit message', async () => {
  process.env.FAKE_SCENARIO = 'crash';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_3', cwd: tmpRoot });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_3');
  client.send({ type: 'send', key: started.key, text: 'boom' });
  const exit = await client.next((m) => m.type === 'exit' && m.key === started.key);
  assert.equal(exit.code, 3);
  client.close();
});

test('unknown session key yields error message', async () => {
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'send', key: 's_9999', text: 'x' });
  const err = await client.next((m) => m.type === 'error' && m.key === 's_9999');
  assert.match(err.message, /s_9999/);
  client.close();
});

test('send to an exited session yields an error (not silent drop)', async () => {
  process.env.FAKE_SCENARIO = 'crash';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_dead', cwd: tmpRoot });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_dead');
  client.send({ type: 'send', key: started.key, text: 'boom' });
  await client.next((m) => m.type === 'exit' && m.key === started.key);
  // 세션이 죽은 뒤 send는 조용히 유실되지 않고 error로 응답해야 한다.
  client.send({ type: 'send', key: started.key, text: 'after death' });
  const err = await client.next((m) => m.type === 'error' && m.key === started.key);
  assert.match(err.message, /not running/);
  client.close();
});

test('exited session entry is cleaned up after retention window', async () => {
  process.env.FAKE_SCENARIO = 'crash';
  // 짧은 retention으로 전용 서버 기동 → 종료 후 엔트리 소거 검증.
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    exitedRetentionMs: 150,
  });
  try {
    const client = await TestClient.connect(`ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`);
    client.send({ type: 'start', startId: 'cl_ttl', cwd: tmpRoot });
    const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_ttl');
    client.send({ type: 'send', key: started.key, text: 'boom' });
    await client.next((m) => m.type === 'exit' && m.key === started.key);
    // retention 창 경과 대기
    await new Promise((r) => setTimeout(r, 350));
    // 소거되었으면 attach는 'unknown session key' error로 떨어진다.
    client.send({ type: 'attach', key: started.key, afterSeq: 0 });
    const err = await client.next((m) => m.type === 'error' && m.key === started.key);
    assert.match(err.message, /unknown session key/);
    client.close();
  } finally {
    await h.close();
  }
});

test('(f) REST auth + /api/projects/sessions/transcript/browse/bootstrap', async () => {
  // 인증 실패
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/projects`, { headers: { 'x-auth-token': 'nope' } })).status,
    401,
  );
  // Origin 위조는 토큰이 맞아도 거부
  assert.equal(
    (await fetch(`${base}/api/projects`, {
      headers: { 'x-auth-token': TOKEN, Origin: 'http://evil.example' },
    })).status,
    401,
  );

  const auth = { headers: { 'x-auth-token': TOKEN } };

  const projects = await (await fetch(`${base}/api/projects`, auth)).json();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].dirName, 'C--fake-proj');
  assert.equal(projects[0].cwd, 'C:\\fake');
  assert.equal(projects[0].sessionCount, 1);

  const sessions = await (await fetch(`${base}/api/sessions?dir=C--fake-proj`, auth)).json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(sessions[0].title, '제목이 될 텍스트');

  const transcript = await (
    await fetch(`${base}/api/transcript?dir=C--fake-proj&sessionId=11111111-1111-1111-1111-111111111111`, auth)
  ).json();
  assert.equal(transcript.messages.length, 2);

  // 경로 탈출은 400
  assert.equal(
    (await fetch(`${base}/api/transcript?dir=..&sessionId=x`, auth)).status,
    400,
  );

  const browse = await (await fetch(`${base}/api/browse?path=${encodeURIComponent(tmpRoot)}`, auth)).json();
  assert.ok(browse.dirs.includes('projects'));
  assert.ok(browse.dirs.includes('dist'));

  const bootstrap = await (await fetch(`${base}/api/bootstrap`, auth)).json();
  assert.equal(bootstrap.port, port);
  assert.ok('claudeVersion' in bootstrap);
  assert.equal(typeof bootstrap.defaultCwd, 'string');

  // /api/usage — 픽스처 assistant 엔트리(방금 timestamp) 1건이 양쪽 창에 집계되고,
  // 주입한 공식 사용률 스텁이 quota 필드로 실린다
  const usage = await (await fetch(`${base}/api/usage`, auth)).json();
  assert.equal(usage.fiveHour.totalTokens, 185);
  assert.equal(usage.fiveHour.entries, 1);
  assert.equal(usage.sevenDay.totalTokens, 185);
  assert.equal(usage.quota.fiveHour.utilization, 46);
  assert.equal(usage.quota.sevenDay.utilization, 28);
});

test('/api/usage quota 실패 → quota:null + 로컬 집계 보존 + 요청마다 재시도', async () => {
  let calls = 0;
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    quotaFetcher: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  try {
    const b = `http://127.0.0.1:${h.port}`;
    const auth = { headers: { 'x-auth-token': TOKEN } };
    const r1 = await (await fetch(`${b}/api/usage`, auth)).json();
    assert.equal(r1.quota, null);
    assert.equal(r1.fiveHour.totalTokens, 185); // quota 실패가 로컬 집계를 막지 않는다
    const r2 = await (await fetch(`${b}/api/usage`, auth)).json();
    assert.equal(r2.quota, null);
    assert.equal(calls, 2); // null은 캐시되지 않는다 — 다음 요청에서 재시도
  } finally {
    await h.close();
  }
});

test('static serving + SPA fallback (no auth required)', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ccob-test/);

  const fallback = await fetch(`${base}/some/spa/route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /ccob-test/);
});
