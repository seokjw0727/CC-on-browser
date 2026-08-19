import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_SIZE,
  WINDOW_STEP,
  windowStartFor,
  windowFloorFor,
  expandStart,
} from '../src/lib/chat-window.js';

/** 경계가 아닌 평범한 메시지 n개. */
const msg = (n) => Array.from({ length: n }, () => ({ kind: 'assistant-text' }));

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

// ----- 컨텍스트 경계(floor): /clear·/compact 위를 기본 창에서 숨긴다 -----

test('windowFloorFor: 경계가 없으면 0 — 기존 창 계산 그대로', () => {
  assert.equal(windowFloorFor([]), 0);
  assert.equal(windowFloorFor(msg(50)), 0);
  // 비배열도 안전하게 0 (세션이 아직 없을 때)
  for (const bad of [null, undefined, 'nope', 7, {}]) assert.equal(windowFloorFor(bad), 0, String(bad));
});

test('windowFloorFor: /clear·/compact 경계 — 가장 최근 것이 이긴다', () => {
  assert.equal(windowFloorFor([...msg(3), { kind: 'cleared' }, ...msg(2)]), 3);
  assert.equal(windowFloorFor([...msg(3), { kind: 'compaction', state: 'done' }, ...msg(2)]), 3);
  assert.equal(windowFloorFor([...msg(1), { kind: 'compaction-summary', text: 'x' }, ...msg(2)]), 1);
  // 여러 번 비웠으면 마지막 경계만 의미가 있다
  assert.equal(windowFloorFor([{ kind: 'cleared' }, ...msg(2), { kind: 'cleared' }, ...msg(2)]), 3);
  // 경계가 맨 끝이어도 된다
  assert.equal(windowFloorFor([...msg(4), { kind: 'compaction', state: 'done' }]), 4);
});

test('windowFloorFor: 아직·끝내 안 바뀐 컨텍스트는 경계가 아니다(running·canceled)', () => {
  // 진행 중: 접으면 압축이 끝날 때까지(최대 78초) 진행 카드 한 장만 남고, 방금 찍은
  // /compact 칩까지 숨는다. 중단되면 접혔던 대화가 한 커밋에 되살아난다.
  assert.equal(windowFloorFor([...msg(3), { kind: 'compaction', state: 'running' }, ...msg(2)]), 0);
  assert.equal(windowFloorFor([...msg(4), { kind: 'compaction', state: 'running' }]), 0);
  // 중단: 압축이 일어나지 않았으므로 컨텍스트가 그대로다
  assert.equal(windowFloorFor([...msg(3), { kind: 'compaction', state: 'canceled' }, ...msg(2)]), 0);
  // 둘 다 그 앞의 진짜 경계를 가리지 않는다
  const msgs = [...msg(2), { kind: 'cleared' }, ...msg(1), { kind: 'compaction', state: 'canceled' }, ...msg(1)];
  assert.equal(windowFloorFor(msgs), 2);
  assert.equal(windowFloorFor([...msg(2), { kind: 'cleared' }, { kind: 'compaction', state: 'running' }]), 2);
  // state가 없는 카드도 경계가 아니다(완료를 확인하지 못한 것)
  assert.equal(windowFloorFor([...msg(3), { kind: 'compaction' }, ...msg(2)]), 0);
});

test('windowFloorFor: 진행 카드가 완료로 바뀌는 그 커밋에 경계가 생긴다', () => {
  // finishCompaction은 running 카드를 **제자리에서** done으로 바꾼다 — 인덱스가 같으므로
  // 압축이 끝나는 순간(컨텍스트가 실제로 줄어든 순간) 딱 그 자리에서 접힌다.
  const running = [...msg(5), { kind: 'compaction', state: 'running' }, ...msg(2)];
  assert.equal(windowFloorFor(running), 0);
  const done = running.map((m) => (m.kind === 'compaction' ? { ...m, state: 'done' } : m));
  assert.equal(windowFloorFor(done), 5);
});

test('windowFloorFor: 붙어 있는 경계 무리는 첫 인덱스 — 압축 카드가 요약과 함께 보인다', () => {
  const pair = [...msg(5), { kind: 'compaction', state: 'done' }, { kind: 'compaction-summary', text: 'x' }, ...msg(2)];
  assert.equal(windowFloorFor(pair), 5);
  // 사이에 다른 메시지가 끼면 무리가 아니다 — 마지막 경계부터
  const split = [...msg(5), { kind: 'compaction', state: 'done' }, ...msg(1), { kind: 'compaction-summary', text: 'x' }, ...msg(2)];
  assert.equal(windowFloorFor(split), 7);
  // 무리가 스캔 범위(뒤 size개)에 걸치면 범위 끝에서 끊는다 — 렌더 결과는 같다.
  const atEdge = [{ kind: 'compaction', state: 'done' }, { kind: 'compaction-summary', text: 'x' }, ...msg(199)];
  assert.equal(windowFloorFor(atEdge, 200), 1);
  const win = (floor) =>
    windowStartFor({ total: atEdge.length, start: 0, sticky: false, pinned: true, size: 200, floor });
  assert.equal(win(1), win(0)); // tailStart에 눌려 무리 첫 인덱스(0)와 구별되지 않는다
});

