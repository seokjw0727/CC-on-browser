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

// updateByUid의 계약 — Message의 React.memo가 여기에 얹혀 있다. 델타 하나가
// "바뀐 블록 하나"만 새 참조로 만들고 나머지 아이템의 객체 참조를 그대로 넘겨야
// memo가 bailout한다. 이게 깨지면 성능 회귀가 조용히 돌아온다(설계도 §1 ①).
test('스트리밍 델타는 대상 블록만 새 참조로 바꾸고 나머지 메시지 참조는 보존한다', () => {
  const stream = (s, ev) => reduceCliEvent(s, { type: 'stream_event', event: ev });
  let s = createSessionState();
  // 앞쪽에 확정 메시지 몇 개를 쌓고, 그 뒤에 스트리밍 블록을 연다.
  s = reduceCliEvent(s, { type: 'user', message: { role: 'user', content: '첫 질문' } });
  s = reduceCliEvent(s, { type: 'user', message: { role: 'user', content: '둘째 질문' } });
  s = stream(s, { type: 'message_start', message: { id: 'msg_1' } });
  s = stream(s, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const before = s.messages;
  assert.equal(before.length, 3);

  s = stream(s, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안녕' } });

  assert.notEqual(s.messages, before, '배열은 새로 만들어진다(React가 변화를 보게)');
  assert.equal(s.messages[0], before[0], '앞선 메시지는 같은 객체 참조여야 memo가 bailout한다');
  assert.equal(s.messages[1], before[1]);
  assert.notEqual(s.messages[2], before[2], '대상 블록만 새 객체');
  assert.equal(s.messages[2].text, '안녕');
});

test('열려 있는 블록이 없으면(uid 불일치) 세션 객체를 그대로 돌려준다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'user', message: { role: 'user', content: '질문' } });
  // content_block_stop은 streaming.blocks에 uid가 없으면 아무것도 하지 않는다.
  const before = s;
  const after = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 7 },
  });
  assert.equal(after, before, '변화가 없으면 같은 세션 참조(불필요한 리렌더 방지)');
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
  // 카드와 상태줄이 같은 숫자를 말해야 한다 — 완료 카드로 전환하는 running 분기도
  // usage를 함께 갱신한다(usage 계보 전반은 reduce-usage.test.js 담당).
  assert.equal(s.usage.contextTokens, 3171, '카드의 postTokens = 상태줄 CTX');
  assert.equal(s.usage.ctxDisplayable, true);
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

// ----- live wire의 압축 요약/주입 메시지 (실 CLI 실측: 플래그 집합이 트랜스크립트와 다름) -----

test('live 압축 요약(isSynthetic, isCompactSummary 없음)도 요약 카드가 된다 — 거대 사용자 버블 방지', () => {
  // 실측 wire: { isReplay:false, isSynthetic:true } + 고정 본문 접두, isCompactSummary 없음
  const s = reduceCliEvent(
    createSessionState(),
    userEvent(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers…',
      { isReplay: false, isSynthetic: true },
    ),
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].kind, 'compaction-summary');
});

test('isSynthetic user 이벤트(주입 넛지)는 렌더되지 않는다', () => {
  // 실측 wire: "[Your previous response had no visible output. …]" — isSynthetic:true
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('[Your previous response had no visible output. Please continue and produce a user-visible response.]', {
      isSynthetic: true,
    }),
  );
  assert.equal(s.messages.length, 0);
});

test('isMeta user 이벤트(트랜스크립트 프리로드의 훅 피드백/캐빗)는 렌더되지 않는다', () => {
  let s = reduceCliEvent(
    createSessionState(),
    userEvent('Stop hook feedback:\nA Stop hook detected that…', { isMeta: true }),
  );
  s = reduceCliEvent(
    s,
    userEvent([{ type: 'text', text: 'Continue from where you left off.' }], { isMeta: true }),
  );
  assert.equal(s.messages.length, 0);
});

