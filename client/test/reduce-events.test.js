// reduce-cli-event — user 이벤트 분류(에코 억제/notice 변환)와 hasCompletedTurn 게이트 테스트.
// 실 CLI v2.1.206 실측 형태(플랜 "handshake 프로브" 절)를 그대로 픽스처로 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';

const userEvent = (content, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  session_id: 'sess-1',
  ...extra,
});

test('isReplay 문자열 user 이벤트(set_model 에코)는 채팅에 추가되지 않는다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout>Set model to sonnet (claude-sonnet-5)</local-command-stdout>', {
      isReplay: true,
    }),
  );
  assert.equal(s.messages.length, 0);
  // sessionId 채택은 유지된다 (이벤트 자체는 유효한 세션 신호)
  assert.equal(s.sessionId, 'sess-1');
});

test('비-replay 로컬 커맨드 출력은 태그를 벗겨 notice로 렌더된다 (슬래시 커맨드 결과)', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout>help output here</local-command-stdout>'),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'notice');
  assert.equal(s.messages[0].text, 'help output here');
});

test('빈 로컬 커맨드 출력은 빈 notice를 만들지 않는다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout></local-command-stdout>'),
  );
  assert.equal(s.messages.length, 0);
});

test('일반 문자열 user 이벤트는 user-text로 남는다', () => {
  const s = reduceCliEvent(createSessionState(), userEvent('안녕하세요'));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'user-text');
  assert.equal(s.messages[0].text, '안녕하세요');
});

test('isReplay 배열 content(히스토리 재전송)는 preload와 중복되지 않도록 무시된다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent([{ type: 'text', text: '과거 메시지' }], { isReplay: true }),
  );
  assert.equal(s.messages.length, 0);
});

test('system/status의 permissionMode는 권위 상태로 채택된다 (낙관 갱신 desync 회복)', () => {
  let s = createSessionState({ permissionMode: 'default' });
  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'status',
    status: null,
    permissionMode: 'plan',
    session_id: 'sess-1',
  });
  assert.equal(s.permissionMode, 'plan');
  // permissionMode가 없는 status 이벤트는 기존 값을 유지한다
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(s.permissionMode, 'plan');
  assert.equal(s.statusText, 'compacting');
});

// ----- hasCompletedTurn: --resume 게이트 (무턴 세션은 트랜스크립트가 없어 resume 불가) -----

const resultEvent = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'sess-1',
  usage: {},
  ...extra,
});

test('성공 result가 오면 hasCompletedTurn이 열린다', () => {
  const s = reduceCliEvent(createSessionState(), resultEvent({ num_turns: 1 }));
  assert.equal(s.hasCompletedTurn, true);
});

test('resume 실패류(is_error, num_turns:0)는 게이트를 열지 않는다 — v2.1.206 실측 형태', () => {
  const s = reduceCliEvent(
    createSessionState(),
    resultEvent({ subtype: 'error_during_execution', is_error: true, num_turns: 0 }),
  );
  assert.equal(s.hasCompletedTurn, false);
});

test('턴이 접수된 뒤의 is_error result(num_turns>0)는 게이트를 연다 — 대화가 디스크에 존재', () => {
  const s = reduceCliEvent(
    createSessionState(),
    resultEvent({ is_error: true, num_turns: 2 }),
  );
  assert.equal(s.hasCompletedTurn, true);
});

test('is_error result는 채팅에 error 아이템을 남기지 않는다 (토스트는 store 소관)', () => {
  const s = reduceCliEvent(
    createSessionState(),
    resultEvent({ is_error: true, num_turns: 0, result: '뭔가 실패' }),
  );
  assert.equal(s.messages.length, 0);
  assert.equal(s.lastResult.isError, true);
});