test('windowFloorFor: /clear를 연달아 쳐도 훑는 비용이 size로 묶인다', () => {
  // 연속 경계 무리가 아무리 길어도 스캔 범위 밖으로 거슬러 오르지 않는다.
  const spam = [...msg(500), ...Array.from({ length: 300 }, () => ({ kind: 'cleared' }))];
  assert.equal(windowFloorFor(spam, 10), spam.length - 10);
  // 무리 전체가 범위 안이면 무리의 첫 인덱스 그대로
  assert.equal(windowFloorFor([...msg(5), { kind: 'cleared' }, { kind: 'cleared' }, { kind: 'cleared' }], 200), 5);
});

test('windowFloorFor: 뒤에서 size개만 훑는다 — 더 오래된 경계는 어차피 창 계산에 영향이 없다', () => {
  const msgs = [...msg(5), { kind: 'cleared' }, ...msg(54)]; // 경계는 인덱스 5, 전체 60
  assert.equal(windowFloorFor(msgs, 10), 0); // 스캔 범위 밖이라 못 본다
  // 못 봐도 결과가 같다 — 이게 이 최적화(스트리밍 중 매 렌더 호출)의 근거다
  const at = (floor) => windowStartFor({ total: 60, start: 0, sticky: false, pinned: true, size: 10, floor });
  assert.equal(at(0), 50);
  assert.equal(at(5), 50);
});

test('floor: 경계가 꼬리보다 최근이면 기본 창이 그 아래로 접힌다', () => {
  const at = (total, floor) => windowStartFor({ total, start: 0, sticky: false, pinned: true, size: 10, floor });
  assert.equal(at(100, 95), 95); // 경계 이후 5개만 — "기본 창보다 적게" 보이는 유일한 예외
  assert.equal(at(100, 90), 90); // 경계 == tailStart
  assert.equal(at(100, 80), 90); // 경계가 꼬리보다 오래됨 → 기본 창 유지
  assert.equal(at(100, 0), 90); // 경계 없음 → 종전과 동일
  assert.equal(at(5, 3), 3); // 전체가 창보다 짧아도 경계는 적용된다
});

test('floor: 펼쳐 둔 창(sticky)·읽던 위치(비고정)는 경계가 빼앗지 않는다', () => {
  // "모두 불러오기"로 펼쳐 둔 상태에서 /clear가 나도 접히지 않는다
  assert.equal(windowStartFor({ total: 100, start: 0, sticky: true, pinned: true, size: 10, floor: 95 }), 0);
  assert.equal(windowStartFor({ total: 100, start: 50, sticky: true, pinned: true, size: 10, floor: 95 }), 50);
  // 위로 읽는 중 자동 압축이 끝나도 읽던 위치 그대로
  assert.equal(windowStartFor({ total: 100, start: 40, sticky: false, pinned: false, size: 10, floor: 95 }), 40);
  // 시작점이 경계보다 뒤(더 최근)면 경계로 클램프 — 빈 창 방지 상한이 base로 올라간다
  assert.equal(windowStartFor({ total: 100, start: 97, sticky: true, pinned: true, size: 10, floor: 95 }), 95);
});

test('floor 클램프: 비정상 값이 창을 망가뜨리지 않는다', () => {
  const at = (floor) => windowStartFor({ total: 100, start: 0, sticky: false, pinned: true, size: 10, floor });
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -5, 0, 'x']) {
    assert.equal(at(bad), 90, `floor=${String(bad)}`);
  }
  assert.equal(at(999), 99); // total을 넘겨도 빈 창이 되지 않는다(최소 1개는 남는다)
  assert.equal(at(95.9), 95); // 소수는 절삭
  assert.equal(windowStartFor({ total: 0, start: 0, sticky: false, pinned: true, size: 10, floor: 5 }), 0);
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
    render(total, pinned, floor = 0) {
      start = windowStartFor({ total, start, sticky, pinned, size, floor });
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

test('전이: /clear로 접힌 뒤 "더 보기"로 되살리고, "최신으로"면 다시 접힌다', () => {
  const v = makeView(10);
  assert.equal(v.render(100, true), 10); // 경계 없음: 최근 10개
  // 인덱스 100에 cleared가 붙고 이후 대화 3개 → 경계 이후 4개만 보인다
  assert.equal(v.render(104, true, 100), 4);
  assert.equal(v.start, 100);

  v.expand(10); // "이전 메시지 더 보기" — 숨겼던 기록을 되살린다
  assert.equal(v.render(104, false, 100), 14);
  assert.equal(v.start, 90);
  assert.equal(v.render(104, true, 100), 14); // 하단으로 돌아와도 유지(sticky)

  v.reset(); // "↓ 최신으로"
  assert.equal(v.render(104, true, 100), 4); // 다시 경계 아래로 접힌다
  assert.equal(v.start, 100);
});

test('전이: 위로 읽는 중 자동 압축이 끝나도 위치를 빼앗기지 않는다', () => {
  const v = makeView(10);
  v.render(200, true);
  assert.equal(v.render(200, false), 10); // 읽기 시작 — 190에서 동결
  assert.equal(v.start, 190);

  // 압축 카드+요약(인덱스 200~201)이 붙고 새 대화 2개 → 경계 200, 전체 204
  assert.equal(v.render(204, false, 200), 14); // 읽던 위치 그대로, 새 메시지는 아래에 쌓인다
  assert.equal(v.start, 190);

  assert.equal(v.render(204, true, 200), 4); // 하단으로 돌아온 그때 경계 아래로 접힌다
});
