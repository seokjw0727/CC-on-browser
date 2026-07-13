// CLAW'D — 컴포저 우측 하단 마스코트의 상태 기반 애니메이션.
// 실제 claude CLI 바이너리에 내장된 공식 아트·포즈를 그대로 옮긴 프레임을
// 스왑한다(외부 GIF/이미지 없음 — 로컬 CSP 안전). 색은 interact.css의
// .px-body/.px-eye(공식 clawd_body 주황/검정 눈)가 입힌다.
// 무드 어휘는 clawd-on-desk의 state-mapping.md 축소 이식 — lib/clawd.js 헤더 참조.
//
// 무드(세션 상태 → 애니메이션):
//   idle   — 느린 바운스 + 무작위 깜박임 + 커서 눈 추적(lookLeft/Right)
//   think  — thinking: 말풍선(CSS 점 3개) + 바운스 + 깜박임
//   busy   — tool 실행 중: 좌우 두리번(look-left/right 교대) + 빠른 바운스
//   juggle — 서브에이전트(Task/Agent) 실행 중: 집게 들고 눈이 공을 쫓는다
//   alert  — 권한 응답 대기: 집게 들어올린 arms-up 포즈 + 홉
//   happy  — 턴 정상 종료 직후 2.4s: 집게 펌프 + 환호 홉 (일회성)
//   error  — 턴 에러 종료·연타 이스터에그: 눈 팽글 + 셰이크 (일회성)
//   sleep  — idle에서 유저 무활동 60s: 졸기 + zzz(CSS 텍스트), 입력에 깬다
//   doze   — 세션 없음/종료/연결 끊김: 눈 감고 팔 붙인 채 느리게 숨쉬기(흐리게)
// 클릭하면 스쿼시(찌르기), 1.6s 내 4연타면 어지럼(이스터에그).
// 직접 중단(interrupt)한 턴은 happy/error 무반응(interrupted prop — DA #24).
// prefers-reduced-motion 또는 ≤900px(CSS가 마스코트를 숨김)이면 모든
// 모션·타이머·전역 리스너 정지.
// 프레임 비트맵·무드 매핑(순수 데이터)은 lib/clawd.js — node --test 검증 대상.
import { useEffect, useRef, useState } from 'react';
import {
  CLAWD_FRAMES,
  CLAWD_PIXEL_ASPECT,
  CLAWD_REACT_MS,
  CLAWD_SLEEP_MS,
  CLAWD_POKE_DIZZY_COUNT,
  CLAWD_POKE_DIZZY_WINDOW_MS,
  clawdMood,
  clawdVisualMood,
  clawdTurnEnd,
  eyeOffsetFor,
} from '../lib/clawd.js';
import './interact.css';

const BLINK_MS = 130;
const STEP_MS = 220; // busy 두리번
const JUGGLE_MS = 260; // juggle 눈-공 왕복
const CHEER_MS = 200; // happy 집게 펌프
const DIZZY_MS = 90; // error 눈 팽글
const SLEEP_POLL_MS = 5000; // 무활동 판정 주기(리스너는 타임스탬프만 갱신)
// interact.css의 `.composer-mascot { display: none }` 미디어 규칙과 반드시 동기 —
// CSS로 숨겨진 동안 전역 리스너·타이머를 전부 정지시키는 게이트다 (DA #24).
const HIDDEN_QUERY = '(max-width: 900px)';
const blinkDelay = () => 2800 + Math.random() * 2800;

function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

