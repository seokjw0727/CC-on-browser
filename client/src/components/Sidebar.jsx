// 사이드바 — wordmark / [새 세션](cwd 피커 모달) / 현재 세션(라이브 탭 + 히스토리 재개)
// / 다른 열린 세션(타 프로젝트 라이브 세션 전환·종료)
// / 하단 고정 통계·설정 버튼(.sidebar-foot) — 패널은 화면 중앙 모달로 표시.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import {
  fetchBootstrap,
  fetchDailyUsage,
  fetchProjects,
  fetchRecentSessions,
  fetchSessions,
  fetchTranscript,
  pickDirectory,
} from '../lib/api.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { createSessionState } from '../lib/store-reducer.js';
import { isQuestionRequest } from '../lib/ask-user-question.js';
import { buildSessionTree, deriveSessionTitle } from '../lib/sessionTree.js';
import { fmtReset, fmtTok, shortPath } from '../lib/format.js';
import { buildHeatmap } from '../lib/usage-grid.js';
import { MODE_LABEL, MODE_CLASS, MODES } from '../lib/permission-modes.js';
import { Sparkle, Mascot } from './Brand.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { usePresence } from '../lib/usePresence.js';
import './interact.css';

const STATUS_BADGE = {
  idle: { label: '대기', cls: 'idle' },
  thinking: { label: '생각 중', cls: 'busy' },
  tool: { label: '도구', cls: 'busy' },
  'awaiting-permission': { label: '권한 대기', cls: 'warn' },
  exited: { label: '종료', cls: 'off' },
};

// 모달용 상세 설명 — 표시 이름·색 클래스는 permission-modes.js와 공유
const MODE_DESC = {
  default: '매번 확인',
  acceptEdits: '파일 편집 자동 허용',
  plan: '계획만, 실행 안 함',
  bypassPermissions: '확인 없이 전부 실행',
};
const PERMISSION_MODES = MODES.map((value) => ({
  value,
  label: `${MODE_LABEL[value]} — ${MODE_DESC[value]}`,
}));

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

