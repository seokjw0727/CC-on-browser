// model-catalog 회귀 테스트 — 모델 피커의 카탈로그 우선/fallback 규칙.
// 카탈로그 형상: 4.8 항목은 2026-07-11 실측, opus-5 항목은 CLI 갱신 후 가정 형상
// (fable-5 실측처럼 [1m] 마커가 유지된다고 가정 — 설계도 §3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_FAMILIES, parseVersion, familyOf, buildModelOptions } from '../src/lib/model-catalog.js';

const opusOf = (options) => options.find((o) => o.family === 'opus');

test('빈 카탈로그 → opus는 fallback value/version (Opus 5)', () => {
  const opus = opusOf(buildModelOptions([]));
  assert.equal(opus.value, 'opus');
  assert.equal(opus.version, '5');
  assert.equal(opus.cliEntry, null);
});

test('카탈로그가 claude-opus-5를 보고하면 version 5 (가정 형상)', () => {
  const opus = opusOf(buildModelOptions([
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus' },
  ]));
  assert.equal(opus.value, 'opus[1m]');
  assert.equal(opus.version, '5');
});

test('구 CLI 카탈로그(claude-opus-4-8)는 fallback에 가려지지 않고 4.8 표시', () => {
  // 실측 형상(2026-07-11): 카탈로그 우선 — fallbackVersion '5'가 덮어쓰면 안 된다.
  const opus = opusOf(buildModelOptions([
    { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus' },
  ]));
  assert.equal(opus.value, 'opus[1m]');
  assert.equal(opus.version, '4.8');
});

test('default 항목만 있는 카탈로그 → 매칭 제외라 fallback으로 감', () => {
  // buildModelOptions는 value !== 'default' 항목만 패밀리 매칭 대상으로 삼는다.
  const opus = opusOf(buildModelOptions([
    { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (Opus)' },
  ]));
  assert.equal(opus.value, 'opus');
  assert.equal(opus.version, '5');
});

test('parseVersion — 단일/이중 버전·접미사·비정형 입력', () => {
  assert.equal(parseVersion('claude-opus-5'), '5');
  assert.equal(parseVersion('claude-opus-5[1m]'), '5');
  assert.equal(parseVersion('claude-opus-4-8'), '4.8');
  assert.equal(parseVersion('claude-haiku-4-5-20251001'), '4.5');
  assert.equal(parseVersion('opus'), null);
  assert.equal(parseVersion(null), null);
});

test('familyOf — 해석 id/별칭 양쪽에서 패밀리를 찾는다', () => {
  assert.equal(familyOf('claude-opus-5').family, 'opus');
  assert.equal(familyOf('opus[1m]').family, 'opus');
  assert.equal(familyOf('unknown-model'), null);
  assert.equal(MODEL_FAMILIES.some((f) => f.family === 'opus' && f.fallbackVersion === '5'), true);
});
