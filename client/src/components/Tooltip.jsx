// 전역 커스텀 툴팁 레이어 — [data-tip] 요소의 hover/키보드 포커스에 앱 디자인
// (.tip-card) 툴팁을 띄운다. 네이티브 title 대체, 앱에 정확히 1개 마운트.
// - 표시 300ms 지연, 직전 숨김 500ms 이내 재진입은 무지연(warm)
// - 대상 → 카드 위로 마우스가 이동해도 유지. 대상-카드 사이 8px 간극을 지나는
//   동안 사라지지 않도록 hover 이탈은 150ms 유예(grace) 후 숨긴다.
// - hover와 키보드 포커스는 독립 추적 — 둘 다 걸려 있으면 둘 다 풀려야 숨는다
// - 포커스 표시는 키보드 모달리티(:focus-visible)일 때만 — pointerdown 직후의
//   focusin이 툴팁을 되살리지 않는다
// - Escape/스크롤(캡처)/resize/pointerdown/대상 DOM 제거/포커스 이탈 시 즉시 숨김
//   (권한 다이얼로그가 자동 포커스를 가져가는 경우 포함)
// - (hover: none) 코스 포인터에서는 hover 표시 생략
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computeTipPosition } from '../lib/tooltip-position.js';
import './interact.css';

const SHOW_DELAY_MS = 300;
const WARM_MS = 500;
const HIDE_GRACE_MS = 150; // 대상 ↔ 카드 간극 통과 유예
const CONNECTED_POLL_MS = 250; // 토스트 자동 소멸 등 이벤트 없는 대상 제거 감지
const TIP_ID = 'app-tooltip';

