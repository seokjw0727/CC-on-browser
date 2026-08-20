// running-work.js — 입력창 아래 "실행 중" 도크의 파생 셀렉터 테스트.
// 백그라운드 항목의 계약은 추측이 아니라 실측이다(2026-07-30, 실 CLI v2.1.220):
//   system/background_tasks_changed { tasks: [{task_id, task_type, description}] }
//   system/task_started            { task_id, tool_use_id, ... }
// 근거·원시 캡처: .certify/design/2026-07-30-remote-control-running-dock-timestamps.html §3.2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWork, workDetail } from '../src/lib/running-work.js';
import { createSessionState } from '../src/lib/store-reducer.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const feed = (session, payload) => reduceCliEvent(session, payload, NOW);

/** 열린(결과 없는) tool_use 하나를 만들어 넣는다. */
function withOpenTool(session, { name, id, input }) {
  return feed(session, {
    type: 'assistant',
    message: { id: `msg-${id}`, model: 'claude-opus-4-8', content: [{ type: 'tool_use', id, name, input }] },
  });
}

/**
 * 서브에이전트 소속 자식 아이템을 형상 그대로 시딩한다 — 실제로는 CLI가
 * parent_tool_use_id를 실은 stream_event로 주지만, 셀렉터는 형상만 본다.
 */
let childSeq = 0;
const child = (parentToolUseId, item) => ({
  uid: `c_${(childSeq += 1)}`,
  streaming: false,
  parentToolUseId,
  ...item,
});
const withMessages = (s, items) => ({ ...s, messages: [...s.messages, ...items] });

test('빈 세션은 빈 목록', () => {
  assert.deepEqual(openWork(createSessionState()), []);
  assert.deepEqual(openWork(null), []);
});

test('백그라운드 스냅샷이 그대로 항목이 된다 (셸·에이전트 모두)', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' },
      { task_id: 'a1', task_type: 'local_agent', description: '리팩터 조사' },
    ],
  });
  const work = openWork(s);
  assert.equal(work.length, 2);
  assert.equal(work[0].label, 'sleep 40');
  assert.equal(work[0].detail, '백그라운드 셸');
  assert.equal(work[0].icon, 'command', '셸은 command 아이콘');
  assert.equal(work[1].label, '리팩터 조사');
  assert.equal(work[1].detail, '백그라운드 에이전트');
  assert.equal(work[1].icon, 'bot', '에이전트는 bot 아이콘');
});

test('스냅샷이 비면 목록도 비워진다 (해제 휴리스틱 없음)', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' }],
  });
  assert.equal(openWork(s).length, 1);
  s = feed(s, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(openWork(s).length, 0);
});

test('task_started가 점프 대상(uid)을 이어 준다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_1', input: { command: 'sleep 40', run_in_background: true } });
  const toolUid = s.messages.find((m) => m.kind === 'tool_use').uid;
  s = feed(s, {
    type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1',
  });
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' }],
  });
  const [item] = openWork(s);
  assert.equal(item.toolUseId, 'toolu_1');
  assert.equal(item.uid, toolUid, '도크 클릭 → 이 uid의 카드로 스크롤한다');
});

test('연결 정보가 없으면 uid는 null (항목은 남되 클릭 대상이 없다)', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'orphan', task_type: 'local_bash', description: 'x' }],
  });
  assert.equal(openWork(s)[0].uid, null);
});

test('전경 Bash는 결과가 오기 전까지만 실행 중', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command: 'npm test' } });
  const work = openWork(s);
  assert.equal(work.length, 1);
  assert.equal(work[0].kind, 'shell');
  assert.equal(work[0].label, 'npm test');
  assert.equal(work[0].icon, 'command', '전경 셸도 command 아이콘');

  s = feed(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'done', is_error: false }],
    },
  });
  assert.equal(openWork(s).length, 0);
});

test('전경 서브에이전트도 함께 나온다', () => {
  let s = createSessionState();
  s = withOpenTool(s, {
    name: 'Task', id: 'toolu_t', input: { description: '조사', subagent_type: 'Explore' },
  });
  const work = openWork(s);
  assert.equal(work.length, 1);
  assert.equal(work[0].kind, 'subagent');
  assert.equal(work[0].label, '조사');
  assert.equal(work[0].detail, 'Explore');
  assert.equal(work[0].icon, 'bot', '서브에이전트도 bot 아이콘');
  assert.ok(work[0].uid, '서브에이전트도 점프 대상이 있어야 한다');
});