// '1'=몸통, '2'=눈. 쿼드런트 픽셀은 터미널 셀 비율대로 세로 2배(1x2)로 그린다.
// eyeDx/eyeDy(viewBox 단위)는 눈 그룹만 커서 방향으로 밀어 연속 시선 추적을 만든다.
//
// 눈 소켓(px-socket): 눈 칸에는 몸통 rect를 그리지 않아 원래 그 자리가 "투명한 구멍"이다.
// 정지 상태엔 눈이 구멍을 덮지만, 시선 추적으로 눈 그룹을 translate하면 눈은 이동하고
// 남은 구멍으로 배경이 비쳐 "눈이 두 쌍"처럼 보인다. 이를 막으려 눈 칸마다 이동하지 않는
// 몸통색 소켓을 눈 아래에 깐다(눈이 밀려나도 뒤가 몸통색). mono 실루엣은 눈을 뚫린 구멍으로
// 두는 의도라 소켓만 투명 처리(CSS)해 원래 룩을 보존한다.
export function FrameSvg({ bits, scale = 4, className = '', eyeDx = 0, eyeDy = 0 }) {
  const cols = bits[0].length;
  const rows = bits.length;
  const body = [];
  const sockets = [];
  const eyes = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = bits[y][x];
      if (c === '0') continue;
      const rect = (
        <rect key={`${x}-${y}`} x={x} y={y * CLAWD_PIXEL_ASPECT} width="1" height={CLAWD_PIXEL_ASPECT} />
      );
      if (c === '2') {
        eyes.push(rect);
        sockets.push(
          <rect key={`s${x}-${y}`} x={x} y={y * CLAWD_PIXEL_ASPECT} width="1" height={CLAWD_PIXEL_ASPECT} />,
        );
      } else {
        body.push(rect);
      }
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
      <g className="px-socket">{sockets}</g>
      <g className="px-eye" transform={eyeDx || eyeDy ? `translate(${eyeDx} ${eyeDy})` : undefined}>
        {eyes}
      </g>
    </svg>
  );
}

