// 모달 포커스 트랩 (ARIA dialog 패턴 / WCAG 2.4.3).
// - Tab / Shift+Tab 을 컨테이너 안에서 순환시켜 배경으로 이탈하지 못하게 함
// - 열릴 때 initialRef(없으면 첫 포커서블)로 포커스 이동
// - 닫힐 때 직전에 포커스돼 있던 요소로 복원 (restoreRef를 주면 그쪽 우선)
// active 는 모달이 현재 열려 있는지를 반영해야 한다.
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusable(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

// 지금 이 요소에 focus()를 걸어도 되는가.
// - 문서에서 떨어진 노드(삭제된 행의 버튼 등)에 focus()를 부르면 조용히 실패하고
//   포커스가 <body>로 떨어진다.
// - inert 서브트리 안(예: 확인 모달이 떠 있는 동안의 아래 모달)도 포커스를 받지
//   못하므로 자기 자신뿐 아니라 조상까지 확인한다.
// - disabled 요소도 제외.
function focusableNow(el) {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el.disabled) return false;
  return !el.closest('[inert]');
}

/**
 * @param {boolean} active 모달이 현재 열려 있는지
 * @param {{current: HTMLElement|null}} [initialRef] 초기 포커스 대상(생략 시 첫 포커서블)
 * @param {{current: HTMLElement|null}} [restoreRef] 닫힐 때 포커스를 돌려줄 대상(우선).
 *   생략하거나 그 노드가 이미 포커스 불가(삭제됨·inert·disabled)면 기존 동작
 *   (열기 직전 활성 요소)으로 폴백한다.
 *   중첩 모달에서는 자동 포착이 믿을 수 없다 — 아래 레이어에 inert가 걸리는 순간
 *   브라우저가 포커스를 <body>로 옮겨 버릴 수 있어, "직전 활성 요소"가 이미 body인
 *   상태로 트랩이 시작될 수 있기 때문(codex 지적). 그래서 호출측이 여는 시점에
 *   포착한 요소를 명시로 넘긴다.
 */
export function useFocusTrap(active, initialRef, restoreRef) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const node = ref.current;
    if (!node) return undefined;

    const restore =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialRef?.current || focusable(node)[0] || node).focus?.();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const els = focusable(node);
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey) {
        if (cur === first || !node.contains(cur)) {
          e.preventDefault();
          last.focus();
        }
      } else if (cur === last || !node.contains(cur)) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // 명시 대상 우선 → 없거나 포커스 불가면 열기 직전 활성 요소.
      // ref는 언마운트 시점에 읽는다 — 열려 있는 동안 대상이 바뀔 수 있다
      // (삭제 성공 시 🗑 → 목록 제목으로 교체되는 흐름).
      const target = focusableNow(restoreRef?.current)
        ? restoreRef.current
        : focusableNow(restore)
          ? restore
          : null;
      target?.focus?.();
    };
  }, [active, initialRef, restoreRef]);
  return ref;
}
