// openSubagents 셀렉터 + activityLabel/panelVisible 순수 함수 테스트
// (설계도 running-subagents-panel §2). handcrafted 메시지와 reduceCliEvent
// 실제 이벤트 연쇄 양쪽으로 고정한다 — 필드명 드리프트 감지선.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBAGENT_TOOLS,
  openSubagents,
  activityLabel,
  panelVisible,
} from '../src/lib/subagents.js';
import { openSubagentCount } from '../src/lib/clawd.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';

const tool = (name, extra = {}) => ({
  uid: extra.uid ?? `u_${Math.random().toString(36).slice(2, 8)}`,
  kind: 'tool_use',
  name,
  toolUseId: extra.toolUseId ?? null,
  input: null,
  streaming: false,
  result: null,
  parentToolUseId: null,
  ...extra,
});

test('openSubagents: 결과 미도착·입력 확정된 Task/Agent만 목록에 오른다', () => {
  const messages = [
    { kind: 'user-text', text: 'go' },
    tool('Task', { toolUseId: 't1', input: { description: '버그 조사', subagent_type: 'Explore' } }),
    tool('Agent', { toolUseId: 't2' }), // 구명 병기
    tool('Task', { toolUseId: 't3', result: { content: 'done', isError: false } }), // 완료 → 제외
    tool('Task', { toolUseId: 't4', streaming: true }), // 입력 미확정 → 제외
    tool('Bash', { toolUseId: 't5' }), // 서브에이전트 아님 → 제외
  ];
  const list = openSubagents(messages);
  assert.deepEqual(list.map((s) => s.toolUseId), ['t1', 't2']);
  assert.equal(list[0].description, '버그 조사');
  assert.equal(list[0].subagentType, 'Explore');
  assert.equal(list[0].label, '버그 조사');
  assert.equal(list[1].description, null);
  assert.equal(list[1].subagentType, null);
  // 빈/비정상 입력에도 안전
  assert.deepEqual(openSubagents([]), []);
  assert.deepEqual(openSubagents(undefined), []);
});

test('openSubagents: label fallback은 description → prompt 첫 줄 → 도구명 순', () => {
  const byPrompt = openSubagents([
    tool('Task', { toolUseId: 'p1', input: { prompt: '  첫 줄 요약\n둘째 줄 상세' } }),
  ])[0];
  assert.equal(byPrompt.label, '첫 줄 요약');
  const byName = openSubagents([tool('Agent', { toolUseId: 'p2', input: {} })])[0];
  assert.equal(byName.label, 'Agent');
  // 공백뿐인 description은 없는 것으로 취급
  const blankDesc = openSubagents([
    tool('Task', { toolUseId: 'p3', input: { description: '   ', prompt: '실제 라벨' } }),
  ])[0];
  assert.equal(blankDesc.description, null);
  assert.equal(blankDesc.label, '실제 라벨');
});

test('openSubagents: null toolUseId — 활동 매핑 생략(본선 아이템 오인 방지), key는 uid 기반 유일', () => {
  const messages = [
    tool('Task', { uid: 'm1', toolUseId: null }),
    tool('Task', { uid: 'm2', toolUseId: null }),
    // 본선(parentToolUseId===null) 아이템 — null ID 에이전트의 활동으로 오인되면 안 된다
    { kind: 'assistant-text', text: '본선 텍스트', streaming: true, parentToolUseId: null },
  ];
  const list = openSubagents(messages);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.activity), [{ state: 'starting' }, { state: 'starting' }]);
  assert.equal(new Set(list.map((s) => s.key)).size, 2, 'React key 충돌 없음');
  // toolUseId 필드 자체가 없는 아이템도 null과 동일 취급
  const noField = openSubagents([
    { uid: 'm3', kind: 'tool_use', name: 'Task', input: null, streaming: false, result: null },
  ]);
  assert.equal(noField.length, 1);
  assert.equal(noField[0].toolUseId, null);
  assert.deepEqual(noField[0].activity, { state: 'starting' });
});

