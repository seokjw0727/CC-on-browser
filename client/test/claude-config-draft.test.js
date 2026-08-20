// 설정 draft가 쓰는 순수 규칙(claude-config-io.js)의 단위 테스트.
// 훅(useClaudeConfigDraft) 자체는 DOM 없이 호출할 수 없어 여기서 다루지 않는다 —
// 훅 파일은 api.js → store.jsx(.jsx)를 끌어와 node --test로 로드조차 되지 않는다.
// 그래서 이 규칙들이 별도 모듈에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVED_NOTICE,
  jsonSyntaxIssue,
  normalizeConfigResponse,
  normalizePluginList,
  saveFailure,
} from '../src/lib/claude-config-io.js';

test('normalizeConfigResponse — 응답을 그대로 통과시킨다', () => {
  assert.deepEqual(
    normalizeConfigResponse({ path: '/p/settings.json', content: '{"a":1}', mtimeMs: 5 }),
    { path: '/p/settings.json', text: '{"a":1}', mtimeMs: 5 },
  );
});

test('normalizeConfigResponse — 빠진 값은 안전한 기준선으로', () => {
  assert.deepEqual(normalizeConfigResponse({}), { path: '', text: '{}', mtimeMs: null });
  assert.deepEqual(normalizeConfigResponse(undefined), { path: '', text: '{}', mtimeMs: null });
});

test('normalizeConfigResponse — 빈 파일은 빈 문자열 그대로 둔다', () => {
  // ??와 ||의 차이. 빈 파일이라는 **사실**을 폼이 '{}'로 조용히 지어내면 안 된다.
  assert.equal(normalizeConfigResponse({ content: '' }).text, '');
});

test('normalizePluginList — 배열이 아니면 빈 목록', () => {
  assert.deepEqual(normalizePluginList({ plugins: [{ key: 'a' }] }), [{ key: 'a' }]);
  for (const bad of [{}, { plugins: null }, { plugins: {} }, { plugins: 'x' }, undefined]) {
    assert.deepEqual(normalizePluginList(bad), [], JSON.stringify(bad));
  }
});

test('jsonSyntaxIssue — 문법만 본다 (최상위 객체 여부는 보지 않는다)', () => {
  assert.equal(jsonSyntaxIssue('{"a":1}'), null);
  assert.match(jsonSyntaxIssue('{ oops'), /^JSON 문법 오류: /);
  assert.match(jsonSyntaxIssue(''), /^JSON 문법 오류: /);
  // 저장 검증은 폼(formReady)보다 느슨하다 — 그 차이 자체를 계약으로 고정한다.
  assert.equal(jsonSyntaxIssue('[1,2]'), null);
  assert.equal(jsonSyntaxIssue('null'), null);
});

test('saveFailure — 409만 "덮어쓰지 않았다"를 따로 알린다', () => {
  const c = saveFailure({ status: 409, message: 'conflict' });
  assert.equal(c.conflict, true);
  assert.match(c.message, /덮어쓰지 않았습니다/);
  const other = saveFailure({ status: 400, message: 'bad json' });
  assert.deepEqual(other, { conflict: false, message: 'bad json' });
});

test('saveFailure — message가 없는 값도 문자열로 만든다', () => {
  assert.deepEqual(saveFailure('boom'), { conflict: false, message: 'boom' });
  assert.equal(saveFailure(undefined).conflict, false);
});

test('저장 성공 문구를 고정한다 (e2e가 이 문자열로 저장 완료를 기다린다)', () => {
  assert.equal(SAVED_NOTICE, 'Claude Code 설정을 저장했습니다. 이후 시작되는 세션부터 적용됩니다.');
});
