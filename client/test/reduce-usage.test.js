// reduce-cli-event 사용량 집계 테스트 — 토큰 누적(result)과 컨텍스트 크기 추적.
// 컨텍스트(CTX%)는 assistant 이벤트의 호출별 usage가 권위이고, result.usage는
// 턴 내 전 호출 합산이라 폴백(호출별 usage가 없는 fake-cli 등)으로만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';

function baseSession() {
  return {
    key: 'k1',
    cwd: null,
    sessionId: null,
    model: null,
    permissionMode: 'default',
    messages: [],
    streaming: { msgId: null, blocks: {} },
    pendingPermissions: [],
    // ctxDisplayable을 명시해 둔다 — 빼면 hasDisplayableCtx의 구 형상 폴백에 가려져
    // "기록 지점이 플래그를 안 세운다"는 회귀가 이 파일에서 보이지 않는다(codex 지적).
    usage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 0, ctxDisplayable: false },
    ctxFromCalls: false, // 실제 createSessionState 형상과 맞춘다(빠져 있으면 undefined)
    rateLimit: null,
    status: 'idle',
    lastSeq: 0,
  };
}

const result = (usage, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage,
  ...extra,
});

test('result usage accumulates tokens and captures context incl. cache', () => {
  let s = baseSession();
  s = reduceCliEvent(
    s,
    result(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
      { total_cost_usd: 0.5 },
    ),
  );
  assert.equal(s.usage.inTok, 100);
  assert.equal(s.usage.outTok, 50);
  assert.equal(s.usage.cost, 0.5);
  assert.equal(s.usage.contextTokens, 1300);

  // 다음 턴의 usage가 오면 컨텍스트는 마지막 턴 기준으로 교체된다
  s = reduceCliEvent(s, result({ input_tokens: 7, output_tokens: 3 }));
  assert.equal(s.usage.inTok, 107);
  assert.equal(s.usage.outTok, 53);
  assert.equal(s.usage.contextTokens, 7);
});

test('result without usage keeps previous contextTokens', () => {
  let s = baseSession();
  s = reduceCliEvent(s, result({ input_tokens: 10, cache_read_input_tokens: 90 }));
  assert.equal(s.usage.contextTokens, 100);
  s = reduceCliEvent(s, result(undefined));
  assert.equal(s.usage.contextTokens, 100);
  assert.equal(s.usage.inTok, 10);
});

const assistantEv = (usage, extra = {}) => ({
  type: 'assistant',
  message: {
    id: extra.msgId ?? 'msg_u1',
    role: 'assistant',
    content: [{ type: 'text', text: extra.text ?? '응답' }],
    usage,
  },
  ...extra,
});

test('컨텍스트는 assistant 호출별 usage의 마지막 값 — result 턴 합산으로 덮지 않는다', () => {
  // 실측 시나리오(2026-07-10): 9회 호출 턴에서 result 합산 489,886(=245%)이
  // 상태줄에 그대로 표시됨. 실제 컨텍스트는 마지막 호출 63,270(=31.6%).
  let s = baseSession();
  s = reduceCliEvent(
    s,
    assistantEv(
      { input_tokens: 6802, cache_creation_input_tokens: 5867, cache_read_input_tokens: 24113, output_tokens: 973 },
      { msgId: 'msg_c1', text: '1차' },
    ),
  );
  assert.equal(s.usage.contextTokens, 36782, '1차 호출의 입력+캐시');
  s = reduceCliEvent(
    s,
    assistantEv(
      { input_tokens: 2, cache_creation_input_tokens: 535, cache_read_input_tokens: 62733, output_tokens: 985 },
      { msgId: 'msg_c2', text: '2차' },
    ),
  );
  assert.equal(s.usage.contextTokens, 63270, '마지막 호출이 권위');

  // 턴 종료: result.usage는 전 호출 합산(인플레) — 컨텍스트는 유지, 토큰 누적만 반영
  s = reduceCliEvent(
    s,
    result({
      input_tokens: 7000,
      output_tokens: 1958,
      cache_read_input_tokens: 400000,
      cache_creation_input_tokens: 80000,
    }),
  );
  assert.equal(s.usage.contextTokens, 63270, '합산 usage로 덮어쓰지 않음');
  assert.equal(s.usage.inTok, 7000, '소모량 누적은 result 기준 유지');
});

