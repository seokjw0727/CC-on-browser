// App shell: StatusBar (top) + Sidebar (left, collapsible) + ChatView/Composer (center).
// ChatView/Composer/Sidebar/StatusBar contents are placeholders here;
// Tasks 7-8 replace them with real components.

import { useEffect, useState } from 'react';
import { StoreProvider, useStore, useActiveSession } from './lib/store.jsx';
import ChatView from './components/ChatView.jsx';

const THEME_KEY = 'ccob-theme';

const CONN_LABEL = {
  connecting: '연결 중',
  open: '연결됨',
  closed: '연결 끊김',
};

function ConnIndicator() {
  const { state } = useStore();
  return (
    <span title={`WebSocket: ${state.conn}`}>
      <span className={`conn-dot ${state.conn}`} />{' '}
      <span className="dim">{CONN_LABEL[state.conn] ?? state.conn}</span>
    </span>
  );
}

function Shell() {
  const { state } = useStore();
  const active = useActiveSession();
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
      <header className="statusbar">
        <button
          className="icon-btn"
          onClick={() => setSidebarOpen((v) => !v)}
          title="사이드바 접기/펼치기"
        >
          ☰
        </button>
        <strong>Claude Code on Browser</strong>
        {active && (
          <span className="dim">
            {active.cwd} {active.sessionId ? `· ${active.sessionId}` : ''}
          </span>
        )}
        <span className="spacer" />
        {state.lastError && (
          <span style={{ color: 'var(--danger)' }}>{state.lastError}</span>
        )}
        <ConnIndicator />
        <button
          className="icon-btn"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="테마 전환"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <aside className="sidebar">
        {/* Task 8: Sidebar (새 세션 / 세션 탭 / 최근 세션) */}
        <div className="dim">세션 목록 (준비 중)</div>
      </aside>

      <main className="main">
        <ChatView />
        <div className="composer-area">
          {/* Task 8: Composer */}
          <textarea
            rows={2}
            style={{ width: '100%', resize: 'none' }}
            placeholder="메시지 입력 (준비 중)"
            disabled
          />
        </div>
      </main>
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