export default function Clawd({
  status = 'none',
  conn = 'open',
  sessionKey = null,
  lastResult = null,
  interrupted = false,
  subagents = 0,
  scale = 4,
  className = '',
}) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const hidden = useMediaQuery(HIDDEN_QUERY); // CSS가 마스코트를 숨기는 뷰포트
  const [frame, setFrame] = useState('base');
  const [pokeTick, setPokeTick] = useState(0);
  const [transient, setTransient] = useState(null); // 'happy' | 'error' | null
  const [asleep, setAsleep] = useState(false);
  const [eyeOff, setEyeOff] = useState({ ex: 0, ey: 0 }); // 연속 시선 추적 오프셋

  const rootRef = useRef(null);
  const lastActRef = useRef(0); // 마지막 유저 입력 시각(performance.now)
  const pokesRef = useRef([]); // 연타 판정용 클릭 타임스탬프
  const transientTimerRef = useRef(null);
  const prevRef = useRef({ key: sessionKey, status });

  const fireTransient = (kind) => {
    clearTimeout(transientTimerRef.current);
    setTransient(kind);
    transientTimerRef.current = setTimeout(() => setTransient(null), CLAWD_REACT_MS);
  };
  useEffect(() => () => clearTimeout(transientTimerRef.current), []);

  // 턴 종료 감지 — reduceResult가 status를 idle로 되돌리는 그 커밋에서
  // lastResult·interruptRequested도 함께 최신이므로(단일 스토어 업데이트) 여기서
  // 읽어도 안전하다. 세션 전환(sessionKey 변경)은 턴 종료가 아니다 — 리셋만 한다.
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { key: sessionKey, status };
    if (prev.key !== sessionKey) {
      clearTimeout(transientTimerRef.current);
      setTransient(null);
      return;
    }
    if (reduced || hidden) return;
    const kind = clawdTurnEnd(prev.status, status, lastResult, interrupted);
    if (kind) fireTransient(kind);
  }, [status, sessionKey, reduced, hidden]);

  const mood = clawdVisualMood({
    status,
    conn,
    transient,
    userIdleMs: asleep ? CLAWD_SLEEP_MS : 0,
    subagents,
  });
  const base = clawdMood(status, conn);

  // 수면 — idle에서 유저 입력(포인터·키·휠)이 60s 없으면 잠들고, 입력에 깬다.
  // 리스너는 타임스탬프만 갱신하고 판정은 5s 폴링 — mousemove마다 리렌더하지 않는다.
  useEffect(() => {
    if (hidden || reduced || base !== 'idle') {
      setAsleep(false);
      return undefined;
    }
    lastActRef.current = performance.now();
    const onAct = () => {
      lastActRef.current = performance.now();
      setAsleep((s) => (s ? false : s));
    };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    const iv = setInterval(() => {
      if (performance.now() - lastActRef.current >= CLAWD_SLEEP_MS) setAsleep(true);
    }, SLEEP_POLL_MS);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onAct));
      clearInterval(iv);
    };
  }, [base, reduced, hidden]);

  // 연속 시선 추적 — idle/think에서 눈 픽셀을 커서 방향으로(2D, 여러 각도) 부드럽게
  // 민다. rAF로 스로틀하고, 오프셋이 실제로 바뀔 때만 setState한다. 추적을 벗어나는
  // 무드(busy/juggle/doze 등)로 가면 눈을 정면(0,0)으로 되돌린다.
  const tracking = mood === 'idle' || mood === 'think';
  useEffect(() => {
    if (hidden || reduced || !tracking) {
      setEyeOff((o) => (o.ex === 0 && o.ey === 0 ? o : { ex: 0, ey: 0 }));
      return undefined;
    }
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      const cx = e.clientX;
      const cy = e.clientY;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const next = eyeOffsetFor(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2));
        setEyeOff((o) => (o.ex === next.ex && o.ey === next.ey ? o : next));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tracking, reduced, hidden]);

  // 무드별 프레임 타이머 — 무드가 바뀌면 이전 타이머를 정리하고 다시 시작한다.
  useEffect(() => {
    if (hidden) {
      setFrame('base'); // CSS로 숨겨진 동안은 타이머도 정지
      return undefined;
    }
    if (reduced) {
      setFrame(mood === 'doze' || mood === 'sleep' ? 'doze' : 'base');
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
    if (mood === 'juggle') {
      // 집게를 든 채 눈이 공을 쫓는다(jugLeft ↔ jugRight).
      setFrame('jugLeft');
      const t = setInterval(
        () => setFrame((f) => (f === 'jugLeft' ? 'jugRight' : 'jugLeft')),
        JUGGLE_MS,
      );
      return () => clearInterval(t);
    }
    if (mood === 'happy') {
      // 환호 — 집게를 번쩍(claws)·내리기(base)를 반복(펌프), 홉은 CSS.
      setFrame('claws');
      const t = setInterval(
        () => setFrame((f) => (f === 'claws' ? 'base' : 'claws')),
        CHEER_MS,
      );
      return () => clearInterval(t);
    }
    if (mood === 'error') {
      // 어지럼 — 눈이 빠르게 좌우로 팽글, 셰이크는 CSS.
      setFrame('lookLeft');
      const t = setInterval(
        () => setFrame((f) => (f === 'lookLeft' ? 'lookRight' : 'lookLeft')),
        DIZZY_MS,
      );
      return () => clearInterval(t);
    }
    if (mood === 'alert') {
      setFrame('claws');
      return undefined;
    }
    if (mood === 'doze' || mood === 'sleep') {
      setFrame('doze');
      return undefined;
    }
    // idle/think: 무작위 간격 깜박임. 정지 프레임은 base 고정 — 눈의 방향은
    // 프레임 교체가 아니라 눈 그룹 translate(eyeOff)로 연속 추적한다.
    const restFrame = () => 'base';
    setFrame(restFrame());
    let alive = true;
    let timer;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setFrame('blink');
        timer = setTimeout(() => {
          if (!alive) return;
          setFrame(restFrame());
          schedule();
        }, BLINK_MS);
      }, blinkDelay());
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mood, reduced, hidden]);

  // 찌르기 + 연타 이스터에그 — 1.6s 안에 4번 찌르면 어지럼(레퍼런스 click reactions).
  const onPoke = () => {
    setPokeTick((t) => t + 1);
    if (reduced) return;
    const now = performance.now();
    const arr = pokesRef.current.filter((t) => now - t < CLAWD_POKE_DIZZY_WINDOW_MS);
    arr.push(now);
    pokesRef.current = arr;
    if (arr.length >= CLAWD_POKE_DIZZY_COUNT) {
      pokesRef.current = [];
      fireTransient('error');
    }
  };

  return (
    // 장식용 이스터에그(찌르기) — 필수 기능이 아니므로 포커스 대상에서 제외한다.
    // 바운스(.clawd-bob)와 스쿼시(.clawd-poke)는 레이어를 분리해 animation 충돌을 피한다.
    <span
      ref={rootRef}
      className={`clawd mood-${mood} ${className}`.trim()}
      aria-hidden="true"
      onClick={onPoke}
    >
      <span className="clawd-bob">
        {/* key 교체로 스쿼시 애니메이션을 매 클릭 재생 */}
        <span key={pokeTick} className={`clawd-poke${pokeTick > 0 ? ' poked' : ''}`}>
          <FrameSvg
            bits={CLAWD_FRAMES[frame] ?? CLAWD_FRAMES.base}
            scale={scale}
            eyeDx={eyeOff.ex}
            eyeDy={eyeOff.ey}
          />
        </span>
      </span>
      {mood === 'think' && (
        <span className="clawd-bubble">
          <i />
          <i />
          <i />
        </span>
      )}
      {mood === 'sleep' && (
        <span className="clawd-zzz">
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
      )}
    </span>
  );
}