test('서브에이전트 호출(parent_tool_use_id/isSidechain)의 usage는 컨텍스트에 반영하지 않는다', () => {
  let s = baseSession();
  s = reduceCliEvent(
    s,
    assistantEv(
      { input_tokens: 2, cache_read_input_tokens: 50000 },
      { parent_tool_use_id: 'toolu_task1', msgId: 'msg_sub', text: '서브' },
    ),
  );
  assert.equal(s.usage.contextTokens, 0, '라이브 서브에이전트 제외');
  s = reduceCliEvent(
    s,
    assistantEv(
      { input_tokens: 2, cache_read_input_tokens: 70000 },
      { isSidechain: true, msgId: 'msg_side', text: '사이드' },
    ),
  );
  assert.equal(s.usage.contextTokens, 0, '재개 트랜스크립트 사이드체인 제외');
});

test('호출별 usage가 없는 세션(fake-cli)은 result 폴백이 매 턴 갱신한다', () => {
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv(undefined, { msgId: 'msg_f1', text: 'fake' }));
  s = reduceCliEvent(s, result({ input_tokens: 10, output_tokens: 5 }));
  assert.equal(s.usage.contextTokens, 10, '폴백 채움');
  s = reduceCliEvent(s, result({ input_tokens: 25, output_tokens: 5 }));
  assert.equal(s.usage.contextTokens, 25, '다음 턴에도 폴백 갱신');
});

test('rate_limit_event is stored on the session', () => {
  let s = baseSession();
  s = reduceCliEvent(s, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', resetsAt: 1234567890 },
  });
  assert.equal(s.rateLimit.status, 'allowed_warning');
  assert.equal(s.rateLimit.resetsAt, 1234567890);
});

// ----- /clear · /compact 직후 CTX 즉시 반영 -----
// 둘 다 모델 호출이 없는 로컬 커맨드라 assistant/result가 오지 않는다 — 여기서
// 갱신하지 않으면 상태줄 CTX가 다음 실제 턴까지 명령 전 값으로 남는다.

const clearEcho = (extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: '<command-name>/clear</command-name><command-args></command-args>' },
  ...extra,
});

test('/clear: 낙관·에코 양쪽에서 CTX가 0으로 즉시 떨어진다 (ctxFromCalls는 불변)', () => {
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv({ input_tokens: 1000, cache_read_input_tokens: 50_000 }));
  assert.equal(s.usage.contextTokens, 51_000);
  assert.equal(s.usage.ctxDisplayable, true, 'assistant 기록도 표시 플래그를 세운다');
  assert.equal(s.ctxFromCalls, true);

  // 낙관 렌더(컴포저가 직접 전송)
  const opt = reduceCliEvent(s, clearEcho({ optimistic: true }));
  assert.equal(opt.usage.contextTokens, 0, '즉시 0');
  assert.equal(opt.usage.ctxDisplayable, true, '0이어도 링은 표시(0%)');
  assert.equal(opt.ctxFromCalls, true, 'clear는 출처 플래그를 건드리지 않는다');

  // 이어 도착한 CLI 에코 — 멱등
  const echoed = reduceCliEvent(opt, clearEcho());
  assert.equal(echoed.usage.contextTokens, 0);
  assert.equal(echoed.messages.filter((m) => m.kind === 'cleared').length, 1, '중복 구분선 없음');

  // 에코만 오는 경로(낙관 렌더가 없던 세션)
  const echoOnly = reduceCliEvent(s, clearEcho());
  assert.equal(echoOnly.usage.contextTokens, 0);
  assert.equal(echoOnly.usage.ctxDisplayable, true);
});

test('/clear: 아직 아무 값도 없던 세션에서도 링이 열린다 (플래그 false → true)', () => {
  // 위 테스트는 clear 전에 assistant가 이미 true로 만들어 놔서 플래그 회귀를 못 잡는다.
  // 여기서는 false에서 출발해 clear 하나만으로 true가 되는지를 본다.
  const s = baseSession();
  assert.equal(s.usage.ctxDisplayable, false);
  const cleared = reduceCliEvent(s, clearEcho({ optimistic: true }));
  assert.equal(cleared.usage.contextTokens, 0);
  assert.equal(cleared.usage.ctxDisplayable, true, 'clear가 표시를 연다');
});

