// 컴포저(레퍼런스 충실) — 상단 pill 행(레포·권한모드), 입력, 하단 컨트롤(모델·전송),
// 그 아래 상태줄(컨텍스트·5h/7d 사용량·비용·rate limit·연결·테마). 상단 바를 대체한다.
// Enter 전송/Shift+Enter 개행, `/` 커맨드 드롭다운, Esc/버튼 interrupt.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { Mascot } from './Brand.jsx';
import './interact.css';

const MAX_HEIGHT_PX = 200;

const MODE_LABEL = {
  default: '매번 확인',
  acceptEdits: '편집 수락',
  plan: '플랜 모드',
  bypassPermissions: '전체 허용',
};
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const CONN_LABEL = { connecting: '연결 중', open: '연결됨', closed: '연결 끊김' };

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}
function fmtCost(c) {
  return typeof c === 'number' ? `$${c.toFixed(4)}` : '$0.0000';
}
const CONTEXT_WINDOW = 200_000; // Claude 표준 컨텍스트 창(200k tok) 기준 사용률
function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function usageWindowTitle(label, b) {
  return (
    `${label} — 입력 ${b.inputTokens.toLocaleString()}` +
    ` · 출력 ${b.outputTokens.toLocaleString()}` +
    ` · 캐시읽기 ${b.cacheReadTokens.toLocaleString()}` +
    ` · 캐시생성 ${b.cacheCreationTokens.toLocaleString()} tok` +
    ' (로컬 트랜스크립트 집계)'
  );
}
function fmtResetsAt(resetsAt) {
  if (resetsAt == null) return null;
  const n = Number(resetsAt);
  if (!Number.isFinite(n)) return String(resetsAt);
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(resetsAt);
  }
}

