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
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
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
  });
  port = handle.port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  if (handle) await handle.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
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
});

test('static serving + SPA fallback (no auth required)', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ccob-test/);

  const fallback = await fetch(`${base}/some/spa/route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /ccob-test/);
});
