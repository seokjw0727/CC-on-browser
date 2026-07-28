// 채팅 목록 윈도잉의 순수 계산 — "지금 messages의 어디부터 렌더할 것인가".
// React/DOM 의존 없음 → node --test로 계약을 고정한다(ChatView가 이 값을 그대로 쓴다).
//
// 왜 필요한가: 대화 전체를 DOM에 두면 힙의 72%가 DOM(native)이 되고(실측 2026-07-27:
// 메시지 1920개·도구 결과 20KB에서 스냅샷 38.7MB 중 27.8MB), 그 임계를 넘으면 GC
// 스래싱으로 스트리밍 중 메인스레드가 초 단위로 멈춘다(총 블로킹 3851ms → 윈도잉 후 0ms).
//
// 창 상태는 두 축의 조합이다(설계도 §3-1):
//   pinned  — 지금 하단에 고정돼 있는가 (ChatView의 스크롤 상태)
//   sticky  — 사용자가 "더 보기"/"모두 불러오기"로 시작점을 직접 골랐는가
//
//   기본   (pinned,  !sticky): 최근 SIZE개. 새 메시지가 오면 위가 떨어져 개수가 유지된다.
//   읽기 중(!pinned, !sticky): 상단을 고정해 읽던 위치를 지킨다. 그동안 도착한 새 메시지는
//                              아래에 쌓이므로 **렌더 개수가 일시적으로 SIZE를 넘을 수 있다**
//                              (하단으로 돌아오면 다시 SIZE로 준다). 의도된 계약이다.
//   확장됨 (sticky):           사용자가 고른 시작점을 하단에 돌아와도 유지한다. 해제는
//                              "↓ 최신으로" 또는 세션 전환에서만 — 그러지 않으면 "모두
//                              불러오기" 후 하단에 닿는 순간 과거 대화가 다시 사라진다.

/** 평상시(하단 고정) DOM에 두는 메시지 수. 노드 수·바이트가 아니라 **메시지 개수** 기준. */
export const WINDOW_SIZE = 200;

/** "이전 메시지 더 보기" 1회 확장량. */
export const WINDOW_STEP = 200;

/**
 * 렌더 시작 인덱스를 구한다. 반환값은 항상 [0, total] 범위로 클램프된다.
 * @param {object} o
 * @param {number} o.total   전체 메시지 수
 * @param {number} o.start   현재 보관 중인 시작 인덱스(직전 값 또는 사용자가 고른 값)
 * @param {boolean} o.sticky 사용자가 직접 확장한 상태인가
 * @param {boolean} o.pinned 지금 하단에 고정돼 있는가
 * @param {number} [o.size]  기본 창 크기
 * @returns {number}
 */
export function windowStartFor({ total, start = 0, sticky = false, pinned = true, size = WINDOW_SIZE }) {
  const n = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const s = Number.isFinite(start) && start > 0 ? Math.trunc(start) : 0;
  const k = Number.isFinite(size) && size >= 1 ? Math.trunc(size) : WINDOW_SIZE;
  const tailStart = Math.max(0, n - k);
  // 어느 상태에서도 tailStart를 넘지 않는다 = **기본 창보다 적게 보이는 일은 없다**.
  // (sticky start가 total을 넘긴 비정상 값이어도 빈 창이 되지 않고 최신 구간으로 복구된다.)
  //  - sticky: 사용자가 고른 시작점을 고정 여부와 무관하게 존중
  //  - 하단 고정: 항상 최신 구간 — 성능·RAM 이득이 나오는 상태
  //  - 비고정(읽기 중): 상단을 앞으로 밀지 않는다(뒤로 당기지도 않는다)
  if (sticky) return Math.min(s, tailStart);
  return pinned ? tailStart : Math.min(s, tailStart);
}

/** "이전 메시지 더 보기" — 시작점을 step만큼 앞으로. 0 아래로는 안 간다. */
export function expandStart(start, step = WINDOW_STEP) {
  const s = Number.isFinite(start) && start > 0 ? Math.trunc(start) : 0;
  const k = Number.isFinite(step) && step > 0 ? Math.trunc(step) : WINDOW_STEP;
  return Math.max(0, s - k);
}
