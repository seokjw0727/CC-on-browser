// 모달 포커스 트랩 (ARIA dialog 패턴 / WCAG 2.4.3).
// - Tab / Shift+Tab 을 컨테이너 안에서 순환시켜 배경으로 이탈하지 못하게 함
// - 열릴 때 initialRef(없으면 첫 포커서블)로 포커스 이동
// - 닫힐 때 직전에 포커스돼 있던 요소로 복원
// active 는 모달이 현재 열려 있는지를 반영해야 한다.
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusable(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useFocusTrap(active, initialRef) {
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
      restore?.focus?.();
    };
  }, [active, initialRef]);
  return ref;
}
