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

test('effortSet: 런타임 적용 방송이 UI 티어로 역매핑돼 반영된다(재시작 없음)', () => {
  let s = stateWithSession('k', { effort: 'high' });
  // 와이어는 CLI 형상 — ultracode 플래그가 켜져 있으면 UI는 최상위 티어로 표시한다
  s = reducer(s, serverMsg({ type: 'effortSet', key: 'k', effort: 'xhigh', ultracode: true }));
  assert.equal(s.sessions.get('k').effort, 'ultracode');
  // 평범한 수준은 그대로
  s = reducer(s, serverMsg({ type: 'effortSet', key: 'k', effort: 'low', ultracode: false }));
  assert.equal(s.sessions.get('k').effort, 'low');
  // ultracode를 요청했지만 얹지 못한 세션(구버전 CLI·미지원 모델)은 실제값으로 교정된다
  s = reducer(s, serverMsg({ type: 'effortSet', key: 'k', effort: 'xhigh' }));
  assert.equal(s.sessions.get('k').effort, 'xhigh');
  // null = CLI 기본으로 되돌림
  s = reducer(s, serverMsg({ type: 'effortSet', key: 'k', effort: null, ultracode: false }));
  assert.equal(s.sessions.get('k').effort, null);
  // 세션 탭이 없는 방송(다른 탭에서만 열린 세션)은 무해한 무동작
  const before = s;
  const after = reducer(s, serverMsg({ type: 'effortSet', key: 'ghost', effort: 'max' }));
  assert.equal(after, before);
  // 재시작 신호가 아니다 — 시작 대기표를 건드리지 않는다
  assert.equal(after.pendingStarts.size, 0);
});

test('modelSet: CLI가 수용한 모델만 반영하고 전환 확정 대기를 건다', () => {
  let s = stateWithSession('k', {
    model: 'claude-opus-5[1m]',
    spawnModel: 'opus[1m]',
    contextWindow: 1_000_000,
  });
  s = reducer(s, serverMsg({ type: 'modelSet', key: 'k', reqId: 'md_x_1', model: 'sonnet' }));
  const after = s.sessions.get('k');
  assert.equal(after.model, 'sonnet');
  // 스폰 계보 — CLI가 실제로 받아들인 값만 담긴다(재시작 --model 인자로 재사용 가능)
  assert.equal(after.spawnModel, 'sonnet');
  // 이전 모델 기준의 창 크기는 무효 — 다음 result까지 카탈로그 휴리스틱 폴백
  assert.equal(after.contextWindow, null);
  // 표적을 걸어 둬야 진행 중 턴의 구모델 보고가 이 선택을 되돌리지 못한다
  assert.deepEqual(after.modelSwitch, { target: 'sonnet' });

  // 연속 변경 — 새 표적이 옛 표적을 대체한다(옛 표적이 남으면 최신 보고가 버려진다)
  s = reducer(s, serverMsg({ type: 'modelSet', key: 'k', reqId: 'md_x_2', model: 'haiku' }));
  assert.deepEqual(s.sessions.get('k').modelSwitch, { target: 'haiku' });

  // 모델이 빠진 방송은 세션을 건드리지 않는다(형상 방어). updateSession은 세션 객체가
  // 그대로여도 state·Map은 새로 만들므로, 동일성이 아니라 내용으로 확인한다.
  const before = s.sessions.get('k');
  const nulled = reducer(s, serverMsg({ type: 'modelSet', key: 'k', model: null }));
  assert.equal(nulled.sessions.get('k'), before);
  // 이 탭에 없는 세션의 방송은 상태 전체가 그대로다(updateSession이 원본을 돌려준다)
  assert.equal(reducer(s, serverMsg({ type: 'modelSet', key: 'ghost', model: 'opus' })), s);
});

test('exit: 프로세스가 죽으면 모델 전환 확정 대기도 함께 풀린다(수확 고착 방지)', () => {
  let s = stateWithSession('k', { modelSwitch: { target: 'sonnet' }, backgroundTasks: [{ task_id: 't' }] });
  s = reducer(s, serverMsg({ type: 'exit', key: 'k', code: 0 }));
  const after = s.sessions.get('k');
  assert.equal(after.status, 'exited');
  assert.equal(after.modelSwitch, null);
  assert.deepEqual(after.backgroundTasks, []);
});

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

