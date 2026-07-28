import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_SIZE,
  WINDOW_STEP,
  windowStartFor,
  expandStart,
} from '../src/lib/chat-window.js';

test('기본(하단 고정): 최근 SIZE개만 — 새 메시지가 와도 개수가 유지된다', () => {
  const at = (total, start) => windowStartFor({ total, start, sticky: false, pinned: true, size: 10 });
  // 창보다 짧으면 전부
  assert.equal(at(0, 0), 0);
  assert.equal(at(9, 0), 0);
  assert.equal(at(10, 0), 0); // 경계: 정확히 창 크기면 아직 0부터
  // 창을 넘기면 꼬리로 밀린다 — 렌더 개수는 계속 10
  assert.equal(at(11, 0), 1);
  assert.equal(at(50, 0), 40);
  // 보관 중이던 start가 뒤처져 있어도 고정 중이면 꼬리가 이긴다
  assert.equal(at(50, 3), 40);
  // 반대로 start가 앞서 있어도 고정 중이면 꼬리로 맞춘다
  assert.equal(at(50, 45), 40);
});

test('읽기 중(비고정): 상단 앵커를 고정 — 새 메시지는 아래에 쌓여 렌더 수가 SIZE를 넘을 수 있다', () => {
  const at = (total, start) => windowStartFor({ total, start, sticky: false, pinned: false, size: 10 });
  // 40에서 위로 읽기 시작 → 메시지가 60개까지 늘어도 시작점은 그대로 40
  assert.equal(at(50, 40), 40);
  assert.equal(at(60, 40), 40); // 렌더 20개 — 계약상 허용(하단 복귀 시 다시 10으로 준다)
  // 단, 앞으로 밀지는 않는다 = min(start, tailStart). start가 꼬리보다 뒤면 꼬리로 클램프.
  assert.equal(at(50, 45), 40);
  // 하단으로 돌아오면(pinned=true) 곧바로 꼬리로 수축한다
  assert.equal(windowStartFor({ total: 60, start: 40, sticky: false, pinned: true, size: 10 }), 50);
});

test('확장됨(sticky): 사용자가 고른 시작점은 하단에 돌아와도 유지된다', () => {
  // 이게 없으면 "모두 불러오기" 후 스크롤을 내려 하단에 닿는 순간 과거 대화가 사라진다.
  assert.equal(windowStartFor({ total: 500, start: 0, sticky: true, pinned: true, size: 10 }), 0);
  assert.equal(windowStartFor({ total: 500, start: 120, sticky: true, pinned: true, size: 10 }), 120);
  assert.equal(windowStartFor({ total: 500, start: 120, sticky: true, pinned: false, size: 10 }), 120);
  // 새 메시지가 계속 와도 시작점은 그대로 — 창이 커지는 건 사용자가 선택한 결과다
  assert.equal(windowStartFor({ total: 900, start: 120, sticky: true, pinned: true, size: 10 }), 120);
});

test('어느 상태에서도 기본 창보다 적게 보이지 않는다 — 빈 창/과소 창 방지', () => {
  // sticky start가 총 개수를 넘긴 비정상 값이어도 빈 창(slice(total))이 되면 안 된다.
  assert.equal(windowStartFor({ total: 5, start: 99, sticky: true, pinned: true, size: 10 }), 0);
  assert.equal(windowStartFor({ total: 50, start: 99, sticky: true, pinned: false, size: 10 }), 40);
  // 꼬리보다 뒤처진 sticky 시작점은 꼬리로 복구된다(= 최소 size개 보장)
  assert.equal(windowStartFor({ total: 50, start: 45, sticky: true, pinned: true, size: 10 }), 40);
});

test('클램프: 비정상 입력(NaN/Infinity/음수)도 안전하게 접힌다', () => {
  assert.equal(windowStartFor({ total: 0, start: 99, sticky: true, pinned: true, size: 10 }), 0);
  assert.equal(windowStartFor({ total: -3, start: -2, sticky: false, pinned: true, size: 10 }), 0);
  assert.equal(windowStartFor({ total: 50, start: NaN, sticky: false, pinned: false, size: 10 }), 0);
  assert.equal(windowStartFor({ total: NaN, start: 5, sticky: false, pinned: true, size: 10 }), 0);
  // size가 비정상이면 기본 창 크기로 되돌린다 — NaN이 새어 나가면 slice(NaN)이 된다
  for (const bad of [0, -1, NaN, Infinity, -Infinity, undefined, null, 'x']) {
    const got = windowStartFor({ total: 1000, start: 0, sticky: false, pinned: true, size: bad });
    assert.equal(got, 1000 - WINDOW_SIZE, `size=${String(bad)}`);
  }
  // 유효한 소수 size는 절삭
  assert.equal(windowStartFor({ total: 50, start: 0, sticky: false, pinned: true, size: 10.9 }), 40);
});

