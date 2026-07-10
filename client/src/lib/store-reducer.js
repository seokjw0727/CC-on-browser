// 전역 스토어의 순수 상태 로직 — React 없는 모듈로 분리해 node --test로 검증한다.
// (store.jsx가 이 리듀서를 useReducer에 연결하고 WS/컨텍스트를 소유한다.)
import { reduceCliEvent } from './reduce-cli-event.js';

export function createSessionState(partial = {}) {
  return {
    key: null,
    cwd: null,
    sessionId: null,
    model: null,
    permissionMode: 'default',
    maxThinkingTokens: null, // 사고 예산 — 서버 setThinking 채널용으로 유지(현재 UI 미노출)
    effort: null, // 노력 수준(low|medium|high|xhigh|max) — null=CLI 기본(high), spawn 전용
    // --resume 게이트: 완결 턴 ≥1(result 관측) 또는 재개로 시작한 세션만 트랜스크립트가
    // 디스크에 존재한다(무턴 세션은 jsonl 미생성 — 실 CLI v2.1.206 실측).
    hasCompletedTurn: false,
    // 재개 원본 id — 재개 직후(새 fork id 채택 전) 다시 재시작할 때의 --resume 대상
    resumeSourceId: null,
    messages: [],
    streaming: {},
    pendingPermissions: [],
    usage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 0 },
    // contextTokens가 assistant 이벤트의 호출별 usage에서 왔는지 — true면 result의
    // 턴 합산 usage로 덮어쓰지 않는다(합산은 호출 수만큼 인플레 — reduce-cli-event 참조).
    ctxFromCalls: false,
    rateLimit: null,
    status: 'idle', // idle | thinking | tool | awaiting-permission | exited
    // 사용자가 이 턴을 직접 중단했는가 — 마스코트 턴 종료 반응 억제용
    // (인터럽트도 is_error result로 끝난다). Composer가 인터럽트 전송 시 true,
    // 다음 doSend가 false로 되돌린다.
    interruptRequested: false,
    lastSeq: 0,
    ...partial,
  };
}

export function createInitialState() {
  return {
    conn: 'connecting', // connecting | open | closed
    sessions: new Map(), // key -> SessionState
    activeKey: null,
    projects: [],
    initInfo: null,
    // startId -> {cwd, model, permissionMode, effort, resumeSessionId,
    //             preloadMessages?, preloadSessionId?, preloadUsage?,
    //             preloadCtxFromCalls?, replaceKey?}
    // replaceKey: effort 재시작처럼 기존 탭을 대체하는 시작 — started 도착 시 옛 세션 탭 제거
    pendingStarts: new Map(),
    toasts: [], // [{id, kind: 'info'|'error', text}] — 설정 변경·오류의 일시 알림(자동 소멸)
    newSessionOpen: false, // 새 세션(레포 선택) 모달 표시 여부 — Sidebar/Composer 공용
    globalUsage: null, // /api/usage 폴링 결과 — 로컬 5h/7d 집계 + 공식 quota(실패 시 null), 상태줄 표시용
  };
}

function updateSession(state, key, fn) {
  const cur = state.sessions.get(key);
  if (!cur) return state;
  const sessions = new Map(state.sessions);
  sessions.set(key, fn(cur));
  return { ...state, sessions };
}

let toastCounter = 0;
const MAX_TOASTS = 5;

/** 일시 알림 추가 — 채팅 기록 대신 토스트로 표시(오래된 것부터 잘라 최대 5개 유지). */
function pushToast(state, text, kind = 'info') {
  const toast = { id: `t_${++toastCounter}`, kind, text: String(text) };
  return { ...state, toasts: [...state.toasts, toast].slice(-MAX_TOASTS) };
}

