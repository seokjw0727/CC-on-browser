// message 아이템 하나를 kind별로 렌더.
// assistant-text는 delta 덩어리를 그대로 그리지 않고 rAF 페이서(lib/stream-pace)로
// 매 프레임 조금씩 드러내 타자기처럼 부드럽게 출력한다(reduced-motion이면 즉시 전체).
import { cloneElement, memo, useEffect, useMemo, useState } from 'react';
import { render } from '../lib/markdown.js';
import { fmtTok, fmtClock } from '../lib/format.js';
import { nextShown } from '../lib/stream-pace.js';
import ToolCard from './ToolCard.jsx';
import ThinkingBlock from './ThinkingBlock.jsx';

// 메시지 꼬리표 시각. item.at이 없으면(옛 프리로드 등) 아무것도 렌더하지 않는다.
// dateTime에는 ISO 전체를, title에는 로케일 전체 시각을 실어 hover로 날짜까지 볼 수 있게 한다.
function Stamp({ at, pending = false }) {
  const label = fmtClock(at);
  if (!label) return null;
  // 스트리밍 중에는 시각을 감추되 **자리는 차지한다**. 끝난 뒤에 꼬리표가 새로
  // 생기면 그만큼 높이가 늘어, 이미 하단에 고정해 둔 스크롤이 그 높이만큼 밀려
  // "맨 아래"가 아니게 된다(윈도잉 e2e가 이걸 잡았다).
  if (pending) return <time className="msg-time" aria-hidden="true">{' '}</time>;
  const d = new Date(at);
  return (
    <time className="msg-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {label}
    </time>
  );
}

function rawSummary(payload) {
  if (!payload || typeof payload !== 'object') return '이벤트';
  const t = payload.type ?? '?';
  return payload.subtype ? `이벤트 ${t}/${payload.subtype}` : `이벤트 ${t}`;
}

// 디버그 모드 — 프로토콜 내부(raw) 이벤트를 노출할지. 기본 꺼짐. 개발 시
// localStorage.setItem('ccob-debug','1') 또는 window.__CCOB_DEBUG=true로 켠다.
// ChatView가 이 값을 store의 debugRaw와 합쳐 `debug` prop으로 내려 준다 — Message가
// memo라서 여기서 직접 읽으면 토글해도 기존 메시지가 다시 렌더되지 않는다.
export function debugEnabled() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__CCOB_DEBUG === true) return true;
    return window.localStorage?.getItem('ccob-debug') === '1';
  } catch {
    return false;
  }
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

function AssistantText({ item, enter, isNew, id }) {
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
    <div className={`msg msg-assistant${enter}`} id={id}>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      {(item.streaming || catching) && <span className="stream-cursor" />}
      {/* 시각은 스트리밍이 끝난 뒤에 드러내되 자리는 처음부터 잡아 둔다(Stamp 주석 참조). */}
      <Stamp at={item.at} pending={!!item.streaming || catching} />
    </div>
  );
}

// /compact 진행/완료 카드 — 진행 중엔 부정형(indeterminate) 진행바, 완료 시엔
// 채워진 바 + 토큰 감소량으로 "압축이 끝났음"을 명확히 보여준다.
function CompactionCard({ item }) {
  const running = item.state === 'running';
  const canceled = item.state === 'canceled'; // 인터럽트/실패로 끝난 압축
  const pre = item.preTokens;
  const post = item.postTokens;
  const hasNums = Number.isFinite(pre) && Number.isFinite(post) && pre > 0;
  const reducedPct = hasNums ? Math.max(0, Math.round((1 - post / pre) * 100)) : null;
  const stateCls = running ? ' running' : canceled ? ' canceled' : ' done';
  // 완료 바는 감소율(%)을 채움으로 시각화한다(숫자를 모르면 100% = 그냥 "완료").
  const fillPct = reducedPct ?? 100;
  return (
    <div className={`compaction-card${stateCls}`}>
      <div className="compaction-head">
        <span className="compaction-ico" aria-hidden="true">
          {running ? '🗜' : canceled ? '⊘' : '✓'}
        </span>
        <span className="compaction-title">
          {running ? '컨텍스트 압축 중…' : canceled ? '컨텍스트 압축 중단됨' : '컨텍스트 압축 완료'}
        </span>
        <span className="spacer" />
        {!running && !canceled && reducedPct != null && (
          <span className="compaction-pct">{reducedPct}% 감소</span>
        )}
      </div>
      <div
        className="compaction-bar"
        role="progressbar"
        aria-label={
          running
            ? '컨텍스트 압축 진행 중'
            : canceled
              ? '컨텍스트 압축 중단됨'
              : `컨텍스트 압축 완료 — ${reducedPct ?? 0}% 감소`
        }
        aria-valuemin={0}
        aria-valuemax={100}
        {...(running || canceled ? {} : { 'aria-valuenow': fillPct })}
      >
        <span
          className="compaction-fill"
          style={running || canceled ? undefined : { width: `${fillPct}%` }}
        />
      </div>
      {!running && !canceled && hasNums && (
        <div className="compaction-detail dim">
          {pre.toLocaleString()} → {post.toLocaleString()} 토큰
          {Number.isFinite(item.durationMs) ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}
          {item.trigger === 'auto' ? ' · 자동' : ''}
        </div>
      )}
    </div>
  );
}

