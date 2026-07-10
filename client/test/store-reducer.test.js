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
  });
  s = reducer(s, serverMsg({ type: 'started', startId: 'cl_r', key: 'r1' }));

  const ns = s.sessions.get('r1');
  assert.deepEqual(ns.messages.map((m) => m.uid), ['p1', 'p2'], '히스토리가 생성 시점에 존재');
  assert.equal(ns.sessionId, 'sess-old', '원본 세션 id 표기 이월');
  assert.equal(ns.usage.contextTokens, 1234, 'usage(CTX%) 연속성');
  assert.equal(ns.hasCompletedTurn, true);
  assert.equal(s.activeKey, 'r1');
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