test('플래그 없는 훅 피드백/캐빗도 본문 패턴으로 숨긴다 (플래그 누락 경로 폴백)', () => {
  let s = reduceCliEvent(createSessionState(), userEvent('Stop hook feedback:\n지시문…'));
  s = reduceCliEvent(
    s,
    userEvent('<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>'),
  );
  assert.equal(s.messages.length, 0);
});

test('사용자가 직접 친 프롬프트(text 블록 배열, 플래그 없음)는 접두사가 겹쳐도 억제되지 않는다', () => {
  // 컴포저의 낙관 렌더/서버 전송 형식 — 우연히 주입 메시지와 같은 접두사로 시작해도
  // 진짜 발화는 그대로 렌더돼야 한다(패턴 폴백은 문자열 본문에만 적용 — codex 지적).
  let s = reduceCliEvent(
    createSessionState(),
    userEvent([{ type: 'text', text: 'Stop hook feedback: 이란 무엇인가요?' }]),
  );
  s = reduceCliEvent(
    s,
    userEvent([{ type: 'text', text: 'This session is being continued from a previous conversation 문구를 설명해줘' }]),
  );
  assert.equal(s.messages.length, 2);
  assert.ok(s.messages.every((m) => m.kind === 'user-text'));
});

test('caveat 블록이 감싼 커맨드 에코는 억제되지 않고 커맨드 칩이 된다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent(
      '<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>\n<command-name>/help</command-name>\n<command-args></command-args>',
    ),
  );
  const chips = s.messages.filter((m) => m.kind === 'command');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].name, 'help');
});

test('isMeta여도 tool_result는 정상 부착된다 (억제는 텍스트 본문에 한정)', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  });
  s = reduceCliEvent(
    s,
    userEvent([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { isMeta: true }),
  );
  const tool = s.messages.find((m) => m.kind === 'tool_use');
  assert.ok(tool && tool.result, 'tool_result가 부착된다');
});

test('compact_boundary의 snake_case compact_metadata(live wire)도 완료 카드 메타가 된다', () => {
  let s = reduceCliEvent(createSessionState(), { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 43629, post_tokens: 1262, duration_ms: 23326 },
  });
  const card = s.messages.find((m) => m.kind === 'compaction');
  assert.equal(card.state, 'done');
  assert.equal(card.preTokens, 43629);
  assert.equal(card.postTokens, 1262);
  assert.equal(card.durationMs, 23326);
});

test('ANSI 이스케이프가 붙은 "Compacted…" stdout(TUI 기록 세션)도 압축 카드로 흡수된다', () => {
  // 실측(구 TUI 트랜스크립트): "\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m\n\x1b[2mPreCompact [node …] completed successfully: {…}\x1b[22m"
  const raw = '\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n\u001b[2mPreCompact [node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs] completed successfully: {"continue":true}\u001b[22m';
  const s = reduceCliEvent(
    createSessionState(),
    userEvent(`<local-command-stdout>${raw}</local-command-stdout>`),
  );
  assert.equal(s.messages.filter((m) => m.kind === 'command-output').length, 0, '훅 스팸 출력 없음');
  const card = s.messages.find((m) => m.kind === 'compaction');
  assert.ok(card && card.state === 'done');
});

