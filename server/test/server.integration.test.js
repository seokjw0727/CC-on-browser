import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { saveClipboardFile } from '../src/attachments.js';

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
    // 핸들러를 open **이전에** 붙인다. 서버가 연결 직후 곧바로 보내는 메시지
    // (원격 제어 스냅샷)는 open 이벤트와 같은 틱에 도착할 수 있어, open을 먼저
    // 기다렸다가 붙이면 그 첫 메시지를 놓친다. 실제 브라우저 클라이언트도
    // onmessage를 연결 전에 등록하므로 이 순서가 현실과 맞다.
    const client = new TestClient(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
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

test('(d3) 신뢰모드 가드: 비신뢰 세션의 WS setPermissionMode(bypass)는 error, CLI 미전송', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_guard', cwd: tmpRoot, permissionMode: 'default' });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_guard');
  const key = started.key;

  client.send({ type: 'setPermissionMode', key, mode: 'bypassPermissions' });
  const err = await client.next((m) => m.type === 'error' && m.key === key);
  assert.match(err.message, /신뢰모드는 세션 시작 시에만/);

  // 미전송 검증: 이어지는 plan 전환의 status가 도착한 시점까지 bypass status가
  // 없어야 한다 (fake-cli는 set_permission_mode마다 system/status를 방출).
  client.send({ type: 'setPermissionMode', key, mode: 'plan' });
  await client.next(
    (m) => m.type === 'event' && m.key === key
      && m.payload.type === 'system' && m.payload.subtype === 'status'
      && m.payload.permissionMode === 'plan',
  );
  const bypassStatus = client.messages.find(
    (m) => m.type === 'event' && m.key === key
      && m.payload.type === 'system' && m.payload.subtype === 'status'
      && m.payload.permissionMode === 'bypassPermissions',
  );
  assert.equal(bypassStatus, undefined, 'bypass 전환이 CLI에 전달되면 안 된다');
  client.send({ type: 'stop', key });
  client.close();
});

test('(d4) 제안 필터 계약: 비신뢰 세션은 setMode(bypass)만 제거되고 addRules는 보존', async () => {
  process.env.FAKE_SCENARIO = 'permission';
  process.env.FAKE_SUGGEST_BYPASS = '1';
  try {
    const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
    client.send({ type: 'start', startId: 'cl_filt', cwd: tmpRoot, permissionMode: 'default' });
    const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_filt');
    const key = started.key;

    client.send({ type: 'send', key, text: 'do write' });
    const permReq = await client.next((m) => m.type === 'permission_request' && m.key === key);
    // fake-cli가 setMode(bypass) + addRules 두 제안을 함께 보낸다 — 부분 필터 전제
    assert.equal(permReq.suggestions.length, 2);
    assert.equal(permReq.suggestions[0].type, 'setMode');
    assert.equal(permReq.suggestions[1].type, 'addRules');

    client.send({
      type: 'permission', key, requestId: permReq.requestId,
      behavior: 'allow', updatedInput: permReq.input,
      updatedPermissions: permReq.suggestions, // 둘 다 수락 시도 (위조 클라이언트 상황 포함)
    });
    const allowResult = await client.next(
      (m) => m.type === 'event' && m.key === key && m.payload.type === 'result',
    );
    // 금지 항목만 제거되고 나머지는 그대로 CLI에 도달해야 한다 — 전체 삭제 구현은 실패
    assert.deepEqual(allowResult.payload.echo_response.updatedPermissions, [permReq.suggestions[1]]);

    // setMode(bypass)만 수락한 경우: 필터 후 빈 배열 → updatedPermissions 필드 자체가 생략
    client.send({ type: 'send', key, text: 'do write again' });
    const permReq2 = await client.next(
      (m) => m.type === 'permission_request' && m.key === key && m.requestId !== permReq.requestId,
    );
    client.send({
      type: 'permission', key, requestId: permReq2.requestId,
      behavior: 'allow', updatedInput: permReq2.input,
      updatedPermissions: [permReq2.suggestions[0]],
    });
    const allowResult2 = await client.next(
      (m) => m.type === 'event' && m.key === key && m.payload.type === 'result'
        && m.payload.echo_response,
    );
    assert.equal(allowResult2.payload.echo_response.updatedPermissions, undefined);
    client.send({ type: 'stop', key });
    client.close();
  } finally {
    delete process.env.FAKE_SUGGEST_BYPASS;
  }
});

test('(d5) 신뢰모드 스폰 세션: setMode(bypass) 제안 보존 + 런타임 신뢰 복귀 허용', async () => {
  process.env.FAKE_SCENARIO = 'permission';
  process.env.FAKE_SUGGEST_BYPASS = '1';
  try {
    const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
    client.send({
      type: 'start', startId: 'cl_trust', cwd: tmpRoot, permissionMode: 'bypassPermissions',
    });
    const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_trust');
    const key = started.key;
    // 스폰 인자 확인 — 픽스처 진단 argv
    const argv = started.initInfo.argv;
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');

    client.send({ type: 'send', key, text: 'do write' });
    const permReq = await client.next((m) => m.type === 'permission_request' && m.key === key);
    // 선행 단언 — 제안에 setMode(bypass)+addRules가 실제로 실려 있어야
    // 아래 "보존" 검증이 공허해지지 않는다 (codex 지적).
    assert.deepEqual(
      permReq.suggestions.map((s) => s.type),
      ['setMode', 'addRules'],
    );
    assert.equal(permReq.suggestions[0].mode, 'bypassPermissions');
    client.send({
      type: 'permission', key, requestId: permReq.requestId,
      behavior: 'allow', updatedInput: permReq.input,
      updatedPermissions: permReq.suggestions,
    });
    const allowResult = await client.next(
      (m) => m.type === 'event' && m.key === key && m.payload.type === 'result',
    );
    // 신뢰 스폰 세션은 필터하지 않는다 — 두 제안 모두 CLI에 도달
    assert.deepEqual(allowResult.payload.echo_response.updatedPermissions, permReq.suggestions);

    // 타 모드 전환 후 신뢰 복귀도 허용된다
    client.send({ type: 'setPermissionMode', key, mode: 'plan' });
    client.send({ type: 'setPermissionMode', key, mode: 'bypassPermissions' });
    await client.next(
      (m) => m.type === 'event' && m.key === key
        && m.payload.type === 'system' && m.payload.subtype === 'status'
        && m.payload.permissionMode === 'bypassPermissions',
    );
    client.send({ type: 'stop', key });
    client.close();
  } finally {
    delete process.env.FAKE_SUGGEST_BYPASS;
  }
});

