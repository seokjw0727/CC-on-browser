// 한도 알림 회귀 테스트 — "언제 알리는가"를 고정한다.
//
// 이 기능의 위험은 못 알리는 쪽이 아니라 **잘못 알리는** 쪽이다. 앱을 켤 때마다,
// 조회가 한 번 실패할 때마다, 같은 값이 다시 들어올 때마다 알림이 뜨면 사용자는
// 곧바로 설정을 꺼 버린다. 그래서 여기 있는 대부분은 "알리지 않는다"의 증명이다.
//
// 브라우저 전역은 테스트가 직접 주입한다(scope/storage) — globalThis를 건드리지
// 않으므로 다른 테스트 파일과 섞여 돌아도 서로를 오염시키지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMIT_NOTIFY_KEY,
  detectLimitTransitions,
  limitNotifyEnabled,
  notificationPayload,
  notificationPermission,
  notificationsSupported,
  notifyLimitTransitions,
  requestNotificationPermission,
  sendLimitNotification,
  setLimitNotifyEnabled,
} from '../src/lib/limit-notify.js';

/** localStorage 흉내 — preferences.js가 쓰는 세 메서드만 있으면 된다. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
}

/** Notification 흉내 — 생성된 알림을 sent에 모아 둔다. */
function fakeScope(permission = 'granted') {
  const sent = [];
  function Notification(title, opts) {
    sent.push({ title, ...opts });
  }
  Notification.permission = permission;
  return { Notification, sent };
}

const q = (five, seven) => ({
  fiveHour: five === null ? null : { utilization: five, resetsAt: 1_700_000_000_000 },
  sevenDay: seven === null ? null : { utilization: seven, resetsAt: 1_700_500_000_000 },
});

// ----- 전이 판정(순수) -----

test('detect — 100% 미만에서 100% 이상으로 오르면 체결', () => {
  const t = detectLimitTransitions(q(97, 40), q(100, 41));
  assert.equal(t.length, 1);
  assert.equal(t[0].window, 'fiveHour');
  assert.equal(t[0].kind, 'hit');
  assert.equal(t[0].utilization, 100);
});

test('detect — 100% 이상에서 미만으로 내리면 해제', () => {
  const t = detectLimitTransitions(q(100, 40), q(2, 41));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'release');
});

test('detect — 경계는 100 그 자체다 (99.9는 아직, 100.0부터 체결)', () => {
  assert.equal(detectLimitTransitions(q(50, 0), q(99.9, 0)).length, 0);
  assert.equal(detectLimitTransitions(q(99.9, 0), q(100, 0))[0].kind, 'hit');
  // 100을 넘어선 값(서버가 100 초과를 줄 수 있다)에서 100으로 내려도 해제가 아니다
  assert.equal(detectLimitTransitions(q(120, 0), q(100, 0)).length, 0);
});

test('detect — 값이 그대로면 전이가 아니다 (폴링마다 다시 알리지 않는다)', () => {
  assert.deepEqual(detectLimitTransitions(q(100, 100), q(100, 100)), []);
  assert.deepEqual(detectLimitTransitions(q(30, 30), q(31, 30)), []);
});

test('detect — 첫 폴링(prev 없음)은 기준선일 뿐 알리지 않는다', () => {
  // 이미 한도에 걸린 채로 앱을 켜는 상황 — 여기서 알리면 새로고침마다 다시 뜬다
  assert.deepEqual(detectLimitTransitions(null, q(100, 100)), []);
  assert.deepEqual(detectLimitTransitions(undefined, q(100, 100)), []);
});

test('detect — 한쪽 창만 빠진 부분 응답은 그 창을 건너뛴다', () => {
  // 서버는 조회에 실패한 창을 통째로 뺀다. reducer가 메워 주지 못한 경우까지
  // 여기서 한 겹 더 막는다 — 빠진 창을 해제로 읽으면 거짓 알림이 된다.
  assert.deepEqual(detectLimitTransitions(q(100, 50), q(null, 50)), []);
  assert.deepEqual(detectLimitTransitions(q(100, 50), { sevenDay: q(0, 50).sevenDay }), []);
});

test('detect — 숫자가 아닌 사용률은 판정하지 않는다', () => {
  for (const bad of [undefined, null, NaN, 'many', {}]) {
    const next = { fiveHour: { utilization: bad }, sevenDay: null };
    assert.deepEqual(detectLimitTransitions(q(100, 0), next), [], `${String(bad)}`);
  }
});

