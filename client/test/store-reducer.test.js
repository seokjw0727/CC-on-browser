// store-reducer — replaceKey 탭 대체, 시작 실패 시 보존, 에러·턴 실패 토스트, 토스트 수명 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createSessionState, reducer } from '../src/lib/store-reducer.js';

const serverMsg = (message) => ({ type: 'server-message', message });

function stateWithSession(key, partial = {}) {
  const state = createInitialState();
  state.sessions.set(key, createSessionState({ key, ...partial }));
  state.activeKey = key;
  return state;
}

function registerStart(state, startId, opts) {
  return reducer(state, { type: 'register-start', startId, opts });
}

test('remove-session: 세션을 제거하고, 활성이었으면 남은 세션으로 전환(없으면 null)', () => {
  let s = stateWithSession('a');
  s.sessions.set('b', createSessionState({ key: 'b' }));
  // 활성('a') 제거 → 남은 'b'로 전환
  s = reducer({ ...s, activeKey: 'a' }, { type: 'remove-session', key: 'a' });
  assert.equal(s.sessions.has('a'), false);
  assert.equal(s.activeKey, 'b');
  // 마지막 세션 제거 → activeKey null(그리팅)
  s = reducer(s, { type: 'remove-session', key: 'b' });
  assert.equal(s.sessions.size, 0);
  assert.equal(s.activeKey, null);
  // 없는 키 제거는 무해(상태 동일 참조)
  const same = reducer(s, { type: 'remove-session', key: 'ghost' });
  assert.equal(same, s);
});

test('set-usage: quota 조회 실패(null) 시 직전 quota를 이어 쓴다(로컬 집계는 갱신)', () => {
  const s0 = createInitialState();
  const withQuota = {
    fiveHour: { totalTokens: 100 },
    sevenDay: { totalTokens: 200 },
    quota: { fiveHour: { utilization: 42 }, sevenDay: { utilization: 18 } },
  };
  const s1 = reducer(s0, { type: 'set-usage', usage: withQuota });
  assert.equal(s1.globalUsage.quota.fiveHour.utilization, 42);

  // 다음 폴링에서 quota=null(공식 조회 실패)이라도 직전 quota를 유지
  const noQuota = { fiveHour: { totalTokens: 150 }, sevenDay: { totalTokens: 260 }, quota: null };
  const s2 = reducer(s1, { type: 'set-usage', usage: noQuota });
  assert.equal(s2.globalUsage.quota.fiveHour.utilization, 42, 'quota 이어받음');
  assert.equal(s2.globalUsage.fiveHour.totalTokens, 150, '로컬 집계는 새 값');

  // quota가 다시 오면 새 값으로 갱신
  const fresh = { fiveHour: { totalTokens: 160 }, sevenDay: { totalTokens: 270 }, quota: { fiveHour: { utilization: 55 }, sevenDay: { utilization: 20 } } };
  const s3 = reducer(s2, { type: 'set-usage', usage: fresh });
  assert.equal(s3.globalUsage.quota.fiveHour.utilization, 55);
  assert.equal(s3.globalUsage.quota.sevenDay.utilization, 20);

  // 부분 실패(한쪽 창만 유효) — 빠진 창(sevenDay=null)은 직전 값으로 채우고 온 창은 새 값
  const partial = { fiveHour: { totalTokens: 170 }, sevenDay: { totalTokens: 280 }, quota: { fiveHour: { utilization: 60 }, sevenDay: null } };
  const s5 = reducer(s3, { type: 'set-usage', usage: partial });
  assert.equal(s5.globalUsage.quota.fiveHour.utilization, 60, '온 창은 새 값');
  assert.equal(s5.globalUsage.quota.sevenDay.utilization, 20, '빠진 창은 직전 값 이어받음');
  assert.equal(s5.globalUsage.sevenDay.totalTokens, 280, '로컬 집계는 새 값');

  // 최초부터 quota가 없으면 이어받을 값이 없어 null 그대로(원시 수치 폴백은 그때만)
  const s4 = reducer(s0, { type: 'set-usage', usage: noQuota });
  assert.equal(s4.globalUsage.quota, null);
});