test('같은 도구가 백그라운드와 전경으로 중복되지 않는다', () => {
  let s = createSessionState();
  s = withOpenTool(s, {
    name: 'Task', id: 'toolu_dup', input: { description: '중복', subagent_type: 'Explore' },
  });
  s = feed(s, {
    type: 'system', subtype: 'task_started', task_id: 'd1', tool_use_id: 'toolu_dup',
  });
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'd1', task_type: 'local_agent', description: '중복' }],
  });
  const work = openWork(s);
  assert.equal(work.length, 1, '스냅샷이 이미 세고 있으면 전경 파생이 또 세면 안 된다');
  assert.equal(work[0].kind, 'background');
});

test('백그라운드가 먼저, 전경이 뒤에 온다 (오래 가는 것이 위)', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command: 'npm test' } });
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b9', task_type: 'local_bash', description: 'tail -f log' }],
  });
  assert.deepEqual(openWork(s).map((w) => w.kind), ['background', 'shell']);
});

test('프리로드된 과거 대화의 열린 도구는 유령으로 세지 않는다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_old', input: { command: '옛 명령' } });
  assert.equal(openWork(s).length, 1);
  // 디스크 재개로 시딩된 메시지에는 preloaded가 찍힌다(store-reducer의 started)
  s = { ...s, messages: s.messages.map((m) => ({ ...m, preloaded: true })) };
  assert.equal(openWork(s).length, 0);
});

test('백그라운드 스냅샷은 프리로드와 무관하게 유지된다 (CLI가 권위)', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: '살아있음' }],
  });
  s = { ...s, messages: s.messages.map((m) => ({ ...m, preloaded: true })) };
  assert.equal(openWork(s).length, 1);
});

test('망가진 스냅샷 항목은 조용히 건너뛴다', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [null, { task_type: 'local_bash' }, { task_id: 'ok', task_type: 'local_bash', description: 'y' }],
  });
  const work = openWork(s);
  assert.equal(work.length, 1);
  assert.equal(work[0].label, 'y');
});

test('task_updated·task_notification은 채팅에 새지 않는다', () => {
  let s = createSessionState();
  const before = s.messages.length;
  s = feed(s, { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } });
  s = feed(s, { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
  assert.equal(s.messages.length, before, 'raw 아이템으로 흘러들면 안 된다');
});

test('세션이 끝나면 백그라운드 목록도 비워진다 (죽은 작업이 맥동하지 않게)', async () => {
  const { createInitialState, reducer } = await import('../src/lib/store-reducer.js');
  let g = createInitialState();
  g = reducer(g, { type: 'server-message', message: { type: 'started', startId: 'x', key: 's_1', initInfo: {} } });
  g = reducer(g, {
    type: 'server-message',
    message: {
      type: 'event',
      key: 's_1',
      seq: 1,
      payload: {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' }],
      },
    },
  });
  assert.equal(openWork(g.sessions.get('s_1')).length, 1);
  g = reducer(g, { type: 'server-message', message: { type: 'exit', key: 's_1', code: 0 } });
  assert.equal(openWork(g.sessions.get('s_1')).length, 0);
});

test('종료된 세션은 전경 도구도 되살아나지 않는다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_x', input: { command: 'sleep 40' } });
  assert.equal(openWork(s).length, 1);
  // backgroundTasks만 비우면 같은 도구가 전경 규칙에 걸려 다시 뜬다 — status로 막는다
  s = { ...s, status: 'exited', backgroundTasks: [] };
  assert.equal(openWork(s).length, 0);
});

// ----- 상세 패널(아코디언)을 위한 확장 모델 -----

test('전경 셸의 startedAt은 tool_use의 at을 그대로 쓴다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command: 'npm test' } });
  assert.equal(openWork(s)[0].startedAt, NOW);
});

test('at이 없는 메시지는 startedAt null (경과 표시를 생략하는 계약)', () => {
  const s = {
    ...createSessionState(),
    messages: [{
      uid: 'u1',
      kind: 'tool_use',
      name: 'Bash',
      toolUseId: 't1',
      input: { command: 'x' },
      streaming: false,
      result: null,
      parentToolUseId: null,
    }],
  };
  assert.equal(openWork(s)[0].startedAt, null, 'NaN분 전이 노출되지 않도록 null이어야 한다');
});