test('openSubagents: depth — 부모가 목록에 함께 있을 때만 1(중첩 들여쓰기), 재배치 없음', () => {
  const parentOpen = [
    tool('Task', { toolUseId: 'outer' }),
    tool('Task', { toolUseId: 'inner', parentToolUseId: 'outer' }),
  ];
  assert.deepEqual(openSubagents(parentOpen).map((s) => [s.toolUseId, s.depth]), [
    ['outer', 0],
    ['inner', 1],
  ]);
  // 부모가 이미 닫혔으면(목록 밖) 들여쓰지 않는다
  const parentClosed = [
    tool('Task', { toolUseId: 'outer', result: { content: 'x', isError: false } }),
    tool('Task', { toolUseId: 'inner', parentToolUseId: 'outer' }),
  ];
  assert.deepEqual(openSubagents(parentClosed).map((s) => [s.toolUseId, s.depth]), [
    ['inner', 0],
  ]);
  // 부모 ID가 목록·메시지 어디에도 없으면 depth 0
  const parentMissing = openSubagents([
    tool('Task', { toolUseId: 'inner', parentToolUseId: 'ghost' }),
  ]);
  assert.deepEqual(parentMissing.map((s) => [s.toolUseId, s.depth]), [['inner', 0]]);
  // 재배치 없음: 부모-자식 사이에 무관한 Task가 끼어도 메시지 순서 그대로
  // (트리 재구성 구현이면 child가 parent 바로 뒤로 끌려온다)
  const interleaved = [
    tool('Task', { toolUseId: 'A' }),
    tool('Task', { toolUseId: 'C' }),
    tool('Task', { toolUseId: 'B', parentToolUseId: 'A' }),
  ];
  assert.deepEqual(openSubagents(interleaved).map((s) => [s.toolUseId, s.depth]), [
    ['A', 0],
    ['C', 0],
    ['B', 1],
  ]);
});

test('openSubagents: 활동 파생 — 마지막 소속 아이템 기준, parent 간 격리', () => {
  const base = [
    tool('Task', { toolUseId: 'a' }),
    tool('Task', { toolUseId: 'b' }),
  ];
  // a는 Bash 실행 중, b는 자식 없음 → 시작 중
  const withChild = [
    ...base,
    tool('Bash', { toolUseId: 'c1', parentToolUseId: 'a' }),
  ];
  let [a, b] = openSubagents(withChild);
  assert.deepEqual(a.activity, { state: 'tool', toolName: 'Bash' });
  assert.deepEqual(b.activity, { state: 'starting' });
  // 자식 도구가 완료되면 '작업 중', b는 여전히 격리
  const childDone = [
    ...base,
    tool('Bash', { toolUseId: 'c1', parentToolUseId: 'a', result: { content: '', isError: false } }),
  ];
  [a, b] = openSubagents(childDone);
  assert.deepEqual(a.activity, { state: 'working' });
  assert.deepEqual(b.activity, { state: 'starting' });
  // thinking은 streaming 여부와 무관하게 '생각 중'
  for (const streaming of [true, false]) {
    const [x] = openSubagents([
      tool('Task', { toolUseId: 'a' }),
      { kind: 'thinking', thinking: '…', streaming, parentToolUseId: 'a' },
    ]);
    assert.deepEqual(x.activity, { state: 'thinking' });
  }
  // 스트리밍 텍스트 → 응답 작성 중, 확정 텍스트 → 작업 중
  const [st] = openSubagents([
    tool('Task', { toolUseId: 'a' }),
    { kind: 'assistant-text', text: '…', streaming: true, parentToolUseId: 'a' },
  ]);
  assert.deepEqual(st.activity, { state: 'responding' });
  const [ct] = openSubagents([
    tool('Task', { toolUseId: 'a' }),
    { kind: 'assistant-text', text: '끝', streaming: false, parentToolUseId: 'a' },
  ]);
  assert.deepEqual(ct.activity, { state: 'working' });
  // 미지원 kind(예: notice)가 마지막이면 기본 '작업 중'
  const [uk] = openSubagents([
    tool('Task', { toolUseId: 'a' }),
    { kind: 'notice', text: 'sys', parentToolUseId: 'a' },
  ]);
  assert.deepEqual(uk.activity, { state: 'working' });
  // 자식 tool_use의 입력 스트리밍 중 → 입력 수신 중
  const [ri] = openSubagents([
    tool('Task', { toolUseId: 'a' }),
    tool('Grep', { toolUseId: 'c2', parentToolUseId: 'a', streaming: true }),
  ]);
  assert.deepEqual(ri.activity, { state: 'receiving-input' });
});

