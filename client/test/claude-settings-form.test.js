// claude-settings-form.js — 원문 ↔ 폼 변환의 단위 테스트.
//
// 이 모듈이 지켜야 할 약속(설계도 §2·§3):
//  · 폼이 모르는 키는 값도 순서도 그대로 남는다
//  · 중첩 필드는 leaf만 바뀐다(형제 보존)
//  · UNSET ≠ false ≠ '' — 키 삭제와 값 설정은 다르다
//  · 경로 중간이 객체가 아니면 덮어쓰지 않고 blocked
//  · select는 모르는 값을 만나면 그 값을 옵션으로 보존한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_FIELDS,
  UNSET,
  UNSET_OPTION,
  formReady,
  optionsWithCurrent,
  parseSettings,
  patchEnvRows,
  patchField,
  pluginRows,
  readEnabledPlugins,
  readEnvRows,
  readField,
  removePluginEntry,
  serializeSettings,
  setPluginEnabled,
  unknownTopKeys,
  validateEnvRows,
} from '../src/lib/claude-settings-form.js';

const parse = (text) => JSON.parse(text);

test('parseSettings: 최상위 객체만 통과시킨다(서버 저장 조건과 같은 기준)', () => {
  assert.equal(parseSettings('{"a":1}').ok, true);
  // 빈 원문은 서버가 문법 오류로 거부한다 — 폼만 열어 주면 저장 못 하는 상태가 된다.
  assert.equal(parseSettings('').ok, false);
  assert.equal(parseSettings('{ "a": ').ok, false);
  assert.equal(parseSettings('[]').ok, false, '배열은 settings.json이 아니다');
  assert.equal(parseSettings('null').ok, false);
  assert.equal(parseSettings('"str"').ok, false);
  assert.equal(formReady('{"a":1}'), true);
  assert.equal(formReady('[1,2]'), false);
});

