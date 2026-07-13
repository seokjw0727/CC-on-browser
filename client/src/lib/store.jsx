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
import { spawnEffort } from './effort.js';

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

// 종료된 세션을 사이드바에서 자동 제거하기까지의 유예 — 종료 직후 결과를 확인할
// 여유를 준다. 필요하면 히스토리에서 재개할 수 있어 데이터 손실이 아니다.
const EXITED_UI_RETENTION_MS = 8_000;

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const wsRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const removalTimersRef = useRef(new Map()); // key -> timeout (exited 세션 제거 예약)

  // exited 세션마다 제거 타이머를 한 번만 건다(키별로 안정 유지 — 다른 세션의
  // 활동으로 이 effect가 재실행돼도 리셋하지 않는다). 재시작 대체 등으로 세션이
  // 사라지거나 다시 exited가 아니게 되면 예약을 취소한다.
  useEffect(() => {
    const timers = removalTimersRef.current;
    for (const s of state.sessions.values()) {
      if (s.status === 'exited' && !timers.has(s.key)) {
        const key = s.key;
        const t = setTimeout(() => {
          timers.delete(key);
          dispatch({ type: 'remove-session', key });
        }, EXITED_UI_RETENTION_MS);
        timers.set(key, t);
      }
    }
    for (const [key, t] of timers) {
      const s = state.sessions.get(key);
      if (!s || s.status !== 'exited') {
        clearTimeout(t);
        timers.delete(key);
      }
    }
  }, [state.sessions]);

  useEffect(
    () => () => {
      for (const t of removalTimersRef.current.values()) clearTimeout(t);
      removalTimersRef.current.clear();
    },
    [],
  );

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
            // UI 의사 티어(ultracode)는 실제 CLI 값(max)으로 매핑해 보낸다 —
            // 서버 EFFORT_LEVELS 검증은 low..max만 통과시킨다. UI 표시용 effort는
            // register-start의 opts.effort로 세션에 그대로 시딩된다(ultracode 보존).
            effort: spawnEffort(opts.effort),
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
