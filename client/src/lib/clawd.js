// CLAW'D 마스코트의 순수 데이터·로직 — 프레임 비트맵과 무드 매핑.
// React 없는 모듈로 분리해 node --test로 검증한다 (렌더·타이머는 components/Clawd.jsx).
//
// 실물 충실도: 프레임은 실제 claude CLI(v2.1.206) 바이너리에 내장된 공식 아트를
// 쿼드런트 단위로 옮긴 것이다. 원본은 3행 블록 문자 아트
//   " ▐▛███▜▌" / "▝▜█████▛▘" / "  ▘▘ ▝▝"
// 이고, 포즈 변형(default / look-left / look-right / arms-up)은 눈 블록
// (r1E: "▛███▜"→"▟███▟"→"▙███▙")과 팔 블록의 쿼드런트 차이로 정의돼 있다.
// 색도 바이너리 테마 실측값을 쓴다: clawd_body rgb(215,119,87), 눈=검정 배경.
//
// 좌표계: 1문자 셀 = 2x2 쿼드런트 → 아트 전체 = 18열 x 6행 쿼드런트(빈 마지막
// 행은 생략해 5행). 터미널 셀은 세로가 길어 쿼드런트가 1:2(가로:세로) 비율이므로
// 렌더 시 픽셀 하나를 세로 2배로 그린다(CLAWD_PIXEL_ASPECT).
//
// 전사 범위: base·lookLeft/lookRight의 눈 위치·claws의 팔은 바이너리 아트의 전사,
// blink/doze(눈 감음·팔 붙임)·look 포즈의 다리 반칸 이동·jugLeft/jugRight(집게 들고
// 눈만 좌우 — 저글링)는 원본에 없는 자체 애니메이션 프레임이다.
//
// 무드 어휘는 clawd-on-desk(github rullerzhou-afk)의 state-mapping.md 이식이다.
// 그 문서의 표는 훅 이벤트(UserPromptSubmit·PreToolUse…)로 쓰여 있지만 이 앱은 훅이
// 아니라 CLI stream-json을 받으므로, 리듀서가 남긴 **정규화된 신호**로 옮겨 대응한다:
//   UserPromptSubmit→think(말풍선) / Pre·PostToolUse→busy(두리번, 세션 수 1·2·3+ 티어)
//   SubagentStart→juggle(1·2+ 티어) / PostToolUseFailure→error / Stop→happy
//   PermissionRequest→alert / Notification→notify / PreCompact→sweep / PostCompact→happy
//   WorktreeCreate→carry / 60s 무활동→sleep / Idle(random)→read / SessionEnd·연결끊김→doze
//
// 비트 문자: '0' 투명, '1' 몸통(주황), '2' 눈(검정).
import { openSubagents } from './subagents.js';

export const CLAWD_PIXEL_ASPECT = 2;

