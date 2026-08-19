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
//
// 여기에 **경계(floor)** 축이 하나 더 얹힌다: /clear·/compact로 CLI 컨텍스트가 비워진
// 지점 위는 기본 창에서 숨긴다(windowFloorFor). 화면이 실제 컨텍스트와 같은 것을 보여주게
// 하려는 것이고, 숨긴 기록은 지운 게 아니라 기존 "이전 메시지 더 보기"로 되살아난다.

/** 평상시(하단 고정) DOM에 두는 메시지 수. 노드 수·바이트가 아니라 **메시지 개수** 기준. */
export const WINDOW_SIZE = 200;

/** "이전 메시지 더 보기" 1회 확장량. */
export const WINDOW_STEP = 200;

// 컨텍스트 경계 = 그 위의 대화가 CLI 컨텍스트에서 사라진 지점(/clear 구분선, /compact
// 카드와 그 요약). 기본 창은 여기서 시작한다 — 화면이 CLI의 실제 컨텍스트와 같은 것을
// 보여주게 된다. 숨긴 기록은 지운 게 아니라 "이전 메시지 더 보기"로 그대로 되살아난다.
//
// 압축 카드는 **완료(state:'done')만** 경계다. 같은 근거의 두 얼굴이다: 컨텍스트가 실제로
// 바뀌기 전에 숨기면 화면과 실제 컨텍스트가 어긋난다.
//  - 'running': 아직 압축 전이다. 여기서 접으면 최대 78초(리듀서 주석의 실측) 동안 진행
//    카드 한 장만 남고, 방금 사용자가 찍은 /compact 커맨드 칩까지 위로 숨는다. 게다가
//    Esc로 중단되면(state:'canceled') 접혔던 200개가 한 커밋에 되살아난다.
//  - 'canceled': 압축이 일어나지 않았으므로 컨텍스트가 그대로다.
// 재개 프리로드는 잘린 running 카드를 done으로 닫으므로(finalizeCompactionCards) 과거
// 세션에서도 경계가 정상적으로 잡힌다.
function isBoundary(m) {
  if (!m) return false;
  if (m.kind === 'cleared' || m.kind === 'compaction-summary') return true;
  return m.kind === 'compaction' && m.state === 'done';
}

/**
 * 마지막 컨텍스트 경계의 인덱스. 없으면 0.
 *
 * 뒤에서부터 **최근 size개만** 훑는다. 그보다 오래된 경계는 windowStartFor의
 * max(tailStart, floor)에서 어차피 tailStart에 눌려 결과가 같으므로 볼 필요가 없다 —
 * 이 함수는 스트리밍 중 매 렌더 돌기 때문에 대화 길이에 비례하면 안 된다.
 *
 * 압축 카드와 그 요약처럼 경계가 연달아 붙어 있으면 그 무리의 첫 인덱스를 준다
 * (카드만 남고 요약이 잘리는 일이 없게). 무리가 스캔 범위를 벗어나면 범위 끝에서
 * 끊기지만, 그 아래는 어차피 tailStart에 눌려 결과가 같다.
 *
 * **windowStartFor와 같은 size로 부를 것** — 위 "결과가 같다"가 그 전제에서 성립한다.
 * @param {Array<{kind?: string, state?: string}>} messages
 * @param {number} [size] 뒤에서부터 훑을 개수
 * @returns {number}
 */
export function windowFloorFor(messages, size = WINDOW_SIZE) {
  if (!Array.isArray(messages)) return 0;
  const n = messages.length;
  const k = Number.isFinite(size) && size >= 1 ? Math.trunc(size) : WINDOW_SIZE;
  const from = Math.max(0, n - k);
  for (let i = n - 1; i >= from; i--) {
    if (!isBoundary(messages[i])) continue;
    // 무리를 거슬러 오를 때도 from에서 멈춘다 — 스캔 전체가 O(size)로 묶인다
    // (/clear를 연달아 치면 cleared가 연속으로 쌓여 무리 길이 자체가 커질 수 있다).
    // from 아래로 못 내려가도 렌더 결과는 같다: windowStartFor가 max(tailStart, floor)를
    // 쓰고 from === tailStart라, from 이하의 floor는 전부 tailStart와 구별되지 않는다.
    let j = i;
    while (j > from && isBoundary(messages[j - 1])) j--;
    return j;
  }
  return 0;
}

/**
 * 렌더 시작 인덱스를 구한다. 반환값은 항상 [0, total] 범위로 클램프된다.
 * @param {object} o
 * @param {number} o.total   전체 메시지 수
 * @param {number} o.start   현재 보관 중인 시작 인덱스(직전 값 또는 사용자가 고른 값)
 * @param {boolean} o.sticky 사용자가 직접 확장한 상태인가
 * @param {boolean} o.pinned 지금 하단에 고정돼 있는가
 * @param {number} [o.size]  기본 창 크기
 * @param {number} [o.floor] 마지막 컨텍스트 경계(windowFloorFor) — 기본 창의 하한
 * @returns {number}
 */
export function windowStartFor({ total, start = 0, sticky = false, pinned = true, size = WINDOW_SIZE, floor = 0 }) {
  const n = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const s = Number.isFinite(start) && start > 0 ? Math.trunc(start) : 0;
  const k = Number.isFinite(size) && size >= 1 ? Math.trunc(size) : WINDOW_SIZE;
  const tailStart = Math.max(0, n - k);
  // 경계가 꼬리보다 최근이면 경계가 이긴다 = **/clear·/compact 위는 기본적으로 숨긴다**.
  // (이때만 기본 창이 size개보다 적어진다 — 의도된 유일한 예외다.)
  // 상한은 n이 아니라 n-1이다 — 비정상 floor(총 개수 이상)가 와도 빈 창이 되지 않는다.
  const f = Number.isFinite(floor) && floor > 0 ? Math.min(Math.trunc(floor), Math.max(0, n - 1)) : 0;
  const base = Math.max(tailStart, f);
  // 어느 상태에서도 base를 넘지 않는다 = 빈 창이 되지 않는다.
  // (sticky start가 total을 넘긴 비정상 값이어도 최신 구간으로 복구된다.)
  //  - sticky: 사용자가 고른 시작점을 고정 여부와 무관하게 존중 — 경계보다 위를 펼쳐
  //    뒀다면 경계가 생겨도 접지 않는다(min이라 base가 올라가도 s가 이긴다)
  //  - 하단 고정: 항상 최신 구간(경계 이후) — 성능·RAM 이득이 나오는 상태
  //  - 비고정(읽기 중): 상단을 앞으로 밀지 않는다(뒤로 당기지도 않는다) — 읽는 도중
  //    자동 압축이 끝나도 읽던 위치를 빼앗지 않는다
  if (sticky) return Math.min(s, base);
  return pinned ? base : Math.min(s, base);
}

/** "이전 메시지 더 보기" — 시작점을 step만큼 앞으로. 0 아래로는 안 간다. */
export function expandStart(start, step = WINDOW_STEP) {
  const s = Number.isFinite(start) && start > 0 ? Math.trunc(start) : 0;
  const k = Number.isFinite(step) && step > 0 ? Math.trunc(step) : WINDOW_STEP;
  return Math.max(0, s - k);
}