test('start: effort 검증 — 무효값은 spawn 전에 거부, 유효값은 정상 시작', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_eff_bad', cwd: tmpRoot, effort: 'ultra' });
  const err = await client.next((m) => m.type === 'error' && m.startId === 'cl_eff_bad');
  assert.match(err.message, /invalid effort/);

  client.send({ type: 'start', startId: 'cl_eff_ok', cwd: tmpRoot, effort: 'low' });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_eff_ok');
  assert.ok(started.key.startsWith('s_'));
  // 픽스처 진단 argv로 --effort 전달까지 확인
  const argv = started.initInfo.argv;
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
  client.send({ type: 'stop', key: started.key });
  client.close();
});

test('setEffort: 런타임 변경 — 검증·reqId 상관·전 소켓 방송, 세션은 살아 있다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  // 두 번째 탭 — 성공 방송이 요청 소켓만이 아니라 모두에게 가는지 본다
  const other = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_ef', cwd: tmpRoot, effort: 'low' });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_ef');
  const key = started.key;
  // 시작 직후 실효 노력 수준이 같은 창구로 방송된다(요청대로 걸렸는지의 권위)
  const initial = await client.next((m) => m.type === 'effortSet' && m.key === key);
  assert.equal(initial.effort, 'low');
  assert.equal(initial.ultracode, false);

  // 무효값은 CLI에 닿기 전에 거부 — CLI는 이 채널의 값을 검증하지 않으므로(v2.1.233
  // 실측) 서버 검증이 유일한 방어선이다. reqId는 실패 응답에도 실려야 한다.
  for (const bad of [{ effort: 'ultracode' }, { effort: 'ultra' }, { effort: 'max', ultracode: 'yes' }]) {
    client.send({ type: 'setEffort', key, reqId: 'r_bad', ...bad });
    const err = await client.next((m) => m.type === 'error' && m.reqId === 'r_bad');
    assert.match(err.message, /invalid (effort|ultracode)/);
  }

  // 유효값 — 성공 방송이 reqId를 그대로 되돌려준다(클라이언트의 ack 짝짓기 근거)
  client.send({ type: 'setEffort', key, reqId: 'r_ok', effort: 'xhigh', ultracode: true });
  const ack = await client.next((m) => m.type === 'effortSet' && m.reqId === 'r_ok');
  assert.equal(ack.key, key);
  assert.equal(ack.effort, 'xhigh');
  assert.equal(ack.ultracode, true);
  const echoed = await other.next((m) => m.type === 'effortSet' && m.reqId === 'r_ok');
  assert.equal(echoed.effort, 'xhigh');

  // 세션은 재시작되지 않았다 — 같은 key로 대화가 계속된다
  client.send({ type: 'send', key, text: 'after effort change' });
  const result = await client.next(
    (m) => m.type === 'event' && m.key === key && m.payload?.type === 'result',
  );
  assert.equal(result.payload.is_error, false);
  assert.equal(client.messages.some((m) => m.type === 'exit' && m.key === key), false);
  client.send({ type: 'stop', key });
  client.close();
  other.close();
});

test('setEffort: 구버전 CLI(제어 요청 거부)는 reqId를 실은 error로 알려 폴백을 트리거한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  process.env.FAKE_NO_FLAG_SETTINGS = '1';
  try {
    const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
    client.send({ type: 'start', startId: 'cl_ef_old', cwd: tmpRoot });
    const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_ef_old');
    const key = started.key;
    client.send({ type: 'setEffort', key, reqId: 'r_old', effort: 'max' });
    const err = await client.next((m) => m.type === 'error' && m.reqId === 'r_old');
    assert.equal(err.key, key);
    assert.match(err.message, /apply_flag_settings/);
    // 실패해도 세션은 그대로 — 폴백(재시작)은 클라이언트가 결정한다
    assert.equal(client.messages.some((m) => m.type === 'exit' && m.key === key), false);
    client.send({ type: 'stop', key });
    client.close();
  } finally {
    delete process.env.FAKE_NO_FLAG_SETTINGS;
  }
});

test('unknown message type 오류에도 reqId가 실린다 (버전 스큐에서 즉시 폴백하도록)', async () => {
  // 이 프레임을 받는 쪽은 대개 "새 클라이언트 + 구 데몬"이다. 상관자가 없으면
  // 요청자는 ack 타임아웃(5초)을 기다린 뒤에야 폴백을 고른다 — setEffort가 그랬다.
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'noSuchMessageType', key: null, reqId: 'r_skew' });
  const err = await client.next((m) => m.type === 'error' && m.reqId === 'r_skew');
  assert.match(err.message, /unknown message type: noSuchMessageType/);
  // reqId가 없는 메시지에는 null이 실린다(기존 계약 유지 — 남의 대기표를 결착시키지 않는다)
  client.send({ type: 'stillUnknown' });
  const plain = await client.next((m) => m.type === 'error' && /stillUnknown/.test(m.message));
  assert.equal(plain.reqId, null);
  client.close();
});

test('/api/shutdown-if-idle: 인증·핸들러 부재·유휴 판정', async () => {
  const stopped = [];
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    version: '9.9.9',
    onShutdownRequest: () => stopped.push(Date.now()),
  });
  const b = `http://127.0.0.1:${h.port}`;
  const post = (headers = {}) => fetch(`${b}/api/shutdown-if-idle`, { method: 'POST', headers });
  try {
    // 주입한 버전이 bootstrap으로 나간다 — 런처·클라이언트의 비교 근거.
    const boot = await (await fetch(`${b}/api/bootstrap`, { headers: { 'x-auth-token': TOKEN } })).json();
    assert.equal(boot.version, '9.9.9');

    // 토큰 없이는 아무것도 내리지 못한다.
    assert.equal((await post()).status, 401);
    assert.equal(stopped.length, 0);
    // GET은 받지 않는다 — 링크·프리페치로 데몬이 죽는 창구를 만들지 않는다.
    assert.equal((await fetch(`${b}/api/shutdown-if-idle`, { headers: { 'x-auth-token': TOKEN } })).status, 405);

    // 유휴 상태 — 200을 받고 핸들러가 불린다(실제 종료는 프로세스 주인의 몫).
    const ok = await post({ 'x-auth-token': TOKEN });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { stopping: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stopped.length, 1);
  } finally {
    await h.close();
  }
});

