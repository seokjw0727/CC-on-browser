// 전역 스토어의 순수 상태 로직 — React 없는 모듈로 분리해 node --test로 검증한다.
// (store.jsx가 이 리듀서를 useReducer에 연결하고 WS/컨텍스트를 소유한다.)
import { reduceCliEvent, finalizeCompactionCards, deriveGoalFromMessages } from './reduce-cli-event.js';
import { autoPreviewPath } from './artifacts.js';
import { uiEffort } from './effort.js';

export function createSessionState(partial = {}) {
  const s = {
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
    // 스폰 계보 — 세션이 실제로 어떤 --permission-mode로 시작됐는지. 신뢰모드
    // (bypassPermissions)는 스폰 시에만 진입 가능하므로, 런타임 permissionMode와
    // 달리 불변이며 신뢰모드 UI 노출 자격 판정에 쓴다(spawnModel 패턴과 동일).
    spawnPermissionMode: 'default',
    maxThinkingTokens: null, // 사고 예산 — 서버 setThinking 채널용으로 유지(현재 UI 미노출)
    // 모델 전환 확정 대기 — {target} (없으면 null). setModel이 CLI에 적용됐다는 ack
    // (modelSet)를 받은 순간 걸리고, 표적 계열의 모델 보고가 도착하거나 다음 턴이
    // 끝나면(reduce-cli-event) 풀린다. 대기 중에는 이미 시작된 API 호출이 계속 보고하는
    // **이전 모델**을 수확하지 않는다 — 그 수확이 사용자가 방금 고른 모델을 저 혼자
    // 되돌리던 원인이다(reduce-cli-event의 modelSwitch 주석에 실측 근거).
    modelSwitch: null,
    // 노력 수준 — **UI 티어** 값(low|medium|high|xhigh|max|ultracode). null=CLI 기본(high).
    // 실행 중 변경은 재시작이 아니라 런타임 채널(setEffort)로 하고, 화면 반영은 서버의
    // effortSet 방송이 담당한다(와이어의 {effort, ultracode} → uiEffort로 되돌림).
    effort: null,
    // --resume 게이트: 완결 턴 ≥1(result 관측) 또는 재개로 시작한 세션만 트랜스크립트가
    // 디스크에 존재한다(무턴 세션은 jsonl 미생성 — 실 CLI v2.1.206 실측).
    hasCompletedTurn: false,
    // 재개 원본 id — 재개 직후(새 fork id 채택 전) 다시 재시작할 때의 --resume 대상
    resumeSourceId: null,
    // sessionId를 CLI가 직접 확정해 줬는가(system/init 또는 이벤트에서 채택).
    // 재개 세션의 sessionId는 init 전까지 트랜스크립트에서 복원한 "원본 id"라,
    // 이 플래그 없이 그 값을 최종 id로 믿으면 사용자 지정 이름을 원본 세션에
    // 덮어써 버린다(설계도 §2 store.jsx 행). 이름 영속의 관문으로만 쓴다.
    idConfirmed: false,
    messages: [],
    streaming: {},
    pendingPermissions: [],
    // 실행 중 백그라운드 작업 — CLI의 system/background_tasks_changed 스냅샷 원본.
    // 항목: {task_id, task_type:'local_bash'|'local_agent', description}
    // 파생이 아니라 상태로 두는 이유: 메시지에서 되살릴 수 없는 정보이고, CLI가
    // 권위 있는 전체 목록을 직접 준다(실측 근거는 reduce-cli-event의 해당 case 주석).
    backgroundTasks: [],
    // task_id -> tool_use_id — 도크 항목에서 대화 속 도구 카드로 점프하는 연결 고리.
    taskToolUseIds: {},
    // ctxDisplayable: contextTokens가 "보여줄 만한 값"인가 — 값이 아니라 플래그로
    // 판정해야 /clear 직후의 0을 "아직 아무 값도 없음"과 구별할 수 있다(0 > 0은 거짓이라
    // 값만 보면 링이 사라진다). 측정값(assistant/result)뿐 아니라 /clear의 의도된 0,
    // /compact의 postTokens에서도 true가 된다. usage 안에 두는 이유: 재개·effort 재시작이
    // preloadUsage로 usage 객체를 통째로 이월하므로 별도 배선 없이 따라온다.
    usage: { cost: 0, inTok: 0, outTok: 0, contextTokens: 0, ctxDisplayable: false },
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
    // 사용자가 우클릭 메뉴에서 직접 지정한 세션 이름 — ''이면 자동 제목(첫 발화 요약)을
    // 쓴다. 리듀서는 순수 유지: localStorage 읽기/쓰기는 store.jsx의 몫이고, 여기엔
    // 화면에 보일 값만 담긴다(debugRaw와 같은 분업).
    customTitle: '',
    // CLI가 이 세션에 붙인 이름(~/.claude/sessions의 name) — 서버가 sessionId 확정 후
    // sessionName 메시지로 알려 준다. 사용자 지정 이름 다음, 첫 발화 요약보다 앞에서
    // 쓰인다(sessionTree.sessionDisplayTitle). ''이면 아직 모르거나 이름이 없는 세션.
    cliName: '',
    // 결과물 미리보기 패널 — {open, path, suppressed}. path는 산출물의 **원본 절대경로**
    // (표시·티켓 발급에 그대로 쓴다). 산출물 목록 자체는 상태로 두지 않고 messages에서
    // 파생한다(lib/artifacts.js) — 재개·effort 재시작의 이월 경로마다 시딩을 배선하지
    // 않기 위해. suppressed=사용자가 직접 닫아 이번 턴의 자동 열기를 원치 않음
    // (close-preview가 켜고, 수동 열기·다음 사용자 턴이 끈다 — 수명은 그 턴 하나다).
    preview: { open: false, path: null, suppressed: false },
    lastSeq: 0,
    ...partial,
  };
  // preview는 shape 불변식을 여기서 강제한다 — 옛 2필드 형태({open, path})가 partial로
  // 들어와도 suppressed가 undefined로 남지 않게(그러면 "억제 안 됨"과 구별할 수 없다).
  s.preview = { open: false, path: null, suppressed: false, ...s.preview };
  return s;
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
    // replaceKey: 기존 탭을 대체하는 시작 — started 도착 시 옛 세션 탭 제거.
    // 노력 수준 변경은 이제 런타임 채널로 적용되므로(재시작 없음) 이 경로는 그 채널을
    // 지원하지 않는 구버전 CLI의 폴백에서만 쓰인다.
    pendingStarts: new Map(),
    toasts: [], // [{id, kind: 'info'|'error', text}] — 설정 변경·오류의 일시 알림(자동 소멸)
    newSessionOpen: false, // 새 세션(레포 선택) 모달 표시 여부 — 진입점은 사이드바뿐
    globalUsage: null, // /api/usage 폴링 결과 — 로컬 5h/7d 집계 + 공식 quota(실패 시 null), 상태줄 표시용
    // 계정 공식 사용률 조회의 옵트인 상태(localStorage 'ccob-official-usage' 미러).
    // 리듀서는 순수 유지 — 저장소 읽기/쓰기는 설정 토글과 App.jsx 폴링의 몫이고,
    // 여기 있는 값은 "지금 화면이 무엇을 근거로 그리고 있는가"의 사본이다.
    // 기본값 false는 저장된 설정이 없을 때의 진짜 기본값(꺼짐)과 같다. 첫 폴링이
    // 곧바로 실제 값으로 덮으므로, 켜 둔 사용자가 보는 잘못된 안내는 한 프레임이다.
    // 이 값이 없으면 화면은 "꺼서 값이 없음"과 "조회에 실패해 값이 없음"을 구분할 수
    // 없어, 껐을 뿐인데 "조회 실패"라는 오류 문구를 띄우게 된다.
    officialUsage: false,
    // 디버그 raw 이벤트 표시(사이드바 설정 토글) — localStorage 'ccob-debug' 미러.
    // 리듀서는 순수 유지: localStorage 읽기/쓰기는 store.jsx(초기 동기화·setDebug)의 몫.
    // 토글 dispatch가 store 구독자(ChatView)를 리렌더시켜 Message.jsx의 기존
    // debugEnabled()가 재평가된다 — Message는 무수정(설계도 §2).
    debugRaw: false,
    // 원격 제어 상태 — 서버가 보내는 스냅샷을 그대로 들고 있는다(부분 갱신 없음).
    // 항목: {cwd, keys[], name, state, environmentId, url, capacity, error, startedAt}
    // 조회는 cwd 문자열이 아니라 keys(세션 key)로 한다 — 서버만 realpath로 동일성을
    // 판정할 수 있으므로, 클라이언트가 cwd를 비교하면 심링크·대소문자에서 어긋난다.
    remoteControls: [],
    // 대화 속 특정 메시지로 이동 요청 — {key, uid, nonce}. ChatView가 소비하고 지운다.
    // nonce가 없으면 같은 항목을 두 번 눌렀을 때 상태가 그대로라 effect가 다시 돌지 않는다.
    jump: null,
  };
}

