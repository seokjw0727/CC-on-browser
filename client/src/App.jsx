// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// 상시 상단 바는 없지만, 메인 우측 상단에 떠 있는 컨트롤 묶음(.main-top-right)이
// 권한 모드 셀렉트와 (사이드바가 접혔을 때) 세션 이름 배지를 담는다.
// 모델·노력·사용량은 여전히 컴포저에 있다. PermissionDialog는 모달.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StoreProvider, useStore, useActiveSession } from './lib/store.jsx';
import { fetchUsage } from './lib/api.js';
import { shortPath } from './lib/format.js';
import { sessionDisplayTitle } from './lib/sessionTree.js';
import { artifactsOf, findArtifact } from './lib/artifacts.js';
import { normalizeShape } from './lib/ui-shape.js';
import { readPref, writePref } from './lib/preferences.js';
import { notifyLimitTransitions } from './lib/limit-notify.js';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Icon from './components/Icon.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';
import PermissionModeBar from './components/PermissionModeBar.jsx';
import PreviewPanel from './components/PreviewPanel.jsx';
import Toasts from './components/Toasts.jsx';
import TooltipLayer from './components/Tooltip.jsx';

const THEME_KEY = 'ccob-theme';
// 모서리 스타일(둥근/각진) — 색 테마와 별개의 키로 둔다. 하나를 바꿔도 다른 하나가
// 덮어써지지 않아야 하기 때문.
const SHAPE_KEY = 'ccob-shape';
const USAGE_POLL_MS = 60_000;
// 미리보기 패널 폭. **열림 상태는 영속하지 않는다** — 새로고침하면 세션 상태가
// 없어 빈 패널만 남기 때문이다(설계도 §2 App.jsx).
const PREVIEW_WIDTH_KEY = 'ccob-preview-width';
const PREVIEW_MIN_W = 320;
const PREVIEW_DEFAULT_W = 480;
// 채팅이 눌리지 않게 남겨 두는 최소 폭 — 최대 패널 폭은 여기서 역산한다.
const CHAT_MIN_W = 420;
// 이 아래 폭에서는 3열 대신 오버레이(채팅 위에 얹기)로 전환한다.
const PREVIEW_OVERLAY_MAX_VW = 1100;
const SIDEBAR_W = 264; // theme.css --sidebar-width와 같은 값

function readStoredWidth() {
  try {
    const raw = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= PREVIEW_MIN_W ? raw : PREVIEW_DEFAULT_W;
  } catch {
    return PREVIEW_DEFAULT_W;
  }
}

/** 현재 창에서 허용되는 패널 폭 상한 — 채팅 최소 폭을 반드시 남긴다. */
function maxPreviewWidth(sidebarOpen) {
  if (typeof window === 'undefined') return PREVIEW_DEFAULT_W;
  const avail = window.innerWidth - (sidebarOpen ? SIDEBAR_W : 0) - CHAT_MIN_W;
  return Math.max(PREVIEW_MIN_W, avail);
}

