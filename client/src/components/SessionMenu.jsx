// 세션 행 컨텍스트 메뉴 — 사이드바 세션을 우클릭(키보드는 Shift+F10)했을 때 뜨는 작은 메뉴.
//
// 모달이 아니라 메뉴다(ARIA menu 패턴): 배경을 가리지 않고, Esc·바깥 클릭·스크롤로
// 닫히며, 닫히면 연 요소로 포커스를 돌려준다. 포커스 트랩은 걸지 않는다 — 메뉴는
// 갇히는 UI가 아니고, Tab은 "취소하고 나가기"로 해석하는 편이 표준에 가깝다.
//
// 위치는 fixed + 커서 좌표. 화면 가장자리 보정은 computeMenuPosition(순수 함수)이 맡고,
// 여기서는 마운트 직후 실제 크기를 재서 한 번 반영한다(첫 페인트 전 useLayoutEffect).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computeMenuPosition } from '../lib/menu-position.js';

export default function SessionMenu({ anchor, label, items, onClose, restoreRef }) {
  const ref = useRef(null);
  // 측정 전 위치 — 커서 지점에 그대로 두고, 레이아웃 직후 보정한다. 화면 밖으로
  // 잠깐 삐져나오는 프레임을 막기 위해 첫 렌더는 숨긴 채(visibility) 그린다.
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPos(
      computeMenuPosition(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  // 열릴 때 첫 항목으로 포커스 — 키보드만으로도 곧바로 고를 수 있게.
  // 반드시 위치가 정해진(=visibility:visible이 된) 다음에 해야 한다. 숨겨진
  // 서브트리의 요소는 focus()가 조용히 실패해, 포커스가 메뉴를 연 버튼에 남고
  // 화살표·Esc가 전혀 먹지 않는다(실측: 우클릭 후 activeElement=.sess-main).
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!pos || focusedRef.current) return;
    const first = ref.current?.querySelector('[role="menuitem"]:not([disabled])');
    if (!first) return;
    first.focus();
    focusedRef.current = true;
  }, [pos]);

  // 닫힐 때 포커스 복원 — 연 요소(행 버튼, 또는 행이 사라진 경우 "새 세션")가
  // 아직 살아 있을 때만.
  useEffect(() => () => {
    const target = restoreRef?.current;
    if (target instanceof HTMLElement && target.isConnected && !target.closest('[inert]')) {
      target.focus?.();
    }
  }, [restoreRef]);

  // 바깥 클릭·스크롤·리사이즈·창 포커스 상실 → 닫기. 스크롤은 capture로 받아야
  // 사이드바 내부 스크롤(버블링하지 않는 scroll 이벤트)도 잡힌다.
  useEffect(() => {
    const onPointerDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      // 트리거 위의 눌림도 바깥 클릭이다. 예전에는 ⋯ 버튼의 토글 클릭이 곧바로
      // 다시 여는 깜빡임을 막으려 예외를 뒀지만, ⋯를 없앤 뒤로 트리거는 세션 행
      // 버튼이다 — 예외를 남기면 메뉴가 열린 채 그 세션을 클릭해도 닫히지 않는다.
      onClose();
    };
    const close = () => onClose();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const moveFocus = useCallback((dir) => {
    const node = ref.current;
    if (!node) return;
    const els = [...node.querySelectorAll('[role="menuitem"]:not([disabled])')];
    if (els.length === 0) return;
    const cur = els.indexOf(document.activeElement);
    const next = dir === 'first'
      ? 0
      : dir === 'last'
        ? els.length - 1
        : (cur + (dir === 'next' ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  }, []);

  const onKeyDown = (e) => {
    switch (e.key) {
      case 'Escape':
        e.stopPropagation(); // 사이드바·모달의 Esc 처리와 겹치지 않게
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus('next');
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus('prev');
        break;
      case 'Home':
        e.preventDefault();
        moveFocus('first');
        break;
      case 'End':
        e.preventDefault();
        moveFocus('last');
        break;
      case 'Tab':
        onClose(); // 메뉴 밖으로 나가는 것은 취소로 본다
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      style={{
        top: `${pos ? pos.top : anchor.y}px`,
        left: `${pos ? pos.left : anchor.x}px`,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
      // 메뉴 위에서의 우클릭이 다시 행의 컨텍스트 메뉴를 열지 않게
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={`ctx-item${it.danger ? ' danger' : ''}`}
          // 진짜 disabled가 아니라 aria-disabled다. 두 가지 이유가 같은 곳을 가리킨다:
          // ① ARIA 메뉴 패턴은 비활성 항목도 포커스 가능하게 두라고 한다(보조기술
          //    사용자가 "지금은 못 쓴다"는 사실 자체를 알 수 있어야 한다).
          // ② 툴팁 레이어는 document의 mouseover 위임으로 [data-tip]을 찾는데,
          //    진짜 disabled 버튼은 마우스 이벤트를 내지 않는다 — 왜 못 누르는지
          //    설명하는 툴팁이 정작 필요한 순간에만 뜨지 않는다.
          aria-disabled={it.disabled || undefined}
          data-tip={it.tip || undefined}
          onClick={() => {
            if (it.disabled) return; // 눌러도 아무 일도 없다(메뉴는 열린 채)
            onClose();
            it.onSelect();
          }}
        >
          {it.icon && <span className="ctx-ico" aria-hidden="true">{it.icon}</span>}
          <span className="truncate">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
