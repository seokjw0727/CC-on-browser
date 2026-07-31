// lifecycle.js — 데몬 수명 정책 상태기계 테스트. 시계·타이머를 주입해 결정적으로 검증.
// advance() = 프로세스가 깨어 있는 시간 흐름(Modern Standby에서 서버가 계속 도는 경우),
// sleep()   = 프로세스 동결 후 재개(S3/hibernate — 시계만 점프하고 만기 타이머가 늦게 발화).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../src/lifecycle.js';

function createFakeTime() {
  let t = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { cb, at }

  const fireDue = (end) => {
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, v] of timers) {
        if (v.at <= end && v.at < dueAt) {
          dueId = id;
          dueAt = v.at;
        }
      }
      if (dueId === null) break;
      const { cb } = timers.get(dueId);
      timers.delete(dueId);
      t = Math.max(t, dueAt);
      cb();
    }
    t = Math.max(t, end);
  };

  return {
    now: () => t,
    setTimeoutFn: (cb, delay) => {
      const id = nextId++;
      timers.set(id, { cb, at: t + delay });
      return id;
    },
    clearTimeoutFn: (id) => {
      timers.delete(id);
    },
    /** 깨어 있는 시간 진행 — 만기 타이머를 제때 발화시킨다. */
    advance: (ms) => fireDue(t + ms),
    /** 프로세스 동결 — 시계만 점프한 뒤 만기 타이머를 (늦게) 발화시킨다. */
    sleep: (ms) => {
      t += ms;
      fireDue(t);
    },
    pendingCount: () => timers.size,
  };
}

// 테스트 공통 하네스 — 짧은 정책 수치로 시간을 압축하지 않고 실제 기본값 그대로 사용
// (가짜 시계라 비용이 없다). shutdown 호출 횟수를 센다.
function setup({ live = false, pinned = false } = {}) {
  const time = createFakeTime();
  let liveSessions = live;
  let pinnedWork = pinned;
  let shutdowns = 0;
  const lc = createLifecycle({
    hasLiveSessions: () => liveSessions,
    hasPinnedWork: () => pinnedWork,
    shutdown: () => {
      shutdowns += 1;
    },
    now: time.now,
    setTimeoutFn: time.setTimeoutFn,
    clearTimeoutFn: time.clearTimeoutFn,
  });
  return {
    time,
    lc,
    setLive: (v) => {
      liveSessions = v;
    },
    setPinned: (v) => {
      pinnedWork = v;
    },
    shutdowns: () => shutdowns,
  };
}

test('bye close → 10초 유예 후 종료 (기존 계약)', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1); // 접속
  s.lc.onClientCountChange(0, { bye: true }); // 마지막 탭 닫힘
  s.time.advance(9_999);
  assert.equal(s.shutdowns(), 0);
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1, '세션이 있어도 의도적 닫힘이면 종료');
});

test('silent drop + 살아있는 세션 → 무기한 대기 (몇 시간이 지나도 종료 안 함)', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: false }); // 리드 닫힘 등 연결 유실
  s.time.advance(6 * 60 * 60_000); // 6시간 (Modern Standby에서 서버가 계속 도는 경우)
  assert.equal(s.shutdowns(), 0);
  assert.ok(s.time.pendingCount() > 0, '폴링 타이머가 체인으로 유지된다');
});

test('silent drop + 세션 없음 → 30분 뒤 종료', () => {
  const s = setup({ live: false });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: false });
  s.time.advance(30 * 60_000 - 1);
  assert.equal(s.shutdowns(), 0);
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1);
});

test('silent 대기 중 세션이 모두 종료되면 관측 시각부터 30분 규칙 전환', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: false });
  s.time.advance(2 * 60 * 60_000); // 2시간 대기(세션 살아있음)
  s.setLive(false); // CLI 세션이 스스로 종료
  s.time.advance(60_000); // 다음 폴링에서 관측
  assert.equal(s.shutdowns(), 0);
  s.time.advance(30 * 60_000 - 1);
  assert.equal(s.shutdowns(), 0, '관측 시점부터 30분');
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1);
});

test('재접속은 모든 유예를 해제한다', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.time.advance(5_000);
  s.lc.onClientCountChange(1); // 유예 내 재접속(새로고침)
  s.time.advance(24 * 60 * 60_000);
  assert.equal(s.shutdowns(), 0);
});

test('S3 절전 관통: bye 10초 유예가 크게 늦게 발화하면 silent로 재분류해 생존', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true }); // 닫힘 직후 리드까지 닫음
  s.time.sleep(60 * 60_000); // 1시간 동결 후 재개 — 타이머 lateBy≈1h ≥ 30s
  assert.equal(s.shutdowns(), 0, '늦은 발화는 종료 대신 재평가');
  s.time.advance(9_999);
  s.lc.onClientCountChange(1); // 복귀 후 재접속
  s.time.advance(60 * 60_000);
  assert.equal(s.shutdowns(), 0);
});