test('일반 커맨드 출력의 ANSI 이스케이프는 벗겨져 렌더된다', () => {
  const s = reduceCliEvent(
    createSessionState(),
    userEvent('<local-command-stdout>\u001b[2mdim text\u001b[22m</local-command-stdout>'),
  );
  assert.equal(s.messages[0].kind, 'command-output');
  assert.equal(s.messages[0].text, 'dim text');
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

// ----- /clear 직후 모델 유지 (실 CLI v2.1.220 실측, 2026-07-30) -----
// /clear는 정상 모델을 담은 system/init을 먼저 보내고, 곧바로 model='<synthetic>'인
// 더미 assistant("(no content)")를 보낸다. 그 센티널을 모델로 수확하면 피커가
// 미선택으로 풀리고 contextWindow까지 리셋된다 — 실브라우저에서 pill이 '<synthetic>'이
// 되고 메뉴 전 항목 aria-checked=false가 되는 회귀를 이 테스트가 잡는다.
test('/clear 직후의 <synthetic> assistant는 모델·컨텍스트 창을 오염시키지 않는다', () => {
  let s = createSessionState({ key: 'k', model: 'opus[1m]', spawnModel: 'opus[1m]' });
  // 첫 result가 보고한 창 크기가 이미 있는 상태를 재현
  s = { ...s, contextWindow: 1_000_000 };

  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'init',
    session_id: 'new-fork-id',
    model: 'claude-opus-5[1m]',
  });
  assert.equal(s.sessionId, 'new-fork-id');
  assert.equal(s.model, 'claude-opus-5[1m]', 'init이 보고한 정상 모델을 채택');

  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'msg_synth',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: '(no content)' }],
    },
  });
  assert.equal(s.model, 'claude-opus-5[1m]', '<synthetic>은 수확하지 않는다');
  assert.equal(s.contextWindow, 1_000_000, '창 크기도 리셋되지 않는다');
  assert.equal(
    s.messages.filter((m) => m.kind === 'assistant-text').length,
    0,
    "'(no content)' 더미는 빈 말풍선으로 렌더되지 않는다",
  );

  // 실측 result(모델 미호출이라 usage 전부 0, modelUsage {})까지 이어 붙인다 —
  // reduceResult의 modelUsage 선택 경로가 창 크기를 되돌리지 않는지 함께 본다.
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 0,
    duration_ms: 671,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
    modelUsage: {},
    session_id: 'new-fork-id',
  });
  assert.equal(s.model, 'claude-opus-5[1m]', 'result 이후에도 모델 유지');
  assert.equal(s.contextWindow, 1_000_000, 'result 이후에도 창 크기 유지');
  assert.equal(s.status, 'idle', '턴이 닫힌다');
});

test('모델이 아직 없는 세션도 <synthetic>으로는 채워지지 않는다', () => {
  let s = createSessionState({ key: 'k' });
  assert.equal(s.model, null);
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: '(no content)' }] },
  });
  assert.equal(s.model, null, '센티널로 첫 모델을 채우지 않는다');
});

// 억제는 '<synthetic>+(no content)' 조합에 한정 — 센티널이 실제 안내 문구를 담고
// 오면(로그인 요구 등) 그건 사용자가 봐야 하므로 렌더된다.
test('<synthetic>이라도 실제 본문이 있으면 렌더된다 (모델만 수확 배제)', () => {
  let s = createSessionState({ key: 'k', model: 'claude-opus-5[1m]' });
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'm1',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'Please run /login to authenticate.' }],
    },
  });
  const texts = s.messages.filter((m) => m.kind === 'assistant-text');
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /\/login/);
  assert.equal(s.model, 'claude-opus-5[1m]', '본문이 있어도 센티널 모델은 수확하지 않는다');
});

test('진짜 모델 전환은 여전히 반영되고 창 크기를 리셋한다', () => {
  let s = createSessionState({ key: 'k', model: 'claude-opus-5[1m]' });
  s = { ...s, contextWindow: 1_000_000 };
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.contextWindow, null, '이전 모델의 창 크기는 무효');
});

// ----- 메시지 시각(at) 스탬프 -----
// 핵심은 스트리밍 확정 경로다: content_block_start에는 timestamp가 없고, 실제 시각을
// 실은 assistant 확정 이벤트는 append가 아니라 기존 항목 갱신으로 들어온다.
// append 한 곳만 고치면 스트리밍 답변은 영원히 "수신 시작 시각"으로 남는다.

const FIXED_NOW = Date.UTC(2026, 6, 30, 1, 2, 3);
const ISO = (ms) => new Date(ms).toISOString();