// 이전 대화 압축 요약(isCompactSummary user 메시지) — 접이식으로 보존.
function CompactionSummary({ item }) {
  return (
    <details className="compaction-summary">
      <summary className="dim">📄 이전 대화 압축 요약 — 펼치기</summary>
      <pre className="compaction-summary-body">{item.text}</pre>
    </details>
  );
}

// 점프 대상 id 주입 — 실행 중 도크가 이 id로 스크롤한다.
// 래퍼 <div>를 씌우지 않고 각 kind가 만든 최상위 요소에 id만 얹는다.
// display:contents 래퍼로 감쌌더니 레이아웃 박스가 사라져 ChatView의 읽기 위치
// 앵커(offsetTop 기반)가 통째로 깨졌다 — DOM 모양은 예전 그대로여야 한다.
function Message(props) {
  const body = MessageBody(props);
  if (body == null) return null;
  return cloneElement(body, { id: `msg-${props.item.uid}` });
}

function MessageBody({ item, isNew, debug = false, onPreview }) {
  const enter = isNew ? ' msg-enter' : '';
  switch (item.kind) {
    case 'user-text':
      return (
        <div className={`msg msg-user${enter}`}>
          <pre className="user-text">{item.text}</pre>
          <Stamp at={item.at} />
        </div>
      );

    case 'assistant-text':
      return <AssistantText item={item} enter={enter} isNew={isNew} />;

    case 'thinking':
      // 본문이 비어 있고(최종 블록은 서명만) 편집표시·스트리밍도 아니면 렌더 생략 —
      // 재개 트랜스크립트엔 사고 원문이 없어 빈 "사고 과정" 토글만 남는다.
      if (!item.thinking && !item.redacted && !item.streaming) return null;
      return <div className={enter ? 'msg-enter' : undefined}><ThinkingBlock item={item} /></div>;

    case 'tool_use':
      // onPreview는 ChatView가 useCallback으로 만든 안정된 참조여야 한다 — 매 렌더
      // 새 함수를 내려보내면 아래 memo가 무력화돼 스트리밍 델타마다 보이는 메시지가
      // 전부 다시 그려진다(윈도잉/memo로 얻은 이득이 사라진다).
      return <div className={enter ? 'msg-enter' : undefined}><ToolCard item={item} onPreview={onPreview} /></div>;

    case 'command':
      return (
        <div className={`msg msg-command${enter}`}>
          <span className="cmd-chip">
            <span className="cmd-chip-ico" aria-hidden="true">⌘</span>
            <span className="cmd-chip-name">/{item.name}</span>
            {item.args ? <span className="cmd-chip-args">{item.args}</span> : null}
          </span>
        </div>
      );

    case 'command-output':
      return (
        <div className={`msg msg-cmd-output${item.isError ? ' err' : ''}${enter}`}>
          <pre className="cmd-output-body">{item.text}</pre>
        </div>
      );

    case 'compaction':
      return <div className={enter ? 'msg-enter' : undefined}><CompactionCard item={item} /></div>;

    case 'compaction-summary':
      return <div className={enter ? 'msg-enter' : undefined}><CompactionSummary item={item} /></div>;

    case 'cleared':
      // separator 롤은 자식이 접근성 트리에서 pruning되므로(Blink) 이름을 aria-label로 준다.
      return (
        <div
          className={`msg msg-cleared${enter}`}
          role="separator"
          aria-label="대화 컨텍스트가 초기화되었습니다 (/clear)"
        >
          <span className="cleared-line" aria-hidden="true" />
          <span className="cleared-label">🧹 대화 컨텍스트가 초기화되었습니다 · /clear</span>
          <span className="cleared-line" aria-hidden="true" />
        </div>
      );

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
      // 프로토콜 내부 이벤트(미지 타입·시스템 서브타입·고아 tool_result 등)는 사용자가
      // 볼 필요가 없어 기본 숨김이다 — 디버그 모드에서만 접이식으로 노출한다.
      if (!debug) return null;
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

// 스트리밍 델타마다 스토어 상태가 바뀌어 ChatView가 리렌더되는데, 리듀서는 새 messages
// 배열을 만들면서도 **건드리지 않은 아이템의 객체 참조는 그대로 넘긴다**(reduce-cli-event의
// updateByUid는 대상 uid만 교체하고 나머지는 원본 객체를 그대로 둔다). 그래서 memo가
// 정확히 "바뀐 메시지 하나"만 다시 그린다.
// 실측 2026-07-27(메시지 1920개, 응답 1개 스트리밍 200델타):
//   - memo만 적용(윈도잉 없음): 총 블로킹 1961ms → 0ms
//   - 윈도잉 위에 얹었을 때의 추가 이득: JS 799→417ms, 레이아웃 525→98ms, 스타일 189→45ms
// 주의 — memo가 걸린 뒤로는 렌더 중에 읽는 **외부 가변 상태가 있으면 안 된다**:
// 그래서 raw 표시 여부(debugRaw/window.__CCOB_DEBUG)를 debug prop으로 받는다.
export default memo(Message);
