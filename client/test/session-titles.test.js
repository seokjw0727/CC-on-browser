// 세션 이름 영속 유틸(lib/session-titles.js) 테스트.
// 계약 세 가지:
//  ① localStorage가 없거나 throw하거나 손상돼 있어도 앱이 죽지 않는다.
//  ② 빈 이름은 "해제"(항목 삭제)이고, 저장은 정규화·길이 제한을 거친다.
//  ③ 보관 개수를 넘으면 마지막 저장이 오래된 것부터 버린다(방금 쓴 건 살아남는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TITLES,
  MAX_TITLE_LEN,
  SESSION_TITLES_KEY,
  carryTitle,
  normalizeTitle,
  readTitles,
  saveTitle,
  titleFor,
} from '../src/lib/session-titles.js';

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const throwingStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

test('normalizeTitle: 공백 정리 + 길이 제한, 문자열이 아니면 빈 값', () => {
  assert.equal(normalizeTitle('  리팩터링\n 작업  '), '리팩터링 작업');
  assert.equal(normalizeTitle('a'.repeat(200)).length, MAX_TITLE_LEN);
  assert.equal(normalizeTitle('   '), '');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(42), '');
});

test('saveTitle/titleFor: 저장·조회·해제', () => {
  const s = fakeStorage();
  assert.equal(saveTitle('sid-1', '  내 세션  ', s, 100), true);
  assert.equal(titleFor('sid-1', s), '내 세션');
  // 빈 값 = 해제 → 항목이 사라지고 자동 제목으로 복귀
  assert.equal(saveTitle('sid-1', '   ', s, 200), true);
  assert.equal(titleFor('sid-1', s), '');
  // 맵이 비면 키 자체를 지운다(찌꺼기 방지)
  assert.equal(s._map.has(SESSION_TITLES_KEY), false);
  // 없는 id·빈 id는 조용히 빈 값
  assert.equal(titleFor('없음', s), '');
  assert.equal(titleFor(null, s), '');
  assert.equal(saveTitle(null, 'x', s), false);
});

test('readTitles: 손상된 JSON·엉뚱한 구조·옛 문자열 형태를 안전하게 처리', () => {
  assert.deepEqual(readTitles(fakeStorage({ [SESSION_TITLES_KEY]: '{not json' })), {});
  assert.deepEqual(readTitles(fakeStorage({ [SESSION_TITLES_KEY]: '[1,2]' })), {});
  assert.deepEqual(readTitles(fakeStorage({ [SESSION_TITLES_KEY]: 'null' })), {});
  assert.deepEqual(readTitles(fakeStorage()), {});
  // 값이 문자열인 옛 형태는 at=0으로 승격 — 정리 시 먼저 버려진다
  const legacy = readTitles(fakeStorage({ [SESSION_TITLES_KEY]: '{"a":"이름","b":{"title":"","at":5}}' }));
  assert.deepEqual(legacy, { a: { title: '이름', at: 0 } });
});

test('차단된 storage에서도 예외가 새지 않는다', () => {
  assert.deepEqual(readTitles(throwingStorage), {});
  assert.equal(titleFor('sid', throwingStorage), '');
  assert.equal(saveTitle('sid', '이름', throwingStorage), false);
  assert.equal(titleFor('sid', null), '');
  assert.equal(saveTitle('sid', '이름', null), false);
});

test('보관 개수 초과 시 오래된 항목부터 버리고 방금 쓴 항목은 남는다', () => {
  const s = fakeStorage();
  for (let i = 0; i < MAX_TITLES; i += 1) saveTitle(`old-${i}`, `이름 ${i}`, s, 1000 + i);
  assert.equal(Object.keys(readTitles(s)).length, MAX_TITLES);
  saveTitle('새 세션', '최신', s, 9999);
  const map = readTitles(s);
  assert.equal(Object.keys(map).length, MAX_TITLES);
  assert.equal(map['새 세션'].title, '최신');
  assert.equal(map['old-0'], undefined); // 가장 오래된 것이 밀려났다
  assert.ok(map['old-1']);
});

test('carryTitle: 재개 fork로 새 id가 생기면 이름을 옮기고 원본도 남긴다', () => {
  const s = fakeStorage();
  saveTitle('src', '원본 이름', s, 100);
  assert.equal(carryTitle('src', 'forked', s, 200), '원본 이름');
  assert.equal(titleFor('forked', s), '원본 이름');
  assert.equal(titleFor('src', s), '원본 이름'); // 지난 세션 목록에서 다시 재개될 수 있다
  // 원본에 이름이 없으면 아무것도 만들지 않는다
  assert.equal(carryTitle('무명', 'forked2', s, 300), '');
  assert.equal(titleFor('forked2', s), '');
  // 같은 id·빈 인자는 무동작
  assert.equal(carryTitle('src', 'src', s), '');
  assert.equal(carryTitle(null, 'x', s), '');
});