test('/api/shutdown-if-idle: 살아있는 세션이 있으면 409로 거절한다 (남의 작업을 죽이지 않는다)', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const stopped = [];
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    onShutdownRequest: () => stopped.push(1),
  });
  const b = `http://127.0.0.1:${h.port}`;
  const client = await TestClient.connect(`ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`);
  try {
    client.send({ type: 'start', startId: 'cl_busy', cwd: tmpRoot });
    const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_busy');
    const res = await fetch(`${b}/api/shutdown-if-idle`, {
      method: 'POST',
      headers: { 'x-auth-token': TOKEN },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'busy');
    assert.equal(stopped.length, 0, '일하는 데몬은 내리지 않는다');
    client.send({ type: 'stop', key: started.key });
    await client.next((m) => m.type === 'exit' && m.key === started.key);
  } finally {
    client.close();
    await h.close();
  }
});

test('/api/shutdown-if-idle: 핸들러가 없으면 501 — 종료 판단은 프로세스 주인의 몫', async () => {
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/shutdown-if-idle`, {
      method: 'POST',
      headers: { 'x-auth-token': TOKEN },
    });
    assert.equal(res.status, 501);
  } finally {
    await h.close();
  }
});

test('start: ultracode 세션은 --effort xhigh로 스폰되고 플래그는 시작 후 방송된다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_ultra', cwd: tmpRoot, effort: 'xhigh', ultracode: true });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_ultra');
  const argv = started.initInfo.argv;
  assert.equal(argv[argv.indexOf('--effort') + 1], 'xhigh');
  const eff = await client.next((m) => m.type === 'effortSet' && m.key === started.key);
  assert.equal(eff.effort, 'xhigh');
  assert.equal(eff.ultracode, true);
  client.send({ type: 'stop', key: started.key });
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

  // /api/recent-sessions — 새 세션 모달의 "최근 세션". 인증 필수, dirName/cwd/title 포함.
  assert.equal((await fetch(`${base}/api/recent-sessions`)).status, 401);
  const recent = await (await fetch(`${base}/api/recent-sessions`, auth)).json();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].sessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(recent[0].dirName, 'C--fake-proj');
  assert.equal(recent[0].cwd, 'C:\\fake');
  assert.equal(recent[0].title, '제목이 될 텍스트');

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

  // /api/files — @ 파일 태그 자동완성. 인증 필수, {files: 상대경로[]} 반환.
  assert.equal((await fetch(`${base}/api/files?cwd=${encodeURIComponent(tmpRoot)}`)).status, 401);
  const files = await (await fetch(
    `${base}/api/files?cwd=${encodeURIComponent(tmpRoot)}&q=`,
    auth,
  )).json();
  assert.ok(Array.isArray(files.files));
  assert.ok(files.files.every((f) => !f.includes('\\')), 'POSIX 구분자');

  const bootstrap = await (await fetch(`${base}/api/bootstrap`, auth)).json();
  assert.equal(bootstrap.port, port);
  assert.ok('claudeVersion' in bootstrap);
  assert.equal(typeof bootstrap.defaultCwd, 'string');
  assert.equal(bootstrap.platform, process.platform, '클라이언트의 폴더 선택 버튼 노출 판단용');
  // version: 클라이언트 번들이 자기 빌드 버전과 견줘 "구 데몬 + 새 번들" 스큐를
  // 알아채는 근거. 주입하지 않은 이 테스트 서버에서는 null이다(= 구버전과 구분 불가).
  assert.equal(bootstrap.version, null, '주입하지 않으면 null');

  // /api/usage — 픽스처 assistant 엔트리(방금 timestamp) 1건이 양쪽 창에 집계되고,
  // 주입한 공식 사용률 스텁이 quota 필드로 실린다
  const usage = await (await fetch(`${base}/api/usage`, auth)).json();
  assert.equal(usage.fiveHour.totalTokens, 185);
  assert.equal(usage.fiveHour.entries, 1);
  assert.equal(usage.sevenDay.totalTokens, 185);
  assert.equal(usage.quota.fiveHour.utilization, 46);
  assert.equal(usage.quota.sevenDay.utilization, 28);

  // /api/usage-daily — 돌아보기 잔디용 일별 집계. 인증 필수, days 검증/clamp,
  // 빈 날짜 0 버킷을 포함한 전체 시계열(오래된 날 → 오늘)을 반환한다.
  assert.equal((await fetch(`${base}/api/usage-daily`)).status, 401);
  assert.equal((await fetch(`${base}/api/usage-daily?days=abc`, auth)).status, 400);
  assert.equal((await fetch(`${base}/api/usage-daily?days=3.5`, auth)).status, 400);

  const daily = await (await fetch(`${base}/api/usage-daily?days=7`, auth)).json();
  assert.equal(daily.days.length, 7);
  // 픽스처 엔트리는 "방금" timestamp — 마지막(오늘) 버킷에 집계된다
  const todayBucket = daily.days[daily.days.length - 1];
  assert.equal(todayBucket.totalTokens, 185);
  assert.equal(todayBucket.entries, 1);
  assert.match(todayBucket.date, /^\d{4}-\d{2}-\d{2}$/);
  // 나머지는 0 버킷으로 채워진다
  assert.ok(daily.days.slice(0, -1).every((d) => d.totalTokens === 0 && d.entries === 0));

  // clamp: 상한(9999 → 365) · 하한(-5 → 1). 캐시는 days별 키라 7일 결과와 섞이지 않는다.
  const big = await (await fetch(`${base}/api/usage-daily?days=9999`, auth)).json();
  assert.equal(big.days.length, 365);
  const one = await (await fetch(`${base}/api/usage-daily?days=-5`, auth)).json();
  assert.equal(one.days.length, 1);
  assert.equal(one.days[0].totalTokens, 185);
});

test('/api/pick-directory: 주입된 폴더 선택기 결과를 반환하고 인증을 요구한다', async () => {
  const calls = [];
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    directoryPicker: async ({ initialPath } = {}) => {
      calls.push(initialPath);
      return { path: 'C:\\picked\\folder', canceled: false };
    },
  });
  const b = `http://127.0.0.1:${h.port}`;
  try {
    // 인증 없으면 401 (폴더 대화상자를 열지 않는다)
    assert.equal((await fetch(`${b}/api/pick-directory`)).status, 401);
    assert.equal(calls.length, 0);

    const auth = { headers: { 'x-auth-token': TOKEN } };
    const res = await (await fetch(`${b}/api/pick-directory?path=${encodeURIComponent('C:\\start')}`, auth)).json();
    assert.deepEqual(res, { path: 'C:\\picked\\folder', canceled: false });
    assert.deepEqual(calls, ['C:\\start']);
  } finally {
    await h.close();
  }
});

