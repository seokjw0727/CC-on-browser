// reduce-cli-event — user 이벤트 분류(에코 억제/notice 변환)와 hasCompletedTurn 게이트 테스트.
// 실 CLI v2.1.206 실측 형태(플랜 "handshake 프로브" 절)를 그대로 픽스처로 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceCliEvent, finalizeCompactionCards } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';

test('finalizeCompactionCards: running 카드를 done으로 닫고, 없으면 원본 참조 유지', () => {
  const running = [{ kind: 'compaction', state: 'running' }, { kind: 'user-text', text: 'x' }];
  const out = finalizeCompactionCards(running);
  assert.equal(out[0].state, 'done');
  const none = [{ kind: 'user-text', text: 'x' }];
  assert.equal(finalizeCompactionCards(none), none, '변화 없으면 같은 참조');
});

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

test('비-replay 로컬 커맨드 출력은 태그를 벗겨 command-output으로 렌더된다 (슬래시 커맨드 결과)', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout>help output here</local-command-stdout>'),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'command-output');
  assert.equal(s.messages[0].text, 'help output here');
  assert.equal(s.messages[0].isError, false);
});

test('stderr 출력은 command-output(isError:true)로 렌더된다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stderr>something failed</local-command-stderr>'),
  );
  assert.equal(s.messages[0].kind, 'command-output');
  assert.equal(s.messages[0].isError, true);
});

test('빈 로컬 커맨드 출력은 빈 아이템을 만들지 않는다', () => {
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

// ----- 턴별 토큰 사용량의 채팅 표시 (CLI풍 usage 아이템) -----

test('토큰을 소모한 result는 채팅에 usage 아이템을 남긴다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    resultEvent({
      num_turns: 1,
      duration_ms: 5300,
      usage: { input_tokens: 12, output_tokens: 345 },
    }),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'usage');
  assert.equal(s.messages[0].inTok, 12);
  assert.equal(s.messages[0].outTok, 345);
  assert.equal(s.messages[0].durationMs, 5300);
});

test('토큰 0인 result(모델 미호출 — 설정 에코·resume 실패류)는 usage 아이템을 남기지 않는다', () => {
  const s = reduceCliEvent(createSessionState(), resultEvent({ num_turns: 0 }));
  assert.equal(s.messages.length, 0);
});

test('is_error라도 토큰>0이면 usage 아이템은 남는다 (에러 알림은 store 토스트 소관)', () => {
  const s = reduceCliEvent(
    createSessionState(),
    resultEvent({ is_error: true, num_turns: 1, usage: { input_tokens: 5, output_tokens: 7 } }),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'usage');
  assert.equal(s.messages[0].inTok, 5);
  assert.equal(s.messages[0].outTok, 7);
});

// ----- 슬래시 커맨드 호출(<command-name> 에코) → 커맨드 칩 / 초기화 구분선 -----

