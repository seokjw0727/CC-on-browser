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
import { effortPayload } from './effort.js';
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
let effortCounter = 0;
// 이 탭만의 reqId 접두사 — 카운터만 쓰면 모든 탭이 'ef_1'부터 시작해, 성공 방송이
// 전 소켓에 가는 구조에서 남의 탭 첫 요청이 내 대기표를 결착시킨다(codex 지적).
const CLIENT_ID = Math.random().toString(36).slice(2, 8);

// 노력 수준 런타임 변경(setEffort)의 ack 대기 한도. 이 시간 안에 effortSet/error가
// 오지 않으면 "이 CLI는 런타임 변경을 못 한다"로 보고 호출측이 재시작 폴백을 고른다.
// 서버의 제어 요청 타임아웃(30s)보다 짧게 둔다 — 사용자를 그만큼 기다리게 할 수 없고,
// 늦게 도착한 성공 방송은 리듀서가 그때 반영하므로 표시가 어긋나지 않는다.
const EFFORT_ACK_TIMEOUT_MS = 5_000;

// 종료된 세션이 회색 상태 점으로 남아 있다가 사이드바 목록에서 사라지기까지의
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
  // 노력 수준 런타임 변경의 ack 대기표 — reqId -> {resolve, timer}.
  // reqId로 짝을 맞추는 이유: 성공(effortSet)은 전 소켓에 방송되고, 실패는 일반 error
  // 프레임으로 오기 때문에 key만으로는 남의 탭의 성공이나 무관한 error(예: 죽은
  // 세션에 send)를 내 요청의 결론으로 오인할 수 있다.
  const pendingEffortRef = useRef(new Map());

  // ack 결착 — refs만 만지므로 첫 렌더의 클로저로 캡처돼도 안전하다(아래 WS effect).
  // 세션 key까지 대조한다 — reqId 접두사와 이중 방어(다른 세션의 프레임으로는 결착 불가).
  const settleEffort = (msg, applied) => {
    const reqId = msg?.reqId;
    if (reqId == null) return;
    const pending = pendingEffortRef.current.get(reqId);
    if (!pending || pending.key !== msg.key) return;
    pendingEffortRef.current.delete(reqId);
    clearTimeout(pending.timer);
    pending.resolve(applied);
  };

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
      onMessage: (msg) => {
        // 노력 수준 변경의 결론(성공 방송 / 실패 error)을 먼저 대기표에 반영한다 —
        // 리듀서는 순수해야 하므로 Promise 결착은 여기서만 한다.
        if (msg?.type === 'effortSet') settleEffort(msg, true);
        else if (msg?.type === 'error' && msg.reqId != null) settleEffort(msg, false);
        dispatch({ type: 'server-message', message: msg });
      },
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
            // UI 티어(ultracode)는 CLI와 같은 의미로 분해해 보낸다 — effort는 xhigh,
            // 플래그는 ultracode:true(서버 EFFORT_LEVELS 검증은 low..max만 통과시킨다).
            // UI 표시용 effort는 register-start의 opts.effort로 세션에 그대로
            // 시딩된다(ultracode 보존).
            ...effortPayload(opts.effort),
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
       * 노력 수준 런타임 변경 — 세션 재시작 없이 실행 중 CLI에 적용한다.
       * @returns Promise<boolean> 적용됐으면 true. false면 이 CLI가 런타임 변경을
       * 지원하지 않는다는 뜻이므로(구버전: 제어 요청 거부 또는 무응답) 호출측이
       * 예전 방식(--resume 재시작)으로 폴백할 수 있다. 화면의 effort 표시는 성공
       * 방송(effortSet)을 받은 리듀서가 갱신한다 — 낙관적 선반영은 하지 않는다.
       */
      setEffort: (key, uiEffortValue) => {
        const reqId = `ef_${CLIENT_ID}_${++effortCounter}`;
        const sent = wsRef.current
          && wsRef.current.send({ type: 'setEffort', key, reqId, ...effortPayload(uiEffortValue) });
        if (!sent) return Promise.resolve(false);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingEffortRef.current.delete(reqId);
            resolve(false);
          }, EFFORT_ACK_TIMEOUT_MS);
          pendingEffortRef.current.set(reqId, { key, resolve, timer });
        });
      },
      /**
       * 현재 상태 스냅샷 — await 뒤처럼 컴포넌트 클로저의 state가 낡았을 수 있는
       * 자리에서만 쓴다(예: setEffort ack를 기다린 뒤의 재시작 폴백).
       */
      getState: () => stateRef.current,
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
