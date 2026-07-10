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
    usage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 0 },
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
