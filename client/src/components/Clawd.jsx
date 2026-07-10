// CLAW'D — 컴포저 우측 하단 마스코트의 상태 기반 애니메이션.
// 실제 claude CLI 바이너리에 내장된 공식 아트·포즈를 그대로 옮긴 프레임을
// 스왑한다(외부 GIF/이미지 없음 — 로컬 CSP 안전). 색은 interact.css의
// .px-body/.px-eye(공식 clawd_body 주황/검정 눈)가 입힌다.
//
// 무드(세션 상태 → 애니메이션):
//   idle  — 느린 바운스 + 무작위 깜박임(눈 프레임 스왑)
//   busy  — thinking/tool 턴 진행 중: 좌우 두리번(look-left/right 교대) + 빠른 바운스
//   alert — 권한 응답 대기: 집게 들어올린 arms-up 포즈 + 홉
//   doze  — 세션 없음/종료/연결 끊김: 눈 감고 팔 붙인 채 느리게 숨쉬기(흐리게)
// 클릭하면 스쿼시(찌르기 반응). prefers-reduced-motion이면 모든 모션·타이머 정지.
// 프레임 비트맵·무드 매핑(순수 데이터)은 lib/clawd.js — node --test 검증 대상.
import { useEffect, useState } from 'react';
import { CLAWD_FRAMES, CLAWD_PIXEL_ASPECT, clawdMood } from '../lib/clawd.js';
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

// '1'=몸통, '2'=눈. 쿼드런트 픽셀은 터미널 셀 비율대로 세로 2배(1x2)로 그린다.
export function FrameSvg({ bits, scale = 4, className = '' }) {
  const cols = bits[0].length;
  const rows = bits.length;
  const body = [];
  const eyes = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = bits[y][x];
      if (c === '0') continue;
      (c === '2' ? eyes : body).push(
        <rect key={`${x}-${y}`} x={x} y={y * CLAWD_PIXEL_ASPECT} width="1" height={CLAWD_PIXEL_ASPECT} />,
      );
    }
  }
  return (
    <svg
      className={`mascot ${className}`.trim()}
      width={cols * scale}
      height={rows * CLAWD_PIXEL_ASPECT * scale}
      viewBox={`0 0 ${cols} ${rows * CLAWD_PIXEL_ASPECT}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g className="px-body">{body}</g>
      <g className="px-eye">{eyes}</g>
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
      // CLI의 작업 중 애니메이션처럼 좌우를 두리번거린다(look-left ↔ look-right).
      setFrame('lookLeft');
      const t = setInterval(
        () => setFrame((f) => (f === 'lookLeft' ? 'lookRight' : 'lookLeft')),
        STEP_MS,
      );
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
