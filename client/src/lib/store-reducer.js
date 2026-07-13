// 전역 스토어의 순수 상태 로직 — React 없는 모듈로 분리해 node --test로 검증한다.
// (store.jsx가 이 리듀서를 useReducer에 연결하고 WS/컨텍스트를 소유한다.)
import { reduceCliEvent, finalizeCompactionCards, deriveGoalFromMessages } from './reduce-cli-event.js';

export function createSessionState(partial = {}) {
  return {
    key: null,
    cwd: null,
    sessionId: null,
    model: null,
    // 스폰 계보 — 실제 --model 인자로 썼거나(started) set_model로 성공 적용된
    // 카탈로그 value만 담는다. model 필드(init/assistant가 보고한 해석 id —
    // 구식·[1m] 접미사 탈락 가능)와 달리 재시작 스폰 인자로 재사용해도 안전.
    spawnModel: null,
    // CLI가 직접 보고한 컨텍스트 창 크기 — result.modelUsage[<id>].contextWindow
    // (실측 2026-07-11: 1M 모델에서 1000000). null이면 카탈로그 휴리스틱으로 폴백.
    contextWindow: null,
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
    // 사용자가 마지막으로 직접 보낸 프롬프트 텍스트 — 인터럽트된 턴의 "재시도/수정 후
    // 재전송" 복구 UI가 참조한다(reduce-cli-event가 user-text에서 채운다).
    lastUserText: null,
    // 활성 세션 목표(/goal <텍스트>) — 구동 중 기능 배지 표시용. null=설정 안 됨.
    // /goal 커맨드 에코 또는 "Goal set:" stdout에서 best-effort로 추적한다.
    goal: null,
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
    //             preloadCtxFromCalls?, preloadModel?, replaceKey?}
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
          // preloadModel: 재개 트랜스크립트가 복원한 표시 전용 모델(스폰 인자 아님)
          // — 피커 라벨·CTX 분모([1m]→1M)가 재개 직후부터 맞고, init이 실제값으로 덮어쓴다.
          model: opts.model ?? opts.preloadModel ?? null,
          spawnModel: opts.model ?? null, // 실제 스폰 인자만 계보에 남긴다

          permissionMode: opts.permissionMode ?? 'default',
          effort: opts.effort ?? null,
          // 재개로 시작한 세션은 원본 트랜스크립트가 디스크에 있음 — resume 게이트 통과
          hasCompletedTurn: opts.resumeSessionId != null,
          resumeSourceId: opts.resumeSessionId ?? null,
          // 프리로드 이월(effort 재시작의 in-memory 메시지, 재개의 pre-reduce된
          // 트랜스크립트). 반드시 started 커밋에서 원자적으로 시딩한다 — 세션 생성
          // 후 별도 커밋으로 주입하면 ChatView의 seenRef 리셋(첫 렌더)이 프리로드를
          // 못 보고 히스토리 전체가 isNew=true로 등장 애니·타자기 출력을 탄다.
          // 시딩된 프리로드에 완료 신호 없이 넘어온 'running' 압축 카드가 있으면
          // 완료로 닫는다 — 정적 히스토리 뷰의 무한 진행바 방지(방어).
          messages: Array.isArray(opts.preloadMessages)
            ? finalizeCompactionCards([...opts.preloadMessages])
            : [],
          // 프리로드 메시지에서 활성 목표(/goal)를 복원한다 — 시딩은 리듀서를 안 태우므로
          // 이게 없으면 effort 재시작·재개에서 🎯 배지가 사라진다(같은 대화가 이어지는데도).
          goal: deriveGoalFromMessages(opts.preloadMessages),
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
            // AskUserQuestion류 "사용자에게 묻기" 신호(실 CLI 실측 2026-07-12) —
            // 렌더 분기 자체는 toolName+input 형상(isQuestionRequest)으로 하므로
            // 현재 소비처는 없다 — 서버 프로토콜과의 계약 패리티 목적으로 보관.
            requiresUserInteraction: msg.requiresUserInteraction === true,
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
    case 'remove-session': {
      // 종료된 세션을 사이드바(=세션 맵)에서 제거. 활성 세션이 사라지면 남은
      // 세션 중 가장 최근 것으로 전환(없으면 null → 그리팅).
      if (!state.sessions.has(action.key)) return state;
      const sessions = new Map(state.sessions);
      sessions.delete(action.key);
      let activeKey = state.activeKey;
      if (activeKey === action.key) {
        // 살아있는 세션을 우선 선택 — 다른 종료 세션이 유예창에 남아 있어도 그쪽으로
        // 포커스가 튀지 않게 한다(codex 지적). 라이브가 없으면 아무거나, 없으면 null.
        const remaining = [...sessions.values()];
        const live = remaining.filter((s) => s.status !== 'exited');
        const pick = live.length ? live[live.length - 1] : remaining[remaining.length - 1];
        activeKey = pick ? pick.key : null;
      }
      return { ...state, sessions, activeKey };
    }
    case 'open-new-session':
      return { ...state, newSessionOpen: true };
    case 'close-new-session':
      return { ...state, newSessionOpen: false };
    case 'set-projects':
      return { ...state, projects: action.projects };
    case 'set-usage': {
      // 공식 사용률(quota)의 5h/7d 창은 폴링마다 독립적으로 실패할 수 있다: 서버는
      // 두 창이 모두 없을 때만 quota=null을 주고, 한쪽만 유효하면 {fiveHour, sevenDay:null}
      // 같은 부분(partial) quota를 준다(quota.js). Composer는 창별로 폴백하므로, 빠진 창을
      // 직전 값으로 채워 넣는다 — 5h/7d 창 %는 느리게 변하므로 일시/부분 실패에도 링(%)
      // 표시가 유지되고, 원시 토큰 수치로 깜빡이며 뒤바뀌지 않는다(로컬 집계는 새 값 유지).
      const usage = action.usage;
      const prevQuota = state.globalUsage?.quota ?? null;
      let merged = usage;
      if (usage && prevQuota) {
        const q = usage.quota;
        const fiveHour = q?.fiveHour ?? prevQuota.fiveHour ?? null;
        const sevenDay = q?.sevenDay ?? prevQuota.sevenDay ?? null;
        if (fiveHour || sevenDay) {
          merged = { ...usage, quota: { ...(q ?? prevQuota), fiveHour, sevenDay } };
        }
      }
      return { ...state, globalUsage: merged };
    }
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