test('30초 미만 지연은 확정된 zeroMode를 유지한다 (bye 15초 창과 혼동 금지)', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.time.sleep(29_000); // lateBy 19s < 30s — bye 유효시간(15s)은 지났지만 intentional 유지
  assert.equal(s.shutdowns(), 1);
});

test('late 경계: intentional 유예 lateBy 29,999ms는 종료, 30,000ms는 재앵커', () => {
  // lateBy = sleep - 10_000 (intentional 유예)
  const a = setup({ live: true });
  a.lc.onClientCountChange(1);
  a.lc.onClientCountChange(0, { bye: true });
  a.time.sleep(10_000 + 29_999);
  assert.equal(a.shutdowns(), 1, '경계 미만은 zeroMode 그대로 실행');

  const b = setup({ live: true });
  b.lc.onClientCountChange(1);
  b.lc.onClientCountChange(0, { bye: true });
  b.time.sleep(10_000 + 30_000);
  assert.equal(b.shutdowns(), 0, '경계 이상은 silent 재평가(세션 보호)');
});

test('silent 30분 유예도 절전 관통 시 재앵커된다', () => {
  const s = setup({ live: false });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: false });
  s.time.sleep(30 * 60_000 + 60_000); // 유예 만료를 1분 넘겨 재개 — lateBy 60s ≥ 30s
  assert.equal(s.shutdowns(), 0, '늦은 발화는 재앵커');
  s.time.advance(30 * 60_000 - 1);
  assert.equal(s.shutdowns(), 0, '재앵커 후 다시 30분 온전히 대기');
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1);
});

test('bye-close 뒤 15초 넘어서 count 0이 되면 silent 판정', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(2);
  s.lc.onClientCountChange(1, { bye: true }); // 탭 하나는 정상 닫힘
  s.time.advance(20_000);
  s.lc.onClientCountChange(0, { bye: false }); // 남은 탭이 나중에 silent로 유실
  s.time.advance(60 * 60_000);
  assert.equal(s.shutdowns(), 0, '오래된 bye는 zero 판정에 쓰지 않는다');
});

test('bye-close 직후(15초 내) silent close로 0이 되면 bye 우선 → 종료', () => {
  const s = setup({ live: true });
  s.lc.onClientCountChange(2);
  s.lc.onClientCountChange(1, { bye: true }); // 창 닫기: bye가 flush된 탭
  s.time.advance(2_000);
  s.lc.onClientCountChange(0, { bye: false }); // 같은 창의 bye 미flush 탭
  s.time.advance(10_000);
  assert.equal(s.shutdowns(), 1);
});

test('신규 연결은 bye episode를 리셋한다', () => {
  const s = setup({ live: false });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true }); // 닫았다가
  s.time.advance(3_000);
  s.lc.onClientCountChange(1); // 바로 다시 접속(리셋)
  s.time.advance(1_000);
  s.lc.onClientCountChange(0, { bye: false }); // 이번엔 silent 유실
  s.time.advance(10 * 60_000);
  assert.equal(s.shutdowns(), 0, '이전 episode의 bye로 intentional 처리되면 안 됨');
  s.time.advance(20 * 60_000 + 1); // silent 무세션 30분 규칙으로 종료
  assert.equal(s.shutdowns(), 1);
});

test('최초 접속 없이 90초가 지나면 종료', () => {
  const s = setup({ live: false });
  s.time.advance(89_999);
  assert.equal(s.shutdowns(), 0);
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1);
});

test('최초 접속 대기도 절전 관통 시 재앵커된다 (유예 전체 길이 보장)', () => {
  const s = setup({ live: false });
  s.time.sleep(10 * 60_000); // 기동 직후 리드 닫힘 — 10분 동결
  assert.equal(s.shutdowns(), 0, '늦은 발화는 재앵커');
  s.time.advance(89_999);
  assert.equal(s.shutdowns(), 0, '재앵커 후 90초 온전히 대기');
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1, '그래도 접속이 없으면 종료');
});

test('최초 접속 재앵커 후 접속이 오면 생존한다', () => {
  const s = setup({ live: false });
  s.time.sleep(10 * 60_000);
  s.lc.onClientCountChange(1); // 복귀 후 브라우저 접속 성공
  s.time.advance(24 * 60 * 60_000);
  assert.equal(s.shutdowns(), 0);
});

test('dispose 후 큐에 이미 남아있던 콜백은 실행돼도 무효', () => {
  // clear가 콜백 실행을 막지 못하는(느슨한) 타이머 구현을 시뮬레이션한다.
  const captured = [];
  let shutdowns = 0;
  const lc = createLifecycle({
    hasLiveSessions: () => false,
    shutdown: () => {
      shutdowns += 1;
    },
    now: () => 0,
    setTimeoutFn: (cb) => {
      captured.push(cb);
      return captured.length;
    },
    clearTimeoutFn: () => {}, // clear가 큐에서 제거하지 못한다
  });
  lc.onClientCountChange(1);
  lc.onClientCountChange(0, { bye: true });
  lc.dispose();
  for (const cb of captured) cb(); // 잔류 콜백 강제 실행
  assert.equal(shutdowns, 0);
});