// 위 이월 규칙의 반례. "조회했는데 실패"와 "아예 조회하지 않음"은 둘 다 quota=null로
// 도착하지만, 후자에서 직전 값을 이어 쓰면 껐는데도 링과 한도 알림이 옛 %로 살아 있게
// 된다 — 끔이 화면에서 끔이 되지 않는다.
test('set-usage: quotaEnabled=false는 이월하지 않고 quota를 즉시 비운다', () => {
  const s0 = createInitialState();
  assert.equal(s0.officialUsage, false, '기본값은 꺼짐');

  const withQuota = {
    fiveHour: { totalTokens: 100 },
    sevenDay: { totalTokens: 200 },
    quota: { fiveHour: { utilization: 42 }, sevenDay: { utilization: 18 } },
  };
  const on = reducer(s0, { type: 'set-usage', usage: withQuota, quotaEnabled: true });
  assert.equal(on.globalUsage.quota.fiveHour.utilization, 42);
  assert.equal(on.officialUsage, true, '요청이 조회를 시도했음을 사본에 기록');

  // 껐다 — quota=null이 오고, 직전 값을 이어받지 않는다. 로컬 집계는 그대로 갱신.
  const off = reducer(on, {
    type: 'set-usage',
    usage: { fiveHour: { totalTokens: 150 }, sevenDay: { totalTokens: 260 }, quota: null },
    quotaEnabled: false,
  });
  assert.equal(off.globalUsage.quota, null, '끈 응답은 직전 quota를 이어받지 않는다');
  assert.equal(off.globalUsage.fiveHour.totalTokens, 150, '로컬 집계는 계속 갱신된다');
  assert.equal(off.officialUsage, false);

  // quotaEnabled를 싣지 않은(구식) 액션은 종전 이월 동작을 그대로 유지한다.
  const legacy = reducer(on, {
    type: 'set-usage',
    usage: { fiveHour: { totalTokens: 150 }, sevenDay: { totalTokens: 260 }, quota: null },
  });
  assert.equal(legacy.globalUsage.quota.fiveHour.utilization, 42, '실패는 여전히 이월된다');
  assert.equal(legacy.officialUsage, true, '싣지 않으면 사본을 건드리지 않는다');
});

