// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// No persistent top bar — session/model/permission/usage controls live in
// the composer (reference-faithful). PermissionDialog is a modal.

import { useEffect, useState } from 'react';
import { StoreProvider, useStore, useActiveSession } from './lib/store.jsx';
import { fetchUsage } from './lib/api.js';
import { shortPath } from './lib/format.js';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';
import Toasts from './components/Toasts.jsx';

const THEME_KEY = 'ccob-theme';
const USAGE_POLL_MS = 60_000;

function Shell() {
  const { dispatch } = useStore();
  const session = useActiveSession();
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || 'dark',
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

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

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <Sidebar onCollapse={() => setSidebarOpen(false)} />

      <main className="main">
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-reopen"
            onClick={() => setSidebarOpen(true)}
            aria-label="사이드바 열기"
            title="사이드바 열기"
          >
            ☰
          </button>
        )}
        {/* 사이드바가 접히면 세션 목록이 안 보이므로 우측 상단에 현재 세션 이름을 띄운다.
            이름은 사이드바 라이브 행과 같은 관례(sessionId 앞 8자, 미발급이면 '새 세션')
            + 보조로 작업 디렉터리 꼬리. */}
        {!sidebarOpen && session && (
          <div className="session-name-badge" title={session.cwd || session.key}>
            {session.sessionId ? session.sessionId.slice(0, 8) : '새 세션'}
            {shortPath(session.cwd) ? ` · ${shortPath(session.cwd)}` : ''}
          </div>
        )}
        <ChatView />
        <Composer theme={theme} onToggleTheme={toggleTheme} />
      </main>

      <PermissionDialog />
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