test('result 폴백이 처음 0 아닌 값을 얻으면 링을 연다 (플래그 false → true)', () => {
  const s = baseSession();
  assert.equal(s.usage.ctxDisplayable, false);
  const done = reduceCliEvent(s, { type: 'result', subtype: 'success', usage: { input_tokens: 1234 } });
  assert.equal(done.usage.contextTokens, 1234);
  assert.equal(done.usage.ctxDisplayable, true);

  // 토큰 0 result는 숨긴 채로 둔다 — 아직 보여줄 값이 없다
  const empty = reduceCliEvent(baseSession(), { type: 'result', subtype: 'success', usage: {} });
  assert.equal(empty.usage.ctxDisplayable, false);
});

test('/clear: isReplay 에코는 커맨드 파싱 전에 걸러져 usage·messages를 통째로 보존한다', () => {
  // reduceUser가 isReplay를 먼저 반환한다 — 실제 CLI /clear 에코에 이 플래그가
  // 붙는지는 저장소에 증거가 없으므로, 세 계약을 모두 고정만 해 둔다.
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv({ input_tokens: 1000, cache_read_input_tokens: 50_000 }));
  const replayed = reduceCliEvent(s, clearEcho({ isReplay: true }));
  // sessionId 채택은 일어날 수 있으므로 세션 전체가 아니라 usage·messages만 비교한다
  assert.deepEqual(replayed.usage, s.usage, 'usage 전 필드 불변');
  assert.equal(replayed.messages.length, s.messages.length, '메시지도 추가되지 않는다');
  assert.equal(replayed.ctxFromCalls, s.ctxFromCalls);
});

test('/clear 후 턴 0 result는 0을 유지하고, ctxFromCalls=false 세션은 다음 실 턴이 정상 복구', () => {
  // ctxFromCalls=true(정상 세션): result 합산이 0을 못 덮는다
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv({ input_tokens: 1000, cache_read_input_tokens: 50_000 }));
  s = reduceCliEvent(s, clearEcho({ optimistic: true }));
  s = reduceCliEvent(s, { type: 'result', subtype: 'success', usage: {} });
  assert.equal(s.usage.contextTokens, 0);
  assert.equal(s.usage.ctxDisplayable, true, '토큰 0 result가 링을 도로 숨기지 않는다');

  // ctxFromCalls=false(호출별 usage를 못 받는 result-only 세션): 폴백이 살아 있어야 한다
  let r = reduceCliEvent(baseSession(), clearEcho({ optimistic: true }));
  assert.equal(r.usage.contextTokens, 0);
  assert.equal(r.ctxFromCalls, false, 'clear가 출처 플래그를 강제하지 않았다');
  r = reduceCliEvent(r, { type: 'result', subtype: 'success', usage: { input_tokens: 7000 } });
  assert.equal(r.usage.contextTokens, 7000, '다음 실제 턴이 폴백으로 정상 복구 — 0에 고착되지 않는다');
});

const boundary = (meta, snake = false) => ({
  type: 'system',
  subtype: 'compact_boundary',
  ...(snake ? { compact_metadata: meta } : { compactMetadata: meta }),
});

test('/compact: 경계 메타의 postTokens가 CTX에 즉시 반영된다 (camel/snake 양쪽)', () => {
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv({ input_tokens: 7000, cache_read_input_tokens: 110_013 }));
  assert.equal(s.usage.contextTokens, 117_013);
  s = reduceCliEvent(s, boundary({ trigger: 'manual', preTokens: 117_013, postTokens: 3171 }));
  assert.equal(s.usage.contextTokens, 3171, '카드에 보이는 숫자와 상태줄이 일치');
  assert.equal(s.usage.ctxDisplayable, true);
  assert.equal(s.ctxFromCalls, true, '직후 result 합산이 postTokens를 덮지 못하게');

  // live wire의 snake_case도 같은 경로
  let t = baseSession();
  t = reduceCliEvent(t, boundary({ pre_tokens: 43_629, post_tokens: 1262 }, true));
  assert.equal(t.usage.contextTokens, 1262);
});