export const CLAWD_FRAMES = {
  // default 포즈 — 눈은 r1E "▛███▜"의 빠진 쿼드런트(아래 안쪽 두 점)
  base: [
    '000111111111111000',
    '000112111111211000',
    '011111111111111110',
    '000111111111111000',
    '000010100001010000',
  ],
  // 눈 감음 — 눈 쿼드런트를 몸통색으로 채운다 (깜박임 프레임)
  blink: [
    '000111111111111000',
    '000111111111111000',
    '011111111111111110',
    '000111111111111000',
    '000010100001010000',
  ],
  // look-left 포즈("▟███▟") — 눈이 윗행 왼쪽으로, 다리는 왼쪽으로 반칸 (스캐틀 A)
  lookLeft: [
    '000121111111211000',
    '000111111111111000',
    '011111111111111110',
    '000111111111111000',
    '000101000010100000',
  ],
  // look-right 포즈("▙███▙") — 눈이 윗행 오른쪽으로, 다리는 오른쪽으로 반칸 (스캐틀 B)
  lookRight: [
    '000112111111121000',
    '000111111111111000',
    '011111111111111110',
    '000111111111111000',
    '000001010000101000',
  ],
  // arms-up 포즈("▗▟…▙▖") — 옆구리 팔이 머리 옆까지 올라온다 (권한 대기 alert)
  claws: [
    '000111111111111000',
    '011112111111211110',
    '001111111111111100',
    '000111111111111000',
    '000010100001010000',
  ],
  // 졸기 — 눈 감고 팔을 몸에 붙인다 (세션 없음/종료/연결 끊김/유저 무활동 sleep)
  doze: [
    '000111111111111000',
    '000111111111111000',
    '001111111111111100',
    '000111111111111000',
    '000010100001010000',
  ],
  // 저글링 A — 집게를 들고(claws 팔) 눈은 위-왼쪽 공을 쫓는다(lookLeft 눈).
  // 발은 base 그대로(제자리에서 팔만 바쁨).
  jugLeft: [
    '000121111111211000',
    '011111111111111110',
    '001111111111111100',
    '000111111111111000',
    '000010100001010000',
  ],
  // 저글링 B — 집게 든 채 눈은 위-오른쪽(lookRight 눈).
  jugRight: [
    '000112111111121000',
    '011111111111111110',
    '001111111111111100',
    '000111111111111000',
    '000010100001010000',
  ],
  // 독서 — 눈을 한 행 아래(팔 행)로 내려 손에 든 책을 내려다본다. 팔은 base 그대로.
  // idle 무작위 변주(레퍼런스 "Idle (random) — reading/patrol")의 정지 프레임이다.
  read: [
    '000111111111111000',
    '000111111111111000',
    '011112111111211110',
    '000111111111111000',
    '000010100001010000',
  ],
  // 쓸기 A — 압축(PreCompact) 중. base에서 다리만 왼쪽 반칸(빗자루를 미는 발놀림).
  // 몸통의 좌우 기울기는 프레임이 아니라 CSS(clawd-sway)가 만든다 — 팔 행까지 옮기면
  // 실루엣이 원본 아트에서 벗어난다.
  sweepLeft: [
    '000111111111111000',
    '000112111111211000',
    '011111111111111110',
    '000111111111111000',
    '000101000010100000',
  ],
  // 쓸기 B — 반대 발(다리 오른쪽 반칸).
  sweepRight: [
    '000111111111111000',
    '000112111111211000',
    '011111111111111110',
    '000111111111111000',
    '000001010000101000',
  ],
  // 나르기 A — worktree 생성 중. 집게를 들어(claws 팔) 상자를 이고 왼발을 내딛는다.
  // 상자 자체는 비트맵이 아니라 CSS 소품(.clawd-box)이다 — 0/1/2 규약을 지키기 위해서.
  carryLeft: [
    '000111111111111000',
    '011112111111211110',
    '001111111111111100',
    '000111111111111000',
    '000101000010100000',
  ],
  // 나르기 B — 오른발을 내딛는다(뒤뚱 걸음의 반대 위상).
  carryRight: [
    '000111111111111000',
    '011112111111211110',
    '001111111111111100',
    '000111111111111000',
    '000001010000101000',
  ],
};

// ----- 타이밍·상호작용 상수 (컴포넌트와 테스트가 공유) -----
export const CLAWD_SLEEP_MS = 60_000; // 유저 무활동 → 수면 (레퍼런스: 60s mouse idle)
export const CLAWD_REACT_MS = 2400; // happy/error 일회성 반응 지속 시간
export const CLAWD_NOTIFY_MS = 2400; // 알림(notify) 팝 지속 시간 — 반응과 별개로 조절 가능
// idle 무작위 독서(레퍼런스 "Idle (random)") — 이 구간에서 뽑은 지연 뒤 HOLD만큼 읽는다.
// 상한(40s)을 수면 문턱(60s)보다 낮게 둬 "읽다가 잠든다"는 순서가 항상 성립한다.
export const CLAWD_READ_MIN_MS = 20_000;
export const CLAWD_READ_MAX_MS = 40_000;
export const CLAWD_READ_HOLD_MS = 5000;
export const CLAWD_EYE_DEADZONE_PX = 48; // 눈 추적 데드존(마스코트 중심 기준 좌우)
export const CLAWD_POKE_DIZZY_COUNT = 4; // 연타 이스터에그 발동 클릭 수
export const CLAWD_POKE_DIZZY_WINDOW_MS = 1600; // 연타 판정 윈도우