// ----- 새 세션 모달 (cwd = 윈도우 파일 탐색기로 선택 + 최근 세션 재개) -----
function NewSessionModal({ initInfo, defaultCwd, platform, onStart, onResume, onClose, presenceStatus }) {
  const [cwd, setCwd] = useState(defaultCwd || '');
  const [model, setModel] = useState('');
  // 기본 권한 모드 = 전체 허용(bypassPermissions) — 사용자 요청(2026-07-10).
  // 모달의 셀렉트에서 세션별로 변경할 수 있고, 경고 문구가 항상 함께 표시된다.
  const [mode, setMode] = useState('bypassPermissions');
  const [error, setError] = useState(null);
  const [browsing, setBrowsing] = useState(false); // 네이티브 폴더 대화상자 대기 중
  const [recent, setRecent] = useState([]); // 최근 세션(전 프로젝트)
  // 포커스 트랩 — 모달이 열린 동안 Tab을 안에 가두고, 닫히면 여는 버튼으로 복원.
  // 초기 포커스는 첫 포커서블(닫기 버튼)로 폴백한다 — 폴더 선택 버튼은 platform 부트스트랩
  // 전(초기 null)과 비-Windows에서 disabled라 초기 포커스 대상으로 지정하면 트랩이 깨진다.
  const dialogRef = useFocusTrap(true);

  // 윈도우 파일 탐색기(네이티브 폴더 선택 대화상자)로 작업 디렉터리를 선택한다 —
  // 인앱 경로 입력/폴더 트리 탐색을 완전히 대체(사용자 요청). 취소 시 기존 값 유지.
  // aria-disabled 전환으로 버튼이 항상 클릭 가능해졌으므로 platform 가드도 여기서.
  const browseNative = async () => {
    if (browsing || platform !== 'win32') return;
    setBrowsing(true);
    setError(null);
    try {
      const res = await pickDirectory(cwd.trim());
      if (res.path) setCwd(res.path);
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setBrowsing(false);
    }
  };

  // 최근 세션 로드(모달이 열릴 때 1회) — 실패는 조용히 빈 목록으로 둔다.
  useEffect(() => {
    let alive = true;
    fetchRecentSessions()
      .then((list) => {
        if (alive) setRecent(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const models = Array.isArray(initInfo?.models) ? initInfo.models : [];

  const start = () => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError('작업 디렉터리를 선택하세요 (📂 폴더 선택).');
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
      className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label="새 세션">
        <div className="modal-title">
          새 세션
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기" data-tip="닫기">
            ✕
          </button>
        </div>

        <div className="modal-body">
        <div className="picker-field">
          <span className="dim">작업 디렉터리 (cwd)</span>
          <div className="cwd-path-row">
            <button
              type="button"
              className="browse-native-btn primary"
              onClick={browseNative}
              aria-disabled={browsing || platform !== 'win32'}
              data-tip={platform === 'win32' ? '윈도우 파일 탐색기로 폴더 선택' : '네이티브 폴더 선택은 Windows에서만 지원됩니다'}
            >
              {browsing ? '탐색기 여는 중…' : '📂 폴더 선택 (파일 탐색기)'}
            </button>
          </div>
          {/* 선택된 경로 표시 — Windows가 아니면 직접 입력 폴백. */}
          {platform === 'win32' ? (
            <div className="cwd-selected" data-tip={cwd || undefined}>
              {cwd ? <span className="truncate">{cwd}</span> : <span className="dim">아직 선택된 폴더가 없습니다</span>}
            </div>
          ) : (
            <input
              type="text"
              value={cwd}
              aria-label="작업 디렉터리 경로"
              placeholder="/path/to/project"
              onChange={(e) => setCwd(e.target.value)}
            />
          )}
        </div>

        {recent.length > 0 && (
          <div className="picker-field">
            <span className="dim">최근 세션 — 클릭하면 이어서 재개합니다</span>
            <div className="recent-sessions">
              {recent.map((s) => (
                <button
                  key={`${s.dirName}/${s.sessionId}`}
                  type="button"
                  className="recent-session-item"
                  aria-disabled={!s.cwd}
                  data-tip={s.cwd ? `재개: ${s.cwd}` : 'cwd를 알 수 없어 재개할 수 없습니다'}
                  onClick={() => s.cwd && onResume(s)}
                >
                  <span className="rs-title truncate">{s.title || '(제목 없음)'}</span>
                  <span className="rs-sub dim truncate">{s.cwd || s.dirName}</span>
                  <span className="rs-time dim">{fmtTime(s.mtime)}</span>
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
            <select
              className={MODE_CLASS[mode] || undefined}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
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
            ⚠ 신뢰모드(bypassPermissions): 모든 도구가 확인 없이 실행됩니다. 파일
            수정·명령 실행이 즉시 반영되므로 신뢰할 수 있는 작업에만 사용하세요.
          </div>
        )}

        {error && <div className="sidebar-error">{error}</div>}
        </div>

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

// ----- 하단 통계·설정 팝오버 (.sidebar-foot) -----

function StatsIcon() {
  return (
    <svg className="foot-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 16.5V11h3v5.5m2-0V7h3v9.5m2 0V3.5h3v13" />
      <path d="M2.5 16.5h15" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="foot-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.9 3.1 8.5 2h3l.6 1.1 1.3.8 1.3-.1 1.5 2.6-.7 1.1v1.6l.7 1.1-1.5 2.6-1.3-.1-1.3.8-.6 1.1h-3l-.6-1.1-1.3-.8-1.3.1-1.5-2.6.7-1.1V7.5l-.7-1.1 1.5-2.6 1.3.1 1.3-.8Z" />
      <circle cx="10" cy="8.3" r="2.2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="foot-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

function FootButton({ title, panel, openPanel, onToggle, icon }) {
  const open = openPanel === panel;
  return (
    <button
      type="button"
      className={`foot-head${open ? ' open' : ''}`}
      aria-expanded={open}
      aria-controls={`sidebar-${panel}-modal`}
      aria-haspopup="dialog"
      onClick={() => onToggle(panel)}
    >
      {icon}
      <span className="foot-title">{title}</span>
      <ChevronIcon />
    </button>
  );
}

// 사용량 블록 — Composer 상태줄과 같은 데이터(store.globalUsage, 60초 폴링 재사용).
// 공식 %(quota)가 있으면 %바 + 리셋 시각, 없으면 로컬 집계 폴백(Composer와 동일 기준).
// 조회 실패 동안 마지막 성공 quota가 유지될 수 있어 fetchedAt을 툴팁에 병기한다.
function UsageStats({ gu }) {
  if (!gu) return <div className="dim foot-note">사용량 정보를 불러오는 중…</div>;
  const quota = gu.quota;
  const rows = [
    { label: '5시간 창', q: quota?.fiveHour, local: gu.fiveHour },
    { label: '7일 창', q: quota?.sevenDay, local: gu.sevenDay },
  ];
  return (
    <div className="usage-stats">
      {rows.map(({ label, q, local }) => {
        const localTok = local ? `로컬 ${fmtTok(local.totalTokens)} tok` : null;
        if (!q) {
          // 공식 %를 한 번도 못 받은 창 — 로컬 집계만(미로그인·네트워크 실패)
          return (
            <div key={label} className="usage-row" data-tip="공식 % 조회 실패(CLI 미로그인 또는 네트워크) — 로컬 트랜스크립트 집계만 표시">
              <div className="usage-row-head">
                <span className="usage-label">{label}</span>
                <span className="usage-pct dim">{localTok ?? '—'}</span>
              </div>
            </div>
          );
        }
        const pct = Math.max(0, Math.min(100, Math.round(q.utilization)));
        const cls = pct >= 95 ? ' danger' : pct >= 80 ? ' warn' : '';
        const reset = fmtReset(q.resetsAt);
        const fetched = fmtReset(quota?.fetchedAt);
        return (
          <div
            key={label}
            className="usage-row"
            data-tip={`${label} 사용률 ${pct}% — 계정 공식 수치(/usage와 동일)${fetched ? ` · 조회 ${fetched}` : ''}${localTok ? ` · ${localTok}` : ''}`}
          >
            <div className="usage-row-head">
              <span className="usage-label">{label}</span>
              <span className={`usage-pct${cls}`}>{pct}%</span>
            </div>
            <div className="usage-bar" role="img" aria-label={`${label} 사용률 ${pct}%`}>
              <div className={`usage-bar-fill${cls}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="usage-row-sub dim">
              {reset ? <span>리셋 {reset}</span> : <span />}
              {localTok && <span>{localTok}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 돌아보기 — GitHub 잔디 스타일 일별 토큰 heatmap. 섹션이 열릴 때(마운트) 365일치를
// 1회 받고 주간(12주)/월간(52주) 뷰는 클라에서 파생한다(토글 시 재요청 없음).
const GRASS_WEEKS = { weekly: 12, monthly: 53 };

function Retrospective({ notify }) {
  const [view, setView] = useState('weekly'); // 'weekly' | 'monthly'
  const [data, setData] = useState(null); // {now, days} | null(로딩)
  const [failed, setFailed] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetchDailyUsage(365)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err) => {
        if (!alive) return;
        setFailed(true);
        notify(`돌아보기 집계 실패: ${String(err.message ?? err)}`, 'error');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grid = useMemo(
    () => (data ? buildHeatmap(data.days, { weeks: GRASS_WEEKS[view] }) : null),
    [data, view],
  );

  // 월간(가로 스크롤)은 최신 주가 보이도록 오른쪽 끝에서 시작한다.
  useEffect(() => {
    const el = scrollRef.current;
    if (view === 'monthly' && el) el.scrollLeft = el.scrollWidth;
  }, [view, grid]);

  return (
    <div className="grass-block">
      <div className="grass-head">
        <span className="foot-sub">돌아보기</span>
        <div className="seg" role="group" aria-label="돌아보기 기간">
          <button
            type="button"
            className={view === 'weekly' ? 'on' : ''}
            aria-pressed={view === 'weekly'}
            onClick={() => setView('weekly')}
          >
            주간
          </button>
          <button
            type="button"
            className={view === 'monthly' ? 'on' : ''}
            aria-pressed={view === 'monthly'}
            onClick={() => setView('monthly')}
          >
            월간
          </button>
        </div>
      </div>

      {failed && <div className="dim foot-note">집계 실패 — 잠시 후 섹션을 다시 열어 보세요.</div>}
      {!failed && !grid && <div className="dim foot-note">집계 중… (최초 1회는 수 초 걸릴 수 있습니다)</div>}
      {grid && (
        <>
          <div className={`grass-scroll${view === 'monthly' ? ' wide' : ''}`} ref={scrollRef}>
            <div className={`grass ${view}`}>
              <div
                className="grass-months"
                style={{ gridTemplateColumns: `repeat(${grid.columns.length}, var(--grass-step))` }}
                aria-hidden="true"
              >
                {grid.monthLabels.map((l) => (
                  <span key={l.col} style={{ gridColumnStart: l.col + 1 }}>{l.label}</span>
                ))}
              </div>
              <div className="grass-grid">
                {grid.columns.map((col, c) => (
                  <div key={c} className="grass-col">
                    {col.map((cell, r) =>
                      cell ? (
                        <span
                          key={r}
                          className={`grass-cell l${cell.level}`}
                          data-tip={`${cell.date} · ${fmtTok(cell.totalTokens)} tok`}
                          role="img"
                          aria-label={`${cell.date} ${fmtTok(cell.totalTokens)} 토큰`}
                        />
                      ) : (
                        <span key={r} className="grass-cell out" aria-hidden="true" />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="grass-legend dim" aria-hidden="true">
            적음
            {[0, 1, 2, 3, 4].map((l) => (
              <span key={l} className={`grass-cell l${l}`} />
            ))}
            많음
          </div>
        </>
      )}
    </div>
  );
}

// 설정 패널 — 테마(라이트/다크 세그먼트) +
// 디버그 raw 이벤트 표시 스위치(store debugRaw + localStorage 'ccob-debug').
function SettingsPanel({ theme, onSetTheme }) {
  const { state, setDebug } = useStore();
  return (
    <div className="settings-panel">
      <div className="setting-row">
        <span className="setting-label">테마</span>
        <div className="seg" role="group" aria-label="테마 선택">
          <button
            type="button"
            className={theme === 'light' ? 'on' : ''}
            aria-pressed={theme === 'light'}
            onClick={() => onSetTheme('light')}
          >
            ☀ 라이트
          </button>
          <button
            type="button"
            className={theme === 'dark' ? 'on' : ''}
            aria-pressed={theme === 'dark'}
            onClick={() => onSetTheme('dark')}
          >
            ☾ 다크
          </button>
        </div>
      </div>
      <div className="setting-row">
        <span
          className="setting-label"
          data-tip="채팅에 프로토콜 내부(raw) 이벤트를 접이식으로 표시합니다"
        >
          디버그 메시지 표시
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={state.debugRaw}
          className={`switch${state.debugRaw ? ' on' : ''}`}
          onClick={() => setDebug(!state.debugRaw)}
          aria-label="디버그 메시지 표시"
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// 하단 고정 버튼 행 — 패널 자체는 화면 중앙 모달(FootModalPresence, aside 밖)로 뜬다.
function SidebarFoot({ openPanel, onToggle }) {
  return (
    <div className="sidebar-foot">
      <FootButton
        title="통계"
        panel="stats"
        openPanel={openPanel}
        onToggle={onToggle}
        icon={<StatsIcon />}
      />
      <FootButton
        title="설정"
        panel="settings"
        openPanel={openPanel}
        onToggle={onToggle}
        icon={<SettingsIcon />}
      />
    </div>
  );
}

// 통계·설정 중앙 모달 — 새 세션 모달과 같은 overlay/trap/presence 패턴.
// 포커스 복원은 useFocusTrap 언마운트 정리가 트리거 버튼으로 되돌린다.
function FootModal({ panel, presenceStatus, onClose, theme, onSetTheme }) {
  const { state, notify } = useStore();
  const dialogRef = useFocusTrap(true);
  const title = panel === 'stats' ? '통계' : '설정';
  return (
    <div
      className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal foot-modal"
        role="dialog"
        aria-modal="true"
        id={`sidebar-${panel}-modal`}
        aria-labelledby={`sidebar-${panel}-title`}
      >
        <div className="modal-title">
          {panel === 'stats' ? <StatsIcon /> : <SettingsIcon />}
          <span id={`sidebar-${panel}-title`}>{title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="modal-body foot-body">
          {panel === 'stats' ? (
            <>
              <UsageStats gu={state.globalUsage} />
              <Retrospective notify={notify} />
            </>
          ) : (
            <SettingsPanel theme={theme} onSetTheme={onSetTheme} />
          )}
        </div>
      </div>
    </div>
  );
}

// 닫힘 페이드아웃(140ms) 동안 마지막 패널 내용을 유지한 채 마운트를 지속.
function FootModalPresence({ panel, ...rest }) {
  const { mounted, status } = usePresence(!!panel, 140);
  const lastPanelRef = useRef(panel);
  if (panel) lastPanelRef.current = panel;
  if (!mounted || !lastPanelRef.current) return null;
  return <FootModal panel={lastPanelRef.current} presenceStatus={status} {...rest} />;
}

// ----- 사이드바 본체 -----
export default function Sidebar({ onCollapse, theme, onSetTheme }) {
  const { state, dispatch, startSession, stopSession, notify } = useStore();
  const modalOpen = state.newSessionOpen;
  const openModal = () => dispatch({ type: 'open-new-session' });
  const closeModal = () => dispatch({ type: 'close-new-session' });
  const [defaultCwd, setDefaultCwd] = useState('');
  const [platform, setPlatform] = useState(null); // 네이티브 폴더 선택 버튼 노출 판단
  const [expanded, setExpanded] = useState({}); // dirName -> sessions[]|'loading'
  const [footPanel, setFootPanel] = useState(null); // null | 'stats' | 'settings'

  // 에러는 영구 배너 대신 토스트(자동 소멸)로 — 모달 내부의 폼 검증 문구만 인라인 유지.
  const refreshProjects = async () => {
    try {
      const projects = await fetchProjects();
      dispatch({ type: 'set-projects', projects });
    } catch (err) {
      notify(String(err.message ?? err), 'error');
    }
  };

  useEffect(() => {
    refreshProjects();
    fetchBootstrap()
      .then((b) => {
        setDefaultCwd(b.defaultCwd || '');
        setPlatform(b.platform || null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      notify(String(err.message ?? err), 'error');
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
      // 트랜스크립트를 여기서 미리 reduce해 started 커밋에 원자적으로 시딩한다.
      // (별도 커밋으로 뒤늦게 주입하면 ChatView seenRef가 히스토리를 신규 메시지로
      // 오인해 등장 애니·타자기 출력을 탄다 — store-reducer 'started' 주석 참조.)
      const pre = messages.reduce(
        (acc, m) => reduceCliEvent(acc, m),
        createSessionState(),
      );
      startSession({
        cwd: project.cwd,
        model: null,
        permissionMode: 'bypassPermissions', // 새 세션 기본과 동일 — 컴포저에서 변경 가능
        resumeSessionId: meta.sessionId,
        // 표시 전용 모델 이월(스폰 --model엔 불사용 — 트랜스크립트의 해석 id는
        // 구식이거나 [1m] 접미사가 탈락했을 수 있어 스폰 인자로는 위험).
        // 재개 직후 피커 라벨·CTX 분모가 맞고, init의 실제값이 곧 덮어쓴다.
        preloadModel: pre.model,
        preloadMessages: pre.messages,
        preloadSessionId: pre.sessionId,
        preloadUsage: pre.usage,
        // 트랜스크립트에 호출별 usage가 있었다면 그 사실도 이월 — 시딩 직후의
        // result성 이벤트가 합산 usage로 컨텍스트를 덮는 경로를 원천 차단(방어).
        preloadCtxFromCalls: pre.ctxFromCalls,
      });
    } catch (err) {
      notify(String(err.message ?? err), 'error');
    }
  };

  const openSessions = [...state.sessions.values()];

  const tree = buildSessionTree({
    liveSessions: openSessions,
    projects: state.projects,
    historyByDir: expanded,
    activeKey: state.activeKey,
  });
  const liveOthers = tree.others.filter((n) => n.live.length > 0);

  // 라이브 세션 행 — 렌더 헬퍼(요소 인스턴스화가 아니라 호출)로 두어 DOM을 안정화.
  // 매 렌더마다 새 컴포넌트 타입이 생기지 않으므로 React가 remount 없이 patch한다.
  const liveRow = (row, node) => {
    const sess = state.sessions.get(row.key);
    // 대기 중인 요청의 앞머리가 AskUserQuestion이면 '권한 대기' 대신 '질문 대기' —
    // 다이얼로그(QuestionDialog/PermissionPrompt) 분기와 같은 판별을 쓴다.
    const badge =
      row.status === 'awaiting-permission' &&
      isQuestionRequest(sess?.pendingPermissions?.[0])
        ? { label: '질문 대기', cls: 'warn' }
        : STATUS_BADGE[row.status] ?? { label: row.status, cls: '' };
    // 세션 이름 = 첫 사용자 발화 요약 → 없으면 세션 id 앞 8자 → 그것도 없으면 '새 세션'.
    const label =
      deriveSessionTitle(sess?.messages) ||
      (row.sessionId ? row.sessionId.slice(0, 8) : '새 세션');
    return (
      <div key={row.key} className={`sess-row live${row.active ? ' active' : ''}`}>
        <button
          type="button"
          className="sess-main"
          onClick={() => dispatch({ type: 'set-active', key: row.key })}
          data-tip={label !== node.cwd ? `${label}${node.cwd ? ` — ${node.cwd}` : ''}` : node.cwd || node.label}
        >
          <span className="sess-dot live" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </button>
        {row.status !== 'exited' && (
          <button
            type="button"
            className="session-stop"
            aria-label="세션 종료"
            data-tip="세션 종료 (CLI 프로세스 정지)"
            onClick={() => stopSession(row.key)}
          >
            ✕
          </button>
        )}
      </div>
    );
  };

  // 재개 가능 히스토리 행
  const historyRow = (h, node) => (
    <button
      key={h.sessionId}
      type="button"
      className="sess-row history"
      aria-disabled={!node.cwd}
      data-tip={node.cwd ? `재개: ${h.sessionId}` : 'cwd를 알 수 없어 재개할 수 없습니다'}
      onClick={() =>
        node.cwd &&
        resumeSession({ dirName: node.dirName, cwd: node.cwd }, { sessionId: h.sessionId })
      }
    >
      <span className="sess-dot" aria-hidden="true" />
      <span className="truncate">{h.title || '(제목 없음)'}</span>
      <span className="rs-meta dim">{fmtTime(h.mtime)}</span>
    </button>
  );

  // 디렉토리 그룹(헤더 + 펼침 영역)
  const dirGroup = (node, pinned = false) => {
    const open = pinned || !!expanded[node.dirName];
    return (
      <div key={node.key} className={`dir-group${node.active ? ' active-dir' : ''}`}>
        <button
          type="button"
          className="dir-head"
          onClick={() => node.dirName && toggleProject(node.dirName)}
          disabled={!node.dirName}
          data-tip={node.cwd || node.label}
        >
          {!pinned && (
            <span className="dir-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          )}
          <span className="dir-ico" aria-hidden="true">📁</span>
          <span className="truncate">{node.label}</span>
          {!open && node.hasLive && (
            <span className="live-dot" data-tip="열린 세션 있음" aria-hidden="true" />
          )}
          <span className="badge">{node.count || node.live.length}</span>
        </button>
        <div className="dir-rows" data-open={open ? 'true' : 'false'} inert={!open}>
          <div className="dir-rows-inner">
            {node.live.map((row) => liveRow(row, node))}
            {expanded[node.dirName] === 'loading' && (
              <div className="dim dir-loading">불러오는 중…</div>
            )}
            {node.history.map((h) => historyRow(h, node))}
            {open &&
              node.live.length === 0 &&
              node.historyLoaded &&
              node.history.length === 0 && (
                <div className="dim dir-empty">세션 없음</div>
              )}
          </div>
        </div>
      </div>
    );
  };

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
          data-tip="사이드바 접기"
          aria-label="사이드바 접기"
        >
          ⟨
        </button>
      </div>

      <div className="sidebar-inner">
        <button type="button" className="new-session-btn" onClick={openModal}>
          <span className="ns-plus" aria-hidden="true">+</span> 새 세션
        </button>

        {tree.pinned && (
          <div className="pin-box">
            <div className="sidebar-h">현재 세션</div>
            {dirGroup(tree.pinned, true)}
          </div>
        )}

        {/* 다른 프로젝트에서 아직 살아 있는 세션 — 목록 섹션은 삭제됐지만
            실행 중인 세션의 전환·종료 경로는 남겨야 한다. */}
        {liveOthers.length > 0 && (
          <>
            <div className="sidebar-h">다른 열린 세션</div>
            {liveOthers.map((n) => dirGroup(n, true))}
          </>
        )}

        {openSessions.length === 0 && (
          <div className="sidebar-empty">
            <Mascot scale={5} className="empty-mascot" />
            <span className="dim">새 세션을 시작하면 여기에 표시됩니다</span>
          </div>
        )}
      </div>

      {/* 하단 고정 통계·설정 버튼 — 세션 목록 스크롤 영역(.sidebar-inner) 밖 */}
      <SidebarFoot
        openPanel={footPanel}
        onToggle={(panel) => setFootPanel((cur) => (cur === panel ? null : panel))}
      />
      </aside>

      {/* 모달은 aside 밖에 렌더 — 사이드바 접힘(.sidebar{display:none}) 시에도
          컴포저 레포 pill로 열 수 있어야 하므로 display:none 서브트리를 피한다. */}
      <NewSessionPresence
        open={modalOpen}
        initInfo={state.initInfo}
        defaultCwd={defaultCwd}
        platform={platform}
        onClose={closeModal}
        onStart={(opts) => {
          closeModal();
          startSession(opts);
        }}
        onResume={(s) => {
          closeModal();
          resumeSession({ dirName: s.dirName, cwd: s.cwd }, { sessionId: s.sessionId });
        }}
      />

      {/* 통계·설정 모달도 aside 밖 — 새 세션 모달과 같은 이유. */}
      <FootModalPresence
        panel={footPanel}
        onClose={() => setFootPanel(null)}
        theme={theme}
        onSetTheme={onSetTheme}
      />
    </>
  );
}

// 새 세션 모달의 닫힘 애니메이션 — usePresence로 페이드아웃 동안 마운트를 유지한 뒤 제거.
function NewSessionPresence({ open, ...rest }) {
  const { mounted, status } = usePresence(open, 140);
  if (!mounted) return null;
  return <NewSessionModal {...rest} presenceStatus={status} />;
}
