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
import { normalizeTitle, saveTitle, titleFor } from './session-titles.js';

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
let jumpCounter = 0;

// 종료된 세션이 '종료' 배지로 남아 있다가 사이드바 목록에서 사라지기까지의
// 유예(사용자 의도: 닫기 → 3초 후 제거). 기준 시점은 CLI exit 확인 시점이며,
// 제거 후에도 새 세션 모달의 "지난 세션"에서 재개할 수 있어 데이터 손실이 아니다.
const EXITED_UI_RETENTION_MS = 3_000;

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const wsRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const removalTimersRef = useRef(new Map()); // key -> timeout (exited 세션 제거 예약)
  // 세션 이름(우클릭 → 이름 변경)의 영속 보조 장부.
  //  pendingTitles: sessionId가 아직 확정되지 않은 동안 들어온 이름 — 확정 즉시 기록한다.
  //  titleSync: key -> 이미 처리한 sessionId. 이월(재개 fork)·복원(새로고침)을 id당 1회만.
  const pendingTitlesRef = useRef(new Map());
  const titleSyncRef = useRef(new Map());

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

  // 세션 이름 ↔ localStorage 동기화. sessionId가 확정된(CLI가 직접 알려 준) 세션만
  // 다룬다 — 재개 직후의 sessionId는 트랜스크립트에서 복원한 "원본 id"라, 그때 쓰면
  // 원본 세션의 이름을 덮어쓴다.
  //
  // 확정된 세션마다 딱 한 번(그 id에 대해) 셋 중 하나를 한다:
  //  ① 보류된 이름 기록 — id가 없던 동안 사용자가 바꾼 이름
  //  ② 이월 — 재개 fork로 새 id를 받은 세션의 이름을 새 id에도 남긴다
  //  ③ 복원 — 새로고침 등으로 메모리 이름이 비었을 때 저장된 이름을 되살린다
  useEffect(() => {
    const pending = pendingTitlesRef.current;
    const synced = titleSyncRef.current;
    for (const s of state.sessions.values()) {
      if (!s.idConfirmed || !s.sessionId) continue;
      if (pending.has(s.key)) {
        const title = pending.get(s.key);
        pending.delete(s.key);
        synced.set(s.key, s.sessionId);
        saveTitle(s.sessionId, title); // ① (빈 값이면 해제)
        continue;
      }
      if (synced.get(s.key) === s.sessionId) continue;
      synced.set(s.key, s.sessionId);
      if (s.customTitle) {
        saveTitle(s.sessionId, s.customTitle); // ②
      } else {
        const stored = titleFor(s.sessionId); // ③
        if (stored) dispatch({ type: 'rename-session', key: s.key, title: stored });
      }
    }
    // 사라진 세션의 장부 찌꺼기 정리 — 끝내 id를 못 받은 세션의 보류 이름은 버린다
    // (영속할 대상이 없다). 화면에서 이미 사라진 세션이므로 사용자에게 손실도 없다.
    for (const key of [...pending.keys()]) if (!state.sessions.has(key)) pending.delete(key);
    for (const key of [...synced.keys()]) if (!state.sessions.has(key)) synced.delete(key);
  }, [state.sessions]);

  // 디버그 플래그 초기 동기화 — localStorage 'ccob-debug'를 store 상태로 미러.
  // (리듀서/createInitialState는 순수 유지 — window 접근은 여기서만.)
  useEffect(() => {
    try {
      if (window.localStorage?.getItem('ccob-debug') === '1') {
        dispatch({ type: 'set-debug', value: true });
      }
    } catch {
      /* localStorage 불가 환경 — 기본 꺼짐 유지 */
    }
  }, []);

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
      /**
       * Start a new CLI session.
       * @returns startId, or null if the WS send failed (전송 실패는 토스트로도
       * 알리지만, 호출측이 "시작됐다"고 후속 UI를 진행하지 않도록 값으로도 알린다).
       */
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
          return null;
        }
        return startId;
      },
      /** Stop a session's CLI process (client->server contract 'stop'). Server replies with exit. */
      stopSession: (key) => (wsRef.current ? wsRef.current.send({ type: 'stop', key }) : false),
      /**
       * 원격 제어 켜기/끄기. 대상 디렉터리는 **보내지 않는다** — 세션 key만 넘기고
       * 서버가 자기 장부에서 cwd를 되찾는다(WS로 온 임의 경로를 신뢰하지 않기 위해).
       * 응답은 remoteControl 스냅샷 방송으로 온다.
       */
      setRemoteControl: (key, action, { name, cwd } = {}) => (wsRef.current
        ? wsRef.current.send({
          type: 'remoteControl',
          action,
          key,
          ...(name ? { name } : {}),
          // cwd는 '끄기'에서만, 그것도 서버가 우리에게 알려 준 항목의 cwd를 되돌려
          // 보낼 때만 실린다(세션이 먼저 끝난 원격 제어를 끄는 경로).
          ...(cwd ? { cwd } : {}),
        })
        : false),
      /**
       * 세션 이름 변경(사이드바 우클릭 메뉴) — 빈 값이면 해제해 자동 제목으로 돌아간다.
       * 화면에는 즉시 반영하고, 영속은 sessionId가 확정된 세션에만 그 자리에서 한다.
       * 아직 확정 전이면 보류했다가 위 effect가 확정 시점에 기록한다.
       */
      renameSession: (key, rawTitle) => {
        const title = normalizeTitle(rawTitle);
        dispatch({ type: 'rename-session', key, title });
        const s = stateRef.current.sessions.get(key);
        if (s?.idConfirmed && s.sessionId) {
          pendingTitlesRef.current.delete(key);
          titleSyncRef.current.set(key, s.sessionId);
          saveTitle(s.sessionId, title);
        } else {
          pendingTitlesRef.current.set(key, title);
        }
      },
      /** 대화에서 특정 메시지로 이동 — 실행 중 도크 항목 클릭. */
      jumpTo: (key, uid) => dispatch({ type: 'jump-to', key, uid, nonce: ++jumpCounter }),
      /** 일시 토스트 알림 — 설정 변경 확인·오류 표시용(자동 소멸). */
      notify: (text, kind = 'info') => dispatch({ type: 'add-toast', text, kind }),
      /** 디버그 raw 이벤트 표시 토글 — localStorage 동기화 + 상태 반영(리렌더 유발). */
      setDebug: (value) => {
        try {
          if (value) window.localStorage?.setItem('ccob-debug', '1');
          else window.localStorage?.removeItem('ccob-debug');
        } catch {
          /* localStorage 불가 환경 — 상태만 반영 */
        }
        dispatch({ type: 'set-debug', value: !!value });
      },
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
