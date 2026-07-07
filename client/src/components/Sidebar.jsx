// 사이드바 — wordmark / [새 세션](cwd 피커 모달) / 열린 세션 탭 / 최근 세션(재개) / 계정 칩.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import {
  browseDirs,
  fetchBootstrap,
  fetchProjects,
  fetchSessions,
  fetchTranscript,
} from '../lib/api.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { Sparkle, Mascot } from './Brand.jsx';
import './interact.css';

const STATUS_BADGE = {
  idle: { label: '대기', cls: 'idle' },
  thinking: { label: '생각 중', cls: 'busy' },
  tool: { label: '도구', cls: 'busy' },
  'awaiting-permission': { label: '권한 대기', cls: 'warn' },
  exited: { label: '종료', cls: 'off' },
};

const PERMISSION_MODES = [
  { value: 'default', label: 'default — 매번 확인' },
  { value: 'acceptEdits', label: 'acceptEdits — 파일 편집 자동 허용' },
  { value: 'plan', label: 'plan — 계획만, 실행 안 함' },
  { value: 'bypassPermissions', label: 'bypassPermissions — 확인 없이 전부 실행' },
];

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

// ----- 새 세션 모달 (cwd 피커: 트리 탐색 + 직접 입력 + 최근 프로젝트) -----
function NewSessionModal({ initInfo, projects, defaultCwd, onStart, onClose }) {
  const [cwd, setCwd] = useState(defaultCwd || '');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('default');
  const [browse, setBrowse] = useState(null); // {path, parent, dirs}
  const [error, setError] = useState(null);

  const navigate = async (target) => {
    try {
      const res = await browseDirs(target ?? '');
      setBrowse(res);
      if (res.path) setCwd(res.path);
      setError(null);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  useEffect(() => {
    navigate(defaultCwd || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const childPath = (name) => {
    if (!browse || !browse.path) return name; // 드라이브 루트 목록
    const sep = browse.path.includes('/') && !browse.path.includes('\\') ? '/' : '\\';
    return browse.path.endsWith(sep) ? browse.path + name : browse.path + sep + name;
  };

  const models = Array.isArray(initInfo?.models) ? initInfo.models : [];
  const recent = projects.filter((p) => p.cwd);

  const start = () => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError('작업 디렉터리를 선택하거나 입력하세요.');
      return;
    }
    onStart({
      cwd: trimmed,
      model: model || null,
      permissionMode: mode,
      resumeSessionId: null,
    });
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="새 세션">
        <div className="modal-title">
          새 세션
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기" title="닫기">
            ✕
          </button>
        </div>

        <div className="picker-field">
          <span className="dim">작업 디렉터리 (cwd)</span>
          <div className="cwd-path-row">
            <input
              type="text"
              value={cwd}
              autoFocus
              aria-label="작업 디렉터리 경로"
              placeholder="C:\\path\\to\\project"
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  navigate(cwd.trim());
                }
              }}
            />
            <button type="button" onClick={() => navigate(cwd.trim())} title="입력한 경로로 이동">
              이동
            </button>
          </div>
        </div>

        {browse && (
          <div className="browse-box">
            {browse.parent != null && (
              <button type="button" className="browse-item dim" onClick={() => navigate(browse.parent)}>
                ↑ ..
              </button>
            )}
            {browse.path !== '' && (
              <button type="button" className="browse-item dim" onClick={() => navigate('')}>
                ⌂ 드라이브 목록
              </button>
            )}
            {browse.dirs.map((name) => (
              <button
                key={name}
                type="button"
                className="browse-item"
                onClick={() => navigate(browse.path === '' ? name : childPath(name))}
              >
                📁 {name}
              </button>
            ))}
            {browse.dirs.length === 0 && (
              <div className="browse-item dim">(하위 폴더 없음)</div>
            )}
          </div>
        )}

        {recent.length > 0 && (
          <div className="picker-field">
            <span className="dim">최근 프로젝트</span>
            <div className="recent-projects">
              {recent.map((p) => (
                <button
                  key={p.dirName}
                  type="button"
                  className="browse-item"
                  title={p.cwd}
                  onClick={() => {
                    setCwd(p.cwd);
                    navigate(p.cwd);
                  }}
                >
                  {p.cwd}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="picker-row">
          <label className="picker-field">
            <span className="dim">모델</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">(기본 모델)</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName || m.value}
                </option>
              ))}
            </select>
          </label>
          <label className="picker-field">
            <span className="dim">권한 모드</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {mode === 'bypassPermissions' && (
          <div className="mode-warning">
            ⚠ bypassPermissions: 모든 도구가 확인 없이 실행됩니다. 파일 수정·명령
            실행이 즉시 반영되므로 신뢰할 수 있는 작업에만 사용하세요.
          </div>
        )}

        {error && <div className="sidebar-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn-primary" onClick={start}>
            세션 시작
          </button>
        </div>
      </div>
    </div>
  );
}

// account.email → 표시 이름. subscriptionType → 짧은 플랜명.
function accountName(account) {
  const email = account?.email;
  if (!email) return '사용자';
  const local = String(email).split('@')[0] || email;
  const base = local.replace(/[._-].*$/, '').replace(/\d+$/, '') || local;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
function planLabel(account) {
  const t = account?.subscriptionType;
  if (!t) return '';
  return String(t).replace(/^claude\s+/i, '');
}

// ----- 사이드바 본체 -----
export default function Sidebar({ onCollapse }) {
  const { state, dispatch, startSession, stopSession } = useStore();
  const modalOpen = state.newSessionOpen;
  const openModal = () => dispatch({ type: 'open-new-session' });
  const closeModal = () => dispatch({ type: 'close-new-session' });
  const [defaultCwd, setDefaultCwd] = useState('');
  const [expanded, setExpanded] = useState({}); // dirName -> sessions[]|'loading'
  const [error, setError] = useState(null);
  // 재개 시 transcript 프리로드: started 도착 후 새 세션에 주입
  const pendingPreloadRef = useRef(null); // {startId, messages, prevKeys}

  const refreshProjects = async () => {
    try {
      const projects = await fetchProjects();
      dispatch({ type: 'set-projects', projects });
      setError(null);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  useEffect(() => {
    refreshProjects();
    fetchBootstrap()
      .then((b) => setDefaultCwd(b.defaultCwd || ''))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // startSession('started') 처리 후 transcript 프리로드 적용
  useEffect(() => {
    const p = pendingPreloadRef.current;
    if (!p) return;
    if (state.pendingStarts.has(p.startId)) return; // 아직 시작 대기 중
    pendingPreloadRef.current = null;
    const key = state.activeKey;
    // start 실패(에러)면 activeKey가 기존 세션 — 프리로드 폐기
    if (!key || p.prevKeys.has(key)) return;
    if (!state.sessions.has(key) || p.messages.length === 0) return;
    dispatch({
      type: 'update-session',
      key,
      fn: (s) => {
        const base = { ...s, messages: [], streaming: { msgId: null, blocks: {} } };
        const pre = p.messages.reduce((acc, m) => reduceCliEvent(acc, m), base);
        return {
          ...pre,
          // 프리로드 메시지를 앞에, 라이브 이벤트로 이미 쌓인 메시지를 뒤에
          messages: [...pre.messages, ...s.messages],
          streaming: s.streaming,
          status: s.status,
          lastSeq: s.lastSeq,
        };
      },
    });
  }, [state.pendingStarts, state.activeKey, state.sessions, dispatch]);

  const toggleProject = async (dirName) => {
    if (expanded[dirName]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[dirName];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [dirName]: 'loading' }));
    try {
      const sessions = await fetchSessions(dirName);
      setExpanded((prev) => ({ ...prev, [dirName]: sessions }));
    } catch (err) {
      setError(String(err.message ?? err));
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[dirName];
        return next;
      });
    }
  };

  const resumeSession = async (project, meta) => {
    try {
      const { messages } = await fetchTranscript(project.dirName, meta.sessionId);
      const prevKeys = new Set(state.sessions.keys());
      const startId = startSession({
        cwd: project.cwd,
        model: null,
        permissionMode: 'default',
        resumeSessionId: meta.sessionId,
      });
      pendingPreloadRef.current = { startId, messages, prevKeys };
      setError(null);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  const openSessions = [...state.sessions.values()];
  const account = state.initInfo?.account;
  const isEmpty = openSessions.length === 0 && state.projects.length === 0;

  return (
    <>
      <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <Sparkle size={20} />
          <span className="brand-word">Claude Code</span>
          <span className="brand-badge">브라우저</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onCollapse}
          title="사이드바 접기"
          aria-label="사이드바 접기"
        >
          ⟨
        </button>
      </div>

      <div className="sidebar-inner">
        <button type="button" className="new-session-btn" onClick={openModal}>
          <span className="ns-plus" aria-hidden="true">+</span> 새 세션
        </button>

        {openSessions.length > 0 && (
          <>
            <div className="sidebar-h">열린 세션</div>
            {openSessions.map((s) => {
              const badge = STATUS_BADGE[s.status] ?? { label: s.status, cls: '' };
              return (
                <div
                  key={s.key}
                  className={`session-tab-row${state.activeKey === s.key ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className="session-tab"
                    onClick={() => dispatch({ type: 'set-active', key: s.key })}
                    title={s.cwd || s.key}
                  >
                    <span className="truncate">{shortPath(s.cwd) || s.key}</span>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  </button>
                  {s.status !== 'exited' && (
                    <button
                      type="button"
                      className="session-stop"
                      aria-label="세션 종료"
                      title="세션 종료 (CLI 프로세스 정지)"
                      onClick={() => stopSession(s.key)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        <div className="sidebar-h">
          최근 세션
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={refreshProjects}
            aria-label="최근 세션 새로고침"
            title="새로고침"
          >
            ↻
          </button>
        </div>

        {state.projects.length === 0 && (
          <div className="dim" style={{ fontSize: 12.5 }}>
            기록된 프로젝트가 없습니다.
          </div>
        )}

        {state.projects.map((p) => (
          <div key={p.dirName} className="proj-item">
            <button
              type="button"
              className="proj-head"
              onClick={() => toggleProject(p.dirName)}
              title={p.cwd || p.dirName}
            >
              <span>{expanded[p.dirName] ? '▾' : '▸'}</span>
              <span className="truncate">{shortPath(p.cwd) || p.dirName}</span>
              <span className="badge">{p.sessionCount}</span>
            </button>
            {expanded[p.dirName] === 'loading' && (
              <div className="dim" style={{ fontSize: 12, paddingLeft: 22 }}>
                불러오는 중…
              </div>
            )}
            {Array.isArray(expanded[p.dirName]) &&
              expanded[p.dirName].map((meta) => (
                <button
                  key={meta.sessionId}
                  type="button"
                  className="recent-session"
                  disabled={!p.cwd}
                  title={
                    p.cwd
                      ? `재개: ${meta.sessionId}`
                      : 'cwd를 알 수 없어 재개할 수 없습니다'
                  }
                  onClick={() => resumeSession(p, meta)}
                >
                  <span className="truncate" style={{ display: 'block' }}>
                    {meta.title || '(제목 없음)'}
                  </span>
                  <span className="rs-meta dim">{fmtTime(meta.mtime)}</span>
                </button>
              ))}
          </div>
        ))}

        {error && <div className="sidebar-error">{error}</div>}

        {openSessions.length === 0 && (
          <div className="sidebar-empty">
            <Mascot scale={5} className="empty-mascot" />
            <span className="dim">
              {isEmpty
                ? '시작한 세션이 여기에 표시됩니다'
                : '위에서 세션을 재개하거나 새 세션을 시작하세요'}
            </span>
          </div>
        )}
      </div>

      <div className="account-chip" title={account?.email || '계정'}>
        <span className="avatar">{accountName(account).charAt(0)}</span>
        <span className="account-text">
          <span className="account-name truncate">{accountName(account)}</span>
          {planLabel(account) && <span className="account-plan dim">{planLabel(account)}</span>}
        </span>
      </div>
      </aside>

      {/* 모달은 aside 밖에 렌더 — 사이드바 접힘(.sidebar{display:none}) 시에도
          컴포저 레포 pill로 열 수 있어야 하므로 display:none 서브트리를 피한다. */}
      {modalOpen && (
        <NewSessionModal
          initInfo={state.initInfo}
          projects={state.projects}
          defaultCwd={defaultCwd}
          onClose={closeModal}
          onStart={(opts) => {
            closeModal();
            startSession(opts);
          }}
        />
      )}
    </>
  );
}
