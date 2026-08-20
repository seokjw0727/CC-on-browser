// 실행 중 작업 도크의 단일 셀렉터 — 입력창 아래 "지금 돌고 있는 것" 목록을 만든다.
//
// 출처가 셋이고, 각각 성격이 다르다:
//   ① 백그라운드 작업 (session.backgroundTasks)
//      CLI의 system/background_tasks_changed 스냅샷 그대로. 셸(local_bash)과
//      에이전트(local_agent)가 같은 이벤트를 탄다. 여기엔 휴리스틱이 없다 —
//      CLI가 "지금 이것들이 돌고 있다"고 직접 말해 준다.
//   ② 전경 서브에이전트 (subagents.js:openSubagents)
//      Task/Agent tool_use가 열려 있고 결과가 아직 없는 것. 기존 로직 재사용.
//   ③ 전경 셸 — Bash tool_use가 열려 있고 결과가 아직 없는 것.
//
// ②③은 "결과가 없으면 실행 중"이라는 규칙이라, 재개 트랜스크립트에서 중단된 채
// 끝난 도구가 유령으로 남을 수 있다. 그래서 프리로드로 시딩된 메시지(preloaded)는
// 제외한다. ①은 스냅샷이라 그런 문제가 없다(새 CLI 프로세스는 빈 목록으로 시작).
import { openSubagents, SUBAGENT_TOOLS } from './subagents.js';

/** 백그라운드 작업 종류 → 표시 라벨. */
const TASK_KIND_LABEL = {
  local_bash: '백그라운드 셸',
  local_agent: '백그라운드 에이전트',
};

/** 상세 패널 미니 트랜스크립트의 기본 표시 개수. 인자로 덮을 수 있게 열어 둔다(테스트). */
export const DETAIL_STEPS = 8;
/** 한 줄 프리뷰 최대 길이 — 도크 폭(입력창 폭)에서 두 줄로 접히지 않는 선. */
const PREVIEW_MAX = 80;

// at은 reducer의 **선택** 필드다(reduce-cli-event.js — at != null일 때만 실린다).
// 없으면 null로 두고 컴포넌트가 경과 표시를 통째로 생략한다. 0/NaN을 시각으로
// 오해해 "1970년"이나 "NaN분 전"을 그리지 않도록 isFinite로 건다.
const atOf = (m) => (m && Number.isFinite(m.at) ? m.at : null);

const trimOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// 도크 항목이 들고 다닐 입력 요약. 라벨(shellLabel)은 첫 줄만 쓰지만 상세 패널은
// 명령 **전문**을 보여 줘야 하므로 여기서는 자르지 않는다. 두 번째 인자는 백그라운드
// 스냅샷 항목 — tool_use 링크가 아직 없어도 description만은 살릴 수 있다.
function inputSummary(msg, task = null) {
  const inp = msg && msg.input && typeof msg.input === 'object' ? msg.input : null;
  return {
    command: inp ? trimOrNull(inp.command) : null,
    description:
      (inp ? trimOrNull(inp.description) : null) ?? (task ? trimOrNull(task.description) : null),
    prompt: inp ? trimOrNull(inp.prompt) : null,
    subagentType: inp ? trimOrNull(inp.subagent_type) : null,
  };
}

/** 도구 이름 → 도크에서 쓸 짧은 활동 문구. */
function shellLabel(item) {
  const cmd = item.input && typeof item.input.command === 'string' ? item.input.command : '';
  const first = cmd.trim().split('\n', 1)[0].trim();
  if (first) return first;
  const desc = item.input && typeof item.input.description === 'string'
    ? item.input.description.trim()
    : '';
  return desc || item.name || 'Bash';
}

/**
 * 실행 중 작업 목록. 순서는 "백그라운드 → 전경"으로 고정한다 —
 * 백그라운드는 턴을 넘겨 살아 있고 전경은 이 턴에만 있으므로, 오래 가는 것이 위로 온다.
 *
 * @param {object} session
 * @returns {Array<{key, kind, icon, label, detail, uid, toolUseId, taskId, taskType,
 *                  startedAt: number|null,
 *                  activity: {state: string, toolName?: string|null}|null,
 *                  input: {command, description, prompt, subagentType}}>}
 *   uid: 대화 속 해당 메시지의 uid (점프 대상). 못 찾으면 null — 그때는 상세 패널의
 *   "대화에서 보기"만 비활성이고, 항목 자체는 여전히 펼쳐 볼 수 있다.
 */
