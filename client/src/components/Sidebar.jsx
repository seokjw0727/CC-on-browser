// 사이드바 — wordmark / [새 세션](모달) / 현재 세션(활성 프로젝트 라이브)
// / 다른 열린 세션(타 프로젝트 라이브 전환·종료)
// / 하단 고정 통계·설정 버튼(.sidebar-foot) — 패널은 화면 중앙 모달로 표시.
//
// 라이브 세션 행은 "이름 + 상태 점"뿐이다(2026-08-09). 이름 변경·세션 종료는 행
// 우클릭(키보드는 Shift+F10) 메뉴로만 열고, 상태는 텍스트 배지 없이 점의 색으로만
// 표현한다 — 색↔의미 매핑과 보조기술용 라벨은 lib/session-status.js가 소유한다.
//
// 사이드바는 "지금 열려 있는 세션"만 다룬다. 히스토리(지난 세션)의 조회·재개·삭제는
// 전부 새 세션 모달 한 곳으로 모았다(2026-07-21) — 상시 노출되던 "지난 세션" 섹션과
// 방금 닫힌 세션의 로컬 캡처 로직은 함께 사라졌다. 모달은 열릴 때와 열린 세션 집합이
// 바뀔 때 서버 목록을 다시 받으므로 로컬 캡처 없이도 신선하다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import {
  deleteSessionFile,
  fetchBootstrap,
  fetchDailyUsage,
  fetchProjects,
  fetchRecentSessions,
  fetchTranscript,
  pickDirectory,
} from '../lib/api.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { createSessionState } from '../lib/store-reducer.js';
import { isQuestionRequest } from '../lib/ask-user-question.js';
import { statusDotOf } from '../lib/session-status.js';
import {
  buildSessionTree,
  mergeRecentSessions,
  sessionDisplayTitle,
  shortDir,
} from '../lib/sessionTree.js';
import { MAX_TITLE_LEN, saveTitle, titleFor } from '../lib/session-titles.js';
import { fmtAgo, fmtBytes, fmtReset, fmtTok } from '../lib/format.js';
import { buildHeatmap } from '../lib/usage-grid.js';
import { MODE_CLASS, PERMISSION_MODES } from '../lib/permission-modes.js';
import {
  DEFAULT_MODEL_KEY,
  DEFAULT_MODE_KEY,
  loadDefaults,
  resolveDefaultModel,
  writePref,
} from '../lib/preferences.js';
import { Sparkle, Mascot } from './Brand.jsx';
import SessionMenu from './SessionMenu.jsx';
import ConfigEditorModal from './ConfigEditorModal.jsx';
import TrustModeWarning from './TrustModeWarning.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { usePresence } from '../lib/usePresence.js';
import './interact.css';

// 모달 "지난 세션" 목록 크기 — 기본 20, "더 보기" 클릭 시 50(서버 clamp 상한).
const PAST_LIMIT_DEFAULT = 20;
const PAST_LIMIT_MAX = 50;
// 재개 잠금 안전망 — 트랜스크립트 요청이 끝내 정착하지 않을 때 잠금을 회수한다.
const RESUME_BUSY_TIMEOUT_MS = 15_000;

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

const rowKeyOf = (s) => `${s.dirName}\n${s.sessionId}`;