/**
 * 세션 상태·WS 연결 상태 → 기본 무드.
 *   think = thinking (모델 응답 생성 중 — 말풍선)
 *   busy  = tool (도구 실행 중 — 두리번 스캐틀)
 *   alert = awaiting-permission (권한 응답 대기)
 *   doze  = 세션 없음('none')|exited|연결 끊김
 *   idle  = 그 외 (idle 등)
 */
export function clawdMood(status, conn) {
  if (conn !== 'open') return 'doze';
  switch (status) {
    case 'thinking':
      return 'think';
    case 'tool':
      return 'busy';
    case 'awaiting-permission':
      return 'alert';
    case 'exited':
    case 'none':
      return 'doze';
    default:
      return 'idle';
  }
}

/**
 * 기본 무드에 파생 신호·일시 상태를 합성한 표시 무드.
 *
 * transientSource가 우선순위를 가른다:
 *   'live' — 지금 막 일어난 일(알림 도착, 도구 실패). 작업 중에도 보여야 의미가 있다.
 *   'turn' — 턴이 끝난 뒤의 반응(축하·실패·압축 완료). 정의상 idle에서 일어나고, 새 턴이
 *            시작되면 작업 표시가 이긴다(축하 중 전송해도 think가 우선 — 기존 계약).
 *
 * 우선순위는 위에서 아래로:
 *
 *   doze   — 연결 없음/세션 없음. 다른 어떤 신호보다 앞선다(보여 줄 세션이 없다).
 *   alert  — 권한 응답 대기. 사용자의 응답이 있어야 무엇도 진행되지 않는다.
 *   carry  — worktree 생성 중(레퍼런스 WorktreeCreate). 열린 도구가 근거라 busy를 대체한다.
 *   sweep  — 컨텍스트 압축 중(레퍼런스 PreCompact). 압축은 턴 밖에서도 돌아 idle 위에도 얹힌다.
 *   live transient — 알림 도착(Notification)·도구 실패(PostToolUseFailure). 작업 중에도
 *            얹힌다 — 그러지 않으면 턴 내내 표시 기회가 없어 2.4s가 통째로 묻힌다.
 *   juggle — 서브에이전트 실행 중(busy 위에서만 — thinking은 결과를 '읽는' 중이라 제외).
 *   busy / think — 평소의 작업·생각.
 *   turn transient — 턴 종료 반응(happy/error)·압축 완료. idle 위에만 얹힌다.
 *   sleep  — 유저 무활동 CLAWD_SLEEP_MS 경과. read보다 앞선다(승인된 UX 결정).
 *   read   — idle 무작위 독서.
 */
export function clawdVisualMood({
  status,
  conn,
  transient = null,
  transientSource = 'turn',
  userIdleMs = 0,
  subagents = 0,
  compacting = false,
  carrying = false,
  reading = false,
}) {
  const base = clawdMood(status, conn);
  if (base === 'doze') return 'doze';
  if (base === 'alert') return 'alert';
  if (carrying) return 'carry';
  if (compacting) return 'sweep';
  if (transient && transientSource === 'live') return transient;
  if (base === 'busy') return subagents > 0 ? 'juggle' : 'busy';
  if (base === 'think') return 'think';
  if (transient) return transient; // 턴 종료 반응(source 'turn')
  if (userIdleMs >= CLAWD_SLEEP_MS) return 'sleep';
  if (reading) return 'read';
  return base;
}

// ----- 동시성 티어 (레퍼런스: working 1/2/3+ 세션, juggling 1/2+ 서브에이전트) -----
// 무드를 쪼개는 대신 같은 무드의 "강도"로 표현한다 — 프레임 간격과 CSS 클래스(tier-N)만
// 달라지고 프레임 자체는 공유하므로, 새 비트맵 없이 레퍼런스의 티어 구분을 담는다.
// tier 1은 반드시 종전 동작과 같아야 한다(단일 세션 회귀 방지 — codex 지적).
export function clawdTier(mood, { sessionsRunning = 0, subagents = 0 } = {}) {
  if (mood === 'juggle') return subagents >= 2 ? 2 : 1;
  if (mood === 'busy' || mood === 'think') {
    if (sessionsRunning >= 3) return 3;
    return sessionsRunning === 2 ? 2 : 1;
  }
  return 1;
}

