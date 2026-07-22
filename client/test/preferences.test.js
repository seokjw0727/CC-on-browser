// 기본값 영속 유틸(lib/preferences.js) 테스트.
// 핵심 계약 두 가지:
//  ① localStorage가 없거나 throw해도 앱이 죽지 않고 기본값으로 수렴한다.
//  ② 저장된 값이 신뢰할 수 없을 때(손댄 모드 문자열, 카탈로그에서 사라진 모델)
//     스폰 인자로 새어 나가지 않고 안전한 값으로 낙하한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE_KEY,
  DEFAULT_MODEL_KEY,
  loadDefaults,
  normalizeMode,
  readPref,
  resolveDefaultModel,
  writePref,
} from '../src/lib/preferences.js';

// 최소 localStorage 흉내 — get/set/remove만.
function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// 접근만으로 throw하는 storage(차단 컨텍스트 재현)
const throwingStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

test('readPref: 값이 없거나 빈 문자열이면 null', () => {
  const s = fakeStorage({ a: 'x', b: '' });
  assert.equal(readPref('a', s), 'x');
  assert.equal(readPref('b', s), null);
  assert.equal(readPref('missing', s), null);
  assert.equal(readPref('a', null), null); // storage 자체가 없는 환경
});

test('readPref/writePref: throw하는 storage에서도 예외가 새지 않는다', () => {
  assert.equal(readPref('a', throwingStorage), null);
  assert.equal(writePref('a', 'x', throwingStorage), false);
  // 삭제 경로(빈 값 쓰기)도 같은 보호를 받아야 한다 — removeItem이 try 밖으로
  // 빠져나가는 회귀를 잡는다.
  assert.equal(writePref('a', '', throwingStorage), false);
});

test('writePref: storage가 없으면 성공을 보고하지 않는다', () => {
  // 아무 데도 쓰이지 않았는데 true를 주면 호출측이 "저장됨"을 오보한다.
  assert.equal(writePref('a', 'x', null), false);
  assert.equal(writePref('a', '', null), false);
});

test('기본 storage 경로: 인자 생략 시 매 호출마다 globalThis.localStorage를 다시 읽는다', () => {
  // 모듈 로드 시점에 캐시하면 (a) 접근만으로 throw하는 환경에서 임포트가 깨지고
  // (b) 아래처럼 도중에 교체되는 storage를 못 따라간다.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    let store = null;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        if (store === null) throw new Error('blocked');
        return store;
      },
    });

    // ① getter가 throw하는 동안 — 조용히 기본값
    assert.equal(readPref('k'), null);
    assert.equal(writePref('k', 'v'), false);
    assert.deepEqual(loadDefaults(), { model: '', mode: 'default' });

    // ② 나중에 사용 가능해지면 같은 호출이 새 storage를 본다
    store = fakeStorage({ [DEFAULT_MODEL_KEY]: 'sonnet' });
    assert.equal(readPref(DEFAULT_MODEL_KEY), 'sonnet');
    assert.equal(writePref(DEFAULT_MODE_KEY, 'plan'), true);
    assert.deepEqual(loadDefaults(), { model: 'sonnet', mode: 'plan' });
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('writePref: 빈 값은 키를 지운다(= 지정 안 함)', () => {
  const s = fakeStorage({ k: 'v' });
  assert.equal(writePref('k', '', s), true);
  assert.equal(s._map.has('k'), false);
  assert.equal(writePref('k', null, s), true);
  assert.equal(writePref('k', 'sonnet', s), true);
  assert.equal(s._map.get('k'), 'sonnet');
});

test('normalizeMode: MODES 밖의 값은 전부 default로 낙하', () => {
  assert.equal(normalizeMode('acceptEdits'), 'acceptEdits');
  assert.equal(normalizeMode('plan'), 'plan');
  assert.equal(normalizeMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(normalizeMode('default'), 'default');
  assert.equal(normalizeMode('bogus'), 'default');
  assert.equal(normalizeMode(''), 'default');
  assert.equal(normalizeMode(null), 'default');
  assert.equal(normalizeMode(undefined), 'default');
});

test('resolveDefaultModel: 현재 카탈로그에 없는 저장값은 ""(CLI 기본)로 낙하', () => {
  // 실제 CLI initialize 응답의 항목 모양(fake-cli.mjs와 동일 계약).
  const models = [
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-4-8[1m]' },
    { value: 'sonnet', displayName: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
    { value: 'claude-fable-5[1m]', displayName: 'Fable 5', resolvedModel: 'claude-fable-5' },
  ];
  assert.equal(resolveDefaultModel('sonnet', models), 'sonnet');
  assert.equal(resolveDefaultModel('claude-fable-5[1m]', models), 'claude-fable-5[1m]');
  // 대조는 스폰 키(value)로만 — 해석 id(resolvedModel)는 --model로 유효하지
  // 않을 수 있어 통과시키면 안 된다.
  assert.equal(resolveDefaultModel('claude-sonnet-5', models), '');
  assert.equal(resolveDefaultModel('claude-fable-5', models), '');
  // 구버전 CLI/계정에서 사라진 id — 스폰 인자로 넘기면 시작이 깨지므로 낙하
  assert.equal(resolveDefaultModel('claude-3-legacy', models), '');
  assert.equal(resolveDefaultModel('', models), '');
  assert.equal(resolveDefaultModel(null, models), '');
});

test('resolveDefaultModel: 카탈로그가 없으면(init 전) 검증 불가 → 통과시키지 않는다', () => {
  // 셀렉트를 비활성으로 두는 것만으로는 이미 상태에 남은 값의 스폰을 못 막는다.
  assert.equal(resolveDefaultModel('sonnet', []), '');
  assert.equal(resolveDefaultModel('sonnet', undefined), '');
  assert.equal(resolveDefaultModel('sonnet', null), '');
  assert.equal(resolveDefaultModel('sonnet', 'not-an-array'), '');
});

test('loadDefaults: 저장된 묶음을 정규화해 돌려준다', () => {
  const s = fakeStorage({ [DEFAULT_MODEL_KEY]: 'sonnet', [DEFAULT_MODE_KEY]: 'plan' });
  assert.deepEqual(loadDefaults(s), { model: 'sonnet', mode: 'plan' });

  const bad = fakeStorage({ [DEFAULT_MODE_KEY]: 'nonsense' });
  assert.deepEqual(loadDefaults(bad), { model: '', mode: 'default' });

  // 차단 컨텍스트 — 공장 기본값
  assert.deepEqual(loadDefaults(throwingStorage), { model: '', mode: 'default' });
  assert.deepEqual(loadDefaults(null), { model: '', mode: 'default' });
});