const cmdEcho = (name, args = '', extra = {}) =>
  userEvent(
    `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
    extra,
  );
const cmdOptimistic = (name, args = '') => cmdEcho(name, args, { optimistic: true });

test('커맨드 호출 에코(<command-name>)는 커맨드 칩으로 렌더된다', () => {
  const s = reduceCliEvent(createSessionState(), cmdEcho('help'));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'command');
  assert.equal(s.messages[0].name, 'help');
});

test('커맨드 인자도 칩에 담긴다', () => {
  const s = reduceCliEvent(createSessionState(), cmdEcho('model', 'opus[1m]'));
  assert.equal(s.messages[0].kind, 'command');
  assert.equal(s.messages[0].name, 'model');
  assert.equal(s.messages[0].args, 'opus[1m]');
});

test('낙관 렌더 + CLI 에코 중복은 흡수된다 (칩 하나만)', () => {
  let s = reduceCliEvent(createSessionState(), cmdOptimistic('help')); // 낙관
  s = reduceCliEvent(s, cmdEcho('help')); // CLI 에코가 낙관 칩을 확정(소비)
  assert.equal(s.messages.filter((m) => m.kind === 'command').length, 1);
  assert.equal(s.messages[0].optimistic, false, '에코가 도착해 확정됨');
});

test('같은 커맨드를 두 번 실행하면 두 칩이 남는다 (과잉 흡수 아님)', () => {
  let s = reduceCliEvent(createSessionState(), cmdOptimistic('help')); // 1번 낙관
  s = reduceCliEvent(s, cmdEcho('help')); // 1번 에코 → 확정
  s = reduceCliEvent(s, cmdOptimistic('help')); // 2번 낙관
  s = reduceCliEvent(s, cmdEcho('help')); // 2번 에코 → 확정
  assert.equal(s.messages.filter((m) => m.kind === 'command').length, 2);
});

test('CLI 에코가 아예 안 와도 낙관 칩은 남아 렌더된다', () => {
  const s = reduceCliEvent(createSessionState(), cmdOptimistic('help'));
  assert.equal(s.messages.filter((m) => m.kind === 'command').length, 1);
});

test('/clear는 초기화 구분선(cleared)을 만들고 낙관+에코 중복은 흡수한다', () => {
  let s = reduceCliEvent(createSessionState(), cmdOptimistic('clear'));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'cleared');
  s = reduceCliEvent(s, cmdEcho('clear')); // 에코가 낙관 구분선을 확정
  assert.equal(s.messages.filter((m) => m.kind === 'cleared').length, 1);
});

// ----- /compact 진행/완료 카드 (실 CLI wire format 미러) -----

test('/compact: status:compacting → 진행 카드, compact_boundary → 완료+토큰 감소량', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-1' });
  const running = s.messages.find((m) => m.kind === 'compaction');
  assert.ok(running && running.state === 'running');
  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 117013, postTokens: 3171, durationMs: 77985 },
    session_id: 'sess-1',
  });
  const cards = s.messages.filter((m) => m.kind === 'compaction');
  assert.equal(cards.length, 1, '카드 하나만 유지되고 완료로 전환');
  assert.equal(cards[0].state, 'done');
  assert.equal(cards[0].preTokens, 117013);
  assert.equal(cards[0].postTokens, 3171);
});

test('/compact: compact_boundary 뒤 "Compacted" 출력은 중복 카드를 만들지 않는다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { preTokens: 100, postTokens: 10 },
  });
  s = reduceCliEvent(s, userEvent('<local-command-stdout>Compacted </local-command-stdout>'));
  assert.equal(s.messages.filter((m) => m.kind === 'compaction').length, 1);
  assert.equal(s.messages.filter((m) => m.kind === 'command-output').length, 0, '"Compacted" 출력은 흡수');
});

test('/compact: 시작을 못 봐도 "Compacted" 출력만으로 완료 카드를 만든다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout>Compacted </local-command-stdout>'),
  );
  const cards = s.messages.filter((m) => m.kind === 'compaction');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].state, 'done');
});

test('오래된 완료 카드가 있어도 새 압축(자동 등)은 별도 완료 카드를 만든다', () => {
  let s = createSessionState();
  // 1차 압축 완료 카드
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100, postTokens: 10 } });
  // 그 뒤로 대화가 이어진다(오래된 완료 카드로 밀려남)
  for (let i = 0; i < 4; i += 1) s = reduceCliEvent(s, userEvent(`메시지 ${i}`));
  // 2차 압축(진행 신호 없이 compact_boundary만 — 자동 압축) → 새 카드
  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 200, postTokens: 20 },
  });
  const cards = s.messages.filter((m) => m.kind === 'compaction');
  assert.equal(cards.length, 2, '오래된 카드를 덮어쓰지 않고 새 카드 생성');
  assert.equal(cards[1].preTokens, 200);
  assert.equal(cards[1].trigger, 'auto');
});

test('/compact: 진행 카드가 완료 신호 없이 result를 만나면 안전망이 닫는다', () => {
  let s = reduceCliEvent(createSessionState(), { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, resultEvent({ num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
  const running = s.messages.find((m) => m.kind === 'compaction' && m.state === 'running');
  assert.equal(running, undefined, '진행 카드가 남아 무한 스피너가 되지 않는다');
});

test('/compact: 인터럽트/실패(is_error) result는 "완료"가 아니라 "중단됨"으로 닫는다', () => {
  let s = reduceCliEvent(createSessionState(), { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, resultEvent({ is_error: true, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
  const card = s.messages.find((m) => m.kind === 'compaction');
  assert.ok(card);
  assert.equal(card.state, 'canceled', '실패한 압축은 완료로 표시하지 않는다');
});

test('재개(비낙관) /compact 에코는 진행 카드를 만들지 않는다 (잘린 히스토리 무한 스피너 방지)', () => {
  // 트랜스크립트가 /compact에서 잘리고 뒤에 완료 신호가 없는 상황
  const s = reduceCliEvent(createSessionState(), cmdEcho('compact'));
  assert.equal(s.messages.filter((m) => m.kind === 'compaction').length, 0, '에코만으론 진행 카드 없음');
  assert.equal(s.messages.filter((m) => m.kind === 'command').length, 1, '커맨드 칩은 남는다');
});

test('낙관 /compact는 진행 카드를 즉시 띄운다 (라이브 피드백)', () => {
  const s = reduceCliEvent(createSessionState(), cmdOptimistic('compact'));
  const c = s.messages.find((m) => m.kind === 'compaction');
  assert.ok(c && c.state === 'running');
});

test('압축 요약 user 메시지(isCompactSummary)는 접이식 요약 카드로 보존된다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('This session is being continued…', { isCompactSummary: true }),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'compaction-summary');
  assert.match(s.messages[0].text, /continued/);
});

// ----- 사고 과정 본문 보존 (스트리밍 delta로만 오고 최종 블록은 서명만) -----

test('스트리밍 thinking_delta로 쌓인 본문은 빈 확정 블록에 덮이지 않는다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  s = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  });
  s = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '깊이 생각한 내용' } },
  });
  s = reduceCliEvent(s, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  // 최종 assistant: thinking 블록의 본문은 ''(서명만) — 실 CLI 실측 형태
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
  });
  const think = s.messages.find((m) => m.kind === 'thinking');
  assert.ok(think);
  assert.equal(think.thinking, '깊이 생각한 내용', '누적 본문이 보존된다');
});
