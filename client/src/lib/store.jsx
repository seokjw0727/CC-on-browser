// Global store: React context + useReducer.
// Owns the WS connection and re-sends `attach` for every known session after
// a reconnect. 순수 상태 로직(리듀서·세션 상태)은 store-reducer.js로 분리 —
// node --test 단위 테스트 대상.

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { connect } from './ws.js';
import { createInitialState, reducer } from './store-reducer.js';

const TOKEN_KEY = 'ccob-token';

/** Parse `#token=...` from the URL once, persist to sessionStorage, strip hash. */
export function getToken() {
  const m = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

const StoreContext = createContext(null);
let startCounter = 0;

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const wsRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const token = getToken();
    const conn = connect({
      token,
      onMessage: (msg) => dispatch({ type: 'server-message', message: msg }),
      onStatus: (status) => {
        dispatch({ type: 'conn', status });
        if (status === 'open') {
          // Re-attach every known session after (re)connect.
          for (const s of stateRef.current.sessions.values()) {
            conn.send({ type: 'attach', key: s.key, afterSeq: s.lastSeq });
          }
        }
      },
    });
    wsRef.current = conn;
    return () => {
      conn.close();
      wsRef.current = null;
    };
  }, []);

  const actions = useMemo(
    () => ({
      /** Raw WS send (client->server schema). Returns false if not connected. */
      send: (obj) => (wsRef.current ? wsRef.current.send(obj) : false),
      /** Start a new CLI session; returns startId. */
      startSession: (opts) => {
        const startId = `cl_${++startCounter}`;
        dispatch({ type: 'register-start', startId, opts });
        const ok =
          wsRef.current &&
          wsRef.current.send({
            type: 'start',
            startId,
            cwd: opts.cwd,
            model: opts.model ?? null,
            permissionMode: opts.permissionMode ?? 'default',
            effort: opts.effort ?? null,
            resumeSessionId: opts.resumeSessionId ?? null,
          });
        if (!ok) {
          dispatch({ type: 'server-message', message: { type: 'error', startId, message: 'WebSocket이 연결되어 있지 않습니다.' } });
        }
        return startId;
      },
      /** Stop a session's CLI process (client->server contract 'stop'). Server replies with exit. */
      stopSession: (key) => (wsRef.current ? wsRef.current.send({ type: 'stop', key }) : false),
      /** 일시 토스트 알림 — 설정 변경 확인·오류 표시용(자동 소멸). */
      notify: (text, kind = 'info') => dispatch({ type: 'add-toast', text, kind }),
    }),
    [],
  );

  const value = useMemo(
    () => ({ state, dispatch, ...actions }),
    [state, actions],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within <StoreProvider>');
  return ctx;
}

export function useActiveSession() {
  const { state } = useStore();
  return state.activeKey ? state.sessions.get(state.activeKey) ?? null : null;
}
