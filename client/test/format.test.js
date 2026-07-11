// 공용 표시 포매터(lib/format.js) 테스트 — 특히 컨텍스트 창 판별.
// '[1m]' 접미사가 실리는 자리는 보고 경로마다 다르다(실측 2026-07-11, opus[1m] 캡처):
// 카탈로그 value 'default'→resolvedModel에만 / value 'claude-fable-5[1m]'→해석 id에선
// 탈락 / init은 접미사 유지('claude-opus-4-8[1m]') / assistant는 탈락 bare id
// ('claude-opus-4-8'). 판별은 정확 일치 → base(접미사 제거) 일치 → 문자열 순.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextWindowFor, CONTEXT_WINDOW, CONTEXT_WINDOW_1M } from '../src/lib/format.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState, reducer, createInitialState } from '../src/lib/store-reducer.js';

// fake-cli.mjs initialize 응답의 models 미러(관심 행만) — 실 캡처(2026-07-11)와
// 완전 일치 확인됨: 픽스처가 곧 실측 계약
const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
];

test('contextWindowFor: 기본은 200k — 미상/표준 모델', () => {
  assert.equal(CONTEXT_WINDOW, 200_000);
  assert.equal(contextWindowFor(null), CONTEXT_WINDOW); // 카탈로그 없으면 200k
  assert.equal(contextWindowFor(undefined), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('claude-sonnet-4-5-20250929'), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('sonnet', CATALOG), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('claude-sonnet-5', CATALOG), CONTEXT_WINDOW);
});

test('contextWindowFor: 모델 미지정(null/"")은 카탈로그 default 항목으로 해석', () => {
  // "(기본 모델)" 시작 = CLI 기본 — 계정 기본이 [1m]이면 첫 init 전에도 1M이 맞다
  assert.equal(contextWindowFor(null, CATALOG), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowFor('', CATALOG), CONTEXT_WINDOW_1M);
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

test('contextWindowFor: assistant의 bare id는 base 일치로 1M (실측 형상)', () => {
  // 실측: assistant message.model = 'claude-opus-4-8' — 정확 일치 항목이 없어도
  // 접미사를 벗긴 base가 같은 후보(default·opus[1m])가 전부 [1m]이면 1M.
  assert.equal(contextWindowFor('claude-opus-4-8', CATALOG), CONTEXT_WINDOW_1M);
});

test('contextWindowFor: [1m]·비[1m] 변형 혼재 시 bare id는 보수적으로 200k', () => {
  const mixed = [
    { value: 'opus', resolvedModel: 'claude-opus-4-8' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]' },
  ];
  // 'claude-opus-4-8'은 두 변형 어느 쪽 세션인지 문자열만으론 알 수 없다 —
  // 분모 과대(1M 오판)보다 과소(200k)가 안전하다.
  assert.equal(contextWindowFor('claude-opus-4-8', mixed), CONTEXT_WINDOW);
  // 같은 해석 id를 공유하는 혼재도 순서 무관 보수 판정 — 카탈로그 순서 의존 금지
  const mixedShared = [
    { value: 'fable', resolvedModel: 'claude-fable-5' },
    { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5' },
  ];
  assert.equal(contextWindowFor('claude-fable-5', mixedShared), CONTEXT_WINDOW);
  assert.equal(contextWindowFor('claude-fable-5', [...mixedShared].reverse()), CONTEXT_WINDOW);
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
  // 재개 트랜스크립트엔 init이 없어 assistant.message.model이 유일한 모델 출처.
  // 실측 형상 그대로 bare id를 쓴다.
  let s = reduceCliEvent(createSessionState(), {
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 10 } },
  });
  assert.equal(s.model, 'claude-opus-4-8');
  assert.equal(contextWindowFor(s.model, CATALOG), CONTEXT_WINDOW_1M);
  // 서브에이전트(사이드체인) 모델은 본선 모델을 덮지 않는다
  s = reduceCliEvent(s, {
    type: 'assistant',
    isSidechain: true,
    message: { id: 'm2', model: 'claude-haiku-4-5', content: [] },
  });
  assert.equal(s.model, 'claude-opus-4-8');
  s = reduceCliEvent(s, {
    type: 'assistant',
    parent_tool_use_id: 'tu1',
    message: { id: 'm3', model: 'claude-haiku-4-5', content: [] },
  });
  assert.equal(s.model, 'claude-opus-4-8');
});

test('통합: 라이브 무강등 — 같은 base의 assistant bare id는 init의 [1m] id를 덮지 않는다', () => {
  // 실측(2026-07-11): init 'claude-opus-4-8[1m]' → assistant 'claude-opus-4-8'.
  // 무조건 덮어쓰면 첫 assistant에서 [1m] 정밀도를 잃는다 — base 동일 시 유지 검증.
  let s = reduceCliEvent(createSessionState(), {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-4-8[1m]',
  });
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 10 } },
  });
  assert.equal(s.model, 'claude-opus-4-8[1m]');
  assert.equal(contextWindowFor(s.model, CATALOG), CONTEXT_WINDOW_1M);
});

test('통합: result.modelUsage의 contextWindow가 1차 출처로 수확된다', () => {
  // 실측(2026-07-11): result.modelUsage['claude-opus-4-8[1m]'].contextWindow = 1000000
  let s = reduceCliEvent(createSessionState(), {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-4-8[1m]',
  });
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 2, output_tokens: 226 },
    modelUsage: {
      'claude-opus-4-8[1m]': { inputTokens: 2, outputTokens: 226, contextWindow: 1_000_000 },
    },
  });
  assert.equal(s.contextWindow, 1_000_000);
  // 세션 모델과 무관한 다중 키(서브에이전트 혼입)는 신뢰하지 않는다
  let t = reduceCliEvent(createSessionState({ model: 'claude-sonnet-5' }), {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    },
  });
  assert.equal(t.contextWindow, null);
  // 같은 base의 [1m]·비[1m] 키가 공존하면 정확 키가 이긴다 — 순서 무관(codex 지적)
  let u = reduceCliEvent(createSessionState({ model: 'claude-opus-4-8' }), {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
      'claude-opus-4-8': { contextWindow: 200_000 },
    },
  });
  assert.equal(u.contextWindow, 200_000);
});

test('통합: 대역외 모델 전환은 이전 result의 contextWindow도 리셋한다', () => {
  // 전환 후 다음 result 전까지는 카탈로그 휴리스틱으로 폴백해야 한다(codex 지적)
  let s = reduceCliEvent(createSessionState(), {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-4-8[1m]',
  });
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
  });
  assert.equal(s.contextWindow, 1_000_000);
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 1 } },
  });
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.contextWindow, null);
});

test('통합: 다른 base의 assistant 모델은 덮어쓴다 — 대역외 모델 전환 추적', () => {
  // 채팅 /model 입력·CLI측 폴백처럼 UI 피커를 거치지 않는 전환은 assistant의
  // 새 bare id가 유일한 신호 — base가 다르면 진짜 전환이므로 채택한다(DA #22).
  let s = reduceCliEvent(createSessionState(), {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-4-8[1m]',
  });
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: { id: 'm1', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 10 } },
  });
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(contextWindowFor(s.model, CATALOG), CONTEXT_WINDOW);
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