test('백그라운드의 startedAt·input은 연결된 tool_use에서 온다', () => {
  let s = createSessionState();
  s = withOpenTool(s, {
    name: 'Bash', id: 'toolu_1', input: { command: 'sleep 40', run_in_background: true },
  });
  s = feed(s, { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1' });
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 40' }],
  });
  const [item] = openWork(s);
  assert.equal(item.startedAt, NOW);
  assert.equal(item.input.command, 'sleep 40');
  assert.equal(item.taskId, 'b1');
  assert.equal(item.taskType, 'local_bash');
});

test('링크 없는 백그라운드는 startedAt null이고 description만 스냅샷에서 온다', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'orphan', task_type: 'local_bash', description: 'x' }],
  });
  const [item] = openWork(s);
  assert.equal(item.startedAt, null);
  assert.equal(item.input.command, null);
  assert.equal(item.input.description, 'x');
  assert.equal(item.uid, null);
});

test('서브에이전트만 activity를 싣는다 (셸·백그라운드는 null)', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [
    child('toolu_t', {
      kind: 'tool_use', name: 'Bash', toolUseId: 'c1', input: { command: 'ls' }, result: null,
    }),
  ]);
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command: 'npm test' } });
  const byKind = Object.fromEntries(openWork(s).map((w) => [w.kind, w]));
  assert.deepEqual(byKind.subagent.activity, { state: 'tool', toolName: 'Bash' });
  assert.equal(byKind.shell.activity, null);
});

test('input 요약은 라벨과 달리 자르지 않는다 (셸 명령 전문 보존)', () => {
  let s = createSessionState();
  const command = 'git add -A\ngit commit -m "x"';
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command, description: '커밋' } });
  const [item] = openWork(s);
  assert.equal(item.label, 'git add -A', '라벨은 첫 줄만');
  assert.equal(item.input.command, command, '상세는 개행 포함 전문');
  assert.equal(item.input.description, '커밋');
});

test('workDetail: parentToolUseId가 일치하는 자식만 모은다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [
    child('toolu_t', { kind: 'assistant-text', text: '하나' }),
    child('toolu_z', { kind: 'assistant-text', text: '남의 것' }),
    child('toolu_t', { kind: 'assistant-text', text: '둘' }),
    child(null, { kind: 'assistant-text', text: '본선' }),
    child('toolu_t', { kind: 'assistant-text', text: '셋' }),
  ]);
  const d = workDetail(s, openWork(s)[0]);
  assert.equal(d.steps.length, 3);
  assert.equal(d.stepsTotal, 3);
  assert.deepEqual(d.steps.map((x) => x.text), ['하나', '둘', '셋'], '메시지 순서(시간순) 유지');
});

test('workDetail: 최근 N개만 남기고 잘린 총 개수를 함께 보고한다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [1, 2, 3, 4, 5].map((n) => child('toolu_t', { kind: 'assistant-text', text: `s${n}` })));
  const d = workDetail(s, openWork(s)[0], 2);
  assert.deepEqual(d.steps.map((x) => x.text), ['s4', 's5']);
  assert.equal(d.stepsTotal, 5, '"이전 3단계 생략" 안내의 근거');
});

test('workDetail: kind마다 다른 자리에서 프리뷰를 꺼낸다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [
    child('toolu_t', { kind: 'assistant-text', text: '요약본' }),
    child('toolu_t', { kind: 'thinking', thinking: '고민' }),
    child('toolu_t', { kind: 'tool_use', name: 'Read', input: { file_path: 'a.js' }, result: null }),
    child('toolu_t', { kind: 'user-text', text: '입력' }),
    child('toolu_t', { kind: 'usage', inTok: 1 }),
    child('toolu_t', { kind: 'raw', payload: {} }),
  ]);
  const d = workDetail(s, openWork(s)[0]);
  assert.equal(d.steps.length, 4, 'usage·raw는 보여 줄 것이 없어 제외');
  assert.equal(d.steps[0].kindLabel, '응답');
  assert.equal(d.steps[2].tool, 'Read');
  assert.equal(d.steps[2].text, 'a.js');
  assert.equal(d.steps[2].kindLabel, '도구');
});

test('workDetail: 프리뷰는 한 줄로 접고 80자에서 자른다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [
    child('toolu_t', { kind: 'assistant-text', text: 'a'.repeat(200) }),
    child('toolu_t', { kind: 'assistant-text', text: 'ab\n  cd' }),
  ]);
  const d = workDetail(s, openWork(s)[0]);
  assert.equal(d.steps[0].text.length, 81, '80자 + 말줄임표');
  assert.ok(d.steps[0].text.endsWith('…'));
  assert.equal(d.steps[1].text, 'ab cd', '개행·연속 공백은 한 칸으로');
});