test('at — 스트리밍 답변은 확정 assistant의 실제 timestamp로 갱신된다', () => {
  const realAt = Date.UTC(2026, 6, 30, 5, 30, 0);
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm1' } },
  }, FIXED_NOW);
  s = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  }, FIXED_NOW);
  const started = s.messages.at(-1);
  assert.equal(started.at, FIXED_NOW, 'timestamp가 없는 이벤트는 주입 시계로 잠정 표기');

  s = reduceCliEvent(s, {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안녕' } },
  }, FIXED_NOW);

  s = reduceCliEvent(s, {
    type: 'assistant',
    timestamp: ISO(realAt),
    message: { id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'text', text: '안녕' }] },
  }, FIXED_NOW);

  const texts = s.messages.filter((m) => m.kind === 'assistant-text');
  assert.equal(texts.length, 1, '확정은 새 항목이 아니라 기존 항목 갱신이어야 한다');
  assert.equal(texts[0].at, realAt, '잠정 시각이 실제 시각으로 덮여야 한다');
  assert.equal(texts[0].text, '안녕');
});

test('at — 재개(프리로드) 경로는 stream_event 없이 assistant만 와도 시각이 산다', () => {
  // loadTranscript는 stream_event를 제외하므로 confirmBlock의 append 분기를 탄다.
  const realAt = Date.UTC(2026, 6, 29, 22, 15, 0);
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    timestamp: ISO(realAt),
    message: { id: 'm9', model: 'claude-opus-4-8', content: [{ type: 'text', text: '과거 답변' }] },
  }, FIXED_NOW);
  const text = s.messages.find((m) => m.kind === 'assistant-text');
  assert.equal(text.at, realAt);
});

test('at — timestamp가 없는 이벤트는 주입 시계를 쓴다 (Date.now 비의존)', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm2', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'x' }] },
  }, FIXED_NOW);
  assert.equal(s.messages.find((m) => m.kind === 'assistant-text').at, FIXED_NOW);
});

test('at — 사용자 메시지에도 찍힌다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'user',
    message: { role: 'user', content: '사용자 질문' },
  }, FIXED_NOW);
  const u = s.messages.find((m) => m.kind === 'user-text');
  assert.ok(u, 'user-text 항목이 있어야 한다');
  assert.equal(u.at, FIXED_NOW);
});

test('at — 깨진 timestamp는 주입 시계로 폴백한다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    timestamp: 'not-a-date',
    message: { id: 'm3', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'y' }] },
  }, FIXED_NOW);
  assert.equal(s.messages.find((m) => m.kind === 'assistant-text').at, FIXED_NOW);
});

