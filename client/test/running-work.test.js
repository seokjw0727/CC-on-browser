// running-work.js — 입력창 아래 "실행 중" 도크의 파생 셀렉터 테스트.
// 백그라운드 항목의 계약은 추측이 아니라 실측이다(2026-07-30, 실 CLI v2.1.220):
//   system/background_tasks_changed { tasks: [{task_id, task_type, description}] }
//   system/task_started            { task_id, tool_use_id, ... }
// 근거·원시 캡처: .certify/design/2026-07-30-remote-control-running-dock-timestamps.html §3.2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWork } from '../src/lib/running-work.js';
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