/** 이 세션에 걸려 있는 원격 제어 상태 (없으면 null). */
export function remoteControlFor(state, key) {
  if (!key) return null;
  return (state.remoteControls ?? []).find((r) => r.keys?.includes(key)) ?? null;
}

/**
 * 세션 cwd로 찾는 폴백 — 세션이 먼저 끝나면 서버의 keys에서 빠지지만 원격 제어는
 * 계속 돌 수 있고, 그때도 끌 수 있어야 한다.
 *
 * 판정 근거는 서버가 realpath로 묶어 내려준 `cwds` 목록이다. raw cwd 문자열을
 * `r.cwd`와 직접 비교하면 심링크·junction·대소문자·끝 구분자에서 어긋난다 —
 * 정규화는 서버만 할 수 있다. 사이드바 행 아이콘과 우클릭 메뉴가 같은 판정을 쓰도록
 * 여기 한 곳에 둔다.
 */
export function remoteControlByCwd(state, cwd) {
  if (!cwd) return null;
  return (state.remoteControls ?? []).find((r) => (r.cwds ?? []).includes(cwd)) ?? null;
}

/**
 * 스냅샷 두 개를 견줘 "이번에 새로 생긴 상태 전이"만 뽑는다 — 켜짐 안내·실패 사유를
 * 토스트로 알리는 쪽(store.jsx)이 쓴다. 순수 함수로 둔 이유는 이 판정이 e2e로 닿지
 * 않는 경로(ready)를 품고 있어 단위 테스트로 덮어야 하기 때문이다.
 *
 * 규율(codex 지적 반영):
 *  · identity는 cwd다 — 서버 장부가 디렉터리당 항목 하나라, 객체 재생성·배열 순서
 *    변경·keys 변동에 흔들리지 않는 유일한 좌표다.
 *  · 비교는 state 필드만 본다 — url·capacity가 늦게 채워져도 다시 알리지 않는다.
 *  · prev가 null이면(최초 스냅샷·WS 재연결 직후) 전이 없음으로 본다. 호출측이 조용히
 *    시딩만 하도록 — 페이지를 열었을 뿐인데 예전 상태가 새 소식으로 뜨는 것을 막는다.
 *
 * @param {Map<string, string>|null} prev 이전 스냅샷 요약 (cwd -> state). null이면 시딩.
 * @param {Array<object>} next 새 스냅샷 항목 배열
 * @returns {Array<object>} 이번에 새로 ready·error가 된 항목들
 */