test('detect — 두 창이 동시에 넘어가면 둘 다, 창 순서대로 나온다', () => {
  const t = detectLimitTransitions(q(10, 100), q(100, 10));
  assert.deepEqual(
    t.map((x) => [x.window, x.kind]),
    [
      ['fiveHour', 'hit'],
      ['sevenDay', 'release'],
    ],
  );
});

// ----- 알림 내용 -----

test('payload — tag는 창마다 하나다 (해제가 낡은 체결 알림을 밀어낸다)', () => {
  const hit = notificationPayload({ window: 'fiveHour', name: '5시간', label: '5시간 창', kind: 'hit', utilization: 100, resetsAt: null });
  const rel = notificationPayload({ window: 'fiveHour', name: '5시간', label: '5시간 창', kind: 'release', utilization: 3, resetsAt: null });
  // 이미 풀린 창의 "한도 도달"이 "해제" 옆에 남아 있으면 그 자체가 거짓말이다
  assert.equal(hit.tag, rel.tag);
  // 창이 다르면 tag도 달라야 한다 — 5시간 알림이 7일 알림을 지우면 안 된다
  const seven = notificationPayload({ window: 'sevenDay', name: '7일', label: '7일 창', kind: 'hit', utilization: 100, resetsAt: null });
  assert.notEqual(hit.tag, seven.tag);
});

test('payload — 제목이 어느 창인지 밝힌다 (본문은 잘려도 제목은 보인다)', () => {
  // 두 창이 한꺼번에 걸리면 제목이 같아서는 무엇이 걸렸는지 구분할 수 없다
  const five = notificationPayload({ window: 'fiveHour', name: '5시간', label: '5시간 창', kind: 'hit', utilization: 100, resetsAt: null });
  const seven = notificationPayload({ window: 'sevenDay', name: '7일', label: '7일 창', kind: 'hit', utilization: 100, resetsAt: null });
  assert.equal(five.title, '5시간 사용량 한도 도달');
  assert.equal(seven.title, '7일 사용량 한도 도달');
  const rel = notificationPayload({ window: 'fiveHour', name: '5시간', label: '5시간 창', kind: 'release', utilization: 3, resetsAt: null });
  assert.equal(rel.title, '5시간 사용량 한도 해제');
});

test('payload — 창 이름과 %가 문구에 들어가고, 리셋 시각은 있을 때만 붙는다', () => {
  const withReset = notificationPayload({ window: 'sevenDay', name: '7일', label: '7일 창', kind: 'hit', utilization: 100, resetsAt: Date.now() });
  assert.match(withReset.body, /7일 창/);
  assert.match(withReset.body, /100%/);
  assert.match(withReset.body, /초기화/);
  const noReset = notificationPayload({ window: 'sevenDay', name: '7일', label: '7일 창', kind: 'hit', utilization: 100, resetsAt: null });
  assert.doesNotMatch(noReset.body, /초기화/);
});

// ----- 설정 영속 -----

test('설정 — 기본값은 꺼짐, 켜면 저장되고 끄면 키가 사라진다', () => {
  const s = fakeStorage();
  assert.equal(limitNotifyEnabled(s), false);
  setLimitNotifyEnabled(true, s);
  assert.equal(limitNotifyEnabled(s), true);
  setLimitNotifyEnabled(false, s);
  assert.equal(limitNotifyEnabled(s), false);
  assert.equal(s.has(LIMIT_NOTIFY_KEY), false, '끄면 키를 남기지 않는다');
});

test('설정 — 저장소가 막힌 컨텍스트에서도 던지지 않는다', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(limitNotifyEnabled(blocked), false);
  assert.equal(setLimitNotifyEnabled(true, blocked), false, '영속 실패는 false로 보고한다');
});

// ----- 권한·지원 여부 -----

test('지원 여부 — Notification이 없으면 unsupported (denied와 구분한다)', () => {
  assert.equal(notificationsSupported({}), false);
  assert.equal(notificationPermission({}), 'unsupported');
  assert.equal(notificationsSupported(fakeScope()), true);
  assert.equal(notificationPermission(fakeScope('denied')), 'denied');
});

test('권한 요청 — 이미 결정된 권한은 다시 묻지 않는다', async () => {
  for (const p of ['granted', 'denied']) {
    const scope = fakeScope(p);
    scope.Notification.requestPermission = () => {
      throw new Error('다시 물어선 안 된다');
    };
    assert.equal(await requestNotificationPermission(scope), p);
  }
});