test('remove-session: 비활성 세션 제거는 activeKey를 건드리지 않는다', () => {
  let s = stateWithSession('a');
  s.sessions.set('b', createSessionState({ key: 'b' }));
  s = reducer({ ...s, activeKey: 'a' }, { type: 'remove-session', key: 'b' });
  assert.equal(s.activeKey, 'a', '활성은 그대로');
  assert.equal(s.sessions.has('b'), false);
});

test('remove-session: 활성 종료 세션 제거 시 종료 세션이 아닌 라이브 세션으로 전환한다', () => {
  let s = stateWithSession('a', { status: 'exited' });
  // 삽입 순서상 라이브 'b'가 먼저, 종료 'c'가 마지막 — 순진하게 마지막을 고르면 'c'(종료)
  s.sessions.set('b', createSessionState({ key: 'b', status: 'idle' }));
  s.sessions.set('c', createSessionState({ key: 'c', status: 'exited' }));
  s = reducer({ ...s, activeKey: 'a' }, { type: 'remove-session', key: 'a' });
  assert.equal(s.activeKey, 'b', '종료 세션(c)이 아니라 라이브(b)로 전환');
});

test("started(replaceKey): 새 탭이 옛 탭을 대체하고 resume 시딩이 이뤄진다", () => {
  let s = stateWithSession('old', { messages: [{ uid: 'm1', kind: 'user-text', text: '이월' }] });
  s = registerStart(s, 'cl_1', {
    cwd: 'C:\\p',
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    effort: 'max',
    resumeSessionId: 'sess-old',
    preloadMessages: s.sessions.get('old').messages,
    replaceKey: 'old',
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_1', key: 'new', initInfo: null }));

  assert.equal(s.sessions.has('old'), false, '옛 탭은 대체(삭제)된다');
  const ns = s.sessions.get('new');
  assert.equal(ns.hasCompletedTurn, true, '재개 시작은 resume 게이트를 통과 상태로 시딩');
  assert.equal(ns.resumeSourceId, 'sess-old');
  assert.equal(ns.effort, 'max');
  assert.equal(ns.permissionMode, 'bypassPermissions');
  assert.deepEqual(ns.messages.map((m) => m.text), ['이월'], '메시지 이월');
  assert.equal(s.activeKey, 'new');
  assert.equal(s.pendingStarts.size, 0);
});

test('started(재개): 모달에서 고른 모델이 spawnModel 계보로 시딩된다', () => {
  // 새 세션 모달의 지난 세션 재개는 사용자가 고른 모델을 그대로 스폰 --model로
  // 넘긴다(카탈로그 대조를 통과한 값). spawnModel은 "검증된 스폰 인자"만 담는
  // 계보라 Composer의 effort 재시작이 이 값을 재사용한다.
  let s = createInitialState();
  s = registerStart(s, 'cl_m', {
    cwd: 'C:\\p',
    model: 'sonnet',
    resumeSessionId: 'sess-old',
    preloadModel: 'claude-opus-4-8', // 트랜스크립트에서 읽은 표시용 해석 id
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_m', key: 'm1' }));

  const ns = s.sessions.get('m1');
  assert.equal(ns.model, 'sonnet', '표시 모델은 실제 스폰 인자를 따른다');
  assert.equal(ns.spawnModel, 'sonnet', '스폰 계보에 사용자가 고른 값이 실린다');
});

test('started(재개): 모델을 고르지 않으면 spawnModel은 null이고 preloadModel은 표시 전용', () => {
  // 모달에서 "(기본 모델)"을 두면 --model을 생략해 그 세션이 쓰던 모델이 유지된다.
  // 이때 트랜스크립트에서 읽은 해석 id는 표시(피커 라벨·CTX 분모)에만 쓰이고
  // 스폰 인자 계보로 승격되면 안 된다 — 구식이거나 [1m] 접미사가 탈락했을 수 있다.
  let s = createInitialState();
  s = registerStart(s, 'cl_n', {
    cwd: 'C:\\p',
    model: null,
    resumeSessionId: 'sess-old',
    preloadModel: 'claude-opus-4-8',
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_n', key: 'n1' }));

  const ns = s.sessions.get('n1');
  assert.equal(ns.model, 'claude-opus-4-8', '표시용으로는 이월된다');
  assert.equal(ns.spawnModel, null, '검증되지 않은 값은 스폰 계보로 승격되지 않는다');
});

test('started(재개 프리로드): 메시지·sessionId·usage가 started 커밋에 원자적으로 시딩된다', () => {
  // 별도 커밋으로 뒤늦게 주입하면 ChatView seenRef가 히스토리를 신규 메시지로
  // 오인(등장 애니·타자기 출력)한다 — 반드시 started 한 커밋에 실려야 한다.
  let s = createInitialState();
  s = registerStart(s, 'cl_r', {
    cwd: 'C:\\p',
    resumeSessionId: 'sess-old',
    preloadMessages: [
      { uid: 'p1', kind: 'user-text', text: '질문' },
      { uid: 'p2', kind: 'assistant-text', text: '답', streaming: false },
    ],
    preloadSessionId: 'sess-old',
    preloadUsage: { cost: 0.5, inTok: 100, outTok: 50, contextTokens: 1234 },
    preloadCtxFromCalls: true,
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_r', key: 'r1' }));

  const ns = s.sessions.get('r1');
  assert.deepEqual(ns.messages.map((m) => m.uid), ['p1', 'p2'], '히스토리가 생성 시점에 존재');
  assert.equal(ns.sessionId, 'sess-old', '원본 세션 id 표기 이월');
  assert.equal(ns.usage.contextTokens, 1234, 'usage(CTX%) 연속성');
  assert.equal(ns.ctxFromCalls, true, '호출별 usage 출처 플래그 이월 — result 합산이 못 덮는다');
  assert.equal(ns.hasCompletedTurn, true);
  assert.equal(s.activeKey, 'r1');
});

test('usage.ctxDisplayable: 새 세션은 false, preloadUsage는 통째로 이월된다', () => {
  // CTX 링 표시 판정을 값(contextTokens>0)이 아니라 플래그로 옮겼으므로, 기본값과
  // 재개 이월이 둘 다 맞아야 한다. 플래그를 usage 안에 둔 이유가 이 이월이다.
  assert.equal(createSessionState({ key: 'a' }).usage.ctxDisplayable, false, '새 세션은 표시 안 함');

  // 플래그를 가진 프리로드 — 그대로 따라온다
  let s = registerStart(createInitialState(), 'cl_d', {
    preloadUsage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 0, ctxDisplayable: true },
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_d', key: 'd1' }));
  assert.equal(s.sessions.get('d1').usage.ctxDisplayable, true, '0 토큰이어도 표시 플래그 이월');

  // 필드가 없는 구 형상 프리로드 — usage 객체를 통째로 대체하므로 undefined가 된다
  // (hasDisplayableCtx가 이 경우만 옛 규칙으로 폴백한다 — format.test.js 참조)
  let s2 = registerStart(createInitialState(), 'cl_l', {
    preloadUsage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 4321 },
  });
  s2 = reducer(s2, serverMsg({ type: 'started', startId: 'cl_l', key: 'l1' }));
  assert.equal(s2.sessions.get('l1').usage.ctxDisplayable, undefined, '구 형상엔 필드가 없다');
});

test('started: spawnPermissionMode 계보 시딩 — 지정 모드는 그대로, 미지정은 default', () => {
  // 지정 모드 시딩 (신뢰모드 스폰 → 계보에 남아 UI 신뢰모드 노출 자격이 된다)
  let s = createInitialState();
  s = registerStart(s, 'cl_pm', { cwd: 'C:\\p', permissionMode: 'bypassPermissions' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_pm', key: 'pm1' }));
  assert.equal(s.sessions.get('pm1').spawnPermissionMode, 'bypassPermissions');
  assert.equal(s.sessions.get('pm1').permissionMode, 'bypassPermissions');

  // 미지정 → default 폴백 (비신뢰 스폰)
  let s2 = createInitialState();
  s2 = registerStart(s2, 'cl_pm2', { cwd: 'C:\\p' });
  s2 = reducer(s2, serverMsg({ type: 'started', startId: 'cl_pm2', key: 'pm2' }));
  assert.equal(s2.sessions.get('pm2').spawnPermissionMode, 'default');

  // 런타임 모드 변경(update-session의 permissionMode 갱신)이 계보를 덮지 않는다
  const s3 = reducer(s, {
    type: 'update-session',
    key: 'pm1',
    fn: (sess) => ({ ...sess, permissionMode: 'plan' }),
  });
  assert.equal(s3.sessions.get('pm1').permissionMode, 'plan');
  assert.equal(s3.sessions.get('pm1').spawnPermissionMode, 'bypassPermissions', '계보는 불변');
});

test('started(resume 없는 재시작): 게이트는 닫힌 채 시딩된다', () => {
  let s = stateWithSession('old');
  s = registerStart(s, 'cl_2', { cwd: 'C:\\p', resumeSessionId: null, replaceKey: 'old' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_2', key: 'new2' }));
  assert.equal(s.sessions.get('new2').hasCompletedTurn, false);
  assert.equal(s.sessions.get('new2').resumeSourceId, null);
});

test('시작 실패(error+startId): 옛 탭 보존, pendingStarts 정리, 에러는 토스트로만', () => {
  let s = stateWithSession('old', { messages: [{ uid: 'm1', kind: 'user-text', text: '보존' }] });
  s = registerStart(s, 'cl_3', { cwd: 'C:\\p', replaceKey: 'old' });
  s = reducer(s, serverMsg({ type: 'error', startId: 'cl_3', message: 'claude process exited (code 1) — no conversation found' }));

  assert.equal(s.sessions.has('old'), true, '실패 시 옛 탭은 남는다');
  assert.equal(s.sessions.get('old').messages.length, 1, '채팅 기록에 에러가 추가되지 않는다');
  assert.equal(s.pendingStarts.size, 0);
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0].kind, 'error');
  assert.match(s.toasts[0].text, /no conversation found/);
});

test('result.is_error 이벤트는 토스트가 되고, 리플레이(seq 역행)는 토스트를 만들지 않는다', () => {
  let s = stateWithSession('k', { lastSeq: 0 });
  const payload = { type: 'result', subtype: 'success', is_error: true, result: '턴 오류', usage: {} };
  s = reducer(s, serverMsg({ type: 'event', key: 'k', seq: 1, payload }));
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0].text, '턴 오류');
  // 같은 seq가 리플레이로 다시 와도(재접속) 토스트 중복 없음
  s = reducer(s, serverMsg({ type: 'event', key: 'k', seq: 1, payload }));
  assert.equal(s.toasts.length, 1);
  // 세션이 없는 키의 이벤트도 토스트를 만들지 않는다
  s = reducer(s, serverMsg({ type: 'event', key: 'ghost', seq: 9, payload }));
  assert.equal(s.toasts.length, 1);
});

test('토스트는 최대 5개 유지(오래된 것부터 절단), remove-toast로 제거된다', () => {
  let s = createInitialState();
  for (let i = 1; i <= 7; i++) s = reducer(s, { type: 'add-toast', text: `t${i}`, kind: 'info' });
  assert.equal(s.toasts.length, 5);
  assert.deepEqual(s.toasts.map((t) => t.text), ['t3', 't4', 't5', 't6', 't7']);
  s = reducer(s, { type: 'remove-toast', id: s.toasts[0].id });
  assert.deepEqual(s.toasts.map((t) => t.text), ['t4', 't5', 't6', 't7']);
});