// ----- 새 세션 모달 (cwd = 윈도우 파일 탐색기로 선택 + 지난 세션 재개·삭제) -----
function NewSessionModal({
  defaultCwd,
  platform,
  onStart,
  onResume,
  onClose,
  onHistoryChanged,
  presenceStatus,
  // 재개 잠금은 모달 밖(Sidebar)이 소유한다 — 모달을 닫았다 다시 열어도 잠금이
  // 살아 있어야 중복 재개를 막을 수 있다(codex 지적: 모달 안의 ref는 리마운트로 초기화됨).
  resumingKey,
}) {
  const { state, notify } = useStore();
  const [cwd, setCwd] = useState(defaultCwd || '');
  // 모델·권한 모드의 초기값은 설정(설정 패널 → localStorage)에서 가져온다.
  // 여기서 바꾸는 값은 이번 세션 한정 — 기본값 자체는 설정에서만 바뀐다.
  const [model, setModel] = useState(() => loadDefaults().model);
  const [mode, setMode] = useState(() => loadDefaults().mode);
  const [error, setError] = useState(null);
  const [browsing, setBrowsing] = useState(false); // 네이티브 폴더 대화상자 대기 중

  // ----- 지난 세션(전 프로젝트 최근) -----
  const [past, setPast] = useState(null); // null=아직 못 받음 | 서버 목록 Array
  const [pastError, setPastError] = useState(false);
  // 실제 요청 진행 여부 — past===null로는 표현할 수 없다. 첫 요청이 실패하면
  // past는 계속 null이지만 로딩은 끝났고, 반대로 재조회·"더 보기"는 목록이
  // 있는 채로 진행 중이다(codex 지적: aria-busy가 둘 다 틀렸었다).
  const [pastLoading, setPastLoading] = useState(true);
  const [limit, setLimit] = useState(PAST_LIMIT_DEFAULT);
  const [deletingRow, setDeletingRow] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null); // 삭제 확인 대상
  const genRef = useRef(0); // 요청 세대 — 늦은 응답이 새 목록을 덮지 못하게
  const pastHeadingRef = useRef(null); // 삭제로 🗑이 사라졌을 때의 포커스 착지점
  // 확인 모달을 연 🗑 버튼 — 닫힐 때 포커스를 돌려줄 대상. 삭제가 성공하면 그
  // 버튼이 사라지므로 목록 제목으로 갈아 끼운다. 자동 포착(직전 활성 요소)에
  // 맡기지 않는 이유는 useFocusTrap 주석 참조(inert 적용과의 경합).
  const restoreTargetRef = useRef(null);

  // 삭제 확인 모달의 presence — 페이드아웃(140ms)까지 포함해 아래 모달을 잠근다.
  // confirmDel(즉시 null이 됨)에 묶으면 애니메이션 도중 아래가 먼저 풀린다.
  const { mounted: confirmMounted, status: confirmStatus } = usePresence(!!confirmDel, 140);
  const lastConfirmRef = useRef(null);
  // 렌더 중 ref를 쓰지 않는다 — 버려지는 동시성 렌더가 커밋되지 않은 대상을
  // 페이드아웃 UI로 흘릴 수 있다(codex 지적). usePresence 자체가 effect 기반이라
  // effect에서 갱신해도 표시 타이밍은 같다.
  useEffect(() => {
    if (confirmDel) lastConfirmRef.current = confirmDel;
  }, [confirmDel]);

  // 포커스 트랩 — 모달이 열린 동안 Tab을 안에 가두고, 닫히면 여는 버튼으로 복원.
  // 초기 포커스는 첫 포커서블(닫기 버튼)로 폴백한다 — 폴더 선택 버튼은 platform 부트스트랩
  // 전(초기 null)과 비-Windows에서 disabled라 초기 포커스 대상으로 지정하면 트랩이 깨진다.
  const dialogRef = useFocusTrap(true);

  const models = Array.isArray(state.initInfo?.models) ? state.initInfo.models : [];
  // 셀렉트에 실제로 보이는 값 = 스폰에 쓰일 값. 카탈로그에 없는 값(설정에 남은
  // 구버전 id, init 전이라 검증 불가)은 (기본 모델)로 보이고 --model도 생략된다.
  const modelValue = resolveDefaultModel(model, models);

  // 라이브 세션은 지난 세션 목록에서 숨긴다. 재개 세션은 fork로 새 sessionId를
  // 받을 수 있어 원본(resumeSourceId)도 라이브로 취급하고, 아직 started가 오지
  // 않은 재개 요청(pendingStarts)까지 포함한다 — 그러지 않으면 서버가 삭제를
  // 409로 거부하는 유령 행이 남는다.
  const liveIds = useMemo(() => {
    const ids = new Set();
    for (const s of state.sessions.values()) {
      if (s.sessionId) ids.add(s.sessionId);
      if (s.resumeSourceId) ids.add(s.resumeSourceId);
    }
    for (const opts of state.pendingStarts.values()) {
      if (opts?.resumeSessionId) ids.add(opts.resumeSessionId);
    }
    return ids;
  }, [state.sessions, state.pendingStarts]);

  // 열린 세션 "집합"이 바뀔 때만 재조회하기 위한 안정 키 — state.sessions는
  // 스트리밍 이벤트마다 새 Map으로 갈리므로 그대로 의존하면 토큰마다 요청한다.
  const sessionsKey = useMemo(
    () => [...state.sessions.keys()].sort().join('\n'),
    [state.sessions],
  );

  const refreshPast = useCallback(async (nextLimit) => {
    const gen = ++genRef.current;
    setPastLoading(true);
    try {
      const list = await fetchRecentSessions(nextLimit);
      if (genRef.current !== gen) return; // 뒤늦은 응답 — 최신 요청이 상태를 소유
      setPast(Array.isArray(list) ? list : []);
      setPastError(false);
      setPastLoading(false);
    } catch {
      if (genRef.current !== gen) return;
      setPastError(true); // 기존 목록은 유지한 채 오류 문구만
      setPastLoading(false);
    }
  }, []);

  // 최초 1회 + "더 보기"(limit) + 열린 세션 집합 변화 — 단일 effect라 초기 중복 요청 없음.
  useEffect(() => {
    refreshPast(limit);
  }, [limit, sessionsKey, refreshPast]);

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

  // 재개가 진행 중이면 모달 전체가 잠긴다 — 닫기(✕·취소·Esc·배경 클릭)와 새
  // 세션 시작까지 포함. 진행 중 모달이 사라지면 사용자는 무슨 일이 일어나는지
  // 알 수 없고, 다른 행을 눌러도 조용히 무시되는 상태가 된다.
  const resuming = !!resumingKey;
  const requestClose = () => {
    if (!resuming) onClose();
  };

  const start = () => {
    if (resuming) return;
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError('작업 디렉터리를 선택하세요 (📂 폴더 선택).');
      return;
    }
    onStart({
      cwd: trimmed,
      model: modelValue || null,
      permissionMode: mode,
      resumeSessionId: null,
    });
  };

  // 재개 — 여기서 고른 모델·권한 모드가 그대로 스폰 인자가 된다.
  // 잠금·성공 후 모달 닫기는 부모(onResume)가 책임진다.
  const resumeRow = (s) => {
    if (resuming || deletingRow || !s.cwd) return;
    onResume(s, { model: modelValue || null, permissionMode: mode });
  };

  const confirmDelete = async () => {
    const target = confirmDel;
    if (!target || deletingRow) return;
    const rowKey = rowKeyOf(target);
    setDeletingRow(rowKey);
    try {
      await deleteSessionFile(target.dirName, target.sessionId);
      notify('세션을 완전히 삭제했습니다.');
    } catch (err) {
      if (err?.status === 404) {
        notify('이미 삭제된 세션입니다.'); // 외부 삭제와 수렴 — 아래 낙관적 제거 공유
      } else if (err?.status === 409) {
        // 서버가 라이브 세션 파일을 지키는 정상 응답 — 행을 지우면 안 된다.
        notify('실행 중인 세션은 삭제할 수 없습니다. 먼저 세션을 종료하세요.', 'error');
        setDeletingRow(null);
        setConfirmDel(null);
        refreshPast(limit);
        return;
      } else {
        notify(`삭제 실패: ${String(err.message ?? err)}`, 'error');
        setDeletingRow(null);
        return; // 확인 모달 유지 — 재시도/취소 선택
      }
    }
    // 여기(성공·404)서는 확인 모달을 연 🗑 버튼이 곧 사라진다 — 포커스 착지점을
    // 목록 제목으로 갈아 끼운다(확인 모달 언마운트 시 읽힌다).
    // 기록 파일이 사라졌으니 그 세션에 붙여 둔 이름도 함께 정리한다(찌꺼기 방지).
    saveTitle(target.sessionId, '');
    restoreTargetRef.current = pastHeadingRef.current;
    // 낙관적 제거(성공·404 공통): 재조회가 실패해도 삭제된 행이 부활하지 않도록
    // 먼저 목록에서 빼고 나서 갱신을 시도한다.
    setPast((cur) => (Array.isArray(cur) ? cur.filter((s) => rowKeyOf(s) !== rowKey) : cur));
    setDeletingRow(null);
    setConfirmDel(null);
    onHistoryChanged?.();
    refreshPast(limit);
  };

  const pastReady = Array.isArray(past);
  const rows = mergeRecentSessions({ fetched: pastReady ? past : [], liveIds });
  const canLoadMore = pastReady && limit === PAST_LIMIT_DEFAULT && past.length >= PAST_LIMIT_DEFAULT;

  // 지난 세션 행 — 재개(2줄 본문)와 삭제를 형제 버튼으로(버튼 중첩 금지).
  // cwd를 모르면 재개만 막고 삭제는 계속 허용한다(정리 경로를 남긴다).
  const pastRow = (s) => {
    const rowKey = rowKeyOf(s);
    const thisResuming = resumingKey === rowKey;
    const deleting = deletingRow === rowKey;
    // 재개는 한 번에 하나만 — 진행 중에는 모든 행의 재개를 잠근다(조용히 무시되는
    // 버튼을 남기지 않기 위해 시각·보조기술 상태도 함께 끈다).
    const resumeBlocked = resuming || !!deletingRow || !s.cwd;
    // 지난 세션도 사용자가 지정한 이름을 먼저 쓴다 — 사이드바에서 이름을 바꾼 뒤
    // 세션을 닫으면 같은 이름 그대로 이 목록에 나타난다.
    const title = sessionDisplayTitle({
      customTitle: titleFor(s.sessionId),
      title: s.title,
      sessionId: s.sessionId,
      fallback: '(제목 없음)',
    });
    // 서브라인: 디렉터리 · 마지막 접근(상대) · 대화 크기
    const meta = [shortDir(s.cwd) || s.dirName, fmtAgo(s.mtime), fmtBytes(s.fileSize)]
      .filter(Boolean)
      .join(' · ');
    // 절대 시각·정확 바이트는 재개 버튼의 단일 툴팁에 통합 — 부모 행에 따로 달면
    // 자식 버튼 툴팁이 hover/focus를 선점해 가려지고 키보드 사용자에게 닿지 않는다.
    const tip = [
      s.cwd ? `재개: ${s.cwd}` : 'cwd를 알 수 없어 재개할 수 없습니다',
      fmtTime(s.mtime),
      s.fileSize != null ? `${s.fileSize.toLocaleString()} bytes` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div key={rowKey} className="past-row">
        <button
          type="button"
          className="past-resume"
          aria-disabled={resumeBlocked}
          data-tip={tip}
          onClick={() => resumeRow(s)}
        >
          <span className="past-lines">
            <span className="truncate">{title}</span>
            <span className="past-sub dim truncate">{thisResuming ? '재개하는 중…' : meta}</span>
          </span>
        </button>
        <button
          type="button"
          className="past-del"
          aria-label={`세션 삭제: ${title}`}
          data-tip="완전히 삭제"
          disabled={resuming || deleting}
          onClick={(e) => {
            restoreTargetRef.current = e.currentTarget;
            setConfirmDel(s);
          }}
        >
          🗑
        </button>
      </div>
    );
  };

  return (
    <>
      <div
        className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
        // 확인 모달이 떠 있는 동안(페이드아웃 포함)에는 아래 레이어 전체를 비활성화 —
        // 배경 클릭으로 새 세션 모달이 먼저 닫히거나 Tab이 새는 것을 막는다.
        inert={confirmMounted ? true : undefined}
        onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            requestClose();
          }
        }}
      >
        <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label="새 세션">
          <div className="modal-title">
            새 세션
            <span className="spacer" />
            <button
              type="button"
              className="icon-btn"
              onClick={requestClose}
              disabled={resuming}
              aria-label="닫기"
              data-tip="닫기"
            >
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

            <div className="picker-row">
              <label className="picker-field">
                <span className="dim">모델</span>
                <select value={modelValue} onChange={(e) => setModel(e.target.value)}>
                  <option value="">(기본 모델 — 재개 시 기존 모델 유지)</option>
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

            {mode === 'bypassPermissions' && <TrustModeWarning />}

            {error && <div className="sidebar-error">{error}</div>}

            {/* 지난 세션 — 히스토리의 유일한 창구(조회·재개·삭제). 위에서 고른
                모델·권한 모드가 재개에도 그대로 적용된다. */}
            <div className="picker-field past-field">
              <span className="dim" id="past-sessions-heading" tabIndex={-1} ref={pastHeadingRef}>
                지난 세션 — 클릭하면 위 설정으로 이어서 재개합니다
              </span>
              <div
                className="past-list"
                role="group"
                aria-labelledby="past-sessions-heading"
                aria-busy={pastLoading || resuming}
              >
                {/* 비동기 상태(로딩·오류·비어 있음·재개 중)는 role="status"로 묶어
                    스크린 리더에 알린다 — 시각 표시만으로는 전달되지 않는다. */}
                <div role="status" className="past-status">
                  {pastLoading && !pastReady && !pastError && (
                    <span className="dim past-note">불러오는 중…</span>
                  )}
                  {pastError && (
                    <span className="past-note past-note-error">
                      <span className="dim">지난 세션을 불러오지 못했습니다.</span>
                      <button type="button" className="past-retry" onClick={() => refreshPast(limit)}>
                        다시 시도
                      </button>
                    </span>
                  )}
                  {pastReady && !pastError && rows.length === 0 && (
                    <span className="dim past-note">지난 세션 없음</span>
                  )}
                  {resuming && <span className="dim past-note">세션을 재개하는 중…</span>}
                </div>
                {rows.map((s) => pastRow(s))}
                {canLoadMore && (
                  <button
                    type="button"
                    className="past-more-btn dim"
                    onClick={() => setLimit(PAST_LIMIT_MAX)}
                  >
                    더 보기 (최근 {PAST_LIMIT_MAX}개)
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" onClick={requestClose} disabled={resuming}>
              취소
            </button>
            <button type="button" className="btn-primary" onClick={start} disabled={resuming}>
              {resuming ? '재개하는 중…' : '세션 시작'}
            </button>
          </div>
        </div>
      </div>

      {/* 삭제 확인 — 새 세션 모달의 형제로 렌더(중첩 금지: 두 포커스 트랩이 서로
          간섭하지 않게). DOM 순서상 뒤라 같은 z-index에서도 위에 쌓인다. */}
      {confirmMounted && lastConfirmRef.current && (
        <ConfirmDeleteModal
          target={lastConfirmRef.current}
          presenceStatus={confirmStatus}
          busy={!!deletingRow}
          restoreRef={restoreTargetRef}
          onConfirm={confirmDelete}
          onClose={() => !deletingRow && setConfirmDel(null)}
        />
      )}
    </>
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

// 설정 패널 — 테마(라이트/다크 세그먼트) / 새 세션 기본값(모델·권한 모드) /
// 디버그 raw 이벤트 표시 스위치(store debugRaw + localStorage 'ccob-debug').
//
// 기본값은 "새 세션 모달을 열 때의 초기 선택값"에만 쓰인다 — 실행 중 세션이나
// 이미 열려 있는 모달에는 소급 적용하지 않는다.
function SettingsPanel({ theme, onSetTheme, onEditConfig }) {
  const { state, setDebug } = useStore();
  const [defaults, setDefaults] = useState(() => loadDefaults());
  // 모델 카탈로그는 CLI가 세션 init에서 보고한다 — 앱을 켜고 아직 아무 세션도
  // 시작하지 않았다면 비어 있어 고를 수 없다(안내 문구로 대체).
  const models = Array.isArray(state.initInfo?.models) ? state.initInfo.models : [];
  const catalogReady = models.length > 0;
  const modelValue = resolveDefaultModel(defaults.model, models);

  const setDefaultModel = (value) => {
    setDefaults((cur) => ({ ...cur, model: value }));
    writePref(DEFAULT_MODEL_KEY, value);
  };
  const setDefaultMode = (value) => {
    setDefaults((cur) => ({ ...cur, mode: value }));
    writePref(DEFAULT_MODE_KEY, value);
  };

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
        <label className="setting-label" htmlFor="default-model-select" data-tip="새 세션 모달을 열 때 미리 선택되는 모델입니다">
          기본 모델
        </label>
        <select
          id="default-model-select"
          className="setting-select"
          value={modelValue}
          disabled={!catalogReady}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          <option value="">(기본 모델)</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName || m.value}
            </option>
          ))}
        </select>
      </div>
      {!catalogReady && (
        <div className="dim setting-note">
          모델 목록은 CLI가 세션을 시작할 때 알려줍니다 — 세션을 한 번 시작하면 여기서 고를 수 있습니다.
        </div>
      )}

      <div className="setting-row">
        <label className="setting-label" htmlFor="default-mode-select" data-tip="새 세션 모달을 열 때 미리 선택되는 권한 모드입니다">
          기본 권한 모드
        </label>
        <select
          id="default-mode-select"
          className={`setting-select ${MODE_CLASS[defaults.mode] || ''}`.trim()}
          value={defaults.mode}
          onChange={(e) => setDefaultMode(e.target.value)}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {defaults.mode === 'bypassPermissions' && <TrustModeWarning />}

      {/* CLI 전역 설정 파일 편집 — 이 앱의 기본값(위 항목들)과 달리 Claude Code
          자체의 설정이라, 여는 버튼과 경고를 분명히 분리해 둔다. */}
      <div className="setting-row">
        <span
          className="setting-label"
          data-tip="Claude Code CLI의 사용자 설정 파일을 직접 편집합니다 — 저장하면 이후 시작되는 모든 세션에 적용됩니다"
        >
          Claude Code Config
          {/* 어떤 파일을 여는지 버튼을 누르기 전에 보이도록 — 절대 경로는 편집기 안에서 */}
          <span className="setting-sub dim">~/.claude/settings.json</span>
        </span>
        <button
          type="button"
          className="setting-edit-btn"
          onClick={(e) => onEditConfig(e.currentTarget)}
        >
          편집
        </button>
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
function FootModal({ panel, presenceStatus, onClose, theme, onSetTheme, onEditConfig, inert }) {
  const { state, notify } = useStore();
  const dialogRef = useFocusTrap(true);
  const title = panel === 'stats' ? '통계' : '설정';
  return (
    <div
      className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      // Config 편집기가 떠 있는 동안(페이드아웃 포함) 이 레이어 전체를 비활성화 —
      // 배경 클릭으로 설정 모달이 먼저 닫히거나 Tab이 새는 것을 막는다.
      inert={inert ? true : undefined}
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
            <SettingsPanel theme={theme} onSetTheme={onSetTheme} onEditConfig={onEditConfig} />
          )}
        </div>
      </div>
    </div>
  );
}

