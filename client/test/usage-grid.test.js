// usage-grid.js — 돌아보기 잔디 그리드 빌더 테스트 (순수 함수, DOM 무관).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeatmap, parseDateKey, toDateKey } from '../src/lib/usage-grid.js';

// 로컬 날짜 기준 시계열 생성기 — end(로컬 Date)까지 n일, totals[i]는 오래된 날부터.
function makeSeries(end, totals) {
  const n = totals.length;
  return totals.map((totalTokens, i) => {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1 - i));
    return { date: toDateKey(d), totalTokens };
  });
}

test('parseDateKey: 로컬 날짜로 해석한다 (UTC 오프셋 밀림 없음)', () => {
  const d = parseDateKey('2026-07-17');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 17); // new Date('2026-07-17')였다면 음수 오프셋 TZ에서 16일
  assert.equal(toDateKey(d), '2026-07-17');
});

test('그리드 정렬: 일요일 시작, 마지막 열은 오늘까지·이후는 null', () => {
  // 2026-07-15는 수요일 (getDay()=3)
  const end = new Date(2026, 6, 15);
  assert.equal(end.getDay(), 3);
  const series = makeSeries(end, Array(28).fill(1)); // 4주치, 전부 1 tok
  const { columns } = buildHeatmap(series, { weeks: 2 });
  assert.equal(columns.length, 2);
  assert.equal(columns[0].length, 7);
  // 마지막 열: 일(0)~수(3)까지 데이터, 목(4)~토(6)는 미래 → null
  const last = columns[1];
  assert.ok(last[0] && last[3], '일~수는 셀 존재');
  assert.equal(last[3].date, toDateKey(end));
  assert.equal(last[4], null);
  assert.equal(last[6], null);
  // 첫 열 머리는 마지막 열 일요일의 1주 전 일요일
  assert.equal(parseDateKey(columns[0][0].date).getDay(), 0);
});

test('데이터 창 밖(시계열 이전) 셀은 null', () => {
  const end = new Date(2026, 6, 15); // 수요일
  const series = makeSeries(end, [5, 5, 5]); // 월~수 3일치만
  const { columns } = buildHeatmap(series, { weeks: 2 });
  // 첫 열(지난주)은 전부 데이터 창 밖 → null
  assert.ok(columns[0].every((c) => c === null));
  // 마지막 열: 일요일(창 밖)은 null, 월~수는 셀
  assert.equal(columns[1][0], null);
  assert.ok(columns[1][1] && columns[1][2] && columns[1][3]);
});

test('강도 level: 0 토큰=0, 창 내 최댓값 대비 4분위', () => {
  const end = new Date(2026, 6, 18); // 토요일 → 한 주에 7일 전부
  assert.equal(end.getDay(), 6);
  const series = makeSeries(end, [0, 25, 26, 50, 75, 76, 100]);
  const { columns, maxTotal } = buildHeatmap(series, { weeks: 1 });
  assert.equal(maxTotal, 100);
  const levels = columns[0].map((c) => c.level);
  assert.deepEqual(levels, [0, 1, 2, 2, 3, 4, 4]);
});

test('전 구간 0(max=0)이면 모든 level이 0', () => {
  const end = new Date(2026, 6, 18);
  const series = makeSeries(end, [0, 0, 0, 0, 0, 0, 0]);
  const { columns, maxTotal } = buildHeatmap(series, { weeks: 1 });
  assert.equal(maxTotal, 0);
  assert.ok(columns[0].every((c) => c.level === 0));
});

test('max는 표시 창 기준 — 창 밖 큰 값이 4분위를 왜곡하지 않는다', () => {
  const end = new Date(2026, 6, 18); // 토요일
  // 2주치: 첫 주에 1000, 마지막 주 최대 10 — weeks:1이면 max=10
  const totals = [1000, 0, 0, 0, 0, 0, 0, 0, 10, 5, 0, 0, 0, 10];
  const series = makeSeries(end, totals);
  const { maxTotal, columns } = buildHeatmap(series, { weeks: 1 });
  assert.equal(maxTotal, 10);
  assert.equal(columns[0][1].level, 4); // 10/10 → 4
  assert.equal(columns[0][2].level, 2); // 5/10 → ceil(2)
});

test('월 라벨: 열 머리(일요일)의 달이 바뀌는 열에 붙는다', () => {
  // 2026-08-05(수)로 끝나는 6주 — 7월→8월 경계 포함
  const end = new Date(2026, 7, 5);
  const series = makeSeries(end, Array(42).fill(1));
  const { columns, monthLabels } = buildHeatmap(series, { weeks: 6 });
  assert.equal(columns.length, 6);
  assert.ok(monthLabels.length >= 2, '시작 달 + 경계 달');
  assert.equal(monthLabels[0].col, 0);
  const aug = monthLabels.find((l) => l.label === '8월');
  assert.ok(aug, '8월 라벨 존재');
  // 8월 라벨 열의 머리(일요일)는 실제로 8월이어야 한다
  assert.equal(parseDateKey(columns[aug.col][0].date).getMonth(), 7);
});

test('빈 시계열/비정상 weeks는 빈 그리드', () => {
  assert.deepEqual(buildHeatmap([], { weeks: 12 }), { columns: [], monthLabels: [], maxTotal: 0 });
  assert.deepEqual(buildHeatmap(makeSeries(new Date(2026, 6, 15), [1]), { weeks: 0 }), {
    columns: [],
    monthLabels: [],
    maxTotal: 0,
  });
});
