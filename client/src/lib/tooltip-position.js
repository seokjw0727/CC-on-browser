// 커스텀 툴팁(.tip-card) 위치 계산 — 순수 함수, DOM 무관 (Tooltip.jsx에서 사용).
// 기본은 대상 위 중앙. 위 공간이 부족하면 아래로 플립, 아래도 부족하면
// 더 넓은 쪽을 골라 viewport 안으로 클램프한다. 좌우도 margin 안으로 클램프.

/**
 * @param {{top:number,left:number,bottom:number,right:number,width:number,height:number}} targetRect
 * @param {{width:number,height:number}} tipSize
 * @param {{width:number,height:number}} viewport
 * @param {{gap?:number,margin?:number}} [opts]
 * @returns {{top:number,left:number,placement:'top'|'bottom'}}
 */
export function computeTipPosition(targetRect, tipSize, viewport, opts = {}) {
  const gap = opts.gap ?? 8;
  const margin = opts.margin ?? 8;

  const spaceAbove = targetRect.top - gap - margin;
  const spaceBelow = viewport.height - targetRect.bottom - gap - margin;

  let placement = 'top';
  if (tipSize.height > spaceAbove) {
    // 위가 모자라면: 아래가 들어가거나, 아래가 위보다라도 넓으면 아래로.
    placement = tipSize.height <= spaceBelow || spaceBelow > spaceAbove ? 'bottom' : 'top';
  }

  let top =
    placement === 'top'
      ? targetRect.top - gap - tipSize.height
      : targetRect.bottom + gap;
  // 양쪽 다 모자란 경우 대비 상하 클램프 (툴팁이 대상을 덮더라도 화면 밖 방지)
  top = Math.min(top, viewport.height - margin - tipSize.height);
  top = Math.max(top, margin);

  let left = targetRect.left + targetRect.width / 2 - tipSize.width / 2;
  left = Math.min(left, viewport.width - margin - tipSize.width);
  left = Math.max(left, margin);

  return { top, left, placement };
}
