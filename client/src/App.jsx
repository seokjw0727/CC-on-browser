// App shell: Sidebar (left, collapsible) + main (ChatView + Composer).
// No persistent top bar — session/model/permission/usage controls live in
// the composer (reference-faithful). PermissionDialog is a modal.

import { useEffect, useState } from 'react';
import { StoreProvider } from './lib/store.jsx';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Sidebar from './components/Sidebar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';

const THEME_KEY = 'ccob-theme';

function Shell() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || 'dark',
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

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