test('set-official-usage: 끄면 남은 quota를 비우고, 바뀔 것이 없으면 같은 state를 준다', () => {
  const s0 = createInitialState();

  // 켜기 — 사본만 바뀐다.
  const on = reducer(s0, { type: 'set-official-usage', on: true });
  assert.equal(on.officialUsage, true);

  const withQuota = reducer(on, {
    type: 'set-usage',
    usage: { fiveHour: { totalTokens: 1 }, sevenDay: { totalTokens: 2 }, quota: { fiveHour: { utilization: 42 }, sevenDay: null } },
    quotaEnabled: true,
  });
  assert.equal(withQuota.globalUsage.quota.fiveHour.utilization, 42);

  // 끄기 — 다음 폴링을 기다리지 않고 그 자리에서 %가 사라진다.
  const off = reducer(withQuota, { type: 'set-official-usage', on: false });
  assert.equal(off.officialUsage, false);
  assert.equal(off.globalUsage.quota, null, '토글 즉시 비운다');
  assert.equal(off.globalUsage.fiveHour.totalTokens, 1, '로컬 집계는 남는다');

  // 멱등 — 같은 값으로 다시 부르면 **같은 객체**를 돌려준다. App.jsx의 폴링 effect가
  // 이 값에 의존한 채 마운트마다 동기화를 dispatch하므로, 새 객체를 만들면 무한 루프다.
  assert.equal(reducer(off, { type: 'set-official-usage', on: false }), off);
  assert.equal(reducer(on, { type: 'set-official-usage', on: true }), on);

  // 켜져 있고 quota가 없는 상태에서 다시 켜도 마찬가지.
  assert.equal(reducer(s0, { type: 'set-official-usage', on: false }), s0);
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

// ----- 원격 제어 스냅샷 -----
// 서버가 늘 전체를 보내므로 리듀서는 병합하지 않고 통째로 갈아 끼운다.
// 조회는 cwd 문자열이 아니라 keys(세션 key)로 한다 — 동일성 판정은 서버(realpath)만 할 수 있다.

const rcState = (over = {}) => ({
  cwd: '/repo', keys: ['s_1'], name: 'repo', state: 'ready',
  environmentId: 'env_a', url: 'https://claude.ai/code?environment=env_a',
  capacity: { used: 0, max: 32 }, error: null, startedAt: 1, ...over,
});

test('remoteControl 메시지는 스냅샷을 통째로 교체한다', () => {
  let s = createInitialState();
  assert.deepEqual(s.remoteControls, []);
  s = reducer(s, serverMsg({ type: 'remoteControl', states: [rcState()] }));
  assert.equal(s.remoteControls.length, 1);
  assert.equal(s.remoteControls[0].environmentId, 'env_a');
  // 빈 배열도 사실이다 — 병합했다면 옛 항목이 남아 유령이 된다
  s = reducer(s, serverMsg({ type: 'remoteControl', states: [] }));
  assert.deepEqual(s.remoteControls, []);
});

test('remoteControl states가 배열이 아니면 빈 배열로 방어한다', () => {
  let s = createInitialState();
  s = reducer(s, serverMsg({ type: 'remoteControl', states: null }));
  assert.deepEqual(s.remoteControls, []);
});

test('remoteControlFor는 세션 key로 찾고, 없으면 null', async () => {
  const { remoteControlFor } = await import('../src/lib/store-reducer.js');
  let s = createInitialState();
  s = reducer(s, serverMsg({
    type: 'remoteControl',
    states: [rcState({ keys: ['s_2', 's_3'] })],
  }));
  assert.equal(remoteControlFor(s, 's_2').cwd, '/repo');
  assert.equal(remoteControlFor(s, 's_3').cwd, '/repo');
  assert.equal(remoteControlFor(s, 's_9'), null);
  assert.equal(remoteControlFor(s, null), null);
});

test('한 cwd를 여러 세션이 공유하면 모두 같은 원격 제어를 본다', async () => {
  const { remoteControlFor } = await import('../src/lib/store-reducer.js');
  let s = createInitialState();
  s = reducer(s, serverMsg({
    type: 'remoteControl',
    states: [rcState({ keys: ['s_1', 's_2'] }), rcState({ cwd: '/other', keys: ['s_9'] })],
  }));
  assert.equal(remoteControlFor(s, 's_1'), remoteControlFor(s, 's_2'));
  assert.equal(remoteControlFor(s, 's_9').cwd, '/other');
});

test('remoteControlByCwd는 서버가 묶어 준 cwds로 찾는다 (세션이 먼저 끝난 경우의 폴백)', async () => {
  const { remoteControlByCwd } = await import('../src/lib/store-reducer.js');
  let s = createInitialState();
  s = reducer(s, serverMsg({
    type: 'remoteControl',
    // 세션이 끝나 keys는 비었지만 원격 제어는 계속 돈다. cwds에는 그 세션이 쓴
    // 원본 철자(대소문자·심링크가 다를 수 있다)가 서버의 realpath 판정으로 담겨 온다.
    states: [rcState({ keys: [], cwds: ['C:/Repo', 'C:/repo-link'] })],
  }));
  assert.equal(remoteControlByCwd(s, 'C:/Repo').cwd, '/repo');
  assert.equal(remoteControlByCwd(s, 'C:/repo-link').cwd, '/repo', '같은 항목의 다른 철자');
  // canonical cwd(r.cwd)는 매칭 근거가 아니다 — 클라이언트는 정규화를 할 수 없다
  assert.equal(remoteControlByCwd(s, '/repo'), null);
  assert.equal(remoteControlByCwd(s, 'C:/other'), null);
  assert.equal(remoteControlByCwd(s, null), null);
});

test('remoteControlByCwd는 cwds가 없는 항목에서도 터지지 않는다', async () => {
  const { remoteControlByCwd } = await import('../src/lib/store-reducer.js');
  let s = createInitialState();
  s = reducer(s, serverMsg({ type: 'remoteControl', states: [rcState()] })); // cwds 없음
  assert.equal(remoteControlByCwd(s, 'C:/repo'), null);
  assert.equal(remoteControlByCwd(createInitialState(), 'C:/repo'), null);
});

// ----- 원격 제어 상태 전이 알림 -----
// 컴포저 pill을 없앤 뒤 "켜졌다/실패했다"를 알리는 유일한 창구가 토스트다(store.jsx).
// 가짜 CLI로는 ready 경로를 만들 수 없어(e2e는 실패만 관측한다) 여기서 덮는다.

test('remoteControlTransitions: 최초 스냅샷은 전이가 아니다 (prev=null이면 조용히 시딩)', async () => {
  const { remoteControlTransitions } = await import('../src/lib/store-reducer.js');
  // 페이지를 막 열었을 뿐인데 이미 켜져 있던 항목을 "방금 켜졌다"고 알리면 거짓말이다.
  assert.deepEqual(remoteControlTransitions(null, [rcState({ state: 'ready' })]), []);
  assert.deepEqual(remoteControlTransitions(null, [rcState({ state: 'error' })]), []);
});

test('remoteControlTransitions: ready·error로 새로 바뀐 항목만 돌려준다', async () => {
  const { remoteControlTransitions, remoteControlStates } = await import('../src/lib/store-reducer.js');
  const starting = [rcState({ state: 'starting' })];
  const prev = remoteControlStates(starting);
  const ready = remoteControlTransitions(prev, [rcState({ state: 'ready' })]);
  assert.deepEqual(ready.map((r) => r.state), ['ready']);
  const failed = remoteControlTransitions(prev, [rcState({ state: 'error', error: '로그인 필요' })]);
  assert.deepEqual(failed.map((r) => r.error), ['로그인 필요']);
  // 켜는 중·끄는 중·꺼짐은 알리지 않는다 — 사용자가 방금 누른 결과라 이미 안다.
  assert.deepEqual(remoteControlTransitions(prev, [rcState({ state: 'stopping' })]), []);
  assert.deepEqual(remoteControlTransitions(prev, [rcState({ state: 'stopped' })]), []);
});

test('remoteControlTransitions: 같은 상태가 다시 오면 알리지 않는다 (url·capacity가 늦게 채워져도)', async () => {
  const { remoteControlTransitions, remoteControlStates } = await import('../src/lib/store-reducer.js');
  const first = [rcState({ state: 'ready', url: null })];
  const prev = remoteControlStates(first);
  // 같은 항목의 새 객체 + 뒤늦게 붙은 url — 상태가 그대로면 전이가 아니다.
  const again = remoteControlTransitions(prev, [rcState({ state: 'ready', url: 'https://x' })]);
  assert.deepEqual(again, []);
});

test('remoteControlTransitions: identity는 cwd라 순서가 바뀌어도 흔들리지 않는다', async () => {
  const { remoteControlTransitions, remoteControlStates } = await import('../src/lib/store-reducer.js');
  const prev = remoteControlStates([
    rcState({ cwd: '/a', state: 'ready' }),
    rcState({ cwd: '/b', state: 'starting' }),
  ]);
  // 배열 순서를 뒤집고 keys까지 갈아 끼워도, 바뀐 것은 /b 하나뿐이다.
  const changed = remoteControlTransitions(prev, [
    rcState({ cwd: '/b', state: 'ready', keys: ['s_7'] }),
    rcState({ cwd: '/a', state: 'ready', keys: [] }),
  ]);
  assert.deepEqual(changed.map((r) => r.cwd), ['/b']);
});

test('remoteControlStates: cwd 없는 항목·배열 아닌 입력을 걸러 낸다', async () => {
  const { remoteControlStates } = await import('../src/lib/store-reducer.js');
  assert.equal(remoteControlStates(null).size, 0);
  assert.equal(remoteControlStates([{ state: 'ready' }]).size, 0);
  assert.equal(remoteControlStates([rcState()]).get('/repo'), 'ready');
});

test('rename-session: 사용자 지정 이름을 설정·해제하고 없는 키는 무시한다', () => {
  let s = stateWithSession('a');
  assert.equal(s.sessions.get('a').customTitle, '');
  s = reducer(s, { type: 'rename-session', key: 'a', title: '내 세션' });
  assert.equal(s.sessions.get('a').customTitle, '내 세션');
  // 빈 문자열 = 해제(자동 제목으로 복귀), 문자열이 아니면 ''로 방어
  s = reducer(s, { type: 'rename-session', key: 'a', title: '' });
  assert.equal(s.sessions.get('a').customTitle, '');
  s = reducer(s, { type: 'rename-session', key: 'a', title: null });
  assert.equal(s.sessions.get('a').customTitle, '');
  // 공백뿐인 이름도 해제로 수렴한다 — 남겨 두면 자동 제목이 영영 가려진다
  s = reducer(s, { type: 'rename-session', key: 'a', title: '   ' });
  assert.equal(s.sessions.get('a').customTitle, '');
  // 없는 세션은 상태를 바꾸지 않는다(같은 참조)
  const before = s;
  assert.equal(reducer(s, { type: 'rename-session', key: '없음', title: 'x' }), before);
});

test('started: preloadCustomTitle이 새 세션의 이름으로 이월된다(없으면 빈 값)', () => {
  let s = createInitialState();
  s = registerStart(s, 'st_1', { cwd: '/repo', resumeSessionId: 'src', preloadCustomTitle: '이어서 작업' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_1', key: 's_1' }));
  assert.equal(s.sessions.get('s_1').customTitle, '이어서 작업');

  s = registerStart(s, 'st_2', { cwd: '/repo' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_2', key: 's_2' }));
  assert.equal(s.sessions.get('s_2').customTitle, '');

  // 공백뿐인 이월 값은 이름 없음으로 수렴
  s = registerStart(s, 'st_3', { cwd: '/repo', preloadCustomTitle: '   ' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_3', key: 's_3' }));
  assert.equal(s.sessions.get('s_3').customTitle, '');
});

test('preview: 열기/닫기는 세션별이고, 닫아도 마지막 선택은 남는다', () => {
  let s = createInitialState();
  s = registerStart(s, 'st_a', { cwd: '/repo' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_a', key: 'a' }));
  s = registerStart(s, 'st_b', { cwd: '/repo2' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_b', key: 'b' }));
  // 기본은 닫힘 + 선택 없음 + 자동 열기 억제 없음
  assert.deepEqual(s.sessions.get('a').preview, { open: false, path: null, suppressed: false });

  s = reducer(s, { type: 'open-preview', key: 'a', path: 'C:/repo/x.html' });
  assert.deepEqual(s.sessions.get('a').preview, { open: true, path: 'C:/repo/x.html', suppressed: false });
  // 다른 세션은 영향받지 않는다(선택은 세션별)
  assert.deepEqual(s.sessions.get('b').preview, { open: false, path: null, suppressed: false });

  // 닫아도 경로는 보존 — 다시 열면 보던 파일로 돌아간다. 직접 닫았으므로 이번 턴의
  // 자동 열기는 억제되고, 다시 직접 열면 억제가 풀린다.
  s = reducer(s, { type: 'close-preview', key: 'a' });
  assert.deepEqual(s.sessions.get('a').preview, { open: false, path: 'C:/repo/x.html', suppressed: true });
  s = reducer(s, { type: 'open-preview', key: 'a' });
  assert.deepEqual(s.sessions.get('a').preview, { open: true, path: 'C:/repo/x.html', suppressed: false });

  // 없는 세션은 상태를 바꾸지 않는다(같은 참조)
  const before = s;
  assert.equal(reducer(s, { type: 'open-preview', key: '없음', path: 'y' }), before);
});

test('started: preloadPreview가 effort 재시작(replaceKey)에서 이월된다', () => {
  let s = createInitialState();
  s = registerStart(s, 'st_1', {
    cwd: '/repo',
    preloadPreview: { open: true, path: 'C:/repo/report.html' },
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_1', key: 's_1' }));
  // suppressed가 없는 옛 형태가 들어와도 shape는 정규화된다(undefined로 남지 않는다).
  assert.deepEqual(s.sessions.get('s_1').preview, {
    open: true, path: 'C:/repo/report.html', suppressed: false,
  });

  // 이월 값이 없으면 기본(닫힘) — 새로 시작한 세션에 빈 패널이 열리지 않는다
  s = registerStart(s, 'st_2', { cwd: '/repo' });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_2', key: 's_2' }));
  assert.deepEqual(s.sessions.get('s_2').preview, { open: false, path: null, suppressed: false });

  // 억제 상태도 그대로 따라온다 — 같은 대화를 이어가는 재시작이므로.
  s = registerStart(s, 'st_3', {
    cwd: '/repo',
    preloadPreview: { open: false, path: 'C:/repo/report.html', suppressed: true },
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'st_3', key: 's_3' }));
  assert.equal(s.sessions.get('s_3').preview.suppressed, true);
});

// ----- 턴 종료 자동 열기 -----
// 이번 턴에 쓴 산출물 판정 자체는 artifacts.test.js가 검증한다. 여기서는 "언제 여는가"
// (가드)와 억제 수명만 본다.

const okResult = { content: 'Created', isError: false, structured: null };
const writeEvent = (id, file_path) => ({
  type: 'assistant',
  message: { id: `m_${id}`, content: [{ type: 'tool_use', id, name: 'Write', input: { file_path } }] },
});
const toolResultEvent = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Created', is_error: false }] },
});
const promptEvent = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

/**
 * 프롬프트 → Write → tool_result까지 진행한 세션(아직 result 전). seq는 이어서 쓴다.
 * toolId는 턴마다 달라야 한다 — 같은 id를 재사용하면 tool_result가 이미 닫힌 앞 카드에
 * 붙어 두 번째 쓰기가 영영 "실행 중"으로 남는다.
 */
function turnUpToToolResult(state, key, file_path, startSeq, toolId = 't1') {
  let s = state;
  let seq = startSeq;
  for (const payload of [promptEvent('만들어줘'), writeEvent(toolId, file_path), toolResultEvent(toolId)]) {
    s = reducer(s, serverMsg({ type: 'event', key, seq: seq++, payload }));
  }
  return { s, seq };
}

test('event: 성공한 턴이 끝나면 이번 턴 산출물로 미리보기가 자동으로 열린다', () => {
  let { s, seq } = turnUpToToolResult(stateWithSession('a'), 'a', '/repo/out.html', 1);
  // 도구 결과 시점에는 아직 열리지 않는다 — 여는 시점은 result 하나뿐이다.
  assert.equal(s.sessions.get('a').preview.open, false);

  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: { type: 'result', subtype: 'success' } }));
  assert.deepEqual(s.sessions.get('a').preview, {
    open: true, path: '/repo/out.html', suppressed: false,
  });
});

test('event: 실패·리플레이 턴은 산출물이 있어도 자동으로 열지 않는다', () => {
  // 실패한 턴 — 같은 산출물을 깔아 두고도 안 열려야 한다(비어 있어서 안 열린 게 아님).
  let t = turnUpToToolResult(stateWithSession('a'), 'a', '/repo/out.html', 1);
  let s = reducer(t.s, serverMsg({
    type: 'event', key: 'a', seq: t.seq, payload: { type: 'result', subtype: 'error_during_execution', is_error: true },
  }));
  assert.equal(s.sessions.get('a').preview.open, false, 'is_error 턴');

  // CLI가 자기 히스토리를 되쏜 result
  t = turnUpToToolResult(stateWithSession('b'), 'b', '/repo/out.html', 1);
  s = reducer(t.s, serverMsg({
    type: 'event', key: 'b', seq: t.seq, payload: { type: 'result', subtype: 'success', isReplay: true },
  }));
  assert.equal(s.sessions.get('b').preview.open, false, 'payload.isReplay');

  // 이미 반영한 seq(재접속 중복 전달)
  t = turnUpToToolResult(stateWithSession('c'), 'c', '/repo/out.html', 1);
  s = reducer(t.s, serverMsg({
    type: 'event', key: 'c', seq: 1, payload: { type: 'result', subtype: 'success' },
  }));
  assert.equal(s.sessions.get('c').preview.open, false, '중복 seq');

  // 반면 순단 중 놓쳤다가 처음 도착한 result(새 seq)는 정상적으로 연다 — 중복을 한 번
  // 흘려보낸 **그 상태에서** 이어서 검증한다(중복 처리가 상태를 망가뜨리지 않았는가).
  s = reducer(s, serverMsg({
    type: 'event', key: 'c', seq: t.seq, payload: { type: 'result', subtype: 'success' },
  }));
  assert.equal(s.sessions.get('c').preview.path, '/repo/out.html');
});

test('event: 산출물 없는 턴은 미리보기 상태를 건드리지 않는다', () => {
  let s = stateWithSession('a');
  s = reducer(s, { type: 'open-preview', key: 'a', path: '/repo/old.html' });
  s = reducer(s, { type: 'close-preview', key: 'a' }); // 사용자가 직접 닫음
  const closed = s.sessions.get('a').preview;

  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: 1, payload: promptEvent('그냥 물어봄') }));
  // 새 프롬프트가 억제를 푼 직후의 상태 — result가 이 객체를 그대로 두어야 한다.
  const afterPrompt = s.sessions.get('a').preview;
  assert.deepEqual(afterPrompt, { open: false, path: closed.path, suppressed: false });

  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: 2, payload: { type: 'result', subtype: 'success' } }));
  // 열 산출물이 없으므로 닫힌 채 유지된다 — 필드 하나가 아니라 객체 전체가 그대로다.
  assert.deepEqual(s.sessions.get('a').preview, afterPrompt);
});

test('event: 텍스트와 tool_result가 섞인 meta 이벤트는 사용자 턴으로 세지 않는다', () => {
  // 주입 메시지 판별은 단일 텍스트 본문에만 걸린다 — 혼합 블록 meta 이벤트가 억제를
  // 풀어 버리면, 방금 닫은 패널이 같은 턴에 도로 열린다.
  let { s, seq } = turnUpToToolResult(stateWithSession('a'), 'a', '/repo/out.html', 1);
  s = reducer(s, { type: 'close-preview', key: 'a' });
  s = reducer(s, serverMsg({
    type: 'event',
    key: 'a',
    seq: seq++,
    payload: {
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'ok', is_error: false },
          { type: 'text', text: 'Stop hook feedback: …' },
        ],
      },
    },
  }));
  assert.equal(s.sessions.get('a').preview.suppressed, true, 'meta 이벤트는 억제를 풀지 않는다');
  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: { type: 'result', subtype: 'success' } }));
  assert.equal(s.sessions.get('a').preview.open, false);
});