test('/api/pick-directory: 선택기 오류(비-Windows 등)는 400으로 전달된다', async () => {
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    directoryPicker: async () => { throw new Error('네이티브 폴더 선택은 Windows에서만 지원됩니다.'); },
  });
  const b = `http://127.0.0.1:${h.port}`;
  try {
    const auth = { headers: { 'x-auth-token': TOKEN } };
    const r = await fetch(`${b}/api/pick-directory`, auth);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /Windows/);
  } finally {
    await h.close();
  }
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

test('onClientCountChange fires on WS connect/disconnect (browser-presence signal)', async () => {
  const counts = [];
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    onClientCountChange: (n) => counts.push(n),
  });
  try {
    const client = await TestClient.connect(`ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`);
    assert.deepEqual(counts, [1]);
    const client2 = await TestClient.connect(`ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`);
    assert.deepEqual(counts, [1, 2]);
    client.close();
    client2.close();
    const deadline = Date.now() + 5000;
    while (counts[counts.length - 1] !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(counts, [1, 2, 1, 0]);
  } finally {
    await h.close();
  }
});

test('bye/ping 프로토콜: close 메타 {bye}, pong 왕복, hasLiveSessions 노출', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  /** @type {[number, {bye?: boolean}|null][]} [count, close메타|null(open)] */
  const events = [];
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    byeMarkTtlMs: 300, // TTL 만료 케이스를 짧은 대기로 검증
    onClientCountChange: (n, meta) => events.push([n, meta ?? null]),
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  const closes = () => events.filter(([, meta]) => meta !== null);
  const waitCloses = async (count) => {
    const deadline = Date.now() + 5000;
    while (closes().length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(closes().length, count);
  };
  try {
    // ping → pong 왕복
    const c1 = await TestClient.connect(url);
    c1.send({ type: 'ping' });
    await c1.next((m) => m.type === 'pong');
    assert.deepEqual(events, [[1, null]], 'open 보고는 메타 없이 단항');

    // bye 후 즉시 close → {bye:true}
    c1.send({ type: 'bye' });
    c1.close();
    await waitCloses(1);
    assert.deepEqual(closes()[0], [0, { bye: true }]);

    // silent close → {bye:false}
    const c2 = await TestClient.connect(url);
    c2.close();
    await waitCloses(2);
    assert.deepEqual(closes()[1], [0, { bye: false }]);

    // bye 후 TTL(300ms) 경과 뒤 close → {bye:false} (늦은 close는 의도적 닫힘 아님)
    const c3 = await TestClient.connect(url);
    c3.send({ type: 'bye' });
    c3.send({ type: 'ping' });
    await c3.next((m) => m.type === 'pong'); // 순서 보장 — bye가 서버에 도착했음을 확인
    await new Promise((r) => setTimeout(r, 400)); // TTL 경과
    c3.close();
    await waitCloses(3);
    assert.deepEqual(closes()[2], [0, { bye: false }]);

    // 다른 소켓의 bye가 오염되지 않는다: c4는 bye+close, c5는 silent close
    const c4 = await TestClient.connect(url);
    const c5 = await TestClient.connect(url);
    c4.send({ type: 'bye' });
    c4.close();
    await waitCloses(4);
    assert.deepEqual(closes()[3], [1, { bye: true }]);
    c5.close();
    await waitCloses(5);
    assert.deepEqual(closes()[4], [0, { bye: false }]);

    // 새로고침 겹침 순서: 구 소켓 bye → 신 소켓 open → 구 소켓 close.
    // 최신 open 이전에 수신된 bye는 무효 — 신 소켓이 직후 리드 닫힘으로
    // silent drop되어도 이전 episode의 bye로 종료 판정되면 안 된다.
    const cOld = await TestClient.connect(url);
    cOld.send({ type: 'bye' });
    cOld.send({ type: 'ping' });
    await cOld.next((m) => m.type === 'pong'); // bye 도착 확인
    const cNew = await TestClient.connect(url); // 새 페이지가 먼저 연결
    cOld.close(); // 구 소켓 close가 늦게 도착
    await waitCloses(6);
    assert.deepEqual(closes()[5], [1, { bye: false }], '최신 open 이전의 bye는 무효');
    cNew.close();
    await waitCloses(7);

    // hasLiveSessions — 세션 시작 전 false, 시작 후 true, 종료 후 false
    assert.equal(typeof h.hasLiveSessions, 'function');
    assert.equal(h.hasLiveSessions(), false);
    const c6 = await TestClient.connect(url);
    c6.send({ type: 'start', startId: 'cl_live', cwd: tmpRoot });
    const started = await c6.next((m) => m.type === 'started' && m.startId === 'cl_live');
    assert.equal(h.hasLiveSessions(), true);
    c6.send({ type: 'stop', key: started.key });
    await c6.next((m) => m.type === 'exit' && m.key === started.key);
    assert.equal(h.hasLiveSessions(), false, '종료된 세션은 리플레이 보존 중이어도 live 아님');
    c6.close();
  } finally {
    await h.close();
  }
});