export default function Composer({ theme, onToggleTheme }) {
  const { state, dispatch, send } = useStore();
  const session = useActiveSession();
  const [text, setText] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const taRef = useRef(null);

  const busy = !!session && session.status !== 'idle' && session.status !== 'exited';
  const exited = session?.status === 'exited';
  const live = !!session && session.status !== 'exited';
  const canSend =
    !!session && session.status === 'idle' && state.conn === 'open' && text.trim() !== '';

  const models = Array.isArray(state.initInfo?.models) ? state.initInfo.models : [];
  const modelValue = session?.model ?? '';
  const modelInList = models.some((m) => m.value === modelValue);
  const rl = session?.rateLimit;
  const rlWarn = rl && rl.status && rl.status !== 'allowed';
  const gu = state.globalUsage;
  const ctxTokens = session?.usage?.contextTokens || 0;
  const ctxPct = Math.min(999, Math.round((ctxTokens / CONTEXT_WINDOW) * 100));

  // ----- `/` 커맨드 드롭다운 -----
  const commands = useMemo(() => {
    const list = state.initInfo?.commands;
    if (!Array.isArray(list)) return [];
    return list
      .map((c) => (typeof c === 'string' ? { name: c, description: '' } : c))
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ ...c, name: c.name.replace(/^\//, '') }));
  }, [state.initInfo]);

  const cmdMatch = /^\/([\w:.-]*)$/.exec(text);
  const filtered = cmdMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith(cmdMatch[1].toLowerCase()))
    : [];
  const dropdownOpen = !cmdDismissed && !!cmdMatch && filtered.length > 0;

  useEffect(() => {
    setCmdDismissed(false);
    setSelIdx(0);
  }, [text]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const pickCommand = (cmd) => {
    if (!cmd) return;
    setText(`/${cmd.name} `);
    taRef.current?.focus();
  };

  const doSend = () => {
    if (!canSend) return;
    const t = text;
    const ok = send({ type: 'send', key: session.key, text: t });
    if (!ok) return;
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({
        ...reduceCliEvent(s, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        }),
        status: s.status === 'idle' ? 'thinking' : s.status,
      }),
    });
    setText('');
  };

  const doInterrupt = () => {
    if (busy) send({ type: 'interrupt', key: session.key });
  };

  // 낙관적 UI 갱신은 실제 전송이 성공했을 때만 — 끊긴 상태에서 바꾸면
  // CLI에 전달되지 않는데 UI만 바뀌어 모델/권한모드가 desync되는 것을 막는다.
  const changeModel = (model) => {
    if (!session || !model) return;
    if (!send({ type: 'setModel', key: session.key, model })) return;
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, model }) });
  };
  const changeMode = (mode) => {
    if (!session || !mode) return;
    if (!send({ type: 'setPermissionMode', key: session.key, mode })) return;
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, permissionMode: mode }) });
  };

  const onKeyDown = (e) => {
    if (dropdownOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickCommand(filtered[Math.min(selIdx, filtered.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      doInterrupt();
    }
  };

  const placeholder = !session
    ? '레포를 선택하면 대화를 시작할 수 있습니다'
    : exited
      ? '세션이 종료되었습니다'
      : '작업을 설명하거나 질문하세요';

  const repoLabel = session ? shortPath(session.cwd) || session.key : '레포 선택...';

  return (
    <div className="composer-dock">
      <div className="composer-shell">
        {dropdownOpen && (
          <div className="cmd-dropdown" role="listbox" id="cmd-listbox" aria-label="슬래시 커맨드">
            {filtered.map((c, i) => (
              <div
                key={c.name}
                id={`cmd-opt-${i}`}
                role="option"
                aria-selected={i === selIdx}
                className={`cmd-item${i === selIdx ? ' sel' : ''}`}
                onMouseEnter={() => setSelIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c);
                }}
              >
                <span className="cmd-name">/{c.name}</span>
                {c.description && <span className="cmd-desc">{c.description}</span>}
              </div>
            ))}
          </div>
        )}

        {/* 상단 pill 행 — 레포(cwd) + 권한 모드 */}
        <div className="composer-top">
          <button
            type="button"
            className="pill repo-pill"
            onClick={() => dispatch({ type: 'open-new-session' })}
            title={session?.cwd || '새 세션 / 레포 선택'}
          >
            <span className="pill-ico" aria-hidden="true">☁</span>
            <span className="truncate">{repoLabel}</span>
          </button>

          {session && (
            <span className="pill-select-wrap">
              <select
                aria-label="권한 모드"
                className={`pill-select${session.permissionMode === 'bypassPermissions' ? ' danger' : ''}`}
                value={session.permissionMode || 'default'}
                disabled={!live || state.conn !== 'open'}
                title="권한 모드 (setPermissionMode)"
                onChange={(e) => changeMode(e.target.value)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>

        {/* 입력 */}
        <div className="composer-input">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={!session || exited}
            aria-label="메시지 입력"
            role="combobox"
            aria-multiline="true"
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-controls={dropdownOpen ? 'cmd-listbox' : undefined}
            aria-activedescendant={dropdownOpen ? `cmd-opt-${selIdx}` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        {/* 하단 컨트롤 — 모델 + 전송/중단 */}
        <div className="composer-foot">
          <div className="foot-left">
            {session && models.length > 0 && (
              <span className="pill-select-wrap">
                <select
                  aria-label="모델"
                  className="pill-select"
                  value={modelInList ? modelValue : ''}
                  disabled={!live || state.conn !== 'open'}
                  title="모델 (setModel)"
                  onChange={(e) => changeModel(e.target.value)}
                >
                  {!modelInList && (
                    <option value="" disabled>
                      {modelValue || '모델'}
                    </option>
                  )}
                  {models.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.displayName || m.value}
                    </option>
                  ))}
                </select>
              </span>
            )}
            <span className="foot-hint faint">Enter 전송 · Shift+Enter 개행 · / 커맨드</span>
          </div>

          <span className="spacer" />

          {busy ? (
            <button
              type="button"
              className="send-btn interrupt"
              onClick={doInterrupt}
              title="현재 턴 중단 (Esc)"
              aria-label="중단"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              disabled={!canSend}
              onClick={doSend}
              title="전송 (Enter)"
              aria-label="전송"
            >
              ↑
            </button>
          )}
        </div>
      </div>

      {/* 상태줄 — 컨텍스트·5h/7d 사용량·비용·rate limit·연결·테마 */}
      <div className="composer-meta">
        {ctxTokens > 0 && (
          <span
            className={`meta-item${ctxPct >= 80 ? ' warn' : ''}`}
            title={`현재 세션 컨텍스트(마지막 턴 기준): ${ctxTokens.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} tok`}
          >
            CTX {ctxPct}%
          </span>
        )}
        {gu?.fiveHour && (
          <span className="meta-item" title={usageWindowTitle('최근 5시간', gu.fiveHour)}>
            5h {fmtTok(gu.fiveHour.totalTokens)}
          </span>
        )}
        {gu?.sevenDay && (
          <span className="meta-item" title={usageWindowTitle('최근 7일', gu.sevenDay)}>
            7d {fmtTok(gu.sevenDay.totalTokens)}
          </span>
        )}
        {session && (
          <span
            className="meta-item"
            title={`누적 비용 ${fmtCost(session.usage.cost)} · 입력 ${session.usage.inTok} · 출력 ${session.usage.outTok} tok`}
          >
            {fmtCost(session.usage.cost)} · ↑{session.usage.inTok} ↓{session.usage.outTok}
          </span>
        )}
        {rlWarn && (
          <span className="meta-item warn" title={`rate limit: ${rl.status}${rl.rateLimitType ? ` (${rl.rateLimitType})` : ''}`}>
            ⏳ {rl.status}
            {fmtResetsAt(rl.resetsAt) ? ` · ${fmtResetsAt(rl.resetsAt)} 해제` : ''}
          </span>
        )}
        {busy && <span className="meta-item accent">응답 생성 중 — Esc로 중단</span>}
        {session && state.conn !== 'open' && (
          <span className="meta-item danger">연결 끊김 — 재접속 중…</span>
        )}
        <span className="spacer" />
        {state.lastError && (
          <span className="meta-item danger" title={state.lastError}>
            {state.lastError}
            <button type="button" className="meta-x" onClick={() => dispatch({ type: 'clear-error' })} aria-label="오류 지우기">
              ✕
            </button>
          </span>
        )}
        <span className="meta-item" title={`WebSocket: ${state.conn}`}>
          <span className={`conn-dot ${state.conn}`} /> {CONN_LABEL[state.conn] ?? state.conn}
        </span>
        <button
          type="button"
          className="meta-theme"
          onClick={onToggleTheme}
          title="테마 전환"
          aria-label="테마 전환"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>

      <Mascot className="composer-mascot" scale={4} />
    </div>
  );
}
