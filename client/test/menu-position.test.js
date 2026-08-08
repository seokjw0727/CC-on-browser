// 컨텍스트 메뉴 위치 계산(lib/menu-position.js) 테스트.
// 계약: 기본은 커서 오른쪽 아래, 공간이 모자라면 반대편으로 뒤집고,
//       양쪽 다 모자라면 화면 안으로 클램프한다(메뉴가 잘리지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMenuPosition } from '../src/lib/menu-position.js';

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 180, height: 90 };

test('공간이 넉넉하면 커서 지점에 그대로 펼친다', () => {
  assert.deepEqual(computeMenuPosition({ x: 100, y: 200 }, MENU, VIEWPORT), { top: 200, left: 100 });
});

test('아래·오른쪽이 모자라면 커서 기준으로 뒤집는다', () => {
  // 아래 공간 부족 → 위로
  assert.deepEqual(computeMenuPosition({ x: 100, y: 780 }, MENU, VIEWPORT).top, 690);
  // 오른쪽 공간 부족 → 왼쪽으로
  assert.deepEqual(computeMenuPosition({ x: 980, y: 100 }, MENU, VIEWPORT).left, 800);
});

test('양쪽 다 모자라면 화면 안으로 클램프한다', () => {
  const tiny = { width: 120, height: 100 };
  // 메뉴가 화면보다 조금 작은 상황에서 커서가 구석에 있어도 잘리지 않는다
  const pos = computeMenuPosition({ x: 5, y: 95 }, tiny, { width: 130, height: 110 });
  assert.equal(pos.left, 8); // margin
  assert.equal(pos.top, 8);
  // 메뉴가 화면보다 큰 극단도 최소 margin은 지킨다(위/왼쪽이 보이도록)
  const huge = computeMenuPosition({ x: 500, y: 700 }, { width: 2000, height: 2000 }, VIEWPORT);
  assert.equal(huge.top, 8);
  assert.equal(huge.left, 8);
});

test('margin은 조절할 수 있다', () => {
  const pos = computeMenuPosition({ x: 995, y: 795 }, MENU, VIEWPORT, { margin: 20 });
  assert.equal(pos.left, 815); // 995 - 180
  assert.equal(pos.top, 705); // 795 - 90
});
