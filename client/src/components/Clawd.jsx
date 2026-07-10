// CLAW'D — 컴포저 우측 하단 마스코트의 상태 기반 애니메이션 (clawd-on-desk 참조).
// 자기완결형 픽셀 프레임 스왑(외부 GIF/이미지 없음 — 로컬 CSP 안전) + CSS 모션.
//
// 무드(세션 상태 → 애니메이션):
//   idle  — 느린 바운스 + 무작위 깜박임(눈 프레임 스왑)
//   busy  — thinking/tool 턴 진행 중: 다리 스캐틀(2프레임 교대) + 빠른 바운스
//   alert — 권한 응답 대기: 집게 들어올린 프레임 + 홉
//   doze  — 세션 없음/종료/연결 끊김: 더듬이 접힌 채 눈 감고 느리게 숨쉬기(흐리게)
// 클릭하면 스쿼시(찌르기 반응). prefers-reduced-motion이면 모든 모션·타이머 정지.
// 프레임 비트맵·무드 매핑(순수 데이터)은 lib/clawd.js — node --test 검증 대상.
import { useEffect, useState } from 'react';
import { CLAWD_FRAMES, clawdMood } from '../lib/clawd.js';
import './interact.css';

const BLINK_MS = 130;
const STEP_MS = 220;
const blinkDelay = () => 2800 + Math.random() * 2800;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function FrameSvg({ bits, scale }) {
  const cols = bits[0].length;
  const rows = bits.length;
  const rects = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (bits[y][x] === '1') {
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />);
      }
    }
  }
  return (
    <svg
      className="mascot"
      width={cols * scale}
      height={rows * scale}
      viewBox={`0 0 ${cols} ${rows}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects}
    </svg>
  );
}

export default function Clawd({ status = 'none', conn = 'open', scale = 4, className = '' }) {
  const mood = clawdMood(status, conn);
  const reduced = usePrefersReducedMotion();
  const [frame, setFrame] = useState('base');
  const [pokeTick, setPokeTick] = useState(0);

  // 무드별 프레임 타이머 — 무드가 바뀌면 이전 타이머를 정리하고 다시 시작한다.
  useEffect(() => {
    if (reduced) {
      setFrame(mood === 'doze' ? 'doze' : 'base');
      return undefined;
    }
    if (mood === 'busy') {
      setFrame('base');
      const t = setInterval(() => setFrame((f) => (f === 'step' ? 'base' : 'step')), STEP_MS);
      return () => clearInterval(t);
    }
    if (mood === 'alert') {
      setFrame('claws');
      return undefined;
    }
    if (mood === 'doze') {
      setFrame('doze');
      return undefined;
    }
    // idle: 무작위 간격 깜박임
    setFrame('base');
    let alive = true;
    let timer;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setFrame('blink');
        timer = setTimeout(() => {
          if (!alive) return;
          setFrame('base');
          schedule();
        }, BLINK_MS);
      }, blinkDelay());
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mood, reduced]);

  return (
    // 장식용 이스터에그(찌르기) — 필수 기능이 아니므로 포커스 대상에서 제외한다.
    // 바운스(.clawd-bob)와 스쿼시(.clawd-poke)는 레이어를 분리해 animation 충돌을 피한다.
    <span
      className={`clawd mood-${mood} ${className}`.trim()}
      aria-hidden="true"
      onClick={() => setPokeTick((t) => t + 1)}
    >
      <span className="clawd-bob">
        {/* key 교체로 스쿼시 애니메이션을 매 클릭 재생 */}
        <span key={pokeTick} className={`clawd-poke${pokeTick > 0 ? ' poked' : ''}`}>
          <FrameSvg bits={CLAWD_FRAMES[frame] ?? CLAWD_FRAMES.base} scale={scale} />
        </span>
      </span>
    </span>
  );
}