test('event: 턴 중 직접 닫으면 그 턴은 안 열리고, 다음 프롬프트에서 억제가 풀린다', () => {
  let { s, seq } = turnUpToToolResult(stateWithSession('a'), 'a', '/repo/out.html', 1);
  // 턴이 도는 중에 사용자가 패널을 닫는다(직전 턴에서 열려 있던 상태를 닫는 상황).
  s = reducer(s, { type: 'close-preview', key: 'a' });
  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: { type: 'result', subtype: 'success' } }));
  assert.equal(s.sessions.get('a').preview.open, false, '직접 닫은 턴은 조용히');

  // 다음 프롬프트가 억제를 풀고, 그 턴의 산출물로 다시 열린다.
  const t = turnUpToToolResult(s, 'a', '/repo/next.html', seq, 't2');
  assert.equal(t.s.sessions.get('a').preview.suppressed, false, '새 프롬프트가 억제 해제');
  s = reducer(t.s, serverMsg({ type: 'event', key: 'a', seq: t.seq, payload: { type: 'result', subtype: 'success' } }));
  assert.deepEqual(s.sessions.get('a').preview, {
    open: true, path: '/repo/next.html', suppressed: false,
  });
});

test('event: 뒤늦은 커맨드 에코는 이미 센 턴이라 억제를 다시 풀지 않는다', () => {
  const commandEvent = (optimistic) => ({
    type: 'user',
    ...(optimistic ? { optimistic: true } : {}),
    message: {
      role: 'user',
      content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
    },
  });
  let s = stateWithSession('a');
  let seq = 1;
  // 낙관 렌더(사용자가 방금 실행) → 새 턴이므로 억제가 풀리는 것이 맞다.
  s = reducer(s, { type: 'close-preview', key: 'a' });
  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: commandEvent(true) }));
  assert.equal(s.sessions.get('a').preview.suppressed, false, '낙관 렌더는 새 턴');

  // 사용자가 그 턴 도중 패널을 닫는다 → 뒤늦은 CLI 에코가 낙관 칩을 확정만 한다.
  s = reducer(s, { type: 'close-preview', key: 'a' });
  const beforeEcho = s.sessions.get('a').messages.length;
  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: commandEvent(false) }));
  assert.equal(s.sessions.get('a').messages.length, beforeEcho, '에코는 새 칩을 만들지 않는다');
  assert.equal(s.sessions.get('a').preview.suppressed, true, '에코는 억제를 풀지 않는다');
});