function Shell() {
  const { state, dispatch } = useStore();
  const session = useActiveSession();
  // 저장소 접근은 차단 컨텍스트(3rd-party 쿠키 차단 등)에서 던진다 — 렌더 중에
  // 새어 나가면 앱 전체가 뜨지 않으므로 두 축 모두 감싼다.
  const [theme, setTheme] = useState(() => readPref(THEME_KEY) || 'dark');
  const [shape, setShape] = useState(() => normalizeShape(readPref(SHAPE_KEY)));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(readStoredWidth);
  // 좁은 창에서는 오버레이 — 3열을 유지하면 채팅이 읽을 수 없을 만큼 눌린다.
  const [overlay, setOverlay] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < PREVIEW_OVERLAY_MAX_VW,
  );

  // 첫 페인트 값은 index.html의 인라인 부트스트랩이 이미 걸어 뒀다 — 여기서는
  // 이후 변경만 반영한다(모서리는 radius 토큰만 갈아끼우므로 data-shape 하나로 끝).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.shape = shape;
    writePref(SHAPE_KEY, shape);
  }, [shape]);

  // 상태줄용 5h/7d 사용량 폴링 — 실패는 조용히 넘기고 다음 주기에 재시도.
  //
  // 응답 도착 순서는 보장되지 않는다. 한 요청이 주기보다 오래 끌면 뒤늦게 온 옛 응답이
  // 새 값을 덮어써 사용률이 뒷걸음질친다(99 → 100 → 99). 아래 한도 알림이 그 뒷걸음을
  // "해제"로 읽어 거짓 알림을 띄우므로(codex 지적), 순번을 붙여 뒤처진 응답은 버린다.
  useEffect(() => {
    let alive = true;
    let issued = 0;
    let applied = 0;
    const tick = () => {
      const seq = ++issued;
      return fetchUsage()
        .then((usage) => {
          if (!alive || seq <= applied) return;
          applied = seq;
          dispatch({ type: 'set-usage', usage });
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, USAGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [dispatch]);

  // 한도 체결·해제 알림 — 위 폴링에 얹혀 간다(새 요청 없음, 토큰 소모 없음).
  //
  // 보는 값은 **reducer를 통과한 뒤의** quota다. 원본 응답은 창 하나만 조회에 실패해도
  // 그 창을 통째로 빼고 오는데, reducer가 직전 값으로 메워 주기 전의 그것을 보면
  // 빠진 창이 해제 → 체결로 깜빡인다(store-reducer의 set-usage 주석).
  const prevQuotaRef = useRef(null);
  useEffect(() => {
    const quota = state.globalUsage?.quota ?? null;
    // 조회 실패 구간에는 기준선을 그대로 둔다 — 끊긴 동안 실제로 넘어간 전이를
    // 다음 성공에서 잡아내기 위해서다(기준선을 새로 세우면 그 전이를 놓친다).
    if (!quota) return;
    const prev = prevQuotaRef.current;
    prevQuotaRef.current = quota;
    // 켠 직후 첫 값은 기준선만 세운다. 안 그러면 이미 한도에 걸린 채 새로고침할
    // 때마다 같은 알림이 다시 뜬다.
    if (!prev) return;
    notifyLimitTransitions(prev, quota);
  }, [state.globalUsage]);

  // ----- 결과물 미리보기 -----
  // 산출물 목록은 상태가 아니라 대화 메시지에서 파생한다(lib/artifacts.js) —
  // 재개·노력 수준 재시작(구버전 CLI 폴백)이 메시지를 이월하므로 목록도 따라온다.
  const caseInsensitive = state.initInfo?.platform === 'win32'
    || (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || ''));
  const artifacts = useMemo(
    () => artifactsOf(session?.messages, { caseInsensitive }),
    [session?.messages, caseInsensitive],
  );
  const previewPath = session?.preview?.path ?? null;
  const selected = findArtifact(artifacts, previewPath, { caseInsensitive });
  // 선택한 파일이 목록에 있으면 그쪽의 최신 철자를 쓴다(도중에 대소문자가 바뀐 경우).
  const activePath = selected?.path ?? previewPath;
  // 이 파일을 마지막으로 쓴 메시지 uid — 바뀌면 "다시 수정됐다"는 뜻이라 자동 새로고침.
  const revision = selected?.uid ?? 'none';
  const previewOpen = !!(session?.preview?.open && activePath);

  const selectPreview = useCallback(
    (p) => session && dispatch({ type: 'open-preview', key: session.key, path: p }),
    [session, dispatch],
  );
  const closePreview = useCallback(
    () => session && dispatch({ type: 'close-preview', key: session.key }),
    [session, dispatch],
  );

  // 창 크기 변화 → 오버레이 전환 + 폭 재클램프(창을 줄여도 채팅이 사라지지 않게).
  useEffect(() => {
    const onResize = () => {
      setOverlay(window.innerWidth < PREVIEW_OVERLAY_MAX_VW);
      setPreviewWidth((w) => Math.min(w, maxPreviewWidth(sidebarOpen)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sidebarOpen]);

  // 첫 렌더와 사이드바 토글에서도 클램프한다 — 큰 화면에서 저장한 폭으로 이 창을
  // 열면(또는 사이드바를 다시 펴면) resize 이벤트가 없어 채팅이 눌린 채로 남는다.
  useEffect(() => {
    setPreviewWidth((w) => Math.min(w, maxPreviewWidth(sidebarOpen)));
  }, [sidebarOpen]);

  // 폭 영속 — 실패해도 조용히 넘어간다(차단 컨텍스트).
  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth));
    } catch {
      /* noop */
    }
  }, [previewWidth]);

  // 드래그 리사이즈. pointer capture로 프레임 밖으로 나가도 추적하고, 놓으면 해제한다.
  const dragRef = useRef(null);
  const onResizerDown = (e) => {
    if (overlay) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: previewWidth };
  };
  const onResizerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    // 패널은 오른쪽에 있으므로 왼쪽으로 끌수록 넓어진다.
    const next = d.startW + (d.startX - e.clientX);
    setPreviewWidth(Math.max(PREVIEW_MIN_W, Math.min(next, maxPreviewWidth(sidebarOpen))));
  };
  const endResize = (e) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onResizerKey = (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPreviewWidth((w) => Math.min(w + step, maxPreviewWidth(sidebarOpen)));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPreviewWidth((w) => Math.max(PREVIEW_MIN_W, w - step));
    }
  };

  return (
    <div
      className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}${
        previewOpen ? (overlay ? ' preview-overlay' : ' preview-open') : ''
      }`}
      style={previewOpen ? { '--preview-width': `${previewWidth}px` } : undefined}
    >
      {/* 테마(색·모서리) 변경은 사이드바 설정 팝업에서 제공한다. */}
      <Sidebar
        onCollapse={() => setSidebarOpen(false)}
        theme={theme}
        onSetTheme={setTheme}
        shape={shape}
        onSetShape={setShape}
      />

      <main className={`main${session ? ' has-top-controls' : ''}`}>
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-reopen"
            onClick={() => setSidebarOpen(true)}
            aria-label="사이드바 열기"
            data-tip="사이드바 열기"
          >
            <Icon name="menu" />
          </button>
        )}
        {/* 떠 있는 우측 상단 컨트롤. 권한 모드는 세션이 있으면 항상, 세션 이름 배지는
            사이드바가 접혀 세션 목록이 안 보일 때만 — 둘을 한 flex 행에 묶어 서로
            겹치지 않게 한다. 이름 규칙은 사이드바 라이브 행과 같은 함수를 공유한다
            (지정한 이름 → CLI 이름 → 첫 발화 요약 → sessionId 앞 8자 → '새 세션')
            + 작업 디렉터리 꼬리. */}
        {session && (
          <div className="main-top-right">
            {!sidebarOpen && (
              <div className="session-name-badge" data-tip={session.cwd || session.key}>
                {sessionDisplayTitle({
                  customTitle: session.customTitle,
                  cliName: session.cliName,
                  messages: session.messages,
                  sessionId: session.sessionId,
                })}
                {shortPath(session.cwd) ? ` · ${shortPath(session.cwd)}` : ''}
              </div>
            )}
            <PermissionModeBar />
          </div>
        )}
        <ChatView />
        <Composer />
      </main>

      {previewOpen && (
        <div className="preview-col">
          {!overlay && (
            <div
              className="preview-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="미리보기 패널 폭 조절"
              aria-valuenow={Math.round(previewWidth)}
              aria-valuemin={PREVIEW_MIN_W}
              aria-valuemax={Math.round(maxPreviewWidth(sidebarOpen))}
              tabIndex={0}
              onPointerDown={onResizerDown}
              onPointerMove={onResizerMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onKeyDown={onResizerKey}
            />
          )}
          <PreviewPanel
            sessionKey={session.key}
            path={activePath}
            artifacts={artifacts}
            revision={revision}
            onSelect={selectPreview}
            onClose={closePreview}
          />
        </div>
      )}

      <PermissionDialog />
      <TooltipLayer />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
