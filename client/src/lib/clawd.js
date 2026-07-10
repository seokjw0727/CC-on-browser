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
// 무드 어휘는 clawd-on-desk(github rullerzhou-afk)의 state-mapping.md를 축소
// 이식한 것: thinking→think(말풍선)/tool→busy(두리번 스캐틀)/서브에이전트→juggle/
// 턴 종료→happy·error(일회성)/유저 60s 무활동→sleep(눈 추적·zzz는 CSS·JS).
//
// 비트 문자: '0' 투명, '1' 몸통(주황), '2' 눈(검정).
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
};

// ----- 타이밍·상호작용 상수 (컴포넌트와 테스트가 공유) -----
export const CLAWD_SLEEP_MS = 60_000; // 유저 무활동 → 수면 (레퍼런스: 60s mouse idle)
export const CLAWD_REACT_MS = 2400; // happy/error 일회성 반응 지속 시간
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
 * 기본 무드에 일시 상태를 합성한 표시 무드.
 *   - transient('happy'|'error')는 idle 위에만 얹힌다 — 새 턴이 시작되면
 *     think/busy가 즉시 이긴다(축하 중 전송해도 작업 표시가 우선).
 *   - sleep은 idle에서 유저 무활동 CLAWD_SLEEP_MS 경과 시.
 *   - juggle은 busy(도구 실행 중)에서 서브에이전트(Task/Agent 도구) 실행 중일 때.
 *     thinking엔 얹지 않는다 — 서브에이전트 결과를 읽는 중은 '생각'이 맞다.
 */
export function clawdVisualMood({
  status,
  conn,
  transient = null,
  userIdleMs = 0,
  subagents = 0,
}) {
  const base = clawdMood(status, conn);
  if (base === 'idle' && transient) return transient;
  if (base === 'idle' && userIdleMs >= CLAWD_SLEEP_MS) return 'sleep';
  if (base === 'busy' && subagents > 0) return 'juggle';
  return base;
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

/** 커서 X 오프셋(px, 마스코트 중심 기준) → idle 눈 추적 프레임. */
export function eyeFrameFor(dx) {
  if (Math.abs(dx) <= CLAWD_EYE_DEADZONE_PX) return 'base';
  return dx < 0 ? 'lookLeft' : 'lookRight';
}

// 서브에이전트를 스폰하는 도구 이름 — CLI v2.1.x는 'Task'(구명 병기 'Agent'도 수용).
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** 실행 중(결과 미도착·입력 확정)인 서브에이전트 도구 수 — juggle 판정용. */
export function openSubagentCount(messages) {
  let n = 0;
  for (const m of messages ?? []) {
    if (m.kind === 'tool_use' && !m.streaming && m.result == null && SUBAGENT_TOOLS.has(m.name)) {
      n += 1;
    }
  }
  return n;
}
