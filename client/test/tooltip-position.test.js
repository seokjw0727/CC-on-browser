// tooltip-position.js — 툴팁 위치 계산 테스트 (순수 함수, DOM 무관).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTipPosition } from '../src/lib/tooltip-position.js';

const VIEWPORT = { width: 1280, height: 800 };

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

test('기본: 대상 위 중앙에 배치된다', () => {
  const r = rect(600, 400, 80, 30);
  const p = computeTipPosition(r, { width: 200, height: 40 }, VIEWPORT);
  assert.equal(p.placement, 'top');
  assert.equal(p.top, 400 - 8 - 40);
  assert.equal(p.left, 600 + 40 - 100); // 대상 중앙 - 툴팁 절반
});

test('화면 상단 근처: 아래로 플립된다', () => {
  const r = rect(600, 10, 80, 30);
  const p = computeTipPosition(r, { width: 200, height: 40 }, VIEWPORT);
  assert.equal(p.placement, 'bottom');
  assert.equal(p.top, r.bottom + 8);
});

test('좌측 가장자리: left가 margin으로 클램프된다', () => {
  const r = rect(4, 400, 40, 30);
  const p = computeTipPosition(r, { width: 300, height: 40 }, VIEWPORT);
  assert.equal(p.left, 8);
});

test('우측 가장자리: viewport 안으로 클램프된다', () => {
  const r = rect(1240, 400, 30, 30);
  const p = computeTipPosition(r, { width: 300, height: 40 }, VIEWPORT);
  assert.equal(p.left, 1280 - 8 - 300);
});

test('좁은 viewport: 툴팁이 화면보다 넓어도 left ≥ margin', () => {
  const vp = { width: 280, height: 800 };
  const r = rect(100, 400, 40, 30);
  const p = computeTipPosition(r, { width: 320, height: 40 }, vp);
  // min-클램프(우측) 후 max-클램프(좌측)가 우선 — 화면 왼쪽 기준 고정
  assert.equal(p.left, 8);
});

test('위·아래 모두 부족: 더 넓은 쪽을 고르고 상하 클램프된다', () => {
  const vp = { width: 1280, height: 200 };
  // 대상이 중앙보다 약간 위 → 아래 공간이 더 넓다
  const r = rect(600, 60, 80, 30);
  const p = computeTipPosition(r, { width: 200, height: 150 }, vp);
  assert.equal(p.placement, 'bottom');
  // bottom 배치(top=98)는 화면을 넘으므로 아래 경계로 클램프
  assert.equal(p.top, 200 - 8 - 150);
  assert.ok(p.top >= 8);
});

test('위가 부족하고 아래가 충분: 아래 선택', () => {
  const r = rect(600, 30, 80, 20);
  const p = computeTipPosition(r, { width: 200, height: 60 }, VIEWPORT);
  assert.equal(p.placement, 'bottom');
  assert.equal(p.top, 50 + 8);
});

test('gap·margin 옵션이 반영된다', () => {
  const r = rect(600, 400, 80, 30);
  const p = computeTipPosition(r, { width: 200, height: 40 }, VIEWPORT, { gap: 12, margin: 16 });
  assert.equal(p.top, 400 - 12 - 40);
});