test('권한 요청 — default면 묻고, Promise·콜백 두 API를 모두 받는다', async () => {
  const modern = fakeScope('default');
  modern.Notification.requestPermission = async () => 'granted';
  assert.equal(await requestNotificationPermission(modern), 'granted');

  // 구형 사파리(≤15): Promise를 주지 않고 콜백으로만, 그것도 사용자가 답한 뒤에 알린다.
  // 반환값이 없다고 곧장 'default'로 확정해 버리면 이 경로가 영영 granted를 못 받는다.
  const legacy = fakeScope('default');
  legacy.Notification.requestPermission = (cb) => {
    setTimeout(() => {
      legacy.Notification.permission = 'granted';
      cb('granted');
    }, 1);
  };
  assert.equal(await requestNotificationPermission(legacy), 'granted');
});

test('권한 요청 — 호출은 한 번뿐이다 (권한 창을 두 번 띄우면 안 된다)', async () => {
  const scope = fakeScope('default');
  let calls = 0;
  scope.Notification.requestPermission = (cb) => {
    calls += 1;
    cb('denied');
    return Promise.resolve('denied'); // 표준 구현은 콜백도 부르고 Promise도 준다
  };
  assert.equal(await requestNotificationPermission(scope), 'denied');
  assert.equal(calls, 1);
});

test('권한 요청 — 미지원·예외에서도 던지지 않는다', async () => {
  assert.equal(await requestNotificationPermission({}), 'unsupported');
  const boom = fakeScope('default');
  boom.Notification.requestPermission = () => {
    throw new Error('nope');
  };
  assert.equal(await requestNotificationPermission(boom), 'default');
});

// ----- 발송 관문 -----

const hit = { window: 'fiveHour', name: '5시간', label: '5시간 창', kind: 'hit', utilization: 100, resetsAt: null };
const HIT_TITLE = '5시간 사용량 한도 도달';

test('발송 — 설정이 켜져 있고 권한이 granted일 때만 나간다', () => {
  const on = fakeStorage({ [LIMIT_NOTIFY_KEY]: '1' });
  const off = fakeStorage();

  const ok = fakeScope('granted');
  assert.equal(sendLimitNotification(hit, { scope: ok, storage: on }), true);
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.sent[0].title, HIT_TITLE);

  for (const [scope, storage, why] of [
    [fakeScope('granted'), off, '설정이 꺼져 있으면'],
    [fakeScope('denied'), on, '권한이 없으면'],
    [fakeScope('default'), on, '권한을 아직 안 물었으면'],
  ]) {
    assert.equal(sendLimitNotification(hit, { scope, storage }), false, why);
    assert.equal(scope.sent.length, 0, why);
  }
});

test('발송 — 미지원 브라우저에서 조용히 접힌다', () => {
  const on = fakeStorage({ [LIMIT_NOTIFY_KEY]: '1' });
  assert.equal(sendLimitNotification(hit, { scope: {}, storage: on }), false);
});

test('발송 — 생성자가 던져도 앱으로 새지 않는다', () => {
  const on = fakeStorage({ [LIMIT_NOTIFY_KEY]: '1' });
  const scope = { Notification: function () { throw new Error('boom'); } };
  scope.Notification.permission = 'granted';
  assert.equal(sendLimitNotification(hit, { scope, storage: on }), false);
});

// ----- 감지 + 발송 -----

test('notifyLimitTransitions — 전이 두 건이면 두 건 다 나간다', () => {
  const scope = fakeScope('granted');
  const storage = fakeStorage({ [LIMIT_NOTIFY_KEY]: '1' });
  const sent = notifyLimitTransitions(q(10, 100), q(100, 10), { scope, storage });
  assert.equal(sent.length, 2);
  assert.deepEqual(scope.sent.map((n) => n.title), ['5시간 사용량 한도 도달', '7일 사용량 한도 해제']);
});

test('notifyLimitTransitions — 전이가 없으면 아무것도 만들지 않는다', () => {
  const scope = fakeScope('granted');
  const storage = fakeStorage({ [LIMIT_NOTIFY_KEY]: '1' });
  assert.deepEqual(notifyLimitTransitions(q(100, 100), q(100, 100), { scope, storage }), []);
  assert.equal(scope.sent.length, 0);
});

test('notifyLimitTransitions — 설정이 꺼져 있으면 감지해도 나가지 않는다', () => {
  const scope = fakeScope('granted');
  const storage = fakeStorage();
  assert.deepEqual(notifyLimitTransitions(q(10, 10), q(100, 100), { scope, storage }), []);
  assert.equal(scope.sent.length, 0);
});
