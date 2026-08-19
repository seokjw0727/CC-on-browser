// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// No persistent top bar — session/model/permission/usage controls live in
// the composer (reference-faithful). PermissionDialog is a modal.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StoreProvider, useStore, useActiveSession } from './lib/store.jsx';
import { fetchUsage } from './lib/api.js';
import { shortPath } from './lib/format.js';
import { sessionDisplayTitle } from './lib/sessionTree.js';
import { artifactsOf, findArtifact } from './lib/artifacts.js';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Icon from './components/Icon.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';
import PreviewPanel from './components/PreviewPanel.jsx';
import Toasts from './components/Toasts.jsx';
import TooltipLayer from './components/Tooltip.jsx';

const THEME_KEY = 'ccob-theme';
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
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || 'dark',
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(readStoredWidth);
  // 좁은 창에서는 오버레이 — 3열을 유지하면 채팅이 읽을 수 없을 만큼 눌린다.
  const [overlay, setOverlay] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < PREVIEW_OVERLAY_MAX_VW,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // 상태줄용 5h/7d 사용량 폴링 — 실패는 조용히 넘기고 다음 주기에 재시도
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetchUsage()
        .then((usage) => {
          if (alive) dispatch({ type: 'set-usage', usage });
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, USAGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [dispatch]);

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
      {/* 테마 변경은 사이드바 설정 팝업에서 제공한다. */}
      <Sidebar onCollapse={() => setSidebarOpen(false)} theme={theme} onSetTheme={setTheme} />

      <main className="main">
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
        {/* 사이드바가 접히면 세션 목록이 안 보이므로 우측 상단에 현재 세션 이름을 띄운다.
            이름 규칙은 사이드바 라이브 행과 같은 함수를 공유한다(사용자가 지정한 이름 →
            첫 발화 요약 → sessionId 앞 8자 → '새 세션') + 보조로 작업 디렉터리 꼬리. */}
        {!sidebarOpen && session && (
          <div className="session-name-badge" data-tip={session.cwd || session.key}>
            {sessionDisplayTitle({
              customTitle: session.customTitle,
              messages: session.messages,
              sessionId: session.sessionId,
            })}
            {shortPath(session.cwd) ? ` · ${shortPath(session.cwd)}` : ''}
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