test('workDetail: 자식 tool_use의 result가 오면 done이 뒤집힌다', () => {
  let s = createSessionState();
  s = withOpenTool(s, { name: 'Task', id: 'toolu_t', input: { description: '조사' } });
  s = withMessages(s, [
    child('toolu_t', { kind: 'tool_use', name: 'Read', input: { file_path: 'a.js' }, result: null }),
  ]);
  assert.equal(workDetail(s, openWork(s)[0]).steps[0].done, false);
  // 렌더마다 재계산해 라이브로 갱신된다는 계약 — 같은 셀렉터가 새 상태에서 true를 준다
  s = {
    ...s,
    messages: s.messages.map((m) => (m.kind === 'tool_use' && m.parentToolUseId === 'toolu_t'
      ? { ...m, result: { content: 'ok', isError: false } }
      : m)),
  };
  assert.equal(workDetail(s, openWork(s)[0]).steps[0].done, true);
});

test('workDetail: 셸은 자식이 없어 steps가 비고 명령 전문·설명을 준다', () => {
  let s = createSessionState();
  const command = 'npm test -- --watch';
  s = withOpenTool(s, { name: 'Bash', id: 'toolu_fg', input: { command, description: '테스트' } });
  const d = workDetail(s, openWork(s)[0]);
  assert.equal(d.steps.length, 0);
  assert.equal(d.stepsTotal, 0);
  assert.equal(d.command, command);
  assert.equal(d.task, null);
});

test('workDetail: 백그라운드는 uid가 없어도 메타를 준다', () => {
  let s = createSessionState();
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'orphan', task_type: 'local_bash', description: 'x' }],
  });
  const d = workDetail(s, openWork(s)[0]);
  // uid가 없어도 상세는 열려야 한다 — 행 비활성 로직을 제거한 근거
  assert.deepEqual(d.task, { id: 'orphan', type: 'local_bash', label: '백그라운드 셸' });
  assert.equal(d.uid, null);
  assert.equal(d.steps.length, 0);
});

test('workDetail: 백그라운드로 승격된 Task도 자식 단계를 보여 준다', () => {
  let s = createSessionState();
  s = withOpenTool(s, {
    name: 'Task', id: 'toolu_dup', input: { description: '중복', subagent_type: 'Explore' },
  });
  s = feed(s, { type: 'system', subtype: 'task_started', task_id: 'd1', tool_use_id: 'toolu_dup' });
  s = feed(s, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'd1', task_type: 'local_agent', description: '중복' }],
  });
  s = withMessages(s, [child('toolu_dup', { kind: 'assistant-text', text: '진행 중' })]);
  const [item] = openWork(s);
  assert.equal(item.kind, 'background', '스냅샷이 권위라 kind는 background로 승격된다');
  // 그래도 자식은 그대로 들어오므로, kind로 걸러 내면 빈 패널이 된다
  assert.equal(workDetail(s, item).steps.length, 1);
});

test('toolUseId가 없는 서브에이전트도 uid로 원본을 찾아 상세를 채운다', () => {
  // CLI가 tool_use에 id를 싣지 않는 경우 — toolUseId만 보면 link가 null이 되어
  // 설명·프롬프트·시작 시각이 통째로 빈 패널이 된다.
  const s = {
    ...createSessionState(),
    messages: [{
      uid: 'u_noid',
      kind: 'tool_use',
      name: 'Task',
      toolUseId: null,
      at: NOW,
      input: { description: '아이디 없는 조사', subagent_type: 'Explore', prompt: '조사해 줘' },
      streaming: false,
      result: null,
      parentToolUseId: null,
    }],
  };
  const [item] = openWork(s);
  assert.equal(item.kind, 'subagent');
  assert.equal(item.startedAt, NOW);
  assert.equal(item.input.description, '아이디 없는 조사');
  assert.equal(item.input.subagentType, 'Explore');
  assert.equal(workDetail(s, item).prompt, '조사해 줘');
});

test('workDetail: 세션·항목이 없으면 null (방어)', () => {
  assert.equal(workDetail(null, {}), null);
  assert.equal(workDetail(createSessionState(), null), null);
});