export function openWork(session) {
  if (!session) return [];
  // 종료된 세션에는 실행 중인 것이 없다. backgroundTasks만 비우면 같은 도구가
  // ②③의 "결과 없는 tool_use = 실행 중" 규칙에 걸려 전경 항목으로 되살아난다
  // (result 없이 끝난 종료에서 실제로 재현 — codex 지적). 여기서 한 번에 막는다.
  if (session.status === 'exited') return [];
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const live = messages.filter((m) => !m.preloaded);
  const out = [];

  // ① 백그라운드 — CLI 스냅샷이 권위
  const taskToolUseIds = session.taskToolUseIds ?? {};
  // tool_use_id -> 그 도구의 첫 메시지. uid(점프 대상)뿐 아니라 시작 시각(at)과 입력
  // 전문이 전부 여기서 나오므로 uid만 뽑지 않고 메시지째 들고 있는다. 프리로드 여부는
  // 따지지 않는다 — 스냅샷이 "돌고 있다"고 한 작업의 카드는 어디에 있든 보여 줘야 한다.
  const msgByToolUseId = new Map();
  // uid 역인덱스는 toolUseId가 없는 도구를 위한 폴백이다 — CLI가 id를 싣지 않은
  // tool_use도 uid는 갖고 있어, 이게 없으면 그 항목만 설명·프롬프트·시작 시각이
  // 통째로 빈 상세 패널이 된다.
  const msgByUid = new Map();
  for (const m of messages) {
    if (m.kind !== 'tool_use') continue;
    if (m.toolUseId != null && !msgByToolUseId.has(m.toolUseId)) msgByToolUseId.set(m.toolUseId, m);
    if (m.uid != null && !msgByUid.has(m.uid)) msgByUid.set(m.uid, m);
  }
  /** 도크 항목이 가리키는 원본 tool_use 메시지 — toolUseId 우선, 없으면 uid로. */
  const linkOf = (toolUseId, uid) =>
    (toolUseId != null ? msgByToolUseId.get(toolUseId) ?? null : null)
    ?? (uid != null ? msgByUid.get(uid) ?? null : null);
  for (const t of session.backgroundTasks ?? []) {
    if (!t || typeof t.task_id !== 'string') continue;
    const toolUseId = taskToolUseIds[t.task_id] ?? null;
    const link = linkOf(toolUseId, null);
    out.push({
      key: `bg-${t.task_id}`,
      kind: 'background',
      icon: t.task_type === 'local_agent' ? 'bot' : 'command',
      label: String(t.description ?? '').trim() || t.task_id,
      detail: TASK_KIND_LABEL[t.task_type] ?? '백그라운드 작업',
      uid: link?.uid ?? null,
      toolUseId,
      taskId: t.task_id,
      taskType: typeof t.task_type === 'string' ? t.task_type : null,
      startedAt: atOf(link), // 링크(task_started)가 아직 없으면 null — 경과 표시 생략
      activity: null, // 백그라운드는 CLI가 진행 상태를 주지 않는다(설계도 범위 밖)
      input: inputSummary(link, t),
    });
  }

  // ② 전경 서브에이전트 — 기존 파생 로직을 그대로 쓴다.
  //    백그라운드로 이미 올라온 것과 겹치지 않게 tool_use_id로 걸러 낸다.
  const bgToolUseIds = new Set(out.map((o) => o.toolUseId).filter((v) => v != null));
  for (const s of openSubagents(live)) {
    if (s.toolUseId != null && bgToolUseIds.has(s.toolUseId)) continue;
    const link = linkOf(s.toolUseId, s.uid);
    out.push({
      key: s.key,
      kind: 'subagent',
      icon: 'bot',
      label: s.label,
      detail: s.subagentType || '서브에이전트',
      uid: s.uid ?? null,
      toolUseId: s.toolUseId,
      taskId: null,
      taskType: null,
      startedAt: atOf(link),
      // 활동 상태는 subagents.js가 이미 파생한다(마지막 자식 기준) — 여기서 휴리스틱을
      // 새로 만들면 도크 행과 상세 패널이 서로 다른 말을 하게 된다.
      activity: s.activity ?? null,
      input: inputSummary(link),
    });
  }

  // ③ 전경 셸 — 결과가 아직 없는 Bash. 서브에이전트 소속(parentToolUseId)도 포함한다:
  //    사용자 입장에서는 그것도 "지금 돌고 있는 셸"이다.
  for (const m of live) {
    if (m.kind !== 'tool_use' || m.streaming || m.result != null) continue;
    if (SUBAGENT_TOOLS.has(m.name)) continue; // ②가 담당
    if (m.name !== 'Bash') continue;
    if (m.toolUseId != null && bgToolUseIds.has(m.toolUseId)) continue;
    out.push({
      key: `fg-${m.uid ?? m.toolUseId}`,
      kind: 'shell',
      icon: 'command',
      label: shellLabel(m),
      detail: '실행 중',
      uid: m.uid ?? null,
      toolUseId: m.toolUseId ?? null,
      taskId: null,
      taskType: null,
      startedAt: atOf(m),
      activity: null,
      input: inputSummary(m),
    });
  }

  return out;
}