test('serializeSettings: 2-space 들여쓰기 + 끝 개행', () => {
  assert.equal(serializeSettings({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('readField: 없는 값은 undefined, 중간이 객체가 아니면 blocked', () => {
  const text = '{"permissions":{"defaultMode":"plan","allow":["Bash"]}}';
  assert.deepEqual(readField(text, ['permissions', 'defaultMode']), { ok: true, value: 'plan' });
  assert.deepEqual(readField(text, ['model']), { ok: true, value: undefined });
  assert.deepEqual(readField('{"permissions":"x"}', ['permissions', 'defaultMode']), {
    ok: false,
    reason: 'blocked',
  });
  assert.deepEqual(readField('{ oops', ['model']), { ok: false, reason: 'invalid' });
});

test('patchField: 미지 최상위 키와 중첩 형제를 모두 보존한다', () => {
  const text = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    permissions: { defaultMode: 'default', allow: ['Bash'], deny: [] },
    statusLine: { type: 'command', command: 'y' },
  });
  const res = patchField(text, ['permissions', 'defaultMode'], 'plan');
  assert.equal(res.ok, true);
  const out = parse(res.text);
  assert.equal(out.permissions.defaultMode, 'plan');
  assert.deepEqual(out.permissions.allow, ['Bash'], '형제 allow 보존');
  assert.deepEqual(out.permissions.deny, []);
  assert.deepEqual(out.hooks, parse(text).hooks, '폼이 모르는 hooks는 그대로');
  assert.deepEqual(out.statusLine, parse(text).statusLine);
  // 키 순서도 그대로다 — 남의 파일을 재배열하지 않는다.
  assert.deepEqual(Object.keys(out), ['hooks', 'permissions', 'statusLine']);
});

test('patchField(UNSET): leaf만 지우고 형제는 남긴다', () => {
  const text = '{"permissions":{"defaultMode":"plan","allow":["Bash"]},"model":"opus"}';
  const res = patchField(text, ['permissions', 'defaultMode'], UNSET);
  const out = parse(res.text);
  assert.equal('defaultMode' in out.permissions, false);
  assert.deepEqual(out.permissions.allow, ['Bash']);
  assert.equal(out.model, 'opus');
});

test('patchField(UNSET): 우리가 비운 빈 부모만 함께 지운다', () => {
  // permissions에 defaultMode뿐이었다면 껍데기를 남기지 않는다.
  const emptied = patchField('{"permissions":{"defaultMode":"plan"}}', ['permissions', 'defaultMode'], UNSET);
  assert.deepEqual(parse(emptied.text), {});
  // 원래부터 비어 있던 객체는 사용자 것이다 — 지울 leaf가 없으면 손대지 않는다.
  const untouched = patchField('{"permissions":{},"model":"opus"}', ['permissions', 'defaultMode'], UNSET);
  assert.deepEqual(parse(untouched.text), { permissions: {}, model: 'opus' });
  const other = patchField('{"permissions":{},"model":"opus"}', ['model'], UNSET);
  assert.deepEqual(parse(other.text), { permissions: {} });
});

test('patchField(UNSET): 바뀔 것이 없으면 원문을 그대로 돌려준다', () => {
  const text = '{"model":"opus"}';
  // 부모가 아예 없는 경우
  assert.equal(patchField(text, ['permissions', 'defaultMode'], UNSET).text, text);
  // 부모는 있으나 그 키가 없는 경우 — 무의미한 재포맷을 만들지 않는다.
  const withParent = '{"permissions":{"allow":[]}}';
  assert.equal(patchField(withParent, ['permissions', 'defaultMode'], UNSET).text, withParent);
});

test('patchField: 중간이 객체가 아니면 덮어쓰지 않고 blocked', () => {
  const res = patchField('{"permissions":"nope"}', ['permissions', 'defaultMode'], 'plan');
  assert.deepEqual(res, { ok: false, reason: 'blocked' });
  assert.deepEqual(patchField('{ oops', ['model'], 'x'), { ok: false, reason: 'invalid' });
});

test('patchField: false·빈 문자열은 UNSET과 다르다', () => {
  const off = patchField('{}', ['includeCoAuthoredBy'], false);
  assert.deepEqual(parse(off.text), { includeCoAuthoredBy: false });
  const empty = patchField('{}', ['model'], '');
  assert.deepEqual(parse(empty.text), { model: '' });
  const gone = patchField('{"model":"opus"}', ['model'], UNSET);
  assert.deepEqual(parse(gone.text), {});
});

test('patchField: 부모가 없으면 만들어 준다(중첩 신규 설정)', () => {
  const res = patchField('{"model":"opus"}', ['permissions', 'defaultMode'], 'acceptEdits');
  assert.deepEqual(parse(res.text), { model: 'opus', permissions: { defaultMode: 'acceptEdits' } });
});

test('연속 편집은 항상 최신 원문 위에서 이뤄진다(탭 왕복 시나리오)', () => {
  // JSON 탭에서 hooks를 넣고 → 폼에서 모델을 고치고 → JSON 탭에서 또 고치는 흐름.
  let text = '{"model":"opus"}';
  text = patchField(text, ['effortLevel'], 'high').text;
  text = `${JSON.stringify({ ...parse(text), hooks: { Stop: [] } }, null, 2)}\n`;
  text = patchField(text, ['model'], 'sonnet').text;
  assert.deepEqual(parse(text), { model: 'sonnet', effortLevel: 'high', hooks: { Stop: [] } });
});

test('optionsWithCurrent: 모르는 값은 옵션으로 보존한다(강제 치환 금지)', () => {
  const opts = [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }];
  assert.equal(optionsWithCurrent(opts, 'high').length, 2);
  const withUnknown = optionsWithCurrent(opts, 'xhigh');
  assert.equal(withUnknown.length, 3);
  assert.equal(withUnknown[2].value, 'xhigh');
  assert.equal(optionsWithCurrent(opts, undefined).length, 2, '없는 값 = 설정 안 함');
  // 빈 문자열도 실재하는 값이다 — "설정 안 함"으로 뭉개면 고르지도 않은 삭제가 된다.
  const withEmpty = optionsWithCurrent(opts, '');
  assert.equal(withEmpty.length, 3);
  assert.equal(withEmpty[2].value, '');
  // "(설정 안 함)"이 쓰는 값은 실제 값과 겹치지 않는다.
  assert.equal(opts.some((o) => o.value === UNSET_OPTION), false);
  assert.notEqual(UNSET_OPTION, '');
});

test('KNOWN_FIELDS: 스키마가 온전하다(UI가 이 표만 보고 그린다)', () => {
  for (const f of KNOWN_FIELDS) {
    assert.ok(f.id && f.label, `${f.id}: id·label 필요`);
    assert.ok(Array.isArray(f.path) && f.path.length > 0, `${f.id}: path 필요`);
    assert.ok(['text', 'select', 'boolean'].includes(f.kind), `${f.id}: 모르는 kind`);
    if (f.kind === 'select') assert.ok(f.options?.length, `${f.id}: select는 options 필요`);
  }
  const ids = KNOWN_FIELDS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'id 중복 없음');
});

test('unknownTopKeys: 폼이 다루지 않는 최상위 키만 알린다', () => {
  const text = JSON.stringify({
    model: 'opus',
    env: {},
    enabledPlugins: {},
    permissions: {},
    hooks: {},
    statusLine: {},
    extraKnownMarketplaces: {},
  });
  assert.deepEqual(unknownTopKeys(text), ['extraKnownMarketplaces', 'hooks', 'statusLine']);
  assert.deepEqual(unknownTopKeys('{ oops'), []);
});

test('env: 문자열 맵만 폼으로 다룬다', () => {
  assert.deepEqual(readEnvRows('{}'), { ok: true, rows: [] });
  assert.deepEqual(readEnvRows('{"env":{"A":"1","B":"2"}}'), {
    ok: true,
    rows: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
  });
  // 값이 문자열이 아니면 폼이 타입을 바꿔 버린다 — 다루지 않는다.
  assert.deepEqual(readEnvRows('{"env":{"A":1}}'), { ok: false, reason: 'blocked' });
  assert.deepEqual(readEnvRows('{"env":[]}'), { ok: false, reason: 'blocked' });
});

test('env 검증: 빈 키·중복 키·비문자열 값은 커밋할 수 없다', () => {
  assert.equal(validateEnvRows([{ key: 'A', value: '1' }]), null);
  assert.equal(validateEnvRows([{ key: 'A', value: '' }]), null, '빈 값은 정상이다');
  assert.match(validateEnvRows([{ key: '  ', value: '1' }]), /비어 있는/);
  assert.match(
    validateEnvRows([{ key: 'A', value: '1' }, { key: 'A', value: '2' }]),
    /중복/,
  );
  assert.match(validateEnvRows([{ key: 'A', value: 1 }]), /문자열/);
  // 공백 차이는 서로 다른 키다 — 중복으로 뭉뚱그리지 않는다.
  assert.equal(validateEnvRows([{ key: ' A', value: '1' }, { key: 'A', value: '2' }]), null);
});

test('env 반영: 이름을 그대로 보존하고, 행이 0개면 키를 지운다', () => {
  // 앞뒤 공백까지 사용자가 친 그대로 — 값만 고쳤는데 이름이 바뀌면 안 된다.
  const kept = patchEnvRows('{}', [{ key: ' A ', value: '1' }]);
  assert.deepEqual(Object.keys(parse(kept.text).env), [' A ']);
  const set = patchEnvRows('{"model":"opus"}', [{ key: 'A', value: '1' }]);
  assert.deepEqual(parse(set.text), { model: 'opus', env: { A: '1' } });
  const cleared = patchEnvRows(set.text, []);
  assert.deepEqual(parse(cleared.text), { model: 'opus' });
  // 검증에 걸리는 행 집합은 원문을 건드리지 않는다.
  assert.deepEqual(patchEnvRows('{}', [{ key: '', value: 'x' }]), { ok: false, reason: 'invalid' });
});

test('enabledPlugins: 켬/끔은 boolean, 항목 제거는 삭제', () => {
  assert.deepEqual(readEnabledPlugins('{}'), { ok: true, map: {} });
  const on = setPluginEnabled('{}', 'codex@openai-codex', true);
  assert.deepEqual(parse(on.text), { enabledPlugins: { 'codex@openai-codex': true } });
  const off = setPluginEnabled(on.text, 'codex@openai-codex', false);
  assert.deepEqual(parse(off.text), { enabledPlugins: { 'codex@openai-codex': false } });
  assert.deepEqual(readEnabledPlugins(off.text), {
    ok: true,
    map: { 'codex@openai-codex': false },
  });
  // 제거는 "끔"과 다르다 — 키가 사라지고, 마지막 항목이면 부모까지 정리된다.
  const removed = removePluginEntry(off.text, 'codex@openai-codex');
  assert.deepEqual(parse(removed.text), {});
});

test('enabledPlugins: 키는 불투명 식별자다(스코프드 이름도 그대로)', () => {
  const key = '@acme/tool@shop';
  const res = setPluginEnabled('{}', key, true);
  assert.deepEqual(Object.keys(parse(res.text).enabledPlugins), [key]);
});

test('키가 __proto__여도 조용히 사라지지 않는다(대입이 아니라 정의)', () => {
  // 기대값을 객체 리터럴로 쓸 수 없다 — 리터럴의 __proto__는 프로퍼티가 아니라
  // 프로토타입 지정이라 비교 대상 자체가 비어 버린다. 직렬화 결과로 확인한다.
  const plugin = setPluginEnabled('{}', '__proto__', true);
  assert.match(plugin.text, /"enabledPlugins":\s*\{\s*"__proto__": true/);
  const env = patchEnvRows('{}', [{ key: '__proto__', value: 'x' }]);
  assert.match(env.text, /"env":\s*\{\s*"__proto__": "x"/);
  const top = patchField('{}', ['__proto__'], 1);
  assert.match(top.text, /"__proto__": 1/);
});

test('enabledPlugins: boolean이 아닌 값이 있으면 토글로 뭉개지 않는다', () => {
  assert.deepEqual(readEnabledPlugins('{"enabledPlugins":{"a@m":"yes"}}'), {
    ok: false,
    reason: 'blocked',
  });
  assert.deepEqual(readEnabledPlugins('{"enabledPlugins":[]}'), { ok: false, reason: 'blocked' });
});

// ----- pluginRows: 설치 목록 + 설정 켬/끔을 한 화면 목록으로 -----
// 이 병합 규칙이 항목을 빠뜨리면 사용자가 설정 파일을 정리할 방법이 사라진다.

test('pluginRows — 설치된 항목에 설정의 켬/끔이 붙는다', () => {
  const installed = [{ key: 'a@m', name: 'a', marketplace: 'm', installs: [{ scope: 'user' }] }];
  const r = pluginRows('{"enabledPlugins":{"a@m":true}}', installed);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].installed, true);
  assert.equal(r.rows[0].enabled, true);
  assert.deepEqual(r.rows[0].installs, [{ scope: 'user' }]);
});

test('pluginRows — 설정에만 남은 찌꺼기도 목록에 넣는다', () => {
  const r = pluginRows('{"enabledPlugins":{"gone@old":false}}', []);
  assert.deepEqual(r.rows[0], {
    key: 'gone@old',
    name: 'gone',
    marketplace: 'old',
    installs: [],
    installed: false,
    enabled: false,
  });
});

test('pluginRows — "설정 없음"은 undefined이지 false가 아니다', () => {
  // 스위치(켬/끔)와 "설정 없음"(켜기·끄기 두 버튼)이 갈리는 근거다.
  const r = pluginRows('{}', [{ key: 'a@m', name: 'a', marketplace: 'm', installs: [] }]);
  assert.equal(r.rows[0].enabled, undefined);
});

test('pluginRows — 이름에 @가 들어가면 마지막 @를 기준으로 자른다', () => {
  const r = pluginRows('{"enabledPlugins":{"scope@pkg@market":true}}', []);
  assert.equal(r.rows[0].name, 'scope@pkg');
  assert.equal(r.rows[0].marketplace, 'market');
});

test('pluginRows — key 사전순으로 정렬한다 (도착 순서와 무관)', () => {
  const installed = [
    { key: 'z@m', name: 'z', marketplace: 'm', installs: [] },
    { key: 'a@m', name: 'a', marketplace: 'm', installs: [] },
  ];
  const r = pluginRows('{"enabledPlugins":{"m@m":true}}', installed);
  assert.deepEqual(r.rows.map((x) => x.key), ['a@m', 'm@m', 'z@m']);
});

test('pluginRows — 다룰 수 없는 형태면 목록을 만들지 않는다 (값을 덮어쓰지 않는다)', () => {
  assert.deepEqual(pluginRows('{"enabledPlugins":{"a@m":"yes"}}', []), {
    ok: false,
    reason: 'blocked',
  });
  assert.equal(pluginRows('{ oops', []).ok, false);
});

test('pluginRows — 설치 목록을 생략해도 설정 항목만으로 목록이 나온다', () => {
  assert.equal(pluginRows('{"enabledPlugins":{"a@m":true}}').rows.length, 1);
});