test('/compact: stdout이 먼저 와 카드가 닫힌 뒤 경계가 와도(중복 보강 경로) 반영된다', () => {
  // finishCompaction의 recentDuplicate 분기 — 여기서 base를 안 쓰면 숫자가 새어나간다
  let s = baseSession();
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, {
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o)</local-command-stdout>' },
  });
  assert.equal(s.usage.contextTokens, 0, 'stdout 단독은 숫자가 없다');
  s = reduceCliEvent(s, boundary({ preTokens: 100, postTokens: 10 }));
  assert.equal(s.usage.contextTokens, 10, '뒤늦게 온 경계 메타가 반영');
  assert.equal(s.messages.filter((m) => m.kind === 'compaction').length, 1, '카드는 하나');
});

test('/compact: 자동 압축(trigger:auto)도, postTokens:0도 유효값으로 반영된다', () => {
  let s = reduceCliEvent(baseSession(), boundary({ trigger: 'auto', preTokens: 200, postTokens: 20 }));
  assert.equal(s.usage.contextTokens, 20);

  // 0은 "전부 압축됨"이라는 유효한 값 — 링은 0%로 남아야 한다
  let z = reduceCliEvent(baseSession(), boundary({ preTokens: 500, postTokens: 0 }));
  assert.equal(z.usage.contextTokens, 0);
  assert.equal(z.usage.ctxDisplayable, true);
  assert.equal(z.ctxFromCalls, true, '0도 권위 있는 값 — 이후 result 합산이 못 덮는다');
});

test('/compact: 경계가 먼저 오고 stdout이 뒤따라도 이미 쓴 CTX가 보존된다', () => {
  // boundary→stdout 순서. stdout은 메타가 없어 recentDuplicate로 조기 return하는데,
  // 그 분기가 base 대신 session을 쓰면 앞서 쓴 숫자가 되돌아간다.
  let s = reduceCliEvent(baseSession(), boundary({ preTokens: 100, postTokens: 10 }));
  assert.equal(s.usage.contextTokens, 10);
  s = reduceCliEvent(s, {
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o)</local-command-stdout>' },
  });
  assert.equal(s.usage.contextTokens, 10, '메타 없는 중복 신호가 값을 되돌리지 않는다');
  assert.equal(s.messages.filter((m) => m.kind === 'compaction').length, 1, '카드도 하나 유지');
});

test('/compact: 메타 없는 완료 신호·비정상 postTokens는 usage를 건드리지 않는다', () => {
  let s = baseSession();
  s = reduceCliEvent(s, assistantEv({ input_tokens: 40_000 }));
  assert.equal(s.usage.contextTokens, 40_000);

  // 메타 없는 경계(= "Compacted" stdout / result 안전망과 같은 경로)
  const noMeta = reduceCliEvent(s, { type: 'system', subtype: 'compact_boundary' });
  assert.equal(noMeta.usage.contextTokens, 40_000, '추측하지 않는다');

  // 음수·비유한은 usage 미반영 (카드 표시 규칙은 그대로)
  const neg = reduceCliEvent(s, boundary({ postTokens: -5 }));
  assert.equal(neg.usage.contextTokens, 40_000);
  const nan = reduceCliEvent(s, boundary({ postTokens: Number.NaN }));
  assert.equal(nan.usage.contextTokens, 40_000);
});

test('/compact 후: result 합산은 postTokens를 못 덮고, 다음 assistant 호출이 정상 대체', () => {
  let s = reduceCliEvent(baseSession(), boundary({ preTokens: 117_013, postTokens: 3171 }));
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 90_000, cache_read_input_tokens: 200_000 },
  });
  assert.equal(s.usage.contextTokens, 3171, '턴 합산 인플레가 압축값을 덮지 않는다');
  s = reduceCliEvent(s, assistantEv({ input_tokens: 500, cache_read_input_tokens: 4000 }));
  assert.equal(s.usage.contextTokens, 4500, '다음 실제 호출이 권위를 되찾는다');
});
