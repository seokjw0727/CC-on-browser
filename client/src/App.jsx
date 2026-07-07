// App shell: StatusBar (top) + Sidebar (left, collapsible) + ChatView/Composer (center)
// + PermissionDialog (modal). 각 컴포넌트는 store를 통해 상태를 공유한다.

import { useEffect, useState } from 'react';
import { StoreProvider } from './lib/store.jsx';
import ChatView from './components/ChatView.jsx';
import Composer from './components/Composer.jsx';
import Sidebar from './components/Sidebar.jsx';
import StatusBar from './components/StatusBar.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';

const THEME_KEY = 'ccob-theme';

function Shell() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || 'dark',
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <StatusBar
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      <Sidebar />

      <main className="main">
        <ChatView />
        <Composer />
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
