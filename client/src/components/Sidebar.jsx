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
import { APP_VERSION, UNKNOWN_LABEL, infoValue, versionSkew } from '../lib/app-version.js';
import { updateMessage, updateStatus } from '../lib/update-check.js';
import {
  deleteSessionFile,
  fetchBootstrap,
  fetchDailyUsage,
  fetchProjects,
  fetchRecentSessions,
  fetchTranscript,
  fetchUpdateCheck,
  pickDirectory,
} from '../lib/api.js';
import { formReady, removePluginEntry, setPluginEnabled } from '../lib/claude-settings-form.js';
import { useClaudeConfigDraft } from '../lib/claude-config-draft.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { createSessionState, remoteControlByCwd, remoteControlFor } from '../lib/store-reducer.js';
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
import { SHAPES, SHAPE_LABEL } from '../lib/ui-shape.js';
import {
  DEFAULT_MODEL_KEY,
  DEFAULT_MODE_KEY,
  loadDefaults,
  resolveDefaultModel,
  writePref,
} from '../lib/preferences.js';
import { Sparkle, Mascot } from './Brand.jsx';
import Icon from './Icon.jsx';
import SessionMenu from './SessionMenu.jsx';
import ConfigEditorModal from './ConfigEditorModal.jsx';
import PluginsForm from './PluginsForm.jsx';
import TrustModeWarning from './TrustModeWarning.jsx';
import WorktreePanel from './WorktreePanel.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { usePresence } from '../lib/usePresence.js';
import './interact.css';

// package.json repository(github:seokjw0727/CC-on-browser)의 웹 주소. 여기 박아 두는
// 이유: 번들에 package.json을 끌어들이지 않으려고 vite define은 version만 넘긴다.
const REPO_URL = 'https://github.com/seokjw0727/CC-on-browser';

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

// 우클릭 메뉴의 원격 제어 항목이 툴팁으로 보여 줄 현재 상태. 켜짐일 때만 쓴다
// (꺼짐·불가 사유는 아래에서 따로 만든다). 컴포저 pill을 없앤 뒤로 이 메뉴가 원격
// 제어의 유일한 창구라, 상태 설명도 여기 한 줄에 담는다.
const RC_STATE_TIP = {
  starting: '원격 연결 중… — 누르면 취소하고 끕니다',
  ready: 'claude.ai·모바일 앱에서 이 레포를 조종할 수 있습니다',
  stopping: '원격 제어를 끄는 중입니다',
  error: '원격 제어가 실패한 상태입니다 — 끄면 정리됩니다',
};

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
      setError('작업 디렉터리를 선택하세요 (폴더 선택).');
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
      cliName: s.cliName,
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
          <Icon name="trash" className="ico-danger" />
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
              <Icon name="close" />
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
                  {browsing ? '탐색기 여는 중…' : (
                    <>
                      <Icon name="folder-open" /> 폴더 선택 (파일 탐색기)
                    </>
                  )}
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

// 브랜치가 갈라지는 모양 — worktree 패널이 보여 주는 것이 곧 이 모양이다.
// StatsIcon·SettingsIcon과 같은 20 격자 직접 그림(Icon.jsx 세트를 늘리지 않는 이유는
// 바로 아래 InfoIcon 주석과 같다).
function WorktreeIcon() {
  return (
    <svg className="foot-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 5.2v9.6" />
      <path d="M13.8 7.5h-3.3A4.5 4.5 0 0 0 6 12" />
      <circle cx="6" cy="3.6" r="1.6" />
      <circle cx="6" cy="16.4" r="1.6" />
      <circle cx="15.4" cy="7.5" r="1.6" />
    </svg>
  );
}

