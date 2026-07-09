// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// No persistent top bar — session/model/permission/usage controls live in
// the composer (reference-faithful). PermissionDialog is a modal.

import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './lib/store.jsx';
import { fetchUsage } from './lib/api.js';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';

const THEME_KEY = 'ccob-theme';
const USAGE_POLL_MS = 60_000;

function Shell() {
  const { dispatch } = useStore();
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
        <ChatView />
        <Composer theme={theme} onToggleTheme={toggleTheme} />
      </main>

      <PermissionDialog />
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