test('DELETE /api/sessions: 인증·405 Allow·400·404·409(라이브/재개 초기화)·성공 후 파일 부재', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const auth = { headers: { 'x-auth-token': TOKEN } };
  const delDir = path.join(projectsRoot, 'C--del-proj');
  await fs.mkdir(delDir, { recursive: true });
  const victim = path.join(delDir, 'dddd-4444.jsonl');
  await fs.writeFile(
    victim,
    JSON.stringify({ type: 'user', cwd: 'C:\\fake', message: { role: 'user', content: [{ type: 'text', text: '삭제 대상' }] } }) + '\n',
  );
  const delUrl = `${base}/api/sessions?dir=C--del-proj&sessionId=dddd-4444`;

  // 인증 없이는 삭제 불가(401), 파일은 그대로
  assert.equal((await fetch(delUrl, { method: 'DELETE' })).status, 401);
  await fs.access(victim);

  // 허용되지 않은 메서드 — /api/sessions 외 경로는 Allow: GET, /api/sessions POST는 GET, DELETE
  const notAllowed = await fetch(`${base}/api/projects`, { method: 'DELETE', ...auth });
  assert.equal(notAllowed.status, 405);
  assert.equal(notAllowed.headers.get('allow'), 'GET');
  const postSessions = await fetch(`${base}/api/sessions?dir=C--del-proj`, { method: 'POST', ...auth });
  assert.equal(postSessions.status, 405);
  assert.equal(postSessions.headers.get('allow'), 'GET, DELETE');

  // 인자 누락 400 · 없는 파일 404 · 경로 탈출 400
  assert.equal((await fetch(`${base}/api/sessions?dir=C--del-proj`, { method: 'DELETE', ...auth })).status, 400);
  assert.equal((await fetch(`${base}/api/sessions?dir=C--del-proj&sessionId=none`, { method: 'DELETE', ...auth })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions?dir=..&sessionId=x`, { method: 'DELETE', ...auth })).status, 400);

  // 재개 초기화 중(session.sessionId=null이어도 resumeSessionId로 보호) → 409
  const client = await TestClient.connect(`${wsBase}/ws?token=${TOKEN}`);
  client.send({ type: 'start', startId: 'cl_del', cwd: tmpRoot, resumeSessionId: 'dddd-4444' });
  const started = await client.next((m) => m.type === 'started' && m.startId === 'cl_del');
  const conflict = await fetch(delUrl, { method: 'DELETE', ...auth });
  assert.equal(conflict.status, 409);
  await fs.access(victim); // 거부됐으니 파일 보존

  // 세션 종료 후에는 삭제 허용 → {ok:true} + 파일 영구 삭제, 재삭제는 404
  client.send({ type: 'stop', key: started.key });
  await client.next((m) => m.type === 'exit' && m.key === started.key);
  client.close();
  const ok = await fetch(delUrl, { method: 'DELETE', ...auth });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  await assert.rejects(fs.access(victim), { code: 'ENOENT' });
  assert.equal((await fetch(delUrl, { method: 'DELETE', ...auth })).status, 404);
});

test('/api/recent-sessions?limit= 계약: 비정수 400, 유효 정수 clamp 적용', async () => {
  const auth = { headers: { 'x-auth-token': TOKEN } };
  assert.equal((await fetch(`${base}/api/recent-sessions?limit=abc`, auth)).status, 400);
  assert.equal((await fetch(`${base}/api/recent-sessions?limit=1.5`, auth)).status, 400);
  const one = await (await fetch(`${base}/api/recent-sessions?limit=1`, auth)).json();
  assert.equal(one.length, 1);
  const clamped = await (await fetch(`${base}/api/recent-sessions?limit=-3`, auth)).json();
  assert.equal(clamped.length, 1); // 하한 clamp → 1
});

test('static serving + SPA fallback (no auth required)', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ccob-test/);

  const fallback = await fetch(`${base}/some/spa/route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /ccob-test/);
});

// ----- 원격 제어 WS 계약 -----
// 관리자는 가짜로 주입한다(실제 claude remote-control을 띄우지 않는다).
// 여기서 보는 것은 "서버가 key를 cwd로 바꿔 넘기는가 / 스냅샷을 언제 보내는가 /
// close가 자식 정리를 먼저 하는가" 세 가지다.
function fakeRemoteControl() {
  const calls = [];
  let states = [];
  const listeners = new Set();
  return {
    calls,
    setStates(next) {
      states = next;
      for (const fn of listeners) fn(states);
    },
    on: (_evt, fn) => listeners.add(fn),
    off: (_evt, fn) => listeners.delete(fn),
    start: async (cwd, opts) => {
      calls.push({ op: 'start', cwd, opts });
      // 실제 관리자처럼 canonical 경로를 상태의 cwd로 쓴다. 서버의 keysForCwd는
      // 세션 cwd를 realpath해 이 값과 비교하므로, 정규화하지 않으면 tmpdir이
      // 심볼릭 링크인 플랫폼(macOS: /var → /private/var)에서만 keys가 빈다.
      const canonical = await fs.realpath(cwd);
      const st = { cwd: canonical, name: opts?.name ?? 'x', state: 'starting', environmentId: null,
        url: null, capacity: null, error: null, startedAt: 1 };
      states = [st];
      for (const fn of listeners) fn(states);
      return st;
    },
    stop: async (cwd) => {
      calls.push({ op: 'stop', cwd });
      states = states.map((s) => ({ ...s, state: 'stopped' }));
      for (const fn of listeners) fn(states);
      return states[0] ?? null;
    },
    snapshot: () => states,
    hasLive: () => states.some((s) => s.state === 'starting' || s.state === 'ready'),
    closeAll: async () => { calls.push({ op: 'closeAll' }); states = []; },
  };
}

test('원격 제어: 연결 직후 스냅샷, key→cwd 해석, 미지의 key 거부, 상태 방송', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot,
    staticDir,
    remoteControl: rc,
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    // 1) 연결 직후 스냅샷 — 비어 있어도 보낸다("아무것도 안 켜짐"도 복구할 사실)
    const snap = await c.next((m) => m.type === 'remoteControl');
    assert.deepEqual(snap.states, []);

    // 2) 라이브 세션이 아닌 key는 거부 — WS가 준 임의 경로를 쓰지 않는다는 규율
    c.send({ type: 'remoteControl', action: 'start', key: 's_nope' });
    const err = await c.next((m) => m.type === 'error');
    assert.match(err.message, /실행 중인 세션/);
    assert.equal(rc.calls.length, 0, '세션이 없으면 관리자를 부르지 않는다');

    // 3) 라이브 세션의 key → 그 세션의 cwd로 start
    c.send({ type: 'start', startId: 'rc_1', cwd: tmpRoot });
    const started = await c.next((m) => m.type === 'started' && m.startId === 'rc_1');
    c.send({ type: 'remoteControl', action: 'start', key: started.key, name: 'my rc' });
    const after = await c.next((m) => m.type === 'remoteControl' && m.states.length === 1);
    assert.equal(rc.calls[0].op, 'start');
    assert.equal(await fs.realpath(rc.calls[0].cwd), await fs.realpath(tmpRoot),
      '클라이언트가 보낸 경로가 아니라 세션의 cwd');
    assert.equal(rc.calls[0].opts.name, 'my rc');
    // 그 cwd를 쓰는 라이브 세션 key가 붙어 온다
    assert.deepEqual(after.states[0].keys, [started.key]);

    // 4) 관리자가 스스로 상태를 바꾸면 전 소켓에 방송된다
    const c2 = await TestClient.connect(url);
    await c2.next((m) => m.type === 'remoteControl');
    rc.setStates([{ cwd: await fs.realpath(tmpRoot), name: 'my rc', state: 'ready', environmentId: 'env_x',
      url: 'https://claude.ai/code?environment=env_x', capacity: { used: 0, max: 32 },
      error: null, startedAt: 1 }]);
    const bc = await c2.next((m) => m.type === 'remoteControl' && m.states[0]?.state === 'ready');
    assert.equal(bc.states[0].environmentId, 'env_x');

    // 5) stop도 같은 해석 경로
    c.send({ type: 'remoteControl', action: 'stop', key: started.key });
    await c.next((m) => m.type === 'remoteControl' && m.states[0]?.state === 'stopped');
    assert.equal(rc.calls.at(-1).op, 'stop');
    assert.equal(await fs.realpath(rc.calls.at(-1).cwd), await fs.realpath(tmpRoot));

    // 6) 알 수 없는 action
    c.send({ type: 'remoteControl', action: 'bogus', key: started.key });
    const err2 = await c.next((m) => m.type === 'error' && /unknown remoteControl/.test(m.message));
    assert.ok(err2);
  } finally {
    await h.close();
  }
  // 7) close()는 원격 제어 자식 정리를 먼저 한다 — 순서가 뒤집히면 고아가 남는다
  assert.equal(rc.calls.at(-1).op, 'closeAll');
});

