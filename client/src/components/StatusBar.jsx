// 상태바 — 좌: cwd·sessionId 축약 / 중: status 인디케이터 /
// 우: 모델·권한모드 변경, 비용·토큰, rateLimit 경고, 연결 상태, 테마 토글.
import { useStore, useActiveSession } from '../lib/store.jsx';
import './interact.css';

const CONN_LABEL = {
  connecting: '연결 중',
  open: '연결됨',
  closed: '연결 끊김',
};

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}

function shortId(id) {
  return id ? `${String(id).slice(0, 8)}…` : '';
}

function fmtCost(cost) {
  return typeof cost === 'number' ? `$${cost.toFixed(4)}` : '$0.0000';
}

function fmtResetsAt(resetsAt) {
  if (resetsAt == null) return null;
  const n = Number(resetsAt);
  if (!Number.isFinite(n)) return String(resetsAt);
  const ms = n > 1e12 ? n : n * 1000; // 초/밀리초 모두 허용
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(resetsAt);
  }
}

function runningToolName(session) {
  if (!session) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.kind === 'tool_use' && m.result == null) return m.name;
  }
  return null;
}

function StatusIndicator({ session }) {
  if (!session) return <span className="sb-status dim">세션 없음</span>;
  switch (session.status) {
    case 'thinking':
      return (
        <span className="sb-status">
          <span className="pulse-dot on" /> 생각 중…
          {session.thinkingTokens ? ` (~${session.thinkingTokens} tok)` : ''}
        </span>
      );
    case 'tool': {
      const tool = runningToolName(session);
      return (
        <span className="sb-status">
          <span className="pulse-dot on" /> 도구 실행 중{tool ? `: ${tool}` : ''}
        </span>
      );
    }
    case 'awaiting-permission':
      return (
        <span className="sb-status" style={{ color: 'var(--warning)' }}>
          <span className="pulse-dot on" /> 권한 승인 대기
        </span>
      );
    case 'exited':
      return <span className="sb-status dim">세션 종료됨</span>;
    default:
      return <span className="sb-status dim">대기</span>;
  }
}

export default function StatusBar({ theme, onToggleTheme, onToggleSidebar }) {
  const { state, dispatch, send } = useStore();
  const session = useActiveSession();

  const models = Array.isArray(state.initInfo?.models) ? state.initInfo.models : [];
  const live = session && session.status !== 'exited';

  const changeModel = (model) => {
    if (!session || !model) return;
    send({ type: 'setModel', key: session.key, model });
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({ ...s, model }),
    });
  };

  const changeMode = (mode) => {
    if (!session || !mode) return;
    send({ type: 'setPermissionMode', key: session.key, mode });
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({ ...s, permissionMode: mode }),
    });
  };

  const modelValue = session?.model ?? '';
  const modelInList = models.some((m) => m.value === modelValue);
  const rl = session?.rateLimit;
  const rlWarn = rl && rl.status && rl.status !== 'allowed';

  return (
    <header className="statusbar">
      <div className="sb-group">
        <button className="icon-btn" onClick={onToggleSidebar} title="사이드바 접기/펼치기">
          ☰
        </button>
        <strong className="sb-title">Claude Code on Browser</strong>
        {session && (
          <span className="sb-ctx" title={`${session.cwd ?? ''} ${session.sessionId ?? ''}`}>
            {shortPath(session.cwd)}
            {session.sessionId ? ` · ${shortId(session.sessionId)}` : ''}
          </span>
        )}
      </div>

      <span className="spacer" />
      <StatusIndicator session={session} />
      <span className="spacer" />

      <div className="sb-group">
        {state.lastError && (
          <span className="sb-error" title={state.lastError}>
            <span className="msg">{state.lastError}</span>
            <button type="button" onClick={() => dispatch({ type: 'clear-error' })}>
              ✕
            </button>
          </span>
        )}

        {rlWarn && (
          <span
            className="sb-ratelimit"
            title={`rate limit: ${rl.status}${rl.rateLimitType ? ` (${rl.rateLimitType})` : ''}`}
          >
            ⏳ {rl.status}
            {fmtResetsAt(rl.resetsAt) ? ` · ${fmtResetsAt(rl.resetsAt)} 해제` : ''}
          </span>
        )}

        {session && (
          <span
            className="sb-metric"
            title={`누적 비용 ${fmtCost(session.usage.cost)} · 입력 ${session.usage.inTok} tok · 출력 ${session.usage.outTok} tok`}
          >
            {fmtCost(session.usage.cost)} · ↑{session.usage.inTok} ↓{session.usage.outTok}
          </span>
        )}

        {session && (
          <select
            className="sb-select"
            value={modelInList ? modelValue : ''}
            disabled={!live}
            onChange={(e) => changeModel(e.target.value)}
            title="모델 변경 (setModel)"
          >
            {!modelInList && (
              <option value="" disabled>
                {modelValue || '(모델)'}
              </option>
            )}
            {models.map((m) => (
              <option key={m.value} value={m.value} title={m.description || ''}>
                {m.displayName || m.value}
              </option>
            ))}
          </select>
        )}

        {session && (
          <select
            className={`sb-select${session.permissionMode === 'bypassPermissions' ? ' mode-bypass' : ''}`}
            value={session.permissionMode || 'default'}
            disabled={!live}
            onChange={(e) => changeMode(e.target.value)}
            title={
              session.permissionMode === 'bypassPermissions'
                ? '⚠ 모든 권한 확인을 건너뜁니다'
                : '권한 모드 변경 (setPermissionMode)'
            }
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}

        <span title={`WebSocket: ${state.conn}`}>
          <span className={`conn-dot ${state.conn}`} />{' '}
          <span className="dim">{CONN_LABEL[state.conn] ?? state.conn}</span>
        </span>

        <button className="icon-btn" onClick={onToggleTheme} title="테마 전환">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </header>
  );
}