test('session_id 채택: 재개 프리로드의 원본 id는 CLI가 알려 준 fork id로 확정된다', () => {
  // 재개 세션은 트랜스크립트에서 복원한 원본 id로 시작한다(idConfirmed=false).
  const seeded = createSessionState({ sessionId: 'src-id', resumeSourceId: 'src-id' });
  // init이 fork된 새 id를 알려 주면 그 값으로 확정된다.
  const afterInit = reduceCliEvent(seeded, { type: 'system', subtype: 'init', session_id: 'fork-id' });
  assert.equal(afterInit.sessionId, 'fork-id');
  assert.equal(afterInit.idConfirmed, true);

  // init을 놓쳐도 다른 이벤트의 session_id가 같은 일을 한다(이름 영속이 보류에 머물지 않게).
  const viaEvent = reduceCliEvent(seeded, {
    type: 'assistant',
    session_id: 'fork-id',
    message: { content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(viaEvent.sessionId, 'fork-id');
  assert.equal(viaEvent.idConfirmed, true);

  // 이미 확정된 뒤에는 다른 이벤트가 id를 흔들지 못한다.
  const later = reduceCliEvent(afterInit, {
    type: 'assistant',
    session_id: '엉뚱한-id',
    message: { content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(later.sessionId, 'fork-id');

  // 신규 세션(시딩 없음)도 첫 이벤트에서 채택·확정된다.
  const fresh = reduceCliEvent(createSessionState(), { type: 'system', subtype: 'init', session_id: 'new-id' });
  assert.equal(fresh.sessionId, 'new-id');
  assert.equal(fresh.idConfirmed, true);
});

// ----- 모델 전환 확정 대기(modelSwitch) — "바꿔도 적용 안 되고, 입력 없이 바뀐다"의 수정 -----
// 근거: 실 CLI v2.1.235 stream-json 제어 채널 실측. set_model은 진행 중 턴에서도 약
// 170ms에 success를 주지만, 전환은 **다음 API 호출**부터 걸리므로 이미 시작된 호출의
// assistant 이벤트는 이전 모델을 계속 보고한다. 설계 근거:
// .certify/design/2026-08-23-model-effort-change-desync.html
const assistantWithModel = (session, model, extra = {}) =>
  reduceCliEvent(session, {
    type: 'assistant',
    message: { id: 'msg_x', role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] },
    ...extra,
  });

test('전환 대기 중에는 구모델 assistant 보고가 사용자의 선택을 되돌리지 못한다', () => {
  // modelSet(=CLI 수용)이 표적을 걸어 둔 직후의 상태
  const seeded = createSessionState({
    model: 'sonnet',
    modelSwitch: { target: 'sonnet' },
    contextWindow: null,
  });
  // 진행 중 턴의 잔류 보고 — 예전에는 이 한 줄이 피커를 opus로 되돌렸다
  const stale = assistantWithModel(seeded, 'claude-opus-5');
  assert.equal(stale.model, 'sonnet');
  assert.deepEqual(stale.modelSwitch, { target: 'sonnet' });

  // 표적 계열의 보고가 오면 채택하고 대기를 푼다 — 표시는 CLI가 해석한 실제 id로 정밀해진다
  const arrived = assistantWithModel(stale, 'claude-sonnet-5');
  assert.equal(arrived.model, 'claude-sonnet-5');
  assert.equal(arrived.modelSwitch, null);

  // 대기가 풀린 뒤에는 종전 규칙 그대로 — 대역외 전환(채팅 /model)은 다시 수확된다
  const outOfBand = assistantWithModel(arrived, 'claude-opus-5');
  assert.equal(outOfBand.model, 'claude-opus-5');
});

test('전환 대기는 표적 보고가 끝내 안 와도 다음 result가 반드시 푼다(고착 방지)', () => {
  const seeded = createSessionState({ model: 'fable', modelSwitch: { target: 'fable' } });
  // CLI가 조용히 다른 모델로 대체한 경우 — 표적 보고는 영영 오지 않는다
  const stale = assistantWithModel(seeded, 'claude-sonnet-5');
  assert.equal(stale.model, 'fable', '턴 도중에는 아직 표적을 기다린다');

  const ended = reduceCliEvent(stale, { type: 'result', subtype: 'success', usage: {} });
  assert.equal(ended.modelSwitch, null);

  // 다음 턴부터는 실제값이 그대로 표시된다 — 거짓말을 고집하지 않는다
  const next = assistantWithModel(ended, 'claude-sonnet-5');
  assert.equal(next.model, 'claude-sonnet-5');
});

test('CLI 히스토리 되쏘기(result isReplay)는 턴 경계가 아니라 대기를 풀지 않는다', () => {
  const seeded = createSessionState({ model: 'sonnet', modelSwitch: { target: 'sonnet' } });
  const replayed = reduceCliEvent(seeded, {
    type: 'result', subtype: 'success', usage: {}, isReplay: true,
  });
  assert.deepEqual(replayed.modelSwitch, { target: 'sonnet' });
});

test('전환 대기 중 늦게 도착한 구모델 init도 선택을 되돌리지 못한다', () => {
  const seeded = createSessionState({ model: 'sonnet', modelSwitch: { target: 'sonnet' } });
  // 전환 이전에 시작된 턴의 init — 부속 필드(cwd·session_id)는 그대로 받아들인다
  const stale = reduceCliEvent(seeded, {
    type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-opus-5[1m]', cwd: '/w',
  });
  assert.equal(stale.model, 'sonnet');
  assert.equal(stale.sessionId, 'sid');
  assert.equal(stale.cwd, '/w');
  assert.deepEqual(stale.modelSwitch, { target: 'sonnet' });

  // 표적 계열 init은 채택하고 대기를 푼다 — init은 [1m] 접미사까지 보존된 가장 정밀한 출처다
  const arrived = reduceCliEvent(stale, {
    type: 'system', subtype: 'init', model: 'claude-sonnet-5',
  });
  assert.equal(arrived.model, 'claude-sonnet-5');
  assert.equal(arrived.modelSwitch, null);
});

test('대기가 없으면 init은 종전대로 무조건 채택된다([1m] 접미사 보존)', () => {
  const seeded = createSessionState({ model: 'claude-opus-5' });
  const after = reduceCliEvent(seeded, {
    type: 'system', subtype: 'init', model: 'claude-opus-5[1m]',
  });
  assert.equal(after.model, 'claude-opus-5[1m]', 'init이 더 정밀한 출처 — base가 같아도 덮어쓴다');
});

test('전환 표적 판정은 카탈로그 계열로 하고, 계열 밖 모델은 정규화 base 정확비교로만 맞춘다', () => {
  // 표적은 카탈로그 value('opus'), 보고는 해석된 id — 문자열로는 절대 같지 않다
  const byFamily = createSessionState({ model: 'opus', modelSwitch: { target: 'opus' } });
  assert.equal(assistantWithModel(byFamily, 'claude-opus-5[1m]').model, 'claude-opus-5[1m]');

  // 카탈로그에 없는 사내 별칭 — 부분 일치로 오인하지 않고 정확비교만 통과시킨다
  const custom = createSessionState({ model: 'acme-x', modelSwitch: { target: 'acme-x' } });
  assert.equal(assistantWithModel(custom, 'acme-x-mini').model, 'acme-x', '유사 이름은 표적이 아니다');
  assert.equal(assistantWithModel(custom, 'acme-x').modelSwitch, null, '정확히 같으면 확정');
});

test('서브에이전트 assistant는 전환 대기와 무관하게 본선 모델을 건드리지 않는다', () => {
  const seeded = createSessionState({ model: 'sonnet', modelSwitch: { target: 'sonnet' } });
  const sub = assistantWithModel(seeded, 'claude-haiku-4-5', { parent_tool_use_id: 'tu_1' });
  assert.equal(sub.model, 'sonnet');
  assert.deepEqual(sub.modelSwitch, { target: 'sonnet' });
});

test('전환 대기 중 구모델 result의 컨텍스트 창은 새 모델에 붙지 않는다(CTX 분모 오염 방지)', () => {
  // Opus 1M → Sonnet 전환 직후, 아직 Opus로 돌던 턴이 끝난다.
  const seeded = createSessionState({
    model: 'sonnet',
    modelSwitch: { target: 'sonnet' },
    contextWindow: null,
  });
  const staleResult = reduceCliEvent(seeded, {
    type: 'result',
    subtype: 'success',
    usage: {},
    modelUsage: { 'claude-opus-5[1m]': { contextWindow: 1_000_000 } },
  });
  // 1M 분모가 200k짜리 세션에 붙으면 사용률이 1/5로 축소 표시된다 — 건너뛰는 게 맞다.
  assert.equal(staleResult.contextWindow, null);
  assert.equal(staleResult.modelSwitch, null, '대기 자체는 턴 경계에서 풀린다');

  // 표적과 맞는 항목이면 대기 중이라도 그대로 채택한다(전환이 같은 턴에 걸린 경우).
  const matched = reduceCliEvent(seeded, {
    type: 'result',
    subtype: 'success',
    usage: {},
    modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000 } },
  });
  assert.equal(matched.contextWindow, 200_000);
});
