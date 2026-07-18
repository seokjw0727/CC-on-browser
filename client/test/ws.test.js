// ws.js — 재연결 코어·bye·probe/keepalive 테스트.
// 가짜 WebSocket/window/document + node:test mock timers로 브라우저 없이 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/lib/ws.js';

function setupEnv(t) {
  const winListeners = new Map();
  const docListeners = new Map();
  const addTo = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const removeFrom = (map) => (type, fn) => {
    map.get(type)?.delete(fn);
  };
  const emit = (map) => (type, ev) => {
    for (const fn of [...(map.get(type) ?? [])]) fn(ev);
  };

  class FakeWebSocket {
    static CONNECTING = 0;

    static OPEN = 1;

    static CLOSING = 2;

    static CLOSED = 3;

    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      FakeWebSocket.instances.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.closeCalls += 1;
      if (this.readyState === FakeWebSocket.CONNECTING || this.readyState === FakeWebSocket.OPEN) {
        this.readyState = FakeWebSocket.CLOSING;
      }
    }

    // 테스트 헬퍼 — 브라우저 이벤트 시뮬레이션
    _open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    _serverMessage(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }

    _close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  globalThis.window = {
    location: { protocol: 'http:', host: '127.0.0.1:8787' },
    addEventListener: addTo(winListeners),
    removeEventListener: removeFrom(winListeners),
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: addTo(docListeners),
    removeEventListener: removeFrom(docListeners),
  };
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.WebSocket;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  return {
    FakeWebSocket,
    emitWin: emit(winListeners),
    emitDoc: emit(docListeners),
    winListeners,
    docListeners,
    tick: (ms) => t.mock.timers.tick(ms),
  };
}

function lastSent(socket) {
  return socket.sent[socket.sent.length - 1];
}

test('연결 성공 → onStatus open, 토큰이 URL에 실린다', (t) => {
  const env = setupEnv(t);
  const statuses = [];
  const conn = connect({ token: 'tok en', onMessage: () => {}, onStatus: (s) => statuses.push(s) });
  const [s1] = env.FakeWebSocket.instances;
  assert.match(s1.url, /\/ws\?token=tok%20en$/);
  s1._open();
  assert.deepEqual(statuses, ['connecting', 'open']);
  conn.close();
});

test('pagehide: persisted=false면 bye 전송, persisted=true(bfcache)면 미전송', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.emitWin('pagehide', { persisted: true });
  assert.equal(s1.sent.length, 0, 'bfcache 보존은 탭 닫힘이 아니다');
  env.emitWin('pagehide', { persisted: false });
  assert.deepEqual(lastSent(s1), { type: 'bye' });
  conn.close();
});

test('pagehide: 소켓이 OPEN이 아니면 bye는 조용히 생략된다 (best-effort)', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances; // 아직 CONNECTING
  env.emitWin('pagehide', { persisted: false });
  assert.equal(s1.sent.length, 0);
  conn.close();
});

test('keepalive: OPEN 30초마다 ping, 서버 프레임이 오면 생존 유지', (t) => {
  const env = setupEnv(t);
  const received = [];
  const conn = connect({ token: 'x', onMessage: (m) => received.push(m), onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.tick(30_000);
  assert.deepEqual(lastSent(s1), { type: 'ping' });
  s1._serverMessage({ type: 'pong' });
  env.tick(5_000); // 응답이 왔으므로 watchdog은 발화하지 않는다
  assert.equal(s1.closeCalls, 0);
  assert.equal(env.FakeWebSocket.instances.length, 1);
  assert.deepEqual(received, [], 'pong은 스토어로 전달하지 않는다');
  s1._serverMessage({ type: 'event', seq: 1 });
  assert.deepEqual(received, [{ type: 'event', seq: 1 }], '일반 메시지는 전달');
  conn.close();
});

test('probe 무응답 → onclose 없이 소켓 폐기 후 백오프 재연결', (t) => {
  const env = setupEnv(t);
  const statuses = [];
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: (s) => statuses.push(s) });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.emitWin('pageshow'); // 절전 복귀 신호 — 즉시 probe
  assert.deepEqual(lastSent(s1), { type: 'ping' });
  env.tick(5_000); // 서버 무응답 — half-open 판정
  assert.ok(s1.closeCalls > 0, '죽은 소켓은 close 시도');
  assert.equal(statuses[statuses.length - 1], 'closed');
  env.tick(1_000); // 백오프(1초) 후 재연결 — s1의 onclose 없이도 진행돼야 한다
  assert.equal(env.FakeWebSocket.instances.length, 2);
  conn.close();
});