test('취소·교체된 구세대 타이머 콜백은 무시된다 (epoch 가드)', () => {
  const captured = [];
  let shutdowns = 0;
  let t = 0;
  const lc = createLifecycle({
    hasLiveSessions: () => true,
    shutdown: () => {
      shutdowns += 1;
    },
    now: () => t,
    setTimeoutFn: (cb) => {
      captured.push(cb);
      return captured.length;
    },
    clearTimeoutFn: () => {}, // clear가 큐에서 제거하지 못한다
  });
  lc.onClientCountChange(1); // 최초접속 타이머(captured[0])는 이 시점에 취소됨
  t = 1_000;
  lc.onClientCountChange(0, { bye: false }); // silent — 세션 폴링(captured[1]) 예약
  t = 200_000;
  captured[0](); // 구세대(최초접속 90s) 콜백이 뒤늦게 실행 — lateBy 커도 무시돼야 함
  assert.equal(shutdowns, 0, '구세대 콜백이 현재 상태를 건드리면 안 됨');
  t = 261_000;
  captured[1](); // 현행 폴링 콜백은 정상 동작(세션 살아있음 → 계속 대기)
  assert.equal(shutdowns, 0);
});

test('dispose 후에는 어떤 타이머도 종료를 일으키지 않는다', () => {
  const s = setup({ live: false });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.lc.dispose();
  s.time.advance(24 * 60 * 60_000);
  assert.equal(s.shutdowns(), 0);
  s.lc.onClientCountChange(0, { bye: true }); // dispose 후 이벤트도 무시
  s.time.advance(60_000);
  assert.equal(s.shutdowns(), 0);
});

test('shutdown은 한 번만 호출된다', () => {
  const s = setup({ live: false });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.time.advance(10_000);
  assert.equal(s.shutdowns(), 1);
  // 종료 이후 잔여 이벤트/타이머가 중복 호출을 만들지 않는다
  s.lc.onClientCountChange(0, { bye: true });
  s.time.advance(60 * 60_000);
  assert.equal(s.shutdowns(), 1);
});

// ----- 고정 작업(원격 제어) 생존 규칙 -----
// 원격 제어는 "브라우저를 닫고 폰에서 쓰기 위한" 기능이라, 탭을 닫았다고 데몬이
// 내려가면 기능 자체가 성립하지 않는다. 그래서 클라이언트 0을 재검사하는 모든
// 지점에서 hasPinnedWork()를 함께 본다.

test('bye close라도 고정 작업이 있으면 종료하지 않는다', () => {
  const s = setup({ live: false, pinned: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.time.advance(10_000);
  assert.equal(s.shutdowns(), 0, '10초 유예가 지나도 원격 제어가 살아 있으면 남는다');
  s.time.advance(6 * 60 * 60_000);
  assert.equal(s.shutdowns(), 0, '몇 시간이 지나도 마찬가지');
});

test('고정 작업이 끝나면 그때부터 30분 규칙으로 넘어가 종료된다', () => {
  const s = setup({ live: false, pinned: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, { bye: true });
  s.time.advance(10_000);
  assert.equal(s.shutdowns(), 0);
  s.setPinned(false); // 사용자가 원격 제어를 껐다
  s.time.advance(60_000); // 폴링이 소멸을 관측
  s.time.advance(30 * 60_000 - 1);
  assert.equal(s.shutdowns(), 0);
  s.time.advance(1);
  assert.equal(s.shutdowns(), 1);
});

test('연결 유실 + 세션 없음이어도 고정 작업이 있으면 30분에 죽지 않는다', () => {
  const s = setup({ live: false, pinned: true });
  s.lc.onClientCountChange(1);
  s.lc.onClientCountChange(0, {}); // bye 없음 = 연결 유실
  s.time.advance(30 * 60_000 + 1);
  assert.equal(s.shutdowns(), 0, 'silent 경로도 고정 작업을 봐야 한다');
});

test('hasPinnedWork 기본값은 없음 — 기존 계약 그대로', () => {
  const time = createFakeTime();
  let shutdowns = 0;
  const lc = createLifecycle({
    hasLiveSessions: () => false,
    shutdown: () => { shutdowns += 1; },
    now: time.now,
    setTimeoutFn: time.setTimeoutFn,
    clearTimeoutFn: time.clearTimeoutFn,
  });
  lc.onClientCountChange(1);
  lc.onClientCountChange(0, { bye: true });
  time.advance(10_000);
  assert.equal(shutdowns, 1);
});

test('최초 접속 대기 중이라도 고정 작업이 있으면 종료하지 않는다', () => {
  const s = setup({ live: false, pinned: true });
  s.time.advance(90_000); // 브라우저가 한 번도 붙지 않은 채 유예 만료
  assert.equal(s.shutdowns(), 0, '"클라이언트 0 재검사 전 지점" 계약에는 여기도 포함된다');
  s.setPinned(false);
  s.time.advance(60_000); // 폴링이 소멸 관측
  s.time.advance(30 * 60_000);
  assert.equal(s.shutdowns(), 1);
});
