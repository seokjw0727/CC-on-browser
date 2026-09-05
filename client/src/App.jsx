// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// 상시 상단 바는 없다. 메인 우측 상단에 떠 있는 묶음(.main-top-right)은 사이드바가
// 접혔을 때의 세션 이름 배지 하나만 담는다 — 권한 모드 셀렉트는 입력 상자 안쪽 우측
// 상단으로 옮겨 갔다(Composer → PermissionModeBar, 2026-08-31).
// 모델·노력·사용량도 컴포저에 있다. PermissionDialog는 모달.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StoreProvider, useStore, useActiveSession } from './lib/store.jsx';
import { fetchUsage } from './lib/api.js';
import { shortPath } from './lib/format.js';
import { sessionDisplayTitle } from './lib/sessionTree.js';
import { artifactsOf, findArtifact } from './lib/artifacts.js';
import { normalizeShape } from './lib/ui-shape.js';
import {
  OFFICIAL_USAGE_KEY,
  officialUsageEnabled,
  readPref,
  writePref,
} from './lib/preferences.js';
import { notifyLimitTransitions } from './lib/limit-notify.js';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Icon from './components/Icon.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';
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
  // 우측 상단 세션 이름 배지의 표시 조건 — 래퍼와 채팅 상단 여백이 같은 값을 봐야
  // 배지가 없는데 자리만 비어 있는 상태가 생기지 않는다.
  const sessionBadge = !!session && !sidebarOpen;
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
  //
  // 계정 공식 사용률(quota)은 옵트인이라 **매 주기 설정을 다시 읽는다** — 설정 모달에서
  // 켜고 끈 것이 폴링을 다시 걸지 않고도 다음 주기부터 반영되게 하려는 것이다.
  // 읽은 값은 요청(서버 관문)과 dispatch(화면 이월 여부) 양쪽에 같이 실어, 응답이
  // 늦게 도착해도 "그 요청이 조회를 시도했는가"가 응답과 함께 따라오게 한다.
  useEffect(() => {
    let alive = true;
    let issued = 0;
    let applied = 0;
    // 저장소의 옵트인 값을 스토어에 먼저 맞춘다 — 켜 둔 채로 **첫 조회가 실패하면**
    // set-usage가 영영 오지 않아, 화면이 "켰는데 실패"를 "꺼져 있음"으로 잘못 설명하게
    // 된다. 값이 같으면 리듀서가 같은 state를 돌려주므로 이 effect가 되풀이되지 않는다.
    dispatch({ type: 'set-official-usage', on: officialUsageEnabled() });
    const tick = () => {
      const seq = ++issued;
      const quotaEnabled = officialUsageEnabled();
      return fetchUsage(quotaEnabled)
        .then((usage) => {
          if (!alive || seq <= applied) return;
          applied = seq;
          dispatch({ type: 'set-usage', usage, quotaEnabled });
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, USAGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // state.officialUsage에 의존하는 것은 값을 쓰기 위해서가 아니라(tick이 저장소를
    // 직접 읽는다) **토글 직후 즉시 한 번 더 돌게** 하기 위해서다 — 켜자마자 주기를
    // 새로 시작해 첫 조회가 바로 나가고, 끄면 quota 없는 응답이 곧바로 자리를 덮는다.
  }, [dispatch, state.officialUsage]);

  // 다른 탭에서 옵트인을 바꾸면 이 탭도 따라간다. 같은 앱을 두 탭에 띄워 두고 한쪽에서
  // 끄면, 이 리스너가 없는 탭은 다음 주기까지 계속 조회하고 이미 나간 요청의 응답을
  // 그대로 반영한다 — 끈 뒤에도 %가 갱신되고 알림까지 뜰 수 있다(codex 지적).
  // dispatch가 state.officialUsage를 바꾸면 위 폴링 effect가 정리되며 alive=false가 되어
  // 진행 중이던 응답도 함께 버려진다. storage 이벤트는 **다른** 탭에서만 오므로,
  // 이 탭 자신의 토글은 Sidebar가 직접 dispatch하는 경로가 담당한다.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== null && e.key !== OFFICIAL_USAGE_KEY) return;
      dispatch({ type: 'set-official-usage', on: officialUsageEnabled() });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dispatch]);

  // 한도 체결·해제 알림 — 위 폴링에 얹혀 간다(새 요청 없음, 토큰 소모 없음).
  //
  // 보는 값은 **reducer를 통과한 뒤의** quota다. 원본 응답은 창 하나만 조회에 실패해도
  // 그 창을 통째로 빼고 오는데, reducer가 직전 값으로 메워 주기 전의 그것을 보면
  // 빠진 창이 해제 → 체결로 깜빡인다(store-reducer의 set-usage 주석).
  const prevQuotaRef = useRef(null);
  useEffect(() => {
    // 옵트인이 꺼져 있으면 알림 자체가 성립하지 않는다(판정 재료가 없다). 이때
    // **기준선을 지운다** — 남겨 두면 다시 켰을 때 첫 값이 꺼져 있던 동안의 옛 값과
    // 비교돼, 있지도 않은 체결/해제가 한 번 튄다(codex 지적). 끄는 것은 사용자의
    // 명시적 선택이므로 "안 보는 동안의 전이"를 나중에 보고할 이유도 없다.
    if (!state.officialUsage) {
      prevQuotaRef.current = null;
      return;
    }
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
  }, [state.globalUsage, state.officialUsage]);

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

      {/* 우측 상단 띠에 남은 것은 세션 이름 배지뿐이다(권한 모드는 입력창 안으로 갔다) —
          배지는 사이드바가 접혔을 때만 뜨므로, 래퍼도 채팅 상단 여백(has-top-controls)도
          그 조건에서만 만든다. 세션만 보고 붙이면 사이드바가 펼쳐진 평소에 빈 상자와
          쓸데없는 56px 여백이 남는다. */}
      <main className={`main${sessionBadge ? ' has-top-controls' : ''}`}>
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
        {/* 떠 있는 우측 상단 배지 — 사이드바가 접혀 세션 목록이 안 보일 때만 뜬다.
            이름 규칙은 사이드바 라이브 행과 같은 함수를 공유한다
            (지정한 이름 → CLI 이름 → 첫 발화 요약 → sessionId 앞 8자 → '새 세션')
            + 작업 디렉터리 꼬리. 래퍼(.main-top-right)는 배지 하나만 남았어도 유지한다:
            절대 위치를 공용 .session-name-badge에 직접 주면 다른 화면의 같은 클래스까지
            따라 움직인다. */}
        {sessionBadge && (
          <div className="main-top-right">
            <div className="session-name-badge" data-tip={session.cwd || session.key}>
              {sessionDisplayTitle({
                customTitle: session.customTitle,
                cliName: session.cliName,
                messages: session.messages,
                sessionId: session.sessionId,
              })}
              {shortPath(session.cwd) ? ` · ${shortPath(session.cwd)}` : ''}
            </div>
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
