// 공용 표시 포매터(lib/format.js) 테스트 — 특히 컨텍스트 창 판별.
// CLI의 '[1m]' 접미사는 실리는 필드가 일정하지 않다(fake-cli의 v2.1.205 initialize
// 캡처 미러 참조): value 'default'→resolvedModel에만, value 'claude-fable-5[1m]'→
// resolvedModel에선 탈락. 판별은 문자열+카탈로그 양쪽 필드를 모두 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextWindowFor, CONTEXT_WINDOW, CONTEXT_WINDOW_1M } from '../src/lib/format.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState, reducer, createInitialState } from '../src/lib/store-reducer.js';

// fake-cli.mjs initialize 응답의 models 미러(관심 행만) — 픽스처가 곧 실측 계약
const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
];

test('contextWindowFor: 기본은 200k — null/미상/표준 모델(카탈로그 유무 무관)', () => {
  assert.equal(CONTEXT_WINDOW, 200_000);
  assert.equal(contextWindowFor(null), CONTEXT_WINDOW);
  assert.equal(contextWindowFor(undefined), CONTEXT_WINDOW);
  assert.equal(contextWindowFor(''), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('claude-sonnet-4-5-20250929'), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('sonnet', CATALOG), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('claude-sonnet-5', CATALOG), CONTEXT_WINDOW);
});

test('contextWindowFor: 문자열 자체에 [1m] — 카탈로그 없이도 1M', () => {
  assert.equal(CONTEXT_WINDOW_1M, 1_000_000);
  assert.equal(contextWindowFor('sonnet[1m]'), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowFor('claude-sonnet-4-5-20250929[1m]'), CONTEXT_WINDOW_1M);
});

test('contextWindowFor: 별칭 해석 — value "default"의 resolvedModel이 [1m]이면 1M', () => {
  assert.equal(contextWindowFor('default', CATALOG), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowFor('opus[1m]', CATALOG), CONTEXT_WINDOW_1M);
});

test('contextWindowFor: 역방향 — [1m]이 탈락한 해석 id도 value 쪽 접미사로 1M', () => {
  // init/assistant가 'claude-fable-5'(접미사 탈락)를 보고해도 카탈로그의
  // value 'claude-fable-5[1m]' 매칭으로 1M 판별이 유지돼야 한다.
  assert.equal(contextWindowFor('claude-fable-5', CATALOG), CONTEXT_WINDOW_1M);
});

test('통합: system/init이 보고한 [1m] 모델이 컨텍스트 창 선택으로 이어진다', () => {
  // Composer의 계산 경로 그대로: init → session.model → contextWindowFor
  const s = reduceCliEvent(createSessionState(), {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-sonnet-4-5-20250929[1m]',
  });
  assert.equal(contextWindowFor(s.model, CATALOG), CONTEXT_WINDOW_1M);
});

test('통합: 본선 assistant의 message.model 수확 — 사이드체인은 제외', () => {
  // 재개 트랜스크립트엔 init이 없어 assistant.message.model이 유일한 모델 출처
  let s = reduceCliEvent(createSessionState(), {
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-4-8[1m]', content: [], usage: { input_tokens: 10 } },
  });
  assert.equal(s.model, 'claude-opus-4-8[1m]');
  assert.equal(contextWindowFor(s.model, CATALOG), CONTEXT_WINDOW_1M);
  // 서브에이전트(사이드체인) 모델은 본선 모델을 덮지 않는다
  s = reduceCliEvent(s, {
    type: 'assistant',
    isSidechain: true,
    message: { id: 'm2', model: 'claude-haiku-4-5', content: [] },
  });
  assert.equal(s.model, 'claude-opus-4-8[1m]');
  s = reduceCliEvent(s, {
    type: 'assistant',
    parent_tool_use_id: 'tu1',
    message: { id: 'm3', model: 'claude-haiku-4-5', content: [] },
  });
  assert.equal(s.model, 'claude-opus-4-8[1m]');
});

test('통합: 재개 preloadModel이 started 커밋에 시딩된다(표시 전용 이월)', () => {
  let st = createInitialState();
  st = reducer(st, {
    type: 'register-start',
    startId: 'c1',
    opts: { cwd: 'C:\\p', model: null, resumeSessionId: 'orig', preloadModel: 'claude-fable-5' },
  });
  st = reducer(st, {
    type: 'server-message',
    message: { type: 'started', startId: 'c1', key: 'k1' },
  });
  const sess = st.sessions.get('k1');
  assert.equal(sess.model, 'claude-fable-5');
  assert.equal(contextWindowFor(sess.model, CATALOG), CONTEXT_WINDOW_1M);
  // 스폰 계보는 표시용 preload와 분리 — 실제 --model 인자(null)만 남는다.
  // (해석 id를 재시작 스폰 인자로 재사용하면 구식·[1m] 탈락 위험 — codex 지적)
  assert.equal(sess.spawnModel, null);
});

test('통합: 명시 모델로 시작하면 spawnModel 계보가 남는다', () => {
  let st = createInitialState();
  st = reducer(st, {
    type: 'register-start',
    startId: 'c2',
    opts: { cwd: 'C:\\p', model: 'opus[1m]' },
  });
  st = reducer(st, {
    type: 'server-message',
    message: { type: 'started', startId: 'c2', key: 'k2' },
  });
  let sess = st.sessions.get('k2');
  assert.equal(sess.spawnModel, 'opus[1m]');
  // init이 model을 해석 id로 덮어써도 스폰 계보는 불변 — effort 재시작이 이 값을 쓴다
  st = reducer(st, {
    type: 'server-message',
    message: {
      type: 'event',
      key: 'k2',
      seq: 1,
      payload: { type: 'system', subtype: 'init', session_id: 's2', model: 'claude-opus-4-8[1m]' },
    },
  });
  sess = st.sessions.get('k2');
  assert.equal(sess.model, 'claude-opus-4-8[1m]');
  assert.equal(sess.spawnModel, 'opus[1m]');
});
