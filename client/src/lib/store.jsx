// Global store: React context + useReducer.
// Owns the WS connection, reduces server messages into state, and
// re-sends `attach` for every known session after a reconnect.

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { connect } from './ws.js';
import { reduceCliEvent } from './reduce-cli-event.js';

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

export function createSessionState(partial = {}) {
  return {
    key: null,
    cwd: null,
    sessionId: null,
    model: null,
    permissionMode: 'default',
    messages: [],
    streaming: {},
    pendingPermissions: [],
    usage: { cost: 0, inTok: 0, outTok: 0 },
    rateLimit: null,
    status: 'idle', // idle | thinking | tool | awaiting-permission | exited
    lastSeq: 0,
    ...partial,
  };
}

function createInitialState() {
  return {
    conn: 'connecting', // connecting | open | closed
    sessions: new Map(), // key -> SessionState
    activeKey: null,
    projects: [],
    initInfo: null,
    pendingStarts: new Map(), // startId -> {cwd, model, permissionMode, resumeSessionId}
    lastError: null,
    newSessionOpen: false, // 새 세션(레포 선택) 모달 표시 여부 — Sidebar/Composer 공용
  };
}

function updateSession(state, key, fn) {
  const cur = state.sessions.get(key);
  if (!cur) return state;
  const sessions = new Map(state.sessions);
  sessions.set(key, fn(cur));
  return { ...state, sessions };
}

function handleServerMessage(state, msg) {
  switch (msg.type) {
    case 'started': {
      const opts = state.pendingStarts.get(msg.startId) || {};
      const pendingStarts = new Map(state.pendingStarts);
      pendingStarts.delete(msg.startId);
      const sessions = new Map(state.sessions);
      sessions.set(
        msg.key,
        createSessionState({
          key: msg.key,
          cwd: opts.cwd ?? null,
          model: opts.model ?? null,
          permissionMode: opts.permissionMode ?? 'default',
        }),
      );
      return {
        ...state,
        sessions,
        pendingStarts,
        activeKey: msg.key,
        initInfo: msg.initInfo ?? state.initInfo,
      };
    }

    case 'event':
      return updateSession(state, msg.key, (s) => {
        if (typeof msg.seq === 'number' && msg.seq <= s.lastSeq) return s; // replay dedupe
        const next = reduceCliEvent(s, msg.payload);
        return { ...next, lastSeq: msg.seq ?? s.lastSeq };
      });

    case 'permission_request':
      return updateSession(state, msg.key, (s) => ({
        ...s,
        status: 'awaiting-permission',
        pendingPermissions: [
          ...s.pendingPermissions,
          {
            requestId: msg.requestId,
            toolName: msg.toolName,
            displayName: msg.displayName,
            input: msg.input,
            description: msg.description,
            suggestions: msg.suggestions,
            toolUseId: msg.toolUseId,
          },
        ],
      }));

    case 'permission_resolved':
      return updateSession(state, msg.key, (s) => {
        const pendingPermissions = s.pendingPermissions.filter(
          (p) => p.requestId !== msg.requestId,
        );
        return {
          ...s,
          pendingPermissions,
          status:
            pendingPermissions.length === 0 && s.status === 'awaiting-permission'
              ? 'thinking'
              : s.status,
        };
      });

    case 'exit':
      return updateSession(state, msg.key, (s) => ({
        ...s,
        status: 'exited',
      }));

    case 'error': {
      let next = { ...state, lastError: msg.message ?? 'unknown error' };
      if (msg.startId) {
        const pendingStarts = new Map(next.pendingStarts);
        pendingStarts.delete(msg.startId);
        next = { ...next, pendingStarts };
      }
      if (msg.key && next.sessions.has(msg.key)) {
        next = updateSession(next, msg.key, (s) => ({
          ...s,
          messages: [...s.messages, { kind: 'error', text: msg.message }],
        }));
      }
      return next;
    }

    default:
      return state;
  }
}

export function reducer(state, action) {
  switch (action.type) {
    case 'conn':
      return { ...state, conn: action.status };
    case 'server-message':
      return handleServerMessage(state, action.message);
    case 'register-start': {
      const pendingStarts = new Map(state.pendingStarts);
      pendingStarts.set(action.startId, action.opts);
      return { ...state, pendingStarts };
    }
    case 'set-active':
      return { ...state, activeKey: action.key };
    case 'open-new-session':
      return { ...state, newSessionOpen: true };
    case 'close-new-session':
      return { ...state, newSessionOpen: false };
    case 'set-projects':
      return { ...state, projects: action.projects };
    case 'update-session':
      return updateSession(state, action.key, action.fn);
    case 'clear-error':
      return { ...state, lastError: null };
    default:
      return state;
  }
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
            resumeSessionId: opts.resumeSessionId ?? null,
          });
        if (!ok) {
          dispatch({ type: 'server-message', message: { type: 'error', startId, message: 'WebSocket이 연결되어 있지 않습니다.' } });
        }
        return startId;
      },
      /** Stop a session's CLI process (client->server contract 'stop'). Server replies with exit. */
      stopSession: (key) => (wsRef.current ? wsRef.current.send({ type: 'stop', key }) : false),
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