function handleServerMessage(state, msg) {
  switch (msg.type) {
    case 'started': {
      const opts = state.pendingStarts.get(msg.startId) || {};
      const pendingStarts = new Map(state.pendingStarts);
      pendingStarts.delete(msg.startId);
      const sessions = new Map(state.sessions);
      // effort 재시작: 새 탭이 옛 탭을 대체한다 — 성공(started)했을 때만 제거하므로
      // 시작 실패 시에는 옛 exited 탭이 남아 대화가 보존된다.
      if (opts.replaceKey && opts.replaceKey !== msg.key) sessions.delete(opts.replaceKey);
      sessions.set(
        msg.key,
        createSessionState({
          key: msg.key,
          cwd: opts.cwd ?? null,
          model: opts.model ?? null,
          permissionMode: opts.permissionMode ?? 'default',
          effort: opts.effort ?? null,
          // 재개로 시작한 세션은 원본 트랜스크립트가 디스크에 있음 — resume 게이트 통과
          hasCompletedTurn: opts.resumeSessionId != null,
          resumeSourceId: opts.resumeSessionId ?? null,
          // 프리로드 이월(effort 재시작의 in-memory 메시지, 재개의 pre-reduce된
          // 트랜스크립트). 반드시 started 커밋에서 원자적으로 시딩한다 — 세션 생성
          // 후 별도 커밋으로 주입하면 ChatView의 seenRef 리셋(첫 렌더)이 프리로드를
          // 못 보고 히스토리 전체가 isNew=true로 등장 애니·타자기 출력을 탄다.
          messages: Array.isArray(opts.preloadMessages) ? [...opts.preloadMessages] : [],
          // 재개 프리로드의 부속 산출물 — usage(상태줄 CTX% 연속성)와 원본 세션 id
          // (사이드바/배지 표기 — 이후 system/init의 새 fork id가 덮어쓴다).
          // ctxFromCalls도 이월: true면 result의 턴 합산 usage가 컨텍스트를 못 덮는다.
          sessionId: opts.preloadSessionId ?? null,
          ...(opts.preloadUsage ? { usage: opts.preloadUsage } : {}),
          ...(opts.preloadCtxFromCalls ? { ctxFromCalls: true } : {}),
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

    case 'event': {
      const cur = state.sessions.get(msg.key);
      const isReplayed =
        !cur || (typeof msg.seq === 'number' && msg.seq <= cur.lastSeq);
      let next = updateSession(state, msg.key, (s) => {
        if (typeof msg.seq === 'number' && msg.seq <= s.lastSeq) return s; // replay dedupe
        const reduced = reduceCliEvent(s, msg.payload);
        return { ...reduced, lastSeq: msg.seq ?? s.lastSeq };
      });
      // 턴 실패(result.is_error)는 채팅 기록 대신 토스트 — 재접속 리플레이 분은 제외.
      const p = msg.payload;
      if (!isReplayed && p?.type === 'result' && p.is_error) {
        next = pushToast(
          next,
          typeof p.result === 'string' && p.result ? p.result : `턴 실패 (${p.subtype ?? 'unknown'})`,
          'error',
        );
      }
      return next;
    }

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
      // 프로세스가 죽으면 대기 중이던 권한 요청은 더 이상 응답할 수 없고(서버도
      // 이미 정리함), 답할 수 없는 권한 모달이 화면에 고착되므로 함께 비운다.
      return updateSession(state, msg.key, (s) => ({
        ...s,
        status: 'exited',
        pendingPermissions: [],
      }));

    case 'error': {
      // 에러는 채팅 기록·영구 배너 대신 토스트로 잠시 표시하고 사라진다.
      let next = pushToast(state, msg.message ?? 'unknown error', 'error');
      if (msg.startId) {
        const pendingStarts = new Map(next.pendingStarts);
        pendingStarts.delete(msg.startId);
        next = { ...next, pendingStarts };
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
    case 'set-usage':
      return { ...state, globalUsage: action.usage };
    case 'update-session':
      return updateSession(state, action.key, action.fn);
    case 'add-toast':
      return pushToast(state, action.text, action.kind);
    case 'remove-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}
