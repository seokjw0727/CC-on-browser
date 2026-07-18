// 실행 중 서브에이전트 세션 파생 셀렉터 (설계도 running-subagents-panel).
// 서브에이전트는 전용 이벤트가 아니라 "Task/Agent tool_use 열림 → tool_result 도착"
// 시퀀스로만 노출되므로, store 상태 필드 없이 항상 messages에서 파생한다.
// 고아(인터럽트/크래시)는 턴 종료가 합성 결과로 닫아 주므로(reduce-cli-event
// reduceResult) result==null 판정만으로 목록도 자동 소멸한다.

// 서브에이전트를 스폰하는 도구 이름의 단일 소유자 — CLI v2.1.x는 'Task'
// (구명 병기 'Agent'도 수용). clawd.js는 여기서 재수출한다.
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

// activity.state → 사람이 읽는 라벨. 컴포넌트가 아닌 여기 두어 node --test로 고정한다.
const ACTIVITY_LABEL = {
  starting: '시작 중',
  thinking: '생각 중',
  'receiving-input': '입력 수신 중',
  responding: '응답 작성 중',
  working: '작업 중',
};

/** activity {state, toolName?} → 표시 문자열. */
export function activityLabel(activity) {
  if (!activity) return ACTIVITY_LABEL.working;
  if (activity.state === 'tool') return `${activity.toolName || '도구'} 실행 중`;
  return ACTIVITY_LABEL[activity.state] ?? ACTIVITY_LABEL.working;
}

/**
 * 패널 표시 게이트 — 재개(preload) 직후 죽은 Task가 "실행 중"으로 보이는 유령 방지.
 * 프리로드 세션은 idle로 시작하므로 진행 중 상태에서만 렌더한다.
 */
export function panelVisible(status, count) {
  return (
    count > 0 &&
    (status === 'thinking' || status === 'tool' || status === 'awaiting-permission')
  );
}

// 서브에이전트의 마지막 자식 아이템 → 현재 활동. 마지막 아이템 기준 휴리스틱:
// 완료된 항목이면 '작업 중'(다음 스텝 준비)으로 뭉뚱그린다.
function deriveActivity(last) {
  if (!last) return { state: 'starting' };
  switch (last.kind) {
    case 'thinking':
      // 확정된 thinking도 '생각 중' — 다음 블록 도착 전까지는 사고 구간이 맞다(설계도 §2).
      return { state: 'thinking' };
    case 'tool_use':
      if (last.streaming) return { state: 'receiving-input' };
      if (last.result == null) return { state: 'tool', toolName: last.name || null };
      return { state: 'working' };
    case 'assistant-text':
      return last.streaming ? { state: 'responding' } : { state: 'working' };
    default:
      return { state: 'working' };
  }
}

// input.prompt 첫 줄 (description 부재 시 라벨 fallback용).
function promptPreview(input) {
  const p = input && typeof input.prompt === 'string' ? input.prompt : '';
  const line = p.trim().split('\n', 1)[0].trim();
  return line || null;
}

/**
 * 실행 중 서브에이전트 목록 — 재배치 없는 평면 목록(메시지 순서 유지).
 * 반환 항목: { key, toolUseId, name, description, subagentType, label,
 *             parentToolUseId, depth, activity }
 *   - key: uid 기반 — toolUseId가 null이거나 중복(프로토콜 위반)이어도 React 키 안전.
 *   - depth: 부모 toolUseId가 이 목록에 함께 있으면 1(중첩 들여쓰기), 그 외 0.
 *   - label: description → prompt 첫 줄 → 도구명 순 fallback.
 *   - activity: 해당 서브에이전트 소속(parentToolUseId 일치) 마지막 아이템에서 파생.
 *     toolUseId==null이면 매핑 생략(본선 parentToolUseId===null 아이템 오인 방지).
 *     중복 toolUseId는 활동이 양쪽에 동일 표시될 수 있다(attachToolResult와 같은
 *     수준의 한계로 허용).
 */
export function openSubagents(messages) {
  const open = [];
  const lastChild = new Map(); // parentToolUseId → 마지막 소속 아이템
  for (const m of messages ?? []) {
    if (m.kind === 'tool_use' && !m.streaming && m.result == null && SUBAGENT_TOOLS.has(m.name)) {
      open.push(m);
    }
    if (m.parentToolUseId != null) lastChild.set(m.parentToolUseId, m);
  }
  const openIds = new Set(open.map((m) => m.toolUseId).filter((id) => id != null));
  return open.map((m) => {
    const toolUseId = m.toolUseId ?? null;
    const description =
      m.input && typeof m.input.description === 'string' && m.input.description.trim()
        ? m.input.description.trim()
        : null;
    return {
      key: `sub-${m.uid ?? `${m.msgId}:${m.blockIndex}`}`,
      toolUseId,
      name: m.name || 'Task',
      description,
      subagentType:
        m.input && typeof m.input.subagent_type === 'string' && m.input.subagent_type
          ? m.input.subagent_type
          : null,
      label: description ?? promptPreview(m.input) ?? m.name ?? 'Task',
      parentToolUseId: m.parentToolUseId ?? null,
      depth: m.parentToolUseId != null && openIds.has(m.parentToolUseId) ? 1 : 0,
      activity: toolUseId == null ? { state: 'starting' } : deriveActivity(lastChild.get(toolUseId)),
    };
  });
}