// ----- 일회성 반응(transient) 중재 -----
// happy/error/notify는 슬롯 하나와 타이머 하나를 공유한다. 정책이 없으면 늦게 온 notice가
// 방금 띄운 error를 덮어 실패가 눈에 안 띈다(codex 지적) — 그래서 순위를 명시한다.
// 같은 순위끼리는 새 이벤트가 이겨 타이머를 다시 감는다(연속 알림이 갱신되도록).
const TRANSIENT_RANK = { notify: 1, happy: 2, error: 3 };

/** next가 current를 밀어내고 표시될 자격이 있는가. */
export function clawdTransientWins(current, next) {
  if (!next) return false;
  if (!current) return true;
  return (TRANSIENT_RANK[next] ?? 0) >= (TRANSIENT_RANK[current] ?? 0);
}

// ----- 파생 시각 신호 (messages 단일 패스) -----
// 레퍼런스의 agent event는 이 앱에 전용 이벤트로 오지 않는다 — 리듀서가 남긴 메시지
// 아이템의 모양이 곧 신호다. compacting/carrying/notice/압축완료를 각각 훑으면 스트리밍
// 델타마다 배열을 세 번 더 도는 셈이라(useMemo는 messages 참조가 매번 바뀌어 무력 —
// codex 지적) 한 번의 순회로 전부 모은다.
export const WORKTREE_TOOLS = new Set(['EnterWorktree']);

