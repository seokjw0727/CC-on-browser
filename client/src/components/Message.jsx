// message 아이템 하나를 kind별로 렌더.
// assistant-text는 delta 덩어리를 그대로 그리지 않고 rAF 페이서(lib/stream-pace)로
// 매 프레임 조금씩 드러내 타자기처럼 부드럽게 출력한다(reduced-motion이면 즉시 전체).
import { useEffect, useMemo, useState } from 'react';
import { render } from '../lib/markdown.js';
import { fmtTok } from '../lib/format.js';
import { nextShown } from '../lib/stream-pace.js';
import ToolCard from './ToolCard.jsx';
import ThinkingBlock from './ThinkingBlock.jsx';

function rawSummary(payload) {
  if (!payload || typeof payload !== 'object') return '이벤트';
  const t = payload.type ?? '?';
  return payload.subtype ? `이벤트 ${t}/${payload.subtype}` : `이벤트 ${t}`;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 긴 본문은 프레임마다 marked+DOMPurify+hljs로 전체 프리픽스를 재파싱하는 비용이
// 커진다(파싱량 ∝ 전체 길이 — MAX_LAG는 표시 지연만 제한). 이 길이를 넘으면 틱을
// ~20fps로 묶어 파싱 횟수를 상한한다 — 페이서가 dt 기반이라 표시 속도는 동일하다.
const HEAVY_LEN = 8000;
const HEAVY_TICK_MS = 48;

function AssistantText({ item, enter, isNew }) {
  const full = item.text || '';
  // 라이브로 갓 등장한 블록(isNew)만 0부터 드러낸다 — 과거 대화 프리로드/세션 전환은
  // 즉시 전체. item.streaming 기준은 안 된다: delta~result가 한 번에 몰려오면
  // 첫 커밋 전에 리듀서가 전부 처리돼 streaming=false + 전체 텍스트로 마운트된다(실측).
  const [shown, setShown] = useState(() =>
    isNew && !prefersReducedMotion() ? 0 : full.length,
  );
  const catching = shown < full.length;

  useEffect(() => {
    if (!catching) return undefined;
    if (prefersReducedMotion()) {
      setShown(full.length);
      return undefined;
    }
    // 틱당 1회 전진 → setState → 이 effect 재실행이 다음 틱을 예약한다.
    // dt는 "예약~발화" 실측치 — 주사율(60/144Hz)이나 아래 heavy 지연과 무관하게
    // 같은 속도로 보이고, 창 가림 등으로 rAF가 스로틀링돼도 상한(100ms) 안에서만
    // 전진한다(밀린 분량은 MAX_LAG 클램프가 즉시 건너뛰므로 복귀 시 지연 없음).
    const scheduled = performance.now();
    let raf = 0;
    const tick = (now) => {
      const dt = Math.min(100, now - scheduled);
      setShown((s) => nextShown(s, full, !!item.streaming, dt));
    };
    const timer =
      full.length > HEAVY_LEN
        ? setTimeout(() => {
            raf = requestAnimationFrame(tick);
          }, HEAVY_TICK_MS)
        : 0;
    if (!timer) raf = requestAnimationFrame(tick);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [catching, shown, full, item.streaming]);

  const html = useMemo(
    () => render(catching ? full.slice(0, shown) : full),
    [catching, shown, full],
  );

  return (
    <div className={`msg msg-assistant${enter}`}>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      {(item.streaming || catching) && <span className="stream-cursor" />}
    </div>
  );
}

export default function Message({ item, isNew }) {
  const enter = isNew ? ' msg-enter' : '';
  switch (item.kind) {
    case 'user-text':
      return (
        <div className={`msg msg-user${enter}`}>
          <pre className="user-text">{item.text}</pre>
        </div>
      );

    case 'assistant-text':
      return <AssistantText item={item} enter={enter} isNew={isNew} />;

    case 'thinking':
      return <div className={enter ? 'msg-enter' : undefined}><ThinkingBlock item={item} /></div>;

    case 'tool_use':
      return <div className={enter ? 'msg-enter' : undefined}><ToolCard item={item} /></div>;

    case 'notice':
      return <div className={`msg msg-notice dim${enter}`}>{item.text}</div>;

    case 'usage':
      return (
        <div className={`msg msg-usage${enter}`}>
          ↑ {fmtTok(item.inTok)} ↓ {fmtTok(item.outTok)} tok
          {typeof item.durationMs === 'number'
            ? ` · ${(item.durationMs / 1000).toFixed(1)}s`
            : ''}
        </div>
      );

    case 'error':
      return <div className={`msg msg-error${enter}`}>{item.text}</div>;

    case 'raw':
      return (
        <details className={`msg-raw${enter}`}>
          <summary className="dim">{rawSummary(item.payload)}</summary>
          <pre>{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
      );

    default:
      return null;
  }
}