export function remoteControlTransitions(prev, next) {
  const items = Array.isArray(next) ? next : [];
  if (!prev) return [];
  const out = [];
  for (const rc of items) {
    if (!rc?.cwd) continue;
    if (prev.get(rc.cwd) === rc.state) continue;
    if (rc.state === 'ready' || rc.state === 'error') out.push(rc);
  }
  return out;
}

/** remoteControlTransitions가 다음 비교에 쓸 스냅샷 요약 (cwd -> state). */
export function remoteControlStates(list) {
  const map = new Map();
  for (const rc of Array.isArray(list) ? list : []) {
    if (rc?.cwd) map.set(rc.cwd, rc.state);
  }
  return map;
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
    case 'remoteControl':
      // 스냅샷 통째 교체. 서버는 연결 직후·상태 전이·start/stop 응답에서 늘 전체를 보낸다
      // (빈 배열도 "아무것도 안 켜짐"이라는 복구해야 할 사실이다).
      return { ...state, remoteControls: Array.isArray(msg.states) ? msg.states : [] };
    case 'started': {
      const opts = state.pendingStarts.get(msg.startId) || {};
      const pendingStarts = new Map(state.pendingStarts);
      pendingStarts.delete(msg.startId);
      const sessions = new Map(state.sessions);
      // 탭 대체 시작(노력 수준 폴백·재개): 새 탭이 옛 탭을 대체한다 — 성공(started)했을 때만 제거하므로
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
          spawnPermissionMode: opts.permissionMode ?? 'default',
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
          // preloadIsHistory: 디스크 트랜스크립트에서 되살린 과거 대화일 때만 각
          // 아이템에 preloaded를 찍는다. 실행 중 도크가 "결과 없는 도구 = 실행 중"
          // 규칙을 그 메시지들에 적용하면, 중단된 채 끝난 옛 도구가 유령으로 뜬다.
          // effort 재시작은 같은 preloadMessages 경로를 쓰지만 라이브 대화의 이월이라
          // 표시하지 않는다 — 거기 열려 있는 도구는 실제로 돌고 있다.
          messages: Array.isArray(opts.preloadMessages)
            ? finalizeCompactionCards(
              opts.preloadIsHistory
                ? opts.preloadMessages.map((m) => ({ ...m, preloaded: true }))
                : [...opts.preloadMessages],
            )
            : [],
          // 프리로드 메시지에서 활성 목표(/goal)를 복원한다 — 시딩은 리듀서를 안 태우므로
          // 이게 없으면 effort 재시작·재개에서 🎯 배지가 사라진다(같은 대화가 이어지는데도).
          goal: deriveGoalFromMessages(opts.preloadMessages),
          // 재개 프리로드의 부속 산출물 — usage(상태줄 CTX% 연속성)와 원본 세션 id
          // (사이드바/배지 표기 — 이후 system/init의 새 fork id가 덮어쓴다).
          // ctxFromCalls도 이월: true면 result의 턴 합산 usage가 컨텍스트를 못 덮는다.
          sessionId: opts.preloadSessionId ?? null,
          // 이 세션에 이미 붙어 있던 사용자 지정 이름을 이월한다 — 재개(저장된 이름을
          // store.jsx가 조회해 넘김)와 effort 재시작(옛 탭의 in-memory 이름) 공통.
          // 없으면 ''이라 자동 제목으로 돌아간다.
          customTitle:
            typeof opts.preloadCustomTitle === 'string' ? opts.preloadCustomTitle.trim() : '',
          ...(opts.preloadUsage ? { usage: opts.preloadUsage } : {}),
          ...(opts.preloadCtxFromCalls ? { ctxFromCalls: true } : {}),
          // 미리보기 선택 이월 — effort 재시작(replaceKey)은 같은 대화를 이어가므로
          // 메시지가 이월되는 만큼 열려 있던 패널도 그대로 따라와야 한다. 없으면
          // 기본값(닫힘)이라 재개/새 세션에서는 빈 패널이 열리지 않는다.
          // shape 정규화(suppressed 보충)는 createSessionState가 맡는다.
          ...(opts.preloadPreview ? { preview: opts.preloadPreview } : {}),
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
      // 턴이 성공적으로 끝났으면 이번 턴의 결과물을 미리보기로 자동 표시한다.
      // 반드시 reduce **후에** 판정한다 — 마지막 tool_result가 붙어야 그 쓰기가
      // "성공한 산출물"로 보인다. 여는 시점도 result 하나뿐이다(도구 결과 시점이 아니라).
      // 가드 넷은 서로 독립이다:
      //   isReplayed  — 이미 반영한 seq(중복). WS 순단 중 놓쳤다가 처음 도착한 result는
      //                 seq가 새것이라 여기 걸리지 않고 정상적으로 연다.
      //   isReplay    — CLI가 자기 히스토리를 되쏜 것(대화 진행이 아님)
      //   is_error    — 실패·인터럽트 턴은 보여줄 결과물이 아니다
      //   suppressed  — 사용자가 이번 턴에 패널을 직접 닫았다
      const p = msg.payload;
      if (!isReplayed && p?.type === 'result' && !p.is_error && !p.isReplay) {
        next = updateSession(next, msg.key, (s) => {
          if (s.preview?.suppressed) return s;
          // openPath는 패널이 실제로 열려 있을 때만 — 닫힌 패널에 남은 마지막 선택이
          // 주 산출물 판정을 가로채면 안 된다.
          const path = autoPreviewPath(s.messages, {
            openPath: s.preview?.open ? s.preview.path : null,
          });
          // 이번 턴에 쓴 것이 없으면 상태를 건드리지 않는다 — 닫아 둔 패널은 닫힌 채로.
          if (!path) return s;
          return { ...s, preview: { open: true, path, suppressed: false } };
        });
      }
      // 턴 실패(result.is_error)는 채팅 기록 대신 토스트 — 재접속 리플레이 분은 제외.
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
        // CLI 프로세스가 사라졌으니 그 프로세스가 돌리던 백그라운드 작업도 없다.
        // 비우지 않으면 세션 탭이 목록에서 사라지기까지(3초) 죽은 작업이 "실행 중"으로
        // 맥동한다 — result 없이 끝난 종료에서 실제로 재현된다(codex 지적).
        backgroundTasks: [],
        // 프로세스가 죽었으면 확정될 모델 보고도 더는 오지 않는다 — 대기를 풀지 않으면
        // 재접속 리플레이가 이 세션을 되살릴 때까지 수확이 막힌 채로 남는다.
        modelSwitch: null,
      }));

    case 'sessionName':
      // CLI가 붙인 세션 이름. 서버가 세션 id를 확정한 뒤 한 번 보내고, 재접속 리플레이가
      // 다시 보낸다(링버퍼 밖의 정보라 event로 오지 않는다 — session-hub 참조).
      //
      // 빈 값은 기본적으로 무시한다 — 알려 주는 채널이지 지우는 채널이 아니다. 지우는
      // 것은 reset:true로만 한다: /clear처럼 세션 id가 바뀌면 옛 id의 이름은 더 이상
      // 이 세션의 이름이 아니어서, 남겨 두면 화면만 옛 이름을 붙들고 있게 된다.
      return updateSession(state, msg.key, (s) => {
        if (msg.reset === true) return s.cliName ? { ...s, cliName: '' } : s;
        const cliName = typeof msg.cliName === 'string' ? msg.cliName.trim() : '';
        if (!cliName || cliName === s.cliName) return s;
        return { ...s, cliName };
      });

    case 'modelSet':
      // 모델 전환이 실행 중 세션에 **실제로 적용됐다**(CLI가 set_model에 success를 준
      // 뒤에만 서버가 보낸다). 화면 갱신의 유일한 출처가 이 경로다 — 컴포저는 더 이상
      // 낙관적으로 바꾸지 않는다. 서버가 전 소켓에 방송하므로 같은 세션을 열어 둔 다른
      // 탭도 함께 맞춰진다. 요청 대기표(store.jsx)가 이미 타임아웃으로 닫힌 뒤에 늦게
      // 도착해도 여기서 표시는 바로잡힌다.
      return updateSession(state, msg.key, (s) => {
        const model = typeof msg.model === 'string' && msg.model ? msg.model : null;
        if (!model) return s;
        return {
          ...s,
          model,
          // 검증된 스폰 계보 — 실제로 CLI가 받아들인 값만 담는다(재시작 --model 인자).
          spawnModel: model,
          // 이전 모델의 result가 보고한 창 크기는 새 모델에 무효 — 다음 result까지
          // 카탈로그 휴리스틱으로 폴백한다.
          contextWindow: null,
          // 연속 변경 시 새 표적이 옛 표적을 대체한다(옛 표적이 남으면 최신 선택의
          // 보고가 "불일치"로 버려진다).
          modelSwitch: { target: model },
        };
      });

    case 'effortSet':
      // 노력 수준이 실행 중 세션에 적용됐다(재시작 없음). 서버가 전 소켓에 방송하므로
      // 같은 세션을 열어 둔 다른 탭의 표시도 이 한 경로로 맞춰진다.
      // 와이어는 CLI 형상({effort, ultracode})이고 화면은 UI 티어를 쓴다 —
      // uiEffort가 그 둘을 잇는다(ultracode:true → 'ultracode').
      return updateSession(state, msg.key, (s) => ({
        ...s,
        effort: uiEffort({ effort: msg.effort ?? null, ultracode: msg.ultracode === true }),
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
    case 'rename-session':
      // 사용자 지정 이름 설정/해제. 정규화(공백 정리·길이 제한)는 호출측(store.jsx가
      // session-titles의 normalizeTitle을 통과시킨 값)이 이미 마친 상태로 들어오지만,
      // 여기서도 trim한다 — 공백뿐인 값이 "이름 있음"으로 남으면 자동 제목이 영영
      // 가려진다(리듀서를 직접 호출하는 테스트·다른 경로에 대한 방어).
      return updateSession(state, action.key, (s) => ({
        ...s,
        customTitle: typeof action.title === 'string' ? action.title.trim() : '',
      }));
    case 'open-preview':
      // 미리보기 열기/전환. 선택은 세션별이라 탭을 오가도 각자 보던 파일이 유지된다.
      // 직접 열었다는 건 "보고 싶다"는 뜻이므로 억제도 함께 푼다.
      return updateSession(state, action.key, (s) => ({
        ...s,
        preview: {
          open: true,
          path: action.path ?? s.preview?.path ?? null,
          suppressed: false,
        },
      }));
    case 'close-preview':
      // 닫아도 마지막 선택은 남긴다 — 다시 열 때 보던 파일로 돌아가게.
      // 직접 닫은 것은 "이번 턴엔 방해하지 말라"는 뜻이라 자동 열기를 억제한다
      // (다음 프롬프트를 보내면 reduce-cli-event가 풀어 준다).
      return updateSession(state, action.key, (s) => ({
        ...s,
        preview: { open: false, path: s.preview?.path ?? null, suppressed: true },
      }));
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
      //
      // 단 그 이월은 **조회를 시도했을 때만** 옳다. 사용자가 설정에서 공식 사용률
      // 조회를 끄면 서버는 quota=null을 주는데, 그것을 "이번 조회만 실패"로 읽어
      // 직전 값을 메우면 껐는데도 링과 한도 알림이 옛 %로 계속 살아 있게 된다.
      // action.quotaEnabled === false는 "조회하지 않았다"는 뜻이므로 이월하지 않고
      // 즉시 비운다 — 끔은 화면에서도 끔이어야 한다.
      const usage = action.usage;
      // 응답과 함께 온 "그 요청이 조회를 시도했는가"로 옵트인 사본을 맞춘다 — 토글
      // 직후 아직 응답이 오지 않은 구간에도 set-official-usage가 먼저 갱신해 둔다.
      const officialUsage =
        typeof action.quotaEnabled === 'boolean' ? action.quotaEnabled : state.officialUsage;
      if (usage && action.quotaEnabled === false) {
        return { ...state, globalUsage: { ...usage, quota: null }, officialUsage };
      }
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
      return { ...state, globalUsage: merged, officialUsage };
    }
    case 'set-official-usage': {
      // 설정 토글이 즉시 부르는 액션. 폴링(최대 60초)을 기다리지 않고 화면 문구가
      // 곧바로 바뀌게 하고, 끌 때는 남아 있던 quota를 그 자리에서 비운다 —
      // 끈 뒤 다음 응답이 올 때까지 옛 %가 링에 남아 있으면 끈 것으로 보이지 않는다.
      const on = !!action.on;
      const staleQuota = !on && !!state.globalUsage?.quota;
      // 바뀔 것이 없으면 **같은 state 객체를 그대로** 돌려준다. App.jsx의 폴링 effect가
      // state.officialUsage에 의존하면서 마운트 때 이 액션으로 저장소와 동기화하는데,
      // 매번 새 객체를 만들면 리렌더 → effect 재실행 → 다시 dispatch의 무한 루프가 된다.
      if (on === state.officialUsage && !staleQuota) return state;
      const globalUsage = staleQuota ? { ...state.globalUsage, quota: null } : state.globalUsage;
      return { ...state, officialUsage: on, globalUsage };
    }
    case 'update-session':
      return updateSession(state, action.key, action.fn);
    case 'add-toast':
      return pushToast(state, action.text, action.kind);
    case 'remove-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'jump-to':
      return { ...state, jump: { key: action.key, uid: action.uid, nonce: action.nonce } };
    case 'jump-done':
      // 소비한 요청만 지운다 — 처리 중에 새 요청이 들어왔으면 그걸 살린다.
      return state.jump && state.jump.nonce === action.nonce ? { ...state, jump: null } : state;
    case 'set-debug':
      return { ...state, debugRaw: !!action.value };
    default:
      return state;
  }
}