test('event: 보고 있던 파일이 이번 턴에도 수정되면 선택을 바꾸지 않는다', () => {
  let s = stateWithSession('a');
  s = reducer(s, { type: 'open-preview', key: 'a', path: '/repo/notes.md' });
  let seq = 1;
  for (const payload of [
    promptEvent('둘 다 고쳐줘'),
    writeEvent('t1', '/repo/notes.md'), toolResultEvent('t1'),
    writeEvent('t2', '/repo/page.html'), toolResultEvent('t2'),
  ]) {
    s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload }));
  }
  s = reducer(s, serverMsg({ type: 'event', key: 'a', seq: seq++, payload: { type: 'result', subtype: 'success' } }));
  assert.equal(s.sessions.get('a').preview.path, '/repo/notes.md', '우선순위(html)보다 사용자의 선택이 앞선다');
});

test('sessionName: CLI가 붙인 이름을 세션 상태에 담는다', () => {
  let s = stateWithSession('k');
  assert.equal(s.sessions.get('k').cliName, '');
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k', sessionId: 'sid-1', cliName: ' cc-on-browser-ca ' }));
  assert.equal(s.sessions.get('k').cliName, 'cc-on-browser-ca');
  // 빈 이름은 무시한다 — 이름을 지우는 채널이 아니라 알려 주는 채널이다.
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k', cliName: '   ' }));
  assert.equal(s.sessions.get('k').cliName, 'cc-on-browser-ca');
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k' }));
  assert.equal(s.sessions.get('k').cliName, 'cc-on-browser-ca');
  // 같은 값이면 세션 객체를 새로 만들지 않는다(불필요한 리렌더 방지)
  const same = reducer(s, serverMsg({ type: 'sessionName', key: 'k', cliName: 'cc-on-browser-ca' }));
  assert.equal(same.sessions.get('k'), s.sessions.get('k'));
  // 세션 탭이 없는 방송은 무해한 무동작
  assert.equal(reducer(s, serverMsg({ type: 'sessionName', key: 'ghost', cliName: 'x' })), s);
});

test('sessionName: reset은 옛 세션 id의 이름을 지운다(/clear 등 id 교체)', () => {
  let s = stateWithSession('k');
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k', sessionId: 'sid-1', cliName: 'old-name' }));
  assert.equal(s.sessions.get('k').cliName, 'old-name');
  // id가 바뀌면 서버가 reset을 보낸다 — 빈 이름 무시 규칙에 걸리지 않고 지워져야 한다.
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k', sessionId: 'sid-2', cliName: null, reset: true }));
  assert.equal(s.sessions.get('k').cliName, '');
  // 이미 비어 있으면 새 객체를 만들지 않는다
  const same = reducer(s, serverMsg({ type: 'sessionName', key: 'k', reset: true }));
  assert.equal(same.sessions.get('k'), s.sessions.get('k'));
  // 새 id의 이름이 오면 그것이 들어온다
  s = reducer(s, serverMsg({ type: 'sessionName', key: 'k', sessionId: 'sid-2', cliName: 'new-name' }));
  assert.equal(s.sessions.get('k').cliName, 'new-name');
});