// 닫힘 페이드아웃(140ms) 동안 마지막 패널 내용을 유지한 채 마운트를 지속.
function FootModalPresence({ panel, ...rest }) {
  // rest에는 inert·onEditConfig가 그대로 흘러간다(설정 패널 → Config 편집기 배선).
  const { mounted, status } = usePresence(!!panel, 140);
  const lastPanelRef = useRef(panel);
  if (panel) lastPanelRef.current = panel;
  if (!mounted || !lastPanelRef.current) return null;
  return <FootModal panel={lastPanelRef.current} presenceStatus={status} {...rest} />;
}

// ----- 사이드바 본체 -----
export default function Sidebar({ onCollapse, theme, onSetTheme }) {
  const { state, dispatch, startSession, stopSession, renameSession, notify } = useStore();
  const modalOpen = state.newSessionOpen;
  const openModal = () => dispatch({ type: 'open-new-session' });
  const closeModal = () => dispatch({ type: 'close-new-session' });
  const [defaultCwd, setDefaultCwd] = useState('');
  const [platform, setPlatform] = useState(null); // 네이티브 폴더 선택 버튼 노출 판단
  const [footPanel, setFootPanel] = useState(null); // null | 'stats' | 'settings'
  // 세션 컨텍스트 메뉴 — {rowKey, x, y}. 행 데이터는 매 렌더에 스토어에서 다시 읽어
  // 메뉴가 열린 사이 세션이 종료·제거돼도 낡은 정보로 동작하지 않게 한다.
  const [menu, setMenu] = useState(null);
  const menuTriggerRef = useRef(null); // 메뉴를 연 요소 — 닫힐 때 포커스를 돌려줄 대상
  // 인라인 이름 변경 — {rowKey, value}. 한 번에 한 행만 편집한다.
  const [renaming, setRenaming] = useState(null);
  // 행 key -> .sess-main 버튼. 우클릭(포커스 불가한 행 div)과 이름 변경 종료 뒤
  // 포커스를 돌려줄 실제 대상이다 — 없으면 포커스가 <body>로 떨어진다.
  // ⋯·✕ 버튼을 없앤 뒤로는 행에서 포커스를 받을 수 있는 유일한 요소이기도 하다.
  const rowBtnRefs = useRef(new Map());
  // 행이 통째로 사라지는 동작(목록에서 제거) 뒤 포커스가 갈 곳
  const newSessionBtnRef = useRef(null);
  const [focusRow, setFocusRow] = useState(null); // 렌더 후 포커스를 줄 행 key
  // Claude Code Config 편집기 — 설정 모달 위에 형제로 뜬다. 페이드아웃(140ms)까지
  // 마운트를 유지해야 아래 레이어의 inert 해제 시점이 애니메이션과 어긋나지 않는다.
  const [configOpen, setConfigOpen] = useState(false);
  const configTriggerRef = useRef(null); // "편집" 버튼 — 닫힐 때 포커스 복귀 대상
  const { mounted: configMounted, status: configStatus } = usePresence(configOpen, 140);
  // 재개 잠금 — 모달 밖에 두어 모달을 닫았다 다시 열어도 유지된다. ref는 첫 await
  // 전에 동기적으로 세우는 실제 관문이고, state는 UI 표시용 미러다.
  const [resumingKey, setResumingKey] = useState(null);
  const resumeLockRef = useRef(false);
  const resumeTimerRef = useRef(null);
  // 시도 세대 — watchdog이 잠금을 회수하면 이 값을 올려 그 시도를 폐기한다.
  // 폐기된 시도는 뒤늦게 응답이 와도 세션을 만들지 않고, 뒤이은 새 시도의
  // 잠금·모달 상태도 건드리지 않는다(codex 지적: 타임아웃 후 재시도 이중 스폰).
  const resumeAttemptRef = useRef(0);
  const releaseResume = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    resumeLockRef.current = false;
    setResumingKey(null);
  }, []);
  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  // 에러는 영구 배너 대신 토스트(자동 소멸)로 — 모달 내부의 폼 검증 문구만 인라인 유지.
  const refreshProjects = async () => {
    try {
      const projects = await fetchProjects();
      dispatch({ type: 'set-projects', projects });
      return projects;
    } catch (err) {
      notify(String(err.message ?? err), 'error');
      return null;
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

  // 성공 시 true — 호출측(모달)이 busy 유지/해제와 모달 닫기를 판단한다.
  // model/permissionMode는 모달에서 고른 값. 신뢰모드는 스폰 시에만 진입할 수
  // 있으므로 모달 재개가 신뢰모드로 이어가는 유일한 경로다.
  const resumeSession = async (
    project,
    meta,
    { permissionMode = 'default', model = null, shouldProceed } = {},
  ) => {
    try {
      const { messages } = await fetchTranscript(project.dirName, meta.sessionId);
      // 트랜스크립트가 도착하기까지 시간이 걸린다 — 그 사이 이 시도가 폐기됐다면
      // (watchdog 타임아웃 등) 여기서 멈춘다. 스폰 직전이 마지막 관문이다.
      if (shouldProceed && !shouldProceed()) return false;
      // 트랜스크립트를 여기서 미리 reduce해 started 커밋에 원자적으로 시딩한다.
      // (별도 커밋으로 뒤늦게 주입하면 ChatView seenRef가 히스토리를 신규 메시지로
      // 오인해 등장 애니·타자기 출력을 탄다 — store-reducer 'started' 주석 참조.)
      const pre = messages.reduce(
        (acc, m) => reduceCliEvent(acc, m),
        createSessionState(),
      );
      const startId = startSession({
        cwd: project.cwd,
        // 사용자가 모달에서 고른 모델(카탈로그 대조를 통과한 값)만 스폰 --model로
        // 나간다. null이면 --model 생략 = 그 세션이 쓰던 모델 유지.
        model,
        permissionMode,
        resumeSessionId: meta.sessionId,
        // 표시 전용 모델 이월(스폰 --model엔 불사용 — 트랜스크립트의 해석 id는
        // 구식이거나 [1m] 접미사가 탈락했을 수 있어 스폰 인자로는 위험).
        // 재개 직후 피커 라벨·CTX 분모가 맞고, init의 실제값이 곧 덮어쓴다.
        preloadModel: pre.model,
        preloadMessages: pre.messages,
        // 디스크에서 되살린 과거 대화임을 표시 — 실행 중 도크가 이 메시지들의
        // '결과 없는 도구'를 유령으로 세지 않게 한다. effort 재시작처럼 라이브
        // 대화를 이월하는 경로에는 붙이지 않는다(그건 실제로 돌고 있는 작업이다).
        preloadIsHistory: true,
        preloadSessionId: pre.sessionId,
        // 이 세션에 붙여 둔 이름을 이어 간다 — 재개하면 CLI가 새 id로 fork할 수
        // 있어, 화면 이름이 자동 제목으로 되돌아가 보이는 것을 막는다. 새 id로의
        // 영속 이월은 id가 확정될 때 store.jsx가 맡는다.
        preloadCustomTitle: titleFor(meta.sessionId),
        preloadUsage: pre.usage,
        // 트랜스크립트에 호출별 usage가 있었다면 그 사실도 이월 — 시딩 직후의
        // result성 이벤트가 합산 usage로 컨텍스트를 덮는 경로를 원천 차단(방어).
        preloadCtxFromCalls: pre.ctxFromCalls,
      });
      // startSession은 WS 전송이 실패하면 null을 준다 — 그때는 "시작됨"으로
      // 취급하지 않는다(모달을 닫지 않고 잠금도 푼다). 오류는 이미 토스트로 표시된다.
      return startId !== null;
    } catch (err) {
      notify(String(err.message ?? err), 'error');
      return false;
    }
  };

  // 모달의 지난 세션 행 재개 — 잠금 획득 → 재개 → (성공 시) 모달 닫기.
  // 잠금은 첫 await 전에 동기적으로 세우고, finally에서 반드시 회수한다.
  // 트랜스크립트 요청이 끝내 정착하지 않는 경우는 watchdog이 회수한다.
  const resumeFromModal = async (s, opts) => {
    if (resumeLockRef.current) return false;
    const attempt = ++resumeAttemptRef.current;
    const isCurrent = () => resumeAttemptRef.current === attempt;
    resumeLockRef.current = true;
    setResumingKey(`${s.dirName}\n${s.sessionId}`);
    resumeTimerRef.current = setTimeout(() => {
      // 세대를 올려 이 시도를 폐기한 뒤에 잠금을 푼다 — 뒤늦게 도착한 응답이
      // 세션을 만들거나 사용자의 재시도를 방해하지 못하게.
      resumeAttemptRef.current += 1;
      notify('재개 응답이 오지 않아 잠금을 해제했습니다. 다시 시도해 주세요.', 'error');
      releaseResume();
    }, RESUME_BUSY_TIMEOUT_MS);
    let ok = false;
    try {
      ok = await resumeSession(
        { dirName: s.dirName, cwd: s.cwd },
        { sessionId: s.sessionId },
        { ...opts, shouldProceed: isCurrent },
      );
    } finally {
      // 폐기된 시도는 이미 남의 것이 된 잠금·타이머를 건드리지 않는다.
      if (isCurrent()) releaseResume();
    }
    if (ok && isCurrent()) closeModal();
    return ok;
  };

  const openSessions = [...state.sessions.values()];

  const tree = buildSessionTree({
    liveSessions: openSessions,
    projects: state.projects,
    activeKey: state.activeKey,
  });
  const liveOthers = tree.others.filter((n) => n.live.length > 0);

  // 컨텍스트 메뉴 열기 — 이제 진입점은 행 우클릭 하나뿐이다(⋯ 버튼 제거, 2026-08-09).
  // 키보드(컨텍스트 메뉴 키·Shift+F10)도 같은 contextmenu 이벤트로 오지만 좌표가
  // 0/음수인 브라우저가 있어, 그때는 행 버튼의 모서리를 기준으로 띄운다.
  const openRowMenu = (rowKey, trigger, point) => {
    const usable = point && point.x > 0 && point.y > 0;
    const rect = trigger?.getBoundingClientRect?.();
    menuTriggerRef.current = trigger ?? null;
    setMenu({
      rowKey,
      x: usable ? point.x : (rect?.left ?? 0),
      y: usable ? point.y : (rect?.bottom ?? 0),
    });
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  // 메뉴가 열려 있는 사이 세션이 사라지면(종료 유예 만료·재시작 대체) 조용히 닫는다.
  useEffect(() => {
    if (menu && !state.sessions.has(menu.rowKey)) setMenu(null);
    if (renaming && !state.sessions.has(renaming.rowKey)) setRenaming(null);
  }, [state.sessions, menu, renaming]);

  // 이름 변경 종료. restoreFocus는 키보드로 끝낸 경우(Enter·Esc)에만 참 —
  // 다른 곳을 클릭해서 끝난(blur) 경우까지 포커스를 되돌리면 방금 누른 컨트롤에서
  // 포커스를 빼앗는다.
  const endRename = ({ save, restoreFocus }) => {
    if (!renaming) return;
    if (save) renameSession(renaming.rowKey, renaming.value);
    if (restoreFocus) setFocusRow(renaming.rowKey);
    setRenaming(null);
  };

  // 이름 변경이 끝난 뒤 그 행으로 포커스 복귀 — 버튼이 다시 그려진 다음에 실행된다.
  useEffect(() => {
    if (!focusRow) return;
    rowBtnRefs.current.get(focusRow)?.focus?.();
    setFocusRow(null);
  }, [focusRow]);

  // 라이브 세션 행 — 렌더 헬퍼(요소 인스턴스화가 아니라 호출)로 두어 DOM을 안정화.
  // 매 렌더마다 새 컴포넌트 타입이 생기지 않으므로 React가 remount 없이 patch한다.
  const liveRow = (row, node) => {
    const sess = state.sessions.get(row.key);
    // 상태는 텍스트 배지가 아니라 점의 색으로만 보인다 — 라벨은 보조기술과 툴팁에
    // 남는다(lib/session-status.js). 대기 중인 요청의 앞머리가 AskUserQuestion이면
    // '권한 대기' 대신 '질문 대기'로, 다이얼로그 분기와 같은 판별을 쓴다.
    const dot = statusDotOf(
      row.status,
      isQuestionRequest(sess?.pendingPermissions?.[0]),
    );
    const dotCls = `sess-dot${dot.cls ? ` ${dot.cls}` : ''}`;
    const dotLabel = `상태: ${dot.label}`;
    // 세션 이름 — 사용자가 지정한 이름이 있으면 그것, 없으면 자동 제목(sessionDisplayTitle).
    const label = sessionDisplayTitle({
      customTitle: sess?.customTitle,
      messages: sess?.messages,
      sessionId: row.sessionId,
    });
    // 이름 변경 중인 행은 입력 한 줄로 바뀐다 — Enter 저장 / Esc 취소 / 포커스를
    // 잃으면 저장(다른 곳을 눌러 편집을 "끝내는" 흔한 기대에 맞춘다).
    if (renaming?.rowKey === row.key) {
      return (
        <div key={row.key} className={`sess-row live renaming${row.active ? ' active' : ''}`}>
          {/* 이름을 고치는 동안에도 상태 점은 그대로 — 편집 중이라고 세션이
              멈추는 것은 아니다(편집 중 색이 accent로 되돌아가던 회귀 방지). */}
          <span className={dotCls} role="img" aria-label={dotLabel} />
          <input
            className="sess-rename-input"
            autoFocus
            value={renaming.value}
            aria-label="세션 이름"
            placeholder={label}
            maxLength={MAX_TITLE_LEN}
            onChange={(e) => setRenaming((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
            onBlur={() => endRename({ save: true, restoreFocus: false })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                endRename({ save: true, restoreFocus: true });
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                endRename({ save: false, restoreFocus: true });
              }
            }}
          />
        </div>
      );
    }

    return (
      <div
        key={row.key}
        className={`sess-row live${row.active ? ' active' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          // 복원 대상은 행 <div>(포커스 불가)가 아니라 그 안의 세션 버튼이다.
          openRowMenu(row.key, rowBtnRefs.current.get(row.key), { x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          className="sess-main"
          ref={(el) => {
            if (el) rowBtnRefs.current.set(row.key, el);
            else rowBtnRefs.current.delete(row.key);
          }}
          onClick={() => dispatch({ type: 'set-active', key: row.key })}
          // 상태 텍스트가 화면에서 사라졌으므로 툴팁에 꼬리로 붙인다 — 색만으로
          // 구분하기 어려운 사용자의 확인 경로(hover 없는 기기에는 닿지 않는다).
          data-tip={`${
            label !== node.cwd ? `${label}${node.cwd ? ` — ${node.cwd}` : ''}` : node.cwd || node.label
          } · ${dot.label}`}
          // 이름 변경·종료는 우클릭 메뉴에만 있다 — 키보드 사용자에게 여는 법을 알린다.
          aria-keyshortcuts="Shift+F10"
        >
          <span className={dotCls} role="img" aria-label={dotLabel} />
          <span className="truncate">{label}</span>
        </button>
      </div>
    );
  };

  // 디렉토리 그룹 — 라이브 세션 전용(히스토리는 새 세션 모달의 "지난 세션"으로 단일화).
  // 헤더는 클릭 동작이 없는 라벨이고, 배지는 열린 세션 수를 표시한다.
  const dirGroup = (node) => (
    <div key={node.key} className={`dir-group${node.active ? ' active-dir' : ''}`}>
      <div className="dir-head static" data-tip={node.cwd || node.label}>
        <span className="dir-ico" aria-hidden="true">📁</span>
        <span className="truncate">{node.label}</span>
        <span className="badge">{node.live.length}</span>
      </div>
      {node.live.map((row) => liveRow(row, node))}
    </div>
  );

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
        <button type="button" className="new-session-btn" ref={newSessionBtnRef} onClick={openModal}>
          <span className="ns-plus" aria-hidden="true">+</span> 새 세션
        </button>

        {tree.pinned && (
          <div className="pin-box">
            <div className="sidebar-h current">현재 세션</div>
            {dirGroup(tree.pinned)}
          </div>
        )}

        {/* 다른 프로젝트에서 아직 살아 있는 세션 — 전환·종료 경로 */}
        {liveOthers.length > 0 && (
          <>
            <div className="sidebar-h">다른 열린 세션</div>
            {liveOthers.map((n) => dirGroup(n))}
          </>
        )}

        {openSessions.length === 0 && (
          <div className="sidebar-empty">
            <Mascot scale={5} className="empty-mascot" />
            <span className="dim">새 세션을 시작하면 여기에 표시됩니다</span>
            <span className="dim empty-hint">지난 대화는 “+ 새 세션”에서 이어갈 수 있습니다</span>
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
        defaultCwd={defaultCwd}
        platform={platform}
        onClose={closeModal}
        onStart={(opts) => {
          if (startSession(opts) !== null) closeModal();
        }}
        // 재개는 전송(startSession 등록)이 끝난 뒤에 모달을 닫는다 — 먼저 닫으면
        // 모달이 언마운트되며 중복 재개 가드까지 사라진다(codex 지적).
        onResume={resumeFromModal}
        resumingKey={resumingKey}
        onHistoryChanged={refreshProjects}
      />

      {/* 세션 컨텍스트 메뉴 — position:fixed라 aside 밖에서 커서 좌표에 뜬다.
          항목은 지금 상태로 매번 다시 만든다(메뉴가 열린 사이 상태가 바뀔 수 있다). */}
      {menu && state.sessions.has(menu.rowKey) && (
        <SessionMenu
          anchor={{ x: menu.x, y: menu.y }}
          label="세션 메뉴"
          restoreRef={menuTriggerRef}
          onClose={closeMenu}
          items={[
            {
              key: 'rename',
              icon: '✎',
              label: '이름 변경',
              onSelect: () => {
                const sess = state.sessions.get(menu.rowKey);
                // 입력 초기값은 "지금 지정된 이름"뿐 — 자동 제목을 채워 넣으면
                // 사용자가 지우지 않는 한 그 요약이 고정 이름으로 굳어 버린다.
                setRenaming({ rowKey: menu.rowKey, value: sess?.customTitle ?? '' });
              },
            },
            // 실행 중이면 CLI 프로세스를 정지하고, 이미 끝난 세션이면 목록에서 치운다.
            // 같은 자리에서 다른 일을 하므로 라벨도 다르게 — "닫기"가 무엇을 하는지
            // 사용자가 눌러 보기 전에 알 수 있어야 한다.
            // key는 'close'로 고정한다 — 메뉴가 열린 사이 세션이 종료되면 라벨과
            // 동작만 갈아 끼우고 버튼은 그대로 둔다(키가 바뀌면 remount되며 그 항목에
            // 있던 포커스가 사라진다).
            state.sessions.get(menu.rowKey)?.status === 'exited'
              ? {
                key: 'close',
                icon: '✕',
                label: '목록에서 제거',
                onSelect: () => {
                  dispatch({ type: 'remove-session', key: menu.rowKey });
                  // 행과 트리거가 같은 렌더에서 사라진다 — 메뉴가 돌려줄 포커스가
                  // 없으므로 사이드바의 안정된 지점("새 세션")으로 옮긴다.
                  menuTriggerRef.current = newSessionBtnRef.current;
                },
              }
              : {
                key: 'close',
                icon: '✕',
                label: '세션 종료 (CLI 정지)',
                danger: true,
                onSelect: () => stopSession(menu.rowKey),
              },
          ]}
        />
      )}

      {/* 통계·설정 모달도 aside 밖 — 새 세션 모달과 같은 이유. */}
      <FootModalPresence
        panel={footPanel}
        onClose={() => setFootPanel(null)}
        theme={theme}
        onSetTheme={onSetTheme}
        inert={configMounted}
        onEditConfig={(trigger) => {
          configTriggerRef.current = trigger ?? null;
          setConfigOpen(true);
        }}
      />

      {/* Config 편집기 — 설정 모달의 형제로 렌더(중첩 금지). DOM 순서상 뒤라
          같은 z-index에서도 위에 쌓이지만, CSS로도 의도를 못박아 둔다. */}
      {configMounted && (
        <ConfigEditorModal
          presenceStatus={configStatus}
          restoreRef={configTriggerRef}
          notify={notify}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </>
  );
}

// 삭제 확인 모달 — 새 세션 모달과 같은 overlay/trap 패턴, 삭제 중에는 닫기 차단.
// restoreRef: 닫힐 때 포커스를 돌려줄 대상. 취소면 이 모달을 연 🗑 버튼, 삭제
// 성공이면 (그 버튼이 사라지므로) 지난 세션 목록 제목 — 호출측이 갈아 끼운다.
function ConfirmDeleteModal({ target, presenceStatus, busy, restoreRef, onConfirm, onClose }) {
  const dialogRef = useFocusTrap(true, undefined, restoreRef);
  // 목록 행과 같은 이름을 보여 준다 — 확인 모달만 다른 제목을 쓰면 "무엇을 지우는지"가
  // 어긋난다. 이름이 전혀 없을 때만 sessionId 전체를 노출한다.
  const title = sessionDisplayTitle({
    customTitle: titleFor(target.sessionId),
    title: target.title,
    sessionId: target.sessionId,
    fallback: '(제목 없음)',
  });
  return (
    <div
      className={`modal-overlay confirm-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div ref={dialogRef} className="modal confirm-modal" role="dialog" aria-modal="true" aria-label="세션 삭제 확인">
        <div className="modal-title">
          세션 삭제
          <span className="spacer" />
          {/* 삭제 중에는 취소·삭제와 함께 닫기도 잠근다 — 눌러도 아무 일이
              일어나지 않는 버튼을 보조기술에 활성으로 알리지 않기 위해. */}
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="닫기"
            data-tip="닫기"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-target truncate" data-tip={title}>{title}</p>
          <p className="dim confirm-note">
            이 세션의 기록 파일이 완전히 삭제되며 되돌릴 수 없습니다.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? '삭제 중…' : '삭제'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 새 세션 모달의 닫힘 애니메이션 — usePresence로 페이드아웃 동안 마운트를 유지한 뒤 제거.
function NewSessionPresence({ open, ...rest }) {
  const { mounted, status } = usePresence(open, 140);
  if (!mounted) return null;
  return <NewSessionModal {...rest} presenceStatus={status} />;
}