export default function TooltipLayer() {
  const [tip, setTip] = useState(null); // { target, text }
  const [pos, setPos] = useState(null); // { top, left } | null(측정 전)
  const cardRef = useRef(null);
  // 이벤트 핸들러는 마운트 1회 등록 — 최신 상태는 전부 ref로 본다.
  const tipRef = useRef(null);
  const hoverOnRef = useRef(false); // 표시 유지 근거: hover
  const focusOnRef = useRef(false); // 표시 유지 근거: 키보드 포커스
  const showTimerRef = useRef(null); // 지연 표시 타이머
  const pendingRef = useRef(null); // 지연 표시가 예약된 대상
  const graceTimerRef = useRef(null); // hover 이탈 유예 타이머
  const pollRef = useRef(null);
  const prevDescRef = useRef(null); // 덮어쓰기 전 aria-describedby 원본
  const warmUntilRef = useRef(0);

  useEffect(() => {
    const clearShowTimer = () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      pendingRef.current = null;
    };
    const clearGrace = () => {
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    };
    // detached 요소도 속성 변경은 유효 — 재사용될 수 있으니 항상 원복한다.
    const restoreDesc = (target) => {
      if (prevDescRef.current) target.setAttribute('aria-describedby', prevDescRef.current);
      else target.removeAttribute('aria-describedby');
      prevDescRef.current = null;
    };

    // keepPending: 다른 대상으로 이동 중이면 그 대상의 표시 예약은 살려 둔다 —
    // grace 만료가 다음 툴팁의 300ms 타이머를 죽이면 안 된다.
    const hide = ({ keepPending = false } = {}) => {
      if (!keepPending) clearShowTimer();
      clearGrace();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const cur = tipRef.current;
      if (!cur) return;
      restoreDesc(cur.target);
      warmUntilRef.current = Date.now() + WARM_MS;
      tipRef.current = null;
      hoverOnRef.current = false;
      focusOnRef.current = false;
      setTip(null);
      setPos(null);
    };

    // hover 근거가 풀렸을 때 — 간극 통과를 위해 잠깐 기다렸다 숨긴다.
    const hideSoon = () => {
      clearGrace();
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        if (hoverOnRef.current || focusOnRef.current) return;
        hide({ keepPending: true });
        // 키보드 포커스가 여전히 다른 [data-tip] 위면 그 툴팁을 복원한다 —
        // hover가 포커스 툴팁을 밀어냈다가 떠난 경우.
        const ae = document.activeElement;
        if (ae instanceof Element && ae.matches(':focus-visible')) {
          const ft = ae.closest('[data-tip]');
          if (ft) showNow(ft, 'focus');
        }
      }, HIDE_GRACE_MS);
    };

    const showNow = (target, source) => {
      const text = target.getAttribute('data-tip');
      if (!target.isConnected || !text) return;
      const cur = tipRef.current;
      if (cur?.target === target) {
        if (source === 'hover') hoverOnRef.current = true;
        else focusOnRef.current = true;
        clearGrace();
        return;
      }
      if (cur) restoreDesc(cur.target);
      prevDescRef.current = target.getAttribute('aria-describedby');
      target.setAttribute(
        'aria-describedby',
        prevDescRef.current ? `${prevDescRef.current} ${TIP_ID}` : TIP_ID,
      );
      const next = { target, text };
      tipRef.current = next;
      hoverOnRef.current = source === 'hover';
      focusOnRef.current = source === 'focus';
      clearGrace();
      setTip(next);
      setPos(null); // 렌더 후 layout effect가 측정·배치
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          if (tipRef.current && !tipRef.current.target.isConnected) hide();
        }, CONNECTED_POLL_MS);
      }
    };

    const schedule = (target) => {
      clearShowTimer();
      if (Date.now() < warmUntilRef.current) {
        showNow(target, 'hover');
        return;
      }
      pendingRef.current = target;
      showTimerRef.current = setTimeout(() => {
        const t = pendingRef.current;
        clearShowTimer();
        if (t) showNow(t, 'hover');
      }, SHOW_DELAY_MS);
    };

    const findTip = (node) =>
      node instanceof Element ? node.closest('[data-tip]') : null;
    const inCard = (node) =>
      node instanceof Node && !!cardRef.current && cardRef.current.contains(node);

    const onMouseOver = (e) => {
      if (window.matchMedia('(hover: none)').matches) return;
      const cur = tipRef.current;
      if (inCard(e.target)) {
        // 카드 위 — hover 근거 유지
        if (cur) {
          hoverOnRef.current = true;
          clearGrace();
        }
        return;
      }
      const t = findTip(e.target);
      if (!t) return;
      if (cur?.target === t) {
        hoverOnRef.current = true;
        clearGrace();
        return;
      }
      if (pendingRef.current !== t) schedule(t);
    };

    const onMouseOut = (e) => {
      const to = e.relatedTarget;
      // 예약된 표시: 예약 대상을 벗어나면 취소 (중첩 [data-tip]도 개별 판단)
      if (
        pendingRef.current &&
        pendingRef.current.contains(e.target) &&
        !(to && pendingRef.current.contains(to))
      )
        clearShowTimer();
      const cur = tipRef.current;
      if (!cur) return;
      if (to && (inCard(to) || cur.target.contains(to))) return;
      if (!(inCard(e.target) || cur.target.contains(e.target))) return;
      // 대상/카드에서 밖으로 — hover 근거 해제, 유예 후 숨김
      hoverOnRef.current = false;
      if (!focusOnRef.current) hideSoon();
    };

    const onFocusIn = (e) => {
      const t = findTip(e.target);
      if (t && e.target.matches(':focus-visible')) {
        showNow(t, 'focus');
        return;
      }
      // 툴팁 대상 밖으로 포커스 이동(권한 다이얼로그 자동 포커스 등) → 숨김
      const cur = tipRef.current;
      if (cur && !cur.target.contains(e.target)) hide();
    };

    const onFocusOut = (e) => {
      const cur = tipRef.current;
      if (!cur || !focusOnRef.current) return;
      if (e.relatedTarget && cur.target.contains(e.relatedTarget)) return;
      focusOnRef.current = false;
      if (!hoverOnRef.current) hide();
    };

    const onKeyDown = (e) => {
      // 캡처 단계 등록 — 모달이 Escape를 stopPropagation해도 툴팁은 닫혀야 한다.
      if (e.key === 'Escape') hide();
    };
    const onDismiss = () => hide();

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDismiss);
    document.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onDismiss);
      document.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
      hide();
    };
  }, []);

  // 렌더 직후 실제 카드 크기를 재서 배치 (측정 전 프레임은 visibility:hidden)
  useLayoutEffect(() => {
    if (!tip || !cardRef.current || !tip.target.isConnected) return;
    const tr = tip.target.getBoundingClientRect();
    const cr = cardRef.current.getBoundingClientRect();
    const p = computeTipPosition(
      tr,
      { width: cr.width, height: cr.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos({ top: p.top, left: p.left });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={cardRef}
      id={TIP_ID}
      role="tooltip"
      className="tip-card"
      style={
        pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }
      }
    >
      {tip.text}
    </div>
  );
}