// 셸 한 줄에는 여러 명령이 들어온다(`cd x && git worktree add …`) — 구분자로 잘라
// 구간마다 본다. git 전역 옵션(`git -C dir worktree add`)도 통과시키고, add 뒤에
// **비-플래그 피연산자**(만들 경로)가 하나는 있어야 생성으로 친다 — 그러지 않으면
// `git worktree add --help`가 생성으로 오인된다(codex 지적).
// 한계는 남는다: 스크립트·별칭·따옴표 안의 문자열까지는 판별하지 않는다. 그런 경로는
// 전용 신호(EnterWorktree)에 맡긴다.
const GIT_WORKTREE_ADD = /\bgit\b(?:\s+-{1,2}[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+worktree\s+add\b(.*)$/;

function isWorktreeAddCommand(cmd) {
  for (const seg of String(cmd).split(/[\n;&|]+/)) {
    const m = GIT_WORKTREE_ADD.exec(seg);
    if (!m) continue;
    const rest = m[1];
    if (/(^|\s)--?h(elp)?(\s|$)/.test(rest)) continue;
    if (rest.trim().split(/\s+/).some((t) => t && !t.startsWith('-'))) return true;
  }
  return false;
}

/**
 * 이 도구 호출이 worktree를 만드는가. 전용 도구명(EnterWorktree)이 1차 신호지만 이
 * 저장소에서 수신 사례가 확인되지 않아(codex 지적) 영구 미발동이 되지 않도록,
 * 실제로 관측 가능한 `git worktree add` Bash 호출도 같은 신호로 받는다.
 */
export function isWorktreeTool(m) {
  if (!m) return false;
  if (WORKTREE_TOOLS.has(m.name)) return true;
  if (m.name !== 'Bash') return false;
  const cmd = m.input && typeof m.input.command === 'string' ? m.input.command : '';
  return isWorktreeAddCommand(cmd);
}

/**
 * messages → { compacting, compactionsDone, carrying, notices, toolErrors }.
 *   compacting      마지막 압축 카드가 진행 중인가 (sweep 무드의 근거)
 *   compactionsDone 완료된 압축 카드 수 — **증가분**이 PostCompact→attention(happy)이다.
 *                   boolean의 true→false로는 정상 완료와 취소(state:'canceled')를 구분할
 *                   수 없어 축하가 오발동한다(codex 지적).
 *   carrying        결과 미도착 worktree 생성 도구가 있는가 (carry 무드의 근거)
 *   notices         notice 아이템 수 — **증가분**이 Notification→notify다.
 *   toolErrors      실패로 끝난 도구 호출 수 — **증가분**이 PostToolUseFailure→error다.
 *                   턴 전체의 실패(result.is_error)만 보면 도구 하나가 실패하고 모델이
 *                   복구한 경우가 통째로 누락된다(codex 지적).
 */
export function clawdSignals(messages) {
  let compacting = false;
  let compactionsDone = 0;
  let carrying = false;
  let notices = 0;
  let toolErrors = 0;
  for (const m of messages ?? []) {
    if (m.kind === 'compaction') {
      // 마지막 카드가 현재 상태 — running 뒤에 done/canceled가 오면 그것이 이긴다.
      compacting = m.state === 'running';
      if (m.state === 'done') compactionsDone++;
    } else if (m.kind === 'notice') {
      notices++;
    } else if (m.kind === 'tool_use') {
      if (!m.streaming && m.result == null) {
        if (isWorktreeTool(m)) carrying = true;
      } else if (m.result && m.result.isError) {
        toolErrors++;
      }
    }
  }
  return { compacting, compactionsDone, carrying, notices, toolErrors };
}

/** 진행 중(thinking|tool)인 세션 수 — busy 티어의 근거. Map·배열 모두 받는다. */
export function runningSessionCount(sessions) {
  const it = sessions && typeof sessions.values === 'function' ? sessions.values() : sessions;
  let n = 0;
  for (const s of it ?? []) {
    if (s && (s.status === 'thinking' || s.status === 'tool')) n++;
  }
  return n;
}

/**
 * 상태 전이 → 턴 종료 일회성 반응. 진행 중(thinking|tool|awaiting-permission)에서
 * idle로 돌아온 순간만 턴 종료다(reduceResult가 status를 idle로 되돌린다).
 * 세션 전환으로 인한 status 변화는 호출측(sessionKey 비교)이 걸러야 한다.
 * 사용자가 직접 중단한 턴(interrupted — 인터럽트도 is_error result로 끝난다)은
 * 실패 연출이 어울리지 않으므로 무반응(null)이다 (DA #24).
 */
export function clawdTurnEnd(prevStatus, nextStatus, lastResult, interrupted = false) {
  if (nextStatus !== 'idle') return null;
  if (prevStatus !== 'thinking' && prevStatus !== 'tool' && prevStatus !== 'awaiting-permission') {
    return null;
  }
  if (interrupted) return null;
  return lastResult && lastResult.isError ? 'error' : 'happy';
}

/** 커서 X 오프셋(px, 마스코트 중심 기준) → idle 눈 추적 프레임(레거시 3프레임 방식). */
export function eyeFrameFor(dx) {
  if (Math.abs(dx) <= CLAWD_EYE_DEADZONE_PX) return 'base';
  return dx < 0 ? 'lookLeft' : 'lookRight';
}

// 연속 눈 추적(idle/think) — 3프레임(좌/정면/우) 대신 눈 픽셀 그룹을 커서 방향으로
// 조금씩 밀어 "더 많은 각도"를 부드럽게 따라가게 한다. 오프셋 단위는 SVG viewBox
// 좌표(가로 1열, 세로는 CLAWD_PIXEL_ASPECT로 이미 2배 스케일된 값).
export const CLAWD_EYE_MAX_X = 1.7; // 최대 수평 이동(열)
export const CLAWD_EYE_MAX_Y = 1.9; // 최대 수직 이동(스케일된 행 단위)
export const CLAWD_EYE_RANGE_PX = 240; // 이 거리(px)에서 최대 이동에 도달

/**
 * 마스코트 중심 기준 커서 벡터(dx,dy px) → 눈 그룹 translate 오프셋(viewBox 단위).
 * 방향은 커서 각도를 그대로 따르고(2D), 크기는 거리에 비례하되 CLAWD_EYE_RANGE_PX에서
 * 포화한다. 커서가 중심에 있으면 {0,0}(정면).
 */
export function eyeOffsetFor(dx, dy, rangePx = CLAWD_EYE_RANGE_PX) {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) return { ex: 0, ey: 0 };
  const mag = Math.min(1, dist / rangePx);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    ex: round((dx / dist) * mag * CLAWD_EYE_MAX_X),
    ey: round((dy / dist) * mag * CLAWD_EYE_MAX_Y),
  };
}

// 서브에이전트 도구 판정·목록의 소유자는 subagents.js — 여기서는 호환 재수출만.
export { SUBAGENT_TOOLS } from './subagents.js';

/** 실행 중(결과 미도착·입력 확정)인 서브에이전트 도구 수 — juggle 판정용 래퍼. */
export function openSubagentCount(messages) {
  return openSubagents(messages).length;
}