// 정보 아이콘만 Icon.jsx 세트에서 가져온다(StatsIcon·SettingsIcon은 20 격자 직접 그림).
// 새 path를 추가하지 않는 이유: icon.test.js가 세트를 정확한 종수로 고정해 두었고,
// 이미 같은 뜻의 'info'가 있다. 굵기 보정은 interact.css의 .foot-icon.ico가 한다.
function InfoIcon() {
  return <Icon name="info" size={17} className="foot-icon" />;
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

// 설정 패널 — 테마 / 세션 / 플러그인 / 업데이트 네 탭.
//
// 탭이 넷이 된 이유: 한 줄로 늘어놓던 시절엔 성격이 다른 항목(테마·새 세션 기본값·
// CLI 전역 설정)이 같은 목록에 섞여, 어느 것이 이 앱의 설정이고 어느 것이 Claude Code
// 자체의 설정인지 구분되지 않았다.
//
// 기본값(세션 탭)은 "새 세션 모달을 열 때의 초기 선택값"에만 쓰인다 — 실행 중 세션이나
// 이미 열려 있는 모달에는 소급 적용하지 않는다.
const SETTINGS_TABS = [
  { id: 'theme', label: '테마' },
  { id: 'session', label: '세션' },
  { id: 'plugins', label: '플러그인' },
  { id: 'update', label: '업데이트' },
];

function ThemeSettings({ theme, onSetTheme, shape, onSetShape }) {
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
            <Icon name="sun" /> 라이트
          </button>
          <button
            type="button"
            className={theme === 'dark' ? 'on' : ''}
            aria-pressed={theme === 'dark'}
            onClick={() => onSetTheme('dark')}
          >
            <Icon name="moon" /> 다크
          </button>
        </div>
      </div>
      {/* 색과 독립된 축 — 이 세그먼트 컨트롤 자체도 --r-pill을 쓰므로 누르는 즉시
          자기 모서리가 바뀌어 결과가 그 자리에서 보인다. */}
      <div className="setting-row">
        <span className="setting-label">모서리</span>
        <div className="seg" role="group" aria-label="모서리 스타일 선택">
          {SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              className={shape === s ? 'on' : ''}
              aria-pressed={shape === s}
              onClick={() => onSetShape(s)}
            >
              {SHAPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionSettings({ onEditConfig }) {
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

// 플러그인 탭 — Config 편집기와 **같은** 파일(~/.claude/settings.json)을 다룬다.
// 두 화면이 각자 draft를 들기 때문에, 탭에 들어올 때와 편집기가 닫힌 뒤 다시 읽어야
// 편집기에서 저장한 내용을 이 화면의 낡은 원문이 되돌려 놓지 않는다. 그래도 어긋나면
// 저장이 409로 막히고 "다시 불러오기"가 안전망이다.
function PluginSettings({ active, configEditorOpen, onEditConfig }) {
  const { notify } = useStore();
  const draft = useClaudeConfigDraft({ notify, auto: false });
  const { reloadIfClean } = draft;
  useEffect(() => {
    if (!active || configEditorOpen) return;
    // 다시 읽는 것은 **저장하지 않은 편집이 없을 때만**이다(설계도의 "탭 진입 시마다
    // 다시 읽는다"를 한 겹 좁혔다). 무조건 읽으면 방금 누른 켬/끔이 탭을 한 번
    // 오가는 것만으로 조용히 사라진다. 그 대신 남는 어긋남은 저장이 409로 막고
    // "다시 불러오기"가 받아 준다.
    reloadIfClean();
  }, [active, configEditorOpen, reloadIfClean]);

  return (
    <div className="settings-panel">
      {/* 비동기 상태(로딩·실패)는 시각 표시만으로 전달되지 않는다 — 라이브 영역으로. */}
      <div role="status">
        {draft.loading && <span className="dim foot-note">불러오는 중…</span>}
        {draft.loadError && (
          <span className="past-note past-note-error">
            <span className="dim">설정을 불러오지 못했습니다: {draft.loadError}</span>
            <button type="button" className="past-retry" onClick={draft.load}>
              다시 시도
            </button>
          </span>
        )}
      </div>

      {/* 로드 전(text가 빈 문자열)에는 formReady가 false다 — 관문이 없으면 탭에 들어간
          순간 "JSON 문법 오류" 거짓 안내가 먼저 뜬다(Config 편집기와 같은 처방). */}
      {!draft.loading && !draft.loadError && (
        <>
          {!formReady(draft.text) ? (
            <div className="cfg-form">
              <span className="dim cfg-blocked">
                지금 설정 파일은 폼으로 다룰 수 없습니다(JSON 문법 오류이거나 최상위가 객체가 아닙니다).
              </span>
              <button
                type="button"
                className="cfg-row-btn"
                onClick={(e) => onEditConfig(e.currentTarget)}
              >
                Config 편집기 열기
              </button>
            </div>
          ) : (
            <PluginsForm
              text={draft.text}
              disabled={draft.saving}
              plugins={draft.plugins}
              pluginsLoading={draft.pluginsLoading}
              pluginsError={draft.pluginsError}
              onReloadPlugins={draft.loadPlugins}
              onToggle={(k, v) => draft.apply(setPluginEnabled(draft.text, k, v))}
              onRemove={(k) => draft.apply(removePluginEntry(draft.text, k))}
              idPrefix="set"
              blocked={(
                <span className="dim cfg-blocked">
                  enabledPlugins가 &quot;이름: 켬/끔&quot; 형태가 아닙니다 — 값을 덮어쓰지 않았습니다.
                  세션 탭의 Config 편집기(JSON 탭)에서 고치세요.
                </span>
              )}
            />
          )}

          <div className="setting-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={draft.saving || !draft.dirty}
              onClick={draft.save}
            >
              {draft.saving ? '저장 중…' : '저장'}
            </button>
          </div>

          {/* 이 모달에는 Config 편집기의 "닫기 확인" 관문이 없어 Esc·배경 클릭으로 바로
              닫힌다 — 저장하지 않은 편집이 있다는 사실은 상시로 보여 준다. */}
          {draft.dirty && !draft.saving && (
            <div className="dim cfg-hint" role="status">
              저장하지 않은 변경이 있습니다 — 저장을 눌러야 파일에 반영됩니다.
            </div>
          )}
        </>
      )}

      {draft.error && (
        <div className="sidebar-error" role="alert">
          {draft.error}
          {draft.conflict && (
            <button type="button" className="past-retry" onClick={draft.load}>
              다시 불러오기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// 업데이트 탭 — 조회는 **버튼을 누를 때만** 나간다. 마운트 시 자동 조회를 넣지 말 것:
// 설정 모달을 여는 것만으로 앱이 밖에 신호를 보내게 된다(설계도 §4).
function UpdateSettings() {
  const [phase, setPhase] = useState('idle'); // idle | checking | done | failed
  const [result, setResult] = useState(null); // updateStatus() 결과
  const [error, setError] = useState(null); // 로컬 서버에조차 닿지 못한 경우
  // 요청 세대 + 생존 플래그 — 모달을 닫았다 다시 열거나 버튼을 연타한 뒤 늦게 도착한
  // 응답이 현재 화면을 덮어쓰지 못하게 한다.
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const check = async () => {
    const gen = (genRef.current += 1);
    setPhase('checking');
    setError(null);
    try {
      const payload = await fetchUpdateCheck();
      if (!aliveRef.current || genRef.current !== gen) return;
      setResult(updateStatus(payload));
      setPhase('done');
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      setError(String(err.message ?? err));
      setPhase('failed');
    }
  };

  return (
    <div className="settings-panel">
      <div className="setting-row">
        <span
          className="setting-label"
          data-tip="npm 레지스트리에서 배포된 최신 버전만 조회합니다 — 개인 정보는 보내지 않습니다"
        >
          업데이트 확인
        </span>
        <button
          type="button"
          className="setting-edit-btn"
          disabled={phase === 'checking'}
          aria-describedby="update-status"
          onClick={check}
        >
          {phase === 'checking' ? '확인 중…' : '확인'}
        </button>
      </div>
      <div className="dim setting-note">
        자동으로 확인하지 않습니다. 버튼을 누를 때만 registry.npmjs.org에 버전을 물어봅니다.
      </div>

      <div className="update-status" id="update-status" role="status">
        {phase === 'checking' && <span className="dim foot-note">확인 중…</span>}
        {phase === 'failed' && (
          <span className="past-note past-note-error">
            <span className="dim">업데이트를 확인하지 못했습니다: {error}</span>
            <button type="button" className="past-retry" onClick={check}>
              다시 시도
            </button>
          </span>
        )}
        {phase === 'done' && result && (
          <>
            <span className="foot-note">{updateMessage(result)}</span>
            {result.state === 'unknown' && result.reason === 'fetch-failed' && (
              <button type="button" className="past-retry" onClick={check}>
                다시 시도
              </button>
            )}
            {/* 실행은 사용자 손에 남긴다 — 서버가 npm install을 대신 돌리지 않는다. */}
            {result.state === 'outdated' && <code className="update-cmd">{result.command}</code>}
          </>
        )}
      </div>
    </div>
  );
}

// 네 탭의 껍데기. 패널은 전부 마운트해 두고 hidden만 토글한다 — aria-controls가
// 실재하는 요소를 가리켜야 하기 때문(Config 편집기와 같은 규칙). 다만 저장 중 탭을
// 잠그는 편집기와 달리 여기서는 잠그지 않는다: 다른 탭(테마·세션)은 저장 대상과
// 무관하고, 패널이 계속 마운트돼 있어 저장은 안전하게 끝난다.
function SettingsPanel({ theme, onSetTheme, shape, onSetShape, onEditConfig, configEditorOpen }) {
  const [tab, setTab] = useState('theme');
  const tabRefs = useRef(new Map());
  const goTab = (id) => {
    setTab(id);
    tabRefs.current.get(id)?.focus?.();
  };
  // 탭 이동 — WAI-ARIA 탭 패턴(←·→·Home·End). 포커스와 선택이 함께 움직인다.
  const onTabKeyDown = (e) => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step) {
      e.preventDefault();
      goTab(SETTINGS_TABS[(i + step + SETTINGS_TABS.length) % SETTINGS_TABS.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goTab(SETTINGS_TABS[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      goTab(SETTINGS_TABS[SETTINGS_TABS.length - 1].id);
    }
  };

  return (
    <div className="settings-shell">
      <div className="settings-tabs seg" role="tablist" aria-label="설정 항목">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`set-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`set-panel-${t.id}`}
            className={tab === t.id ? 'on' : ''}
            // 선택된 탭만 Tab 순서에 남긴다(탭 안 이동은 화살표 담당).
            tabIndex={tab === t.id ? 0 : -1}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
              else tabRefs.current.delete(t.id);
            }}
            onClick={() => goTab(t.id)}
            onKeyDown={onTabKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
      {SETTINGS_TABS.map((t) => (
        <div
          key={t.id}
          className="settings-tabpanel"
          role="tabpanel"
          id={`set-panel-${t.id}`}
          aria-labelledby={`set-tab-${t.id}`}
          hidden={tab !== t.id}
          tabIndex={0}
        >
          {t.id === 'theme' && (
            <ThemeSettings
              theme={theme}
              onSetTheme={onSetTheme}
              shape={shape}
              onSetShape={onSetShape}
            />
          )}
          {t.id === 'session' && <SessionSettings onEditConfig={onEditConfig} />}
          {t.id === 'plugins' && (
            <PluginSettings
              active={tab === 'plugins'}
              configEditorOpen={configEditorOpen}
              onEditConfig={onEditConfig}
            />
          )}
          {t.id === 'update' && <UpdateSettings />}
        </div>
      ))}
    </div>
  );
}

// 정보 패널 — "지금 무엇이 돌고 있는가"를 한 화면에 모은다.
// 앱(번들) 버전만 이 번들에 박힌 값(APP_VERSION)이고, 나머지는 전부 Sidebar 본체가
// 시작 때 한 번 받아 둔 /api/bootstrap 응답에서 온다. 여기서 다시 조회하지 않는 이유:
// `claude --version` 결과는 서버가 프로세스 단위로 캐시하므로 재조회로 새 값을 얻을
// 수도 없고, 데몬이 이미 죽었다면 재조회가 실패해 직전까지 알던 값마저 잃는다.
function InfoPanel({ appInfo, platform, skew }) {
  const rows = [
    { label: '앱(번들) 버전', value: infoValue(APP_VERSION), tip: '이 화면(정적 번들)이 빌드된 버전' },
    { label: '데몬 버전', value: infoValue(appInfo?.daemonVersion), tip: '브라우저를 닫아도 살아남는 백그라운드 서버의 버전' },
    { label: 'Claude CLI 버전', value: infoValue(appInfo?.claudeVersion), tip: '데몬이 실행하는 claude 실행 파일의 --version 출력' },
    { label: '플랫폼', value: infoValue(platform) },
    { label: '포트', value: infoValue(appInfo?.port) },
  ];
  return (
    <div className="info-panel">
      {rows.map(({ label, value, tip }) => (
        <div className="info-row" key={label}>
          <span className="info-label" data-tip={tip}>{label}</span>
          <span className={`info-value${value === UNKNOWN_LABEL ? ' unknown' : ''}`}>{value}</span>
        </div>
      ))}

      {/* 스큐를 여기서 versionSkew()로 다시 계산하지 않는다 — 판정 기준이 두 곳이 되면
          사이드바 하단 경고와 이 모달이 서로 다른 말을 할 수 있다. */}
      {skew && (
        <div className="info-skew" role="status">
          <Icon name="warning" size={14} />
          <span>
            서버 v{skew.server ?? '구버전'} · 화면 v{skew.client} — 모든 세션을 종료한 뒤 앱을 다시 실행해 주세요
          </span>
        </div>
      )}

      <div className="info-row">
        <span className="info-label">저장소</span>
        {/* window.open이 아니라 앵커로 둔다 — 키보드 포커스와 "어디로 가는가"(상태줄
            URL)를 브라우저가 공짜로 준다. noopener/noreferrer는 새 탭이 이 앱의
            window를 만지지 못하게(원격 제어 열기와 같은 이유). */}
        <a
          className="info-link"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-tip={REPO_URL}
        >
          GitHub <Icon name="external" size={13} />
        </a>
      </div>
    </div>
  );
}

// 패널 정의의 단일 출처. 제목·아이콘·본문이 세 군데에 흩어져 있으면 패널을 하나 늘릴
// 때 그중 하나를 빠뜨린 채 배포된다 — '정보'를 넣으며 실제로 세 곳을 따로 고쳐야 했다.
// 키를 Glyph로 둔 것은 의도적: Icon으로 구조분해하면 파일 상단에서 import한 Icon
// 컴포넌트를 가린다.
//
// modalClass는 폭이 기본형(.foot-modal 400px)과 달라야 하는 패널이 자기 클래스를 직접
// 들고 있게 한다. 예전에는 FootModal 안에서 패널 키를 삼항으로 비교해 설정에만 클래스를
// 붙였는데, 그 방식은 패널을 하나 더 넣을 때마다 표 밖의 분기가 자라 이 표의 존재
// 이유를 지운다. app-version.test.js가 그 분기의 부활을 막는다.
const FOOT_PANELS = {
  stats: {
    title: '통계',
    Glyph: StatsIcon,
    body: ({ state, notify }) => (
      <>
        <UsageStats gu={state.globalUsage} />
        <Retrospective notify={notify} />
      </>
    ),
  },
  worktree: {
    title: 'worktree',
    Glyph: WorktreeIcon,
    // 커밋 그래프와 경로가 들어가 통계·설정보다 넓어야 한다.
    modalClass: 'worktree-modal',
    body: ({ state }) => <WorktreePanel state={state} />,
  },
  settings: {
    title: '설정',
    Glyph: SettingsIcon,
    // 플러그인 목록 행이 400px에서 잘려 설정만 조금 넓힌다(interact.css의 배경 주석 참조).
    modalClass: 'settings-modal',
    body: ({ theme, onSetTheme, shape, onSetShape, onEditConfig, configEditorOpen }) => (
      <SettingsPanel
        theme={theme}
        onSetTheme={onSetTheme}
        shape={shape}
        onSetShape={onSetShape}
        onEditConfig={onEditConfig}
        configEditorOpen={configEditorOpen}
      />
    ),
  },
  info: {
    title: '정보',
    Glyph: InfoIcon,
    body: ({ appInfo, platform, skew }) => (
      <InfoPanel appInfo={appInfo} platform={platform} skew={skew} />
    ),
  },
};
// 화면 순서는 따로 적는다 — Object.keys에 기대면 표의 정의 순서를 옮기는 순간 UI가 바뀐다.
const FOOT_PANEL_ORDER = ['stats', 'worktree', 'settings', 'info'];

// 하단 고정 버튼 행 — 패널 자체는 화면 중앙 모달(FootModalPresence, aside 밖)로 뜬다.
function SidebarFoot({ openPanel, onToggle }) {
  return (
    <div className="sidebar-foot">
      {FOOT_PANEL_ORDER.map((panel) => {
        const { title, Glyph } = FOOT_PANELS[panel];
        return (
          <FootButton
            key={panel}
            title={title}
            panel={panel}
            openPanel={openPanel}
            onToggle={onToggle}
            icon={<Glyph />}
          />
        );
      })}
    </div>
  );
}

// 통계·설정·정보 중앙 모달 — 새 세션 모달과 같은 overlay/trap/presence 패턴.
// 포커스 복원은 useFocusTrap 언마운트 정리가 트리거 버튼으로 되돌린다.
function FootModal({
  panel, presenceStatus, onClose, theme, onSetTheme, shape, onSetShape,
  onEditConfig, inert, configEditorOpen, appInfo, platform, skew,
}) {
  const { state, notify } = useStore();
  const dialogRef = useFocusTrap(true);
  // 알 수 없는 panel로도 제목·아이콘 없는 빈 모달이 뜨지 않게 폴백을 둔다.
  const { title, Glyph, body, modalClass } = FOOT_PANELS[panel] ?? FOOT_PANELS.stats;
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
        className={`modal foot-modal${modalClass ? ` ${modalClass}` : ''}`}
        role="dialog"
        aria-modal="true"
        id={`sidebar-${panel}-modal`}
        aria-labelledby={`sidebar-${panel}-title`}
      >
        <div className="modal-title">
          <Glyph />
          <span id={`sidebar-${panel}-title`}>{title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </div>
        {/* body는 컴포넌트로 렌더(<Body/>)하지 않고 호출한다 — 표 항목이 컴포넌트
            타입이 되면 렌더마다 새 타입으로 보여 하위 상태(설정 탭 선택 등)가 날아간다. */}
        <div className="modal-body foot-body">
          {body({
            state, notify, theme, onSetTheme, shape, onSetShape, onEditConfig, configEditorOpen,
            appInfo, platform, skew,
          })}
        </div>
      </div>
    </div>
  );
}

// 닫힘 페이드아웃(140ms) 동안 마지막 패널 내용을 유지한 채 마운트를 지속.
function FootModalPresence({ panel, ...rest }) {
  // rest에는 inert·onEditConfig·configEditorOpen이 그대로 흘러간다(설정 패널 →
  // Config 편집기 배선과, 편집기가 닫힌 뒤 플러그인 탭이 다시 읽게 하는 신호).
  const { mounted, status } = usePresence(!!panel, 140);
  const lastPanelRef = useRef(panel);
  if (panel) lastPanelRef.current = panel;
  if (!mounted || !lastPanelRef.current) return null;
  return <FootModal panel={lastPanelRef.current} presenceStatus={status} {...rest} />;
}

// ----- 사이드바 본체 -----
export default function Sidebar({ onCollapse, theme, onSetTheme, shape, onSetShape }) {
  const {
    state, dispatch, startSession, stopSession, renameSession, setRemoteControl, notify,
  } = useStore();
  const modalOpen = state.newSessionOpen;
  const openModal = () => dispatch({ type: 'open-new-session' });
  const closeModal = () => dispatch({ type: 'close-new-session' });
  const [defaultCwd, setDefaultCwd] = useState('');
  const [platform, setPlatform] = useState(null); // 네이티브 폴더 선택 버튼 노출 판단
  // 서버(데몬)와 이 번들의 버전이 어긋났는가 — null이면 정상. 배경은 app-version.js.
  const [skew, setSkew] = useState(null);
  // 정보 모달이 쓰는 나머지 bootstrap 값. defaultCwd·platform과 같은 1회 응답에서
  // 갈라 담는다 — 모달 쪽에서 다시 부르면 데몬이 죽은 뒤 이미 알던 값까지 잃는다.
  // 조회 실패 시 null로 남고, 그때는 모든 행이 '알 수 없음'으로 정상 표시된다.
  const [bootInfo, setBootInfo] = useState(null); // {claudeVersion, daemonVersion, port} | null
  // null | 'stats' | 'worktree' | 'settings' | 'info' — 값의 출처는 FOOT_PANEL_ORDER다.
  const [footPanel, setFootPanel] = useState(null);
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
        // 서버가 키를 빼먹거나(구버전 데몬) 타입이 다를 수 있으므로 여기서 한 번
        // 정규화해 둔다 — 화면 쪽 분기를 여러 군데로 늘리지 않기 위해.
        setBootInfo({
          claudeVersion: b.claudeVersion ?? null,
          daemonVersion: b.version ?? null, // 서버는 'version', 화면은 앱 버전과 구분해 부른다
          port: b.port ?? null,
        });
        // 버전 스큐는 조용히 지나가면 안 된다 — 이 상태에서는 새로 생긴 WS 메시지가
        // 서버에서 `unknown message type`으로 튕겨, 기능이 "이유 없이" 안 되는 것처럼
        // 보인다(노력 수준 런타임 변경이 재시작으로 폴백하던 실제 사례).
        const mismatch = versionSkew(b.version);
        setSkew(mismatch);
        if (mismatch) {
          notify(
            `서버(v${mismatch.server ?? '구버전'})와 화면(v${mismatch.client}) 버전이 다릅니다`
            + ' — 모든 세션을 종료한 뒤 앱을 다시 실행해 주세요',
            'error',
          );
        }
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

  /**
   * 이 행에 걸린 원격 제어 항목 한 번에 찾기 — 행 아이콘·메뉴 항목 세 곳이 **같은**
   * 판정을 쓰게 하는 단일 출처다(어긋나면 아이콘은 켜졌는데 메뉴는 "켜기"가 된다).
   *
   * 조회는 세션 key 우선, 없으면 cwd 폴백이다 — 세션이 먼저 끝나도 원격 제어는 계속
   * 돌 수 있고 그때도 끌 수 있어야 한다(판정 근거는 store-reducer 주석 참조).
   */
  const remoteControlOf = (rowKey) => {
    const sess = state.sessions.get(rowKey);
    const byKey = remoteControlFor(state, rowKey);
    const rc = byKey ?? remoteControlByCwd(state, sess?.cwd ?? null);
    // stopped는 "꺼짐"과 같다 — 껐다는 사실을 UI에 남길 이유가 없다.
    return { sess, byKey, rc, active: !!rc && rc.state !== 'stopped' };
  };

  /**
   * 우클릭 메뉴의 "claude.ai/code에서 열기" — 연결 주소가 나온 뒤에만 뜬다.
   * 컴포저 pill 팝오버가 갖고 있던 유일한 이동 경로를 여기로 옮긴 것이다.
   * 항목이 없을 때는 null을 돌려주고 SessionMenu가 걸러 낸다.
   */
  const remoteOpenMenuItem = (rowKey) => {
    const { rc, active } = remoteControlOf(rowKey);
    if (!active || !rc.url) return null;
    return {
      key: 'remote-open',
      icon: 'external',
      label: 'claude.ai/code에서 열기',
      tip: rc.url,
      onSelect: () => {
        // noopener/noreferrer — 새 탭이 이 앱의 window를 만지지 못하게.
        window.open(rc.url, '_blank', 'noopener,noreferrer');
      },
    };
  };

  /**
   * 우클릭 메뉴의 "원격 제어 켜기/끄기" 항목 — 원격 제어를 켜고 끄는 유일한 창구.
   *
   * 상태의 출처는 서버가 보내는 스냅샷 하나뿐이다 — 낙관적 갱신을 하지 않으므로,
   * 누른 직후의 피드백은 "전송했다"는 토스트로 준다. 실제 켜짐·실패 여부는
   * remoteControl 방송이 돌아온 뒤 store.jsx의 전이 토스트가 알린다.
   */
  const remoteMenuItem = (rowKey) => {
    const { sess, byKey, rc, active } = remoteControlOf(rowKey);
    const offline = state.conn !== 'open';
    // 켜기는 서버가 라이브 세션에서만 받아 준다(종료된 세션의 key로는 cwd를 못 찾는다).
    // 눌러도 오류 토스트만 돌아오는 항목을 활성으로 두지 않는다.
    const cannotStart = !active && sess?.status === 'exited';
    const disabled = offline || rc?.state === 'stopping' || cannotStart;

    let tip;
    if (offline) tip = 'WebSocket이 연결되어 있지 않습니다';
    else if (cannotStart) tip = '종료된 세션에서는 켤 수 없습니다';
    else if (active) {
      // 실패한 항목은 CLI가 낸 사유를 그대로 붙인다 — pill 팝오버가 없어진 뒤로
      // 사유를 다시 볼 수 있는 곳은 여기뿐이다(켤 때의 오류 토스트는 지나간다).
      tip = [RC_STATE_TIP[rc.state] ?? '', rc.state === 'error' ? rc.error : null]
        .filter(Boolean)
        .join(' — ');
    } else tip = 'claude.ai·모바일 앱에서 이 레포를 조종할 수 있게 켭니다';

    const failed = () => notify('WebSocket이 연결되어 있지 않습니다.', 'error');
    return {
      key: 'remote',
      icon: 'phone',
      label: active ? '원격 제어 끄기' : '원격 제어 켜기',
      disabled,
      tip,
      onSelect: () => {
        if (!active) {
          if (setRemoteControl(rowKey, 'start')) notify('원격 제어를 켜는 중입니다…');
          else failed();
          return;
        }
        // 서버는 자기가 이미 알려 준 항목의 cwd만 받아들인다 — 임의 경로를 여는
        // 권한이 아니라, 이미 도는 것 중에서 고르는 것이다.
        const sent = byKey
          ? setRemoteControl(rowKey, 'stop')
          : setRemoteControl(null, 'stop', { cwd: rc.cwd });
        if (sent) notify('원격 제어를 끕니다');
        else failed();
      },
    };
  };

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
    // 원격 제어가 켜져 있다는 사실은 행에 남는다 — 컴포저 pill이 하던 "지금 켜져
    // 있음" 표시를 대신한다. 판정은 메뉴와 같은 remoteControlOf 하나를 쓴다.
    const { rc: rowRc, active: remoteOn } = remoteControlOf(row.key);
    const remoteLabel = remoteOn
      ? `원격 제어 ${rowRc.state === 'error' ? '실패' : '켜짐'}`
      : null;
    // 세션 이름 — 사용자가 지정한 이름이 있으면 그것, 없으면 CLI가 붙인 이름,
    // 그것도 없으면 자동 제목(sessionDisplayTitle).
    const label = sessionDisplayTitle({
      customTitle: sess?.customTitle,
      cliName: sess?.cliName,
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
          } · ${dot.label}${remoteLabel ? ` · ${remoteLabel}` : ''}`}
          // 이름 변경·종료는 우클릭 메뉴에만 있다 — 키보드 사용자에게 여는 법을 알린다.
          aria-keyshortcuts="Shift+F10"
        >
          <span className={dotCls} role="img" aria-label={dotLabel} />
          <span className="truncate">{label}</span>
          {/* title을 주면 Icon이 role="img" + aria-label로 렌더한다(장식용은 aria-hidden).
              툴팁이 닿지 않는 키보드·터치 사용자에게도 "켜져 있다"가 이름으로 읽힌다. */}
          {remoteOn && (
            <Icon
              name="phone"
              size={12}
              className={`sess-remote-ico${rowRc.state === 'error' ? ' err' : ''}`}
              title={remoteLabel}
            />
          )}
        </button>
      </div>
    );
  };

  // 디렉토리 그룹 — 라이브 세션 전용(히스토리는 새 세션 모달의 "지난 세션"으로 단일화).
  // 헤더는 클릭 동작이 없는 라벨이고, 배지는 열린 세션 수를 표시한다.
  const dirGroup = (node) => (
    <div key={node.key} className={`dir-group${node.active ? ' active-dir' : ''}`}>
      <div className="dir-head static" data-tip={node.cwd || node.label}>
        <Icon name="folder" size={14} className="dir-ico" />
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
          <Icon name="chevron-left" />
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

      {/* 버전 스큐 상시 경고 — 토스트는 지나가지만 이 상태는 앱을 다시 실행할
          때까지 계속되므로, 그 사실이 화면에 남아 있어야 한다. */}
      {skew && (
        <div className="version-skew" role="status">
          <Icon name="warning" size={13} className="vs-ico" />
          <span className="truncate">
            서버 v{skew.server ?? '구버전'} · 화면 v{skew.client}
          </span>
          <span className="vs-hint dim">세션 종료 후 재실행 필요</span>
        </div>
      )}

      {/* 하단 고정 통계·설정 버튼 — 세션 목록 스크롤 영역(.sidebar-inner) 밖 */}
      <SidebarFoot
        openPanel={footPanel}
        onToggle={(panel) => setFootPanel((cur) => (cur === panel ? null : panel))}
      />
      </aside>

      {/* 모달은 aside 밖에 렌더 — 화면 중앙 오버레이라 사이드바 크롬이 아니고,
          접힘(.sidebar{display:none}) 서브트리 안에 두면 표시 여부가 무관한 상태에
          묶인다(열린 채 접거나 닫힘 페이드 도중 접으면 통째로 사라진다). */}
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
              icon: 'edit',
              label: '이름 변경',
              onSelect: () => {
                const sess = state.sessions.get(menu.rowKey);
                // 입력 초기값은 "지금 지정된 이름"뿐 — 자동 제목을 채워 넣으면
                // 사용자가 지우지 않는 한 그 요약이 고정 이름으로 굳어 버린다.
                setRenaming({ rowKey: menu.rowKey, value: sess?.customTitle ?? '' });
              },
            },
            // 원격 제어 ON/OFF — 활성 세션뿐 아니라 다른 프로젝트의 라이브 세션까지
            // 여기서 켜고 끈다(컴포저 pill을 없앤 뒤로 유일한 창구다).
            remoteMenuItem(menu.rowKey),
            // 켜져서 주소가 나온 뒤에만 붙는다 — 그 전에는 null이라 렌더되지 않는다.
            remoteOpenMenuItem(menu.rowKey),
            // 실행 중이면 CLI 프로세스를 정지하고, 이미 끝난 세션이면 목록에서 치운다.
            // 같은 자리에서 다른 일을 하므로 라벨도 다르게 — "닫기"가 무엇을 하는지
            // 사용자가 눌러 보기 전에 알 수 있어야 한다.
            // key는 'close'로 고정한다 — 메뉴가 열린 사이 세션이 종료되면 라벨과
            // 동작만 갈아 끼우고 버튼은 그대로 둔다(키가 바뀌면 remount되며 그 항목에
            // 있던 포커스가 사라진다).
            state.sessions.get(menu.rowKey)?.status === 'exited'
              ? {
                key: 'close',
                icon: 'close',
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
                icon: 'close',
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
        shape={shape}
        onSetShape={onSetShape}
        appInfo={bootInfo}
        platform={platform}
        skew={skew}
        inert={configMounted}
        // 편집기가 페이드아웃까지 끝난 뒤에 플러그인 탭이 파일을 다시 읽게 한다 —
        // 열려 있는 동안 읽으면 편집기가 저장하기 전 내용을 기준선으로 삼는다.
        configEditorOpen={configMounted}
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
    cliName: target.cliName,
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
            <Icon name="close" />
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