test('폐기된 이전 소켓의 늦은 close는 새 소켓에 영향을 주지 않는다', (t) => {
  const env = setupEnv(t);
  const statuses = [];
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: (s) => statuses.push(s) });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.emitWin('pageshow');
  env.tick(5_000); // s1 폐기
  env.tick(1_000); // s2 생성
  const s2 = env.FakeWebSocket.instances[1];
  s2._open();
  const before = statuses.length;
  s1._close(); // 이전 소켓의 늦은 close 이벤트
  assert.equal(statuses.length, before, '상태 변화 없음(무시)');
  assert.equal(conn.send({ type: 'attach', key: 's_1' }), true, '새 소켓은 계속 동작');
  assert.deepEqual(lastSent(s2), { type: 'attach', key: 's_1' });
  env.tick(20_000);
  assert.equal(env.FakeWebSocket.instances.length, 2, '중복 재연결 없음');
  conn.close();
});

test('복귀 신호에 CONNECTING으로 잔류한 소켓은 5초 watchdog 후 폐기·재연결', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances; // CONNECTING에 머묾
  env.emitWin('online');
  env.tick(5_000);
  assert.ok(s1.closeCalls > 0);
  env.tick(1_000);
  assert.equal(env.FakeWebSocket.instances.length, 2);
  conn.close();
});

test('복귀 신호 후 제때 open되면 watchdog은 소켓을 건드리지 않는다', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  env.emitWin('pageshow'); // CONNECTING watchdog 예약
  s1._open(); // 5초 내 정상 연결
  env.tick(5_000);
  assert.equal(s1.closeCalls, 0);
  assert.equal(env.FakeWebSocket.instances.length, 1);
  conn.close();
});

test('visibilitychange(visible)도 probe를 발동한다', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.emitDoc('visibilitychange');
  assert.deepEqual(lastSent(s1), { type: 'ping' });
  conn.close();
});

test('probe 동시 1개 — 연속 복귀 신호에 ping은 한 번만', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  env.emitWin('pageshow');
  env.emitWin('focus');
  env.emitDoc('visibilitychange');
  assert.equal(s1.sent.filter((m) => m.type === 'ping').length, 1);
  conn.close();
});

test('정상 onclose → closed → 백오프 재연결 → open (store attach 재전송 계약)', (t) => {
  const env = setupEnv(t);
  const statuses = [];
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: (s) => statuses.push(s) });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  s1._close(); // 서버 측 연결 종료
  assert.deepEqual(statuses, ['connecting', 'open', 'closed']);
  env.tick(1_000); // 백오프 1초
  assert.equal(env.FakeWebSocket.instances.length, 2);
  const s2 = env.FakeWebSocket.instances[1];
  assert.equal(statuses[statuses.length - 1], 'connecting');
  s2._open();
  assert.equal(statuses[statuses.length - 1], 'open');
  assert.equal(conn.send({ type: 'attach', key: 's_1' }), true, 'open 직후 send 즉시 동작');
  assert.deepEqual(lastSent(s2), { type: 'attach', key: 's_1' });
  conn.close();
});

test('close(): 리스너·타이머 전부 정리, 이후 어떤 이벤트도 무시', (t) => {
  const env = setupEnv(t);
  const conn = connect({ token: 'x', onMessage: () => {}, onStatus: () => {} });
  const [s1] = env.FakeWebSocket.instances;
  s1._open();
  conn.close();
  const remaining = [...env.winListeners.values(), ...env.docListeners.values()]
    .reduce((n, set) => n + set.size, 0);
  assert.equal(remaining, 0, '모든 window/document 리스너 제거');
  assert.ok(s1.closeCalls > 0);
  s1._close();
  env.tick(120_000);
  assert.equal(env.FakeWebSocket.instances.length, 1, '재연결·keepalive 완전 정지');
});