test('원격 제어: hasLiveRemoteControls가 수명 정책 창구로 노출된다', async () => {
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc,
  });
  try {
    assert.equal(h.hasLiveRemoteControls(), false);
    rc.setStates([{ cwd: 'C:/x', name: 'n', state: 'ready', environmentId: null, url: null,
      capacity: null, error: null, startedAt: 1 }]);
    assert.equal(h.hasLiveRemoteControls(), true);
  } finally {
    await h.close();
  }
});

test('SessionHub.cwdOf: 라이브 세션만 cwd를 내주고 종료·미지의 key는 null', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc,
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    c.send({ type: 'start', startId: 'cw_1', cwd: tmpRoot });
    const started = await c.next((m) => m.type === 'started' && m.startId === 'cw_1');
    // 라이브 → 원격 제어가 붙는다
    c.send({ type: 'remoteControl', action: 'start', key: started.key });
    await c.next((m) => m.type === 'remoteControl' && m.states.length === 1);
    assert.equal(await fs.realpath(rc.calls.at(-1).cwd), await fs.realpath(tmpRoot));

    // 세션 종료 후에는 같은 key로 더 이상 켤 수 없다(리플레이용으로 남아 있어도)
    c.send({ type: 'stop', key: started.key });
    await c.next((m) => m.type === 'exit' && m.key === started.key);
    const before = rc.calls.length;
    c.send({ type: 'remoteControl', action: 'start', key: started.key });
    const err = await c.next((m) => m.type === 'error');
    assert.match(err.message, /실행 중인 세션/);
    assert.equal(rc.calls.length, before, '종료된 세션의 cwd로는 관리자를 부르지 않는다');
  } finally {
    await h.close();
  }
});

test('원격 제어 정리가 걸려도 close는 상한 안에 리스너를 놓는다', async () => {
  const rc = fakeRemoteControl();
  rc.closeAll = () => new Promise(() => {}); // 영원히 안 끝나는 정리
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc, closeRemoteGraceMs: 150,
  });
  assert.equal(h.server.listening, true);
  await h.close();
  // 상한이 없으면 포트를 쥔 채 시그널에도 응답하지 않는 데몬이 된다 — 그쪽이 더 나쁘다
  assert.equal(h.server.listening, false, '정리가 걸려도 포트는 놓아야 한다');
});

test('원격 제어 정리가 실패해도 종료는 진행된다', async () => {
  const rc = fakeRemoteControl();
  rc.closeAll = async () => { throw new Error('boom'); };
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc, closeRemoteGraceMs: 150,
  });
  await h.close();
  assert.equal(h.server.listening, false);
});

test('원격 제어 start 결과는 요청 소켓뿐 아니라 모든 소켓에 방송된다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc,
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const a = await TestClient.connect(url);
    await a.next((m) => m.type === 'remoteControl');
    a.send({ type: 'start', startId: 'bc_1', cwd: tmpRoot });
    const started = await a.next((m) => m.type === 'started' && m.startId === 'bc_1');

    // 두 번째 탭은 세션이 생긴 뒤에 붙는다
    const b = await TestClient.connect(url);
    await b.next((m) => m.type === 'remoteControl');

    a.send({ type: 'remoteControl', action: 'start', key: started.key });
    // 다른 탭도 key가 채워진 최신 상태를 받아야 한다 — 요청 소켓에만 보내면 갇힌다
    const seen = await b.next(
      (m) => m.type === 'remoteControl' && m.states[0]?.keys?.includes(started.key),
    );
    assert.equal(seen.states[0].cwd, await fs.realpath(tmpRoot));
  } finally {
    await h.close();
  }
});

test('원격 제어: 세션 start/exit가 keys 스냅샷을 갱신한다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc,
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    await c.next((m) => m.type === 'remoteControl');
    c.send({ type: 'start', startId: 'k1', cwd: tmpRoot });
    const a = await c.next((m) => m.type === 'started' && m.startId === 'k1');
    c.send({ type: 'remoteControl', action: 'start', key: a.key });
    await c.next((m) => m.type === 'remoteControl' && m.states[0]?.keys?.includes(a.key));

    // 같은 디렉터리에 두 번째 세션 — 새 세션에도 keys가 붙어야 한다
    c.send({ type: 'start', startId: 'k2', cwd: tmpRoot });
    const b = await c.next((m) => m.type === 'started' && m.startId === 'k2');
    const both = await c.next(
      (m) => m.type === 'remoteControl' && m.states[0]?.keys?.includes(b.key),
    );
    assert.ok(both.states[0].keys.includes(a.key), '기존 세션도 그대로 유지');

    // 세션이 끝나면 그 key는 빠져야 한다 — 안 그러면 종료된 탭의 pill이 켜진 채 남는다
    c.send({ type: 'stop', key: b.key });
    const after = await c.next(
      (m) => m.type === 'remoteControl' && !m.states[0]?.keys?.includes(b.key),
    );
    assert.ok(after.states[0].keys.includes(a.key));
  } finally {
    await h.close();
  }
});

test('원격 제어: 세션이 먼저 끝나도 알려 준 cwd로는 끌 수 있다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc,
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    await c.next((m) => m.type === 'remoteControl');
    c.send({ type: 'start', startId: 'x1', cwd: tmpRoot });
    const s = await c.next((m) => m.type === 'started' && m.startId === 'x1');
    c.send({ type: 'remoteControl', action: 'start', key: s.key });
    await c.next((m) => m.type === 'remoteControl' && m.states.length === 1);

    c.send({ type: 'stop', key: s.key });
    await c.next((m) => m.type === 'exit' && m.key === s.key);

    // 세션이 없으니 key로는 못 찾는다 — 서버가 이미 알려 준 cwd는 받아들여야 한다
    c.send({ type: 'remoteControl', action: 'stop', cwd: await fs.realpath(tmpRoot) });
    await c.next((m) => m.type === 'remoteControl' && m.states[0]?.state === 'stopped');
    assert.equal(rc.calls.at(-1).op, 'stop');

    // 우리가 알려 준 적 없는 경로는 거부한다 — 임의 경로를 여는 권한이 아니다
    c.send({ type: 'remoteControl', action: 'stop', cwd: 'C:/somewhere/else' });
    const err = await c.next((m) => m.type === 'error');
    assert.match(err.message, /찾지 못했습니다/);
  } finally {
    await h.close();
  }
});

