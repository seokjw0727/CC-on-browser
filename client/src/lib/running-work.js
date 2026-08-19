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
 * @returns {Array<{key, kind, icon, label, detail, uid, toolUseId}>}
 *   uid: 대화 속 해당 메시지의 uid (점프 대상). 못 찾으면 null — 그때는 클릭 불가.
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
  // tool_use_id -> uid 역인덱스(점프 대상 찾기용). 프리로드 여부는 따지지 않는다 —
  // 스냅샷이 "돌고 있다"고 한 작업의 카드는 어디에 있든 보여 줘야 한다.
  const uidByToolUseId = new Map();
  for (const m of messages) {
    if (m.kind === 'tool_use' && m.toolUseId != null && !uidByToolUseId.has(m.toolUseId)) {
      uidByToolUseId.set(m.toolUseId, m.uid ?? null);
    }
  }
  for (const t of session.backgroundTasks ?? []) {
    if (!t || typeof t.task_id !== 'string') continue;
    const toolUseId = taskToolUseIds[t.task_id] ?? null;
    out.push({
      key: `bg-${t.task_id}`,
      kind: 'background',
      icon: t.task_type === 'local_agent' ? 'bot' : 'command',
      label: String(t.description ?? '').trim() || t.task_id,
      detail: TASK_KIND_LABEL[t.task_type] ?? '백그라운드 작업',
      uid: toolUseId != null ? uidByToolUseId.get(toolUseId) ?? null : null,
      toolUseId,
    });
  }

  // ② 전경 서브에이전트 — 기존 파생 로직을 그대로 쓴다.
  //    백그라운드로 이미 올라온 것과 겹치지 않게 tool_use_id로 걸러 낸다.
  const bgToolUseIds = new Set(out.map((o) => o.toolUseId).filter((v) => v != null));
  for (const s of openSubagents(live)) {
    if (s.toolUseId != null && bgToolUseIds.has(s.toolUseId)) continue;
    out.push({
      key: s.key,
      kind: 'subagent',
      icon: 'bot',
      label: s.label,
      detail: s.subagentType || '서브에이전트',
      uid: s.uid ?? null,
      toolUseId: s.toolUseId,
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
    });
  }

  return out;
}