test('activityLabel: 상태별 라벨 매핑', () => {
  assert.equal(activityLabel({ state: 'starting' }), '시작 중');
  assert.equal(activityLabel({ state: 'thinking' }), '생각 중');
  assert.equal(activityLabel({ state: 'receiving-input' }), '입력 수신 중');
  assert.equal(activityLabel({ state: 'responding' }), '응답 작성 중');
  assert.equal(activityLabel({ state: 'working' }), '작업 중');
  assert.equal(activityLabel({ state: 'tool', toolName: 'Bash' }), 'Bash 실행 중');
  assert.equal(activityLabel({ state: 'tool', toolName: null }), '도구 실행 중');
  assert.equal(activityLabel(null), '작업 중');
  assert.equal(activityLabel({ state: '미지의상태' }), '작업 중');
});

test('panelVisible: 진행 중 상태 + 목록 비어있지 않을 때만 — 재개 유령 방지 게이트', () => {
  for (const status of ['thinking', 'tool', 'awaiting-permission']) {
    assert.equal(panelVisible(status, 1), true, `${status}+1`);
    assert.equal(panelVisible(status, 0), false, `${status}+0`);
  }
  for (const status of ['idle', 'exited', 'none', undefined]) {
    assert.equal(panelVisible(status, 3), false, `${status}+3`);
  }
});

// ----- 리듀서 통합: fake-cli wire format과 동일한 페이로드 연쇄로 구동 -----

const taskToolUse = (id, input = { prompt: '서브에이전트 작업' }, parent = null) => ({
  type: 'assistant',
  message: {
    id: `msg_${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Task', input }],
  },
  ...(parent ? { parent_tool_use_id: parent } : {}),
  session_id: 'fake-session-1',
});

const toolResult = (id) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: false }],
  },
  session_id: 'fake-session-1',
});

test('통합: 병렬 Task 2개 — 자식 활동 귀속, 부분 종료, 고아 합성 마감', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, taskToolUse('toolu_a', { description: '조사 A', subagent_type: 'Explore' }));
  s = reduceCliEvent(s, taskToolUse('toolu_b', { description: '조사 B' }));
  // a 밑에서 Bash가 도는 중(parent_tool_use_id 귀속)
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'msg_child',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } }],
    },
    parent_tool_use_id: 'toolu_a',
    session_id: 'fake-session-1',
  });
  let list = openSubagents(s.messages);
  assert.deepEqual(list.map((x) => [x.toolUseId, x.label, x.activity]), [
    ['toolu_a', '조사 A', { state: 'tool', toolName: 'Bash' }],
    ['toolu_b', '조사 B', { state: 'starting' }],
  ]);
  assert.equal(list[0].subagentType, 'Explore');
  assert.equal(panelVisible(s.status, list.length), true);
  assert.equal(openSubagentCount(s.messages), list.length, 'clawd 래퍼와 동일 판정');
  // a만 종료 → b만 남는다
  s = reduceCliEvent(s, toolResult('toolu_a'));
  list = openSubagents(s.messages);
  assert.deepEqual(list.map((x) => x.toolUseId), ['toolu_b']);
  // tool_result 없이 턴 종료(인터럽트/크래시) → 합성 결과가 목록도 닫는다
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    is_error: true,
    usage: { input_tokens: 3, output_tokens: 1 },
    num_turns: 1,
    session_id: 'fake-session-1',
  });
  assert.deepEqual(openSubagents(s.messages), []);
  assert.equal(panelVisible(s.status, 0), false);
});

test('통합: 중첩 Task(서브에이전트가 띄운 Task)는 depth 1로 함께 잡힌다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, taskToolUse('toolu_outer', { description: '바깥' }));
  s = reduceCliEvent(s, taskToolUse('toolu_inner', { description: '안쪽' }, 'toolu_outer'));
  const list = openSubagents(s.messages);
  assert.deepEqual(list.map((x) => [x.toolUseId, x.depth]), [
    ['toolu_outer', 0],
    ['toolu_inner', 1],
  ]);
  // 안쪽 Task가 바깥의 마지막 자식이므로 바깥 활동은 '도구 실행 중'
  assert.deepEqual(list[0].activity, { state: 'tool', toolName: 'Task' });
});

test('SUBAGENT_TOOLS 재수출: clawd.js 경유 import와 동일 인스턴스', async () => {
  const viaClawd = (await import('../src/lib/clawd.js')).SUBAGENT_TOOLS;
  assert.equal(viaClawd, SUBAGENT_TOOLS);
});