test('expandStart: step만큼 앞으로 당기되 0 아래로 안 간다', () => {
  assert.equal(expandStart(500, 200), 300);
  assert.equal(expandStart(200, 200), 0);
  assert.equal(expandStart(120, 200), 0);
  assert.equal(expandStart(0, 200), 0);
  assert.equal(expandStart(-5, 200), 0);
  assert.equal(expandStart(500), 500 - WINDOW_STEP);
  assert.equal(expandStart(500, 0), 500 - WINDOW_STEP); // 잘못된 step은 기본값으로
});

test('기본 상수: 창 크기·확장량은 메시지 개수 기준의 양수', () => {
  assert.ok(Number.isInteger(WINDOW_SIZE) && WINDOW_SIZE > 0);
  assert.ok(Number.isInteger(WINDOW_STEP) && WINDOW_STEP > 0);
});

// ChatView가 실제로 하는 일(매 렌더 windowStartFor로 시작점을 다시 구해 보관)을 그대로 흉내내
// 상태 전이 흐름을 고정한다. 개별 호출만 검증하면 "확장 후 하단 복귀에 sticky가 풀리는"
// 류의 회귀를 못 잡는다(설계도 §3-1이 바로 그 결함을 막으려고 만든 계약이다).
function makeView(size) {
  let start = 0;
  let sticky = false;
  return {
    /** 한 번의 렌더 — 시작점을 다시 구해 보관하고 렌더될 메시지 수를 돌려준다. */
    render(total, pinned) {
      start = windowStartFor({ total, start, sticky, pinned, size });
      return total - start;
    },
    get start() { return start; },
    get sticky() { return sticky; },
    /** "이전 메시지 더 보기" / "모두 불러오기" */
    expand(step) { start = step == null ? 0 : expandStart(start, step); sticky = true; },
    /** "↓ 최신으로" 또는 세션 전환 — 확장을 해제한다 */
    reset() { sticky = false; },
  };
}

test('전이: 기본 → 첫 확장 → 새 메시지 도착 → 하단 복귀에도 확장이 유지된다', () => {
  const v = makeView(10);
  assert.equal(v.render(100, true), 10); // 기본: 최근 10개
  assert.equal(v.start, 90);

  v.expand(10); // "더 보기" 1회 — 전체 로드가 아니라 딱 10개만 더
  assert.equal(v.start, 80);
  assert.equal(v.render(100, false), 20);

  assert.equal(v.render(105, false), 25); // 읽는 중 새 메시지 5개 도착 → 아래에 쌓인다
  assert.equal(v.render(105, true), 25); // 하단으로 돌아와도 확장 유지(Ctrl+F 복원 계약)

  v.reset(); // "↓ 최신으로"
  assert.equal(v.render(105, true), 10); // 이제서야 기본 창으로 수축
  assert.equal(v.start, 95);
});

test('전이: 읽기 시작 → 새 메시지 누적(창이 커짐) → 하단 복귀 시 기본 창으로 수축', () => {
  const v = makeView(10);
  v.render(100, true);
  assert.equal(v.start, 90);

  assert.equal(v.render(100, false), 10); // 위로 스크롤(비고정) — 상단 앵커 고정
  assert.equal(v.render(120, false), 30); // 스트리밍 20개 — 렌더 수가 창을 넘는다(허용)
  assert.equal(v.start, 90); // 읽던 위치는 그대로

  assert.equal(v.render(120, true), 10); // 하단 복귀 — 즉시 수축
  assert.equal(v.start, 110);
});

test('전이: "모두 불러오기"는 전체를 보여주고, 세션 전환/최신으로만 해제된다', () => {
  const v = makeView(10);
  v.render(1000, true);
  v.expand(null); // 모두 불러오기
  assert.equal(v.start, 0);
  assert.equal(v.render(1000, true), 1000);
  assert.equal(v.render(1010, true), 1010); // 새 메시지가 와도 전체 유지
  v.reset();
  assert.equal(v.render(1010, true), 10);
});