test('원격 제어: cwd 대소문자가 달라도 keys가 붙는다 (win32 realpath 편차 방어)', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc, platform: 'win32',
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    await c.next((m) => m.type === 'remoteControl');
    c.send({ type: 'start', startId: 'case1', cwd: tmpRoot });
    const s = await c.next((m) => m.type === 'started' && m.startId === 'case1');
    // 관리자가 대문자로 정규화한 경로를 돌려주는 상황을 흉내낸다
    rc.setStates([{
      cwd: (await fs.realpath(tmpRoot)).toUpperCase(),
      name: 'x', state: 'ready', environmentId: null, url: null,
      capacity: null, error: null, startedAt: 1,
    }]);
    const seen = await c.next((m) => m.type === 'remoteControl' && m.states[0]?.state === 'ready');
    assert.deepEqual(seen.states[0].keys, [s.key],
      'win32에서는 대소문자 차이로 세션을 놓치면 안 된다');
  } finally {
    await h.close();
  }
});

test('원격 제어: win32에서도 cwds가 채워진다 (세션 종료 후 끄기 경로)', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const rc = fakeRemoteControl();
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, remoteControl: rc, platform: 'win32',
  });
  const url = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  try {
    const c = await TestClient.connect(url);
    await c.next((m) => m.type === 'remoteControl');
    c.send({ type: 'start', startId: 'cwds1', cwd: tmpRoot });
    const s = await c.next((m) => m.type === 'started' && m.startId === 'cwds1');
    c.send({ type: 'remoteControl', action: 'start', key: s.key });
    const seen = await c.next((m) => m.type === 'remoteControl' && m.states.length === 1);
    // cwds가 비면 세션 종료 후 클라이언트가 끌 방법이 사라진다.
    // 대소문자를 접지 않고 비교하면 win32에서 항상 비었다.
    assert.ok(seen.states[0].cwds.length > 0, 'cwds가 비면 안 된다');
    assert.ok(seen.states[0].keys.includes(s.key));
  } finally {
    await h.close();
  }
});

// ----- 붙여넣기 첨부 REST -----
// attachmentsApi를 통째로 주입한다 — 실제 PowerShell 클립보드 조회와 사용자 공용 tmp의
// cc-on-browser-paste 폴더를 테스트가 건드리지 않기 위해서다. 다만 저장만은 진짜 구현에
// root만 바꿔 위임한다: 여기서 보려는 것이 "attachments가 던진 오류를 서버가 어떤 상태
// 코드로 옮기는가"라서, 그 오류까지 흉내 내면 검증이 공허해진다.
function fakeAttachments(root) {
  const calls = [];
  const state = { clipboard: [], listError: null, saveError: null };
  return {
    calls,
    state,
    listClipboardFiles: async ({ platform } = {}) => {
      calls.push({ op: 'list', platform });
      if (state.listError) throw state.listError;
      return state.clipboard;
    },
    saveClipboardFile: (body) => {
      calls.push({ op: 'save' });
      // 디스크 가득·권한 거부처럼 실제로 만들기 어려운 실패만 주입한다.
      if (state.saveError) throw state.saveError;
      return saveClipboardFile(body, { root });
    },
    cleanupStalePasteDirs: async () => {
      calls.push({ op: 'cleanup' });
      return 0;
    },
  };
}

test('POST /api/paste-file: 인증 전에는 저장하지 않고, 통과하면 파일과 경로가 생긴다', async () => {
  const root = path.join(tmpRoot, 'paste-ok');
  const at = fakeAttachments(root);
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, attachmentsApi: at,
  });
  const b = `http://127.0.0.1:${h.port}`;
  const post = (init) => fetch(`${b}/api/paste-file`, { method: 'POST', ...init });
  const payload = JSON.stringify({ name: 'x.png', data: 'AAAA' });
  try {
    // 토큰이 없거나 Origin이 위조면 본문을 읽기도 전에 401 — 디스크에 아무 일도 없어야 한다
    assert.equal((await post({ body: payload })).status, 401);
    assert.equal((await post({
      headers: { 'x-auth-token': TOKEN, Origin: 'http://evil.example' },
      body: payload,
    })).status, 401);
    assert.equal(at.calls.filter((c) => c.op === 'save').length, 0, '인증 전 저장은 없어야 한다');

    const bytes = Buffer.from('붙여넣은 스크린샷 바이트', 'utf8');
    const res = await post({
      headers: { 'x-auth-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '스크린샷 2026-08-11.png', data: bytes.toString('base64') }),
    });
    assert.equal(res.status, 200);
    const { path: saved } = await res.json();
    // 저장 위치는 서버가 정한다 — 클라이언트가 준 것은 이름과 바이트뿐이다
    assert.ok(saved.startsWith(root + path.sep), `서버가 정한 root 안이어야 한다: ${saved}`);
    assert.equal(path.basename(saved), '스크린샷 2026-08-11.png');
    assert.deepEqual(await fs.readFile(saved), bytes);
  } finally {
    await h.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// 상한을 넘기는 업로드를 조각으로 흘려보내다가, 응답이 오면 그 자리에서 멈춘다.
//
// fetch를 쓰지 않는다. 서버는 413을 내보낸 **뒤에** 남은 업로드를 끊는데, undici는 그
// 소켓 리셋을 만나면 이미 받아 둔 응답까지 버리고 ECONNRESET만 남긴다 — "이유를 먼저
// 준다"는 계약이 지켜져도 확인할 방법이 없어진다. content-length를 명시한 raw http
// 클라이언트는 같은 상황에서 응답을 먼저 읽어 낸다(본문 한 덩어리 write도 같은 이유로
// 실패하므로 조각내 보낸다).
function postOversized(port, pathname, { headers, chunk, count }) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { ...headers, 'content-length': String(chunk.length * count) },
      agent: false, // 끊긴 소켓이 풀에 남아 다음 요청을 오염시키지 않게
    }, (res) => {
      answered = true;
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
      req.destroy(); // 이유를 받았으니 남은 업로드를 마저 보낼 이유가 없다
    });
    // 서버가 업로드를 끊으면 소켓 쪽에서도 write 오류가 난다 — 여기서 삼키지 않으면
    // uncaught로 테스트 프로세스가 죽는다. 응답을 못 받았을 때만 실패로 본다.
    req.on('socket', (socket) => { socket.on('error', () => { /* 기대한 결과 */ }); });
    req.on('error', (err) => { if (!answered) reject(err); });
    let sent = 0;
    const pump = () => {
      while (!answered && sent < count) {
        sent += 1;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      if (!answered) req.end();
    };
    pump();
  });
}