// ----- 상세 패널(아코디언) 셀렉터 -----
// 자식 메시지 한 줄 요약의 본문은 kind마다 실리는 필드가 다르다(text/thinking/input).
// 여기서 한 번에 흡수하지 않으면 컴포넌트가 kind 분기를 또 갖게 되고, 그 분기는
// node --test가 지켜 주지 못한다.
const STEP_KIND_LABEL = {
  'assistant-text': '응답',
  thinking: '사고',
  tool_use: '도구',
  'user-text': '입력',
  notice: '알림',
  'command-output': '출력',
};

// 줄바꿈·연속 공백을 한 칸으로 접는다 — 여러 줄 텍스트가 그대로 들어오면 ellipsis가
// 첫 줄만 보여 주는 게 아니라 행 높이가 통째로 튄다.
function firstLine(v, max = PREVIEW_MAX) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 도구 입력에서 "무엇을 하는지"가 드러나는 첫 필드. 도구마다 이름이 달라 순서로 본다.
const TOOL_ARG_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'description', 'prompt'];
function toolArgPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of TOOL_ARG_KEYS) {
    const hit = trimOrNull(input[k]);
    if (hit) return firstLine(hit);
  }
  return '';
}

// null이면 미니 트랜스크립트에 보일 것이 없는 종류(usage·raw·compaction 등).
function stepBody(m) {
  switch (m.kind) {
    case 'assistant-text':
      return { text: firstLine(m.text), tool: null };
    case 'thinking':
      return { text: firstLine(m.thinking), tool: null };
    // 인자가 비어도 행을 남긴다 — 도구 이름 자체가 정보다.
    case 'tool_use':
      return { text: toolArgPreview(m.input), tool: m.name || '도구' };
    case 'user-text':
    case 'notice':
    case 'command-output':
      return { text: firstLine(m.text), tool: null };
    default:
      return null;
  }
}

/**
 * 도크 항목 하나의 상세. **렌더마다 호출**되는 것을 전제로 만든 순수 파생이다
 * (메모이즈하면 서브에이전트가 한 걸음 나아가도 패널이 옛 화면에 멈춘다).
 *
 * 자식 수집 조건은 kind로 분기하지 않는다: parentToolUseId === item.toolUseId 규칙은
 * 셸·백그라운드에서 자연히 빈 배열이 되므로, 분기를 두면 백그라운드로 승격된
 * 서브에이전트만 조용히 빈 패널이 되는 사고가 난다.
 * 자식은 live(비프리로드)가 아니라 messages 전체에서 찾는다 — 항목이 이미 유령
 * 필터를 통과했으므로, 재개 뒤 이어 도는 작업의 앞부분을 지울 이유가 없다.
 *
 * @returns {null | {
 *   kind: 'background'|'subagent'|'shell',
 *   startedAt: number|null, uid: string|null, toolUseId: string|null,
 *   activity: {state: string, toolName?: string|null} | null,
 *   description: string|null, command: string|null, prompt: string|null,
 *   subagentType: string|null,
 *   task: {id: string|null, type: string|null, label: string|null} | null,
 *   steps: Array<{uid, kind, kindLabel, tool, text, done}>, stepsTotal: number,
 * }}
 */
export function workDetail(session, item, limit = DETAIL_STEPS) {
  if (!session || !item) return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const inp = item.input ?? { command: null, description: null, prompt: null, subagentType: null };
  const steps = [];
  let stepsTotal = 0;
  if (item.toolUseId != null) {
    for (const m of messages) {
      if (m.parentToolUseId !== item.toolUseId) continue; // 본선(null)은 자연히 제외
      const body = stepBody(m);
      if (!body) continue;
      stepsTotal += 1;
      steps.push({
        uid: m.uid ?? null,
        kind: m.kind,
        kindLabel: STEP_KIND_LABEL[m.kind] ?? m.kind,
        tool: body.tool,
        text: body.text,
        done: m.kind === 'tool_use' ? m.result != null : !m.streaming,
      });
    }
  }
  const n = Number.isFinite(limit) && limit > 0 ? limit : DETAIL_STEPS;
  return {
    kind: item.kind,
    startedAt: item.startedAt ?? null,
    uid: item.uid ?? null,
    toolUseId: item.toolUseId ?? null,
    activity: item.activity ?? null,
    description: inp.description,
    command: inp.command,
    prompt: inp.prompt,
    subagentType: inp.subagentType,
    task:
      item.kind === 'background'
        ? {
            id: item.taskId ?? null,
            type: item.taskType ?? null,
            label: TASK_KIND_LABEL[item.taskType] ?? null,
          }
        : null,
    // 최근 n개 = 배열 꼬리. stepsTotal은 자르기 **전** 개수라 "이전 N단계 생략" 안내가 가능하다.
    steps: steps.length > n ? steps.slice(steps.length - n) : steps,
    stepsTotal,
  };
}
