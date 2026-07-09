// reduce-cli-event 사용량 집계 테스트 — result usage → 세션 usage/contextTokens.
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

test('rate_limit_event is stored on the session', () => {
  let s = baseSession();
  s = reduceCliEvent(s, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', resetsAt: 1234567890 },
  });
  assert.equal(s.rateLimit.status, 'allowed_warning');
  assert.equal(s.rateLimit.resetsAt, 1234567890);
});