test('POST /api/paste-file: 잘못된 base64는 400, 과대 본문은 413, 다른 메서드는 405', async () => {
  const root = path.join(tmpRoot, 'paste-err');
  const at = fakeAttachments(root);
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, attachmentsApi: at,
  });
  const b = `http://127.0.0.1:${h.port}`;
  const auth = { 'x-auth-token': TOKEN, 'content-type': 'application/json' };
  const post = (body) => fetch(`${b}/api/paste-file`, { method: 'POST', headers: auth, body });
  try {
    // base64가 아닌 문자열 — 관대한 디코더였다면 쓰레기 파일이 남았을 자리다
    const bad = await post(JSON.stringify({ name: 'x.png', data: 'not base64!!' }));
    assert.equal(bad.status, 400);
    // 본문이 JSON 객체가 아니어도 400(500이 아니다)
    assert.equal((await post('[1,2,3]')).status, 400);

    // 본문 상한(32MB)은 파싱보다 **먼저** 걸린다 — 그래서 내용이 JSON이 아니어도 413이다
    // 상한을 딱 한 조각만 넘겨 보낸다. 크게 넘기면 서버가 응답과 함께 소켓을 끊는
    // 순간 클라이언트에 아직 못 보낸 본문이 남아, 응답 대신 write 오류를 보게 된다.
    const huge = await postOversized(h.port, '/api/paste-file', {
      headers: auth, chunk: Buffer.alloc(64 * 1024, 0x78), count: 32 * 16 + 1,
    });
    assert.equal(huge.status, 413);

    // 저장 계층의 실패도 제 상태 코드로 옮겨진다: 디코드 후 상한 초과는 413,
    // 예상 밖 파일시스템 오류는 클라이언트 잘못이 아니므로 500.
    const ok = JSON.stringify({ name: 'x.png', data: 'AAAA' });
    at.state.saveError = Object.assign(new Error('pasted file exceeds'), { code: 'EPAYLOAD' });
    assert.equal((await post(ok)).status, 413);
    at.state.saveError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    assert.equal((await post(ok)).status, 500);
    at.state.saveError = null;

    // GET은 이 창구의 메서드가 아니다 — 404가 아니라 Allow를 단 405여야 한다
    const wrong = await fetch(`${b}/api/paste-file`, { headers: auth });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');

    // 본문 상한·형식 위반·잘못된 메서드는 저장 계층까지 내려가지 않는다
    // (내려간 것은 base64 1건 + 주입 실패 2건뿐)
    assert.equal(at.calls.filter((c) => c.op === 'save').length, 3);
  } finally {
    await h.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('POST /api/clipboard-files: 주입한 경로를 그대로 주고, 조회 실패는 빈 목록으로 수렴', async () => {
  const at = fakeAttachments(path.join(tmpRoot, 'paste-clip'));
  at.state.clipboard = ['C:\\Users\\me\\보고서.pdf', 'C:\\Users\\me\\사진 1.png'];
  const h = await startServer({
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir, platform: 'win32', attachmentsApi: at,
  });
  const b = `http://127.0.0.1:${h.port}`;
  const auth = { 'x-auth-token': TOKEN };
  try {
    // 인증을 통과하기 전에는 클립보드를 들여다보지 않는다
    assert.equal((await fetch(`${b}/api/clipboard-files`, { method: 'POST' })).status, 401);
    assert.equal(at.calls.filter((c) => c.op === 'list').length, 0);

    const res = await fetch(`${b}/api/clipboard-files`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { paths: at.state.clipboard });
    // 조회 플랫폼은 클라이언트가 아니라 서버가 정한다
    assert.deepEqual(at.calls.at(-1), { op: 'list', platform: 'win32' });

    // 조회가 던져도 200 {paths: []} — 클라이언트는 빈 목록을 보고 업로드 폴백으로 간다
    at.state.listError = new Error('powershell을 찾을 수 없습니다');
    const failed = await fetch(`${b}/api/clipboard-files`, { method: 'POST', headers: auth });
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), { paths: [] });

    const wrong = await fetch(`${b}/api/clipboard-files`, { headers: auth });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
  } finally {
    await h.close();
  }
});

test('붙여넣기 임시 폴더 청소는 기동을 붙잡지 않고, 실패해도 기동을 깨지 않는다', async () => {
  const common = {
    port: 0, token: TOKEN, cliPath: process.execPath, cliArgsPrefix: [fakeCliPath],
    projectsRoot, staticDir,
    // 청소는 기본 꺼짐(부수효과 옵트인) — 실제 앱 기동을 흉내 내려면 여기서 켠다.
    pasteCleanup: true,
  };
  const stub = (cleanupStalePasteDirs) => ({
    listClipboardFiles: async () => [],
    saveClipboardFile: async () => ({ path: '' }),
    cleanupStalePasteDirs,
  });

  // 끝나지 않는 청소 — await하는 구현이었다면 startServer가 여기서 영영 안 돌아온다
  let hung = 0;
  const h1 = await startServer({
    ...common,
    attachmentsApi: stub(() => { hung += 1; return new Promise(() => {}); }),
  });
  try {
    assert.equal(hung, 1, '기동마다 정확히 1회');
    assert.equal(h1.server.listening, true);
  } finally {
    await h1.close();
  }

  // 거부하는 청소 — catch가 없으면 unhandled rejection으로 프로세스가 죽는다
  let failed = 0;
  const h2 = await startServer({
    ...common,
    attachmentsApi: stub(async () => { failed += 1; throw new Error('청소 실패'); }),
  });
  try {
    const r = await fetch(`http://127.0.0.1:${h2.port}/api/bootstrap`, {
      headers: { 'x-auth-token': TOKEN },
    });
    assert.equal(r.status, 200);
    assert.equal(failed, 1);
  } finally {
    await h2.close();
  }

  // 옵트인하지 않으면 청소는 아예 돌지 않는다 — 이 스위트의 나머지 20여 개
  // startServer 호출이 개발자 %TEMP%의 붙여넣기 폴더를 지우지 않는다는 보장.
  let uninvited = 0;
  const h3 = await startServer({
    ...common,
    pasteCleanup: undefined,
    attachmentsApi: stub(async () => { uninvited += 1; }),
  });
  try {
    assert.equal(uninvited, 0, '옵트인 없으면 청소는 호출조차 되지 않는다');
  } finally {
    await h3.close();
  }
});
