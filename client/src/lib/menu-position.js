// 컨텍스트 메뉴 위치 계산 — 순수 함수, DOM 무관 (SessionMenu.jsx에서 사용).
// 기본은 클릭 지점의 오른쪽 아래. 그쪽이 모자라면 반대편으로 뒤집고, 양쪽 다
// 모자라면 viewport 안으로 클램프한다(메뉴가 커서를 덮더라도 화면 밖 방지).
//
// tooltip-position.js와 분리한 이유: 툴팁은 "대상 사각형" 기준으로 위/아래를
// 고르지만, 메뉴는 "커서 한 점" 기준으로 네 방향 중 하나에 펼쳐진다.

/**
 * @param {{x:number, y:number}} anchor 커서(또는 트리거 버튼 모서리) 좌표 — viewport 기준
 * @param {{width:number, height:number}} menuSize
 * @param {{width:number, height:number}} viewport
 * @param {{margin?:number}} [opts] 화면 가장자리 여백
 * @returns {{top:number, left:number}}
 */
export function computeMenuPosition(anchor, menuSize, viewport, opts = {}) {
  const margin = opts.margin ?? 8;

  // 아래로 펼칠 공간이 부족하면 위로 뒤집는다(커서 위쪽으로 열림).
  let top = anchor.y;
  if (top + menuSize.height + margin > viewport.height) {
    const flipped = anchor.y - menuSize.height;
    top = flipped >= margin ? flipped : viewport.height - margin - menuSize.height;
  }
  top = Math.max(margin, top);

  // 오른쪽이 부족하면 왼쪽으로 뒤집는다.
  let left = anchor.x;
  if (left + menuSize.width + margin > viewport.width) {
    const flipped = anchor.x - menuSize.width;
    left = flipped >= margin ? flipped : viewport.width - margin - menuSize.width;
  }
  left = Math.max(margin, left);

  return { top, left };
}
