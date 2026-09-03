// CLAW'D 프레임 비트맵 무결성 + 무드 매핑 테스트.
// 프레임은 실제 CLI 바이너리 아트의 쿼드런트 전사(lib/clawd.js 헤더 참조) —
// 행 단위 diff를 고정해 의도치 않은 실루엣 드리프트를 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAWD_FRAMES,
  CLAWD_PIXEL_ASPECT,
  CLAWD_SLEEP_MS,
  CLAWD_EYE_DEADZONE_PX,
  clawdMood,
  clawdVisualMood,
  clawdTurnEnd,
  eyeFrameFor,
  eyeOffsetFor,
  CLAWD_EYE_MAX_X,
  CLAWD_EYE_MAX_Y,
  CLAWD_EYE_RANGE_PX,
  openSubagentCount,
} from '../src/lib/clawd.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';

const FRAME_NAMES = [
  'base', 'blink', 'lookLeft', 'lookRight', 'claws', 'doze', 'jugLeft', 'jugRight',
  // state-mapping.md의 나머지 상태용 프레임
  'read', 'sweepLeft', 'sweepRight', 'carryLeft', 'carryRight',
];

test('모든 프레임은 18x5이고 0/1/2로만 구성된다', () => {
  assert.deepEqual(Object.keys(CLAWD_FRAMES).sort(), [...FRAME_NAMES].sort());
  for (const name of FRAME_NAMES) {
    const bits = CLAWD_FRAMES[name];
    assert.equal(bits.length, 5, `${name}: 5행`);
    for (const row of bits) {
      assert.equal(row.length, 18, `${name}: 18열`);
      assert.match(row, /^[012]+$/, `${name}: 0/1/2만`);
    }
  }
});

test('픽셀 종횡비는 터미널 쿼드런트(1:2)를 따른다', () => {
  assert.equal(CLAWD_PIXEL_ASPECT, 2);
});

function diffRows(a, b) {
  const rows = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) rows.push(i);
  return rows;
}
const eyeCount = (bits) => bits.join('').split('').filter((c) => c === '2').length;

test('base의 눈은 정확히 2개 — 눈 블록 "▛███▜"의 빠진 쿼드런트(1행 x5·x12)', () => {
  assert.equal(eyeCount(CLAWD_FRAMES.base), 2);
  assert.equal(CLAWD_FRAMES.base[1][5], '2');
  assert.equal(CLAWD_FRAMES.base[1][12], '2');
});

test('blink는 base와 눈 행(1행)만 다르고 눈이 사라진다(감음)', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.blink), [1]);
  assert.equal(eyeCount(CLAWD_FRAMES.blink), 0);
});

test('lookLeft/lookRight는 눈(0,1행)·다리(4행)만 다르다 — 두리번 + 스캐틀', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.lookLeft), [0, 1, 4]);
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.lookRight), [0, 1, 4]);
  // 눈이 윗행(0행)으로 올라가고(치켜뜸), 좌우가 서로 다른 위치를 본다
  assert.equal(eyeCount(CLAWD_FRAMES.lookLeft), 2);
  assert.equal(eyeCount(CLAWD_FRAMES.lookRight), 2);
  assert.notEqual(CLAWD_FRAMES.lookLeft[0], CLAWD_FRAMES.lookRight[0]);
  // 다리도 서로 반대 방향으로 움직인다 (교대 시 스캐틀로 보이는 근거)
  assert.notEqual(CLAWD_FRAMES.lookLeft[4], CLAWD_FRAMES.lookRight[4]);
});

test('claws(arms-up)는 팔 행(1,2행)만 다르다 — 집게가 머리 옆까지 올라온다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.claws), [1, 2]);
  assert.equal(eyeCount(CLAWD_FRAMES.claws), 2, '눈은 뜨고 있다');
});

test('doze는 눈(1행)·팔(2행)만 다르다 — 눈 감고 팔을 몸에 붙인다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.doze), [1, 2]);
  assert.equal(eyeCount(CLAWD_FRAMES.doze), 0);
});

test('jugLeft/jugRight: 집게는 들고(claws 팔) 눈만 좌우(0행) — 발은 base 그대로', () => {
  for (const name of ['jugLeft', 'jugRight']) {
    const f = CLAWD_FRAMES[name];
    // 팔 행은 claws에서 눈만 지운 것, 발 행은 base와 동일(제자리 저글링)
    assert.deepEqual(diffRows(CLAWD_FRAMES.base, f), [0, 1, 2], `${name}: 0·1·2행만 다름`);
    assert.equal(f[2], CLAWD_FRAMES.claws[2], `${name}: 집게 행은 claws와 동일`);
    assert.equal(f[4], CLAWD_FRAMES.base[4], `${name}: 발은 base 그대로`);
    assert.equal(eyeCount(f), 2, `${name}: 눈 2개`);
  }
  // 눈은 look 포즈의 윗행 눈 위치를 그대로 쓴다(공을 쫓는 시선)
  assert.equal(CLAWD_FRAMES.jugLeft[0], CLAWD_FRAMES.lookLeft[0]);
  assert.equal(CLAWD_FRAMES.jugRight[0], CLAWD_FRAMES.lookRight[0]);
  assert.equal(CLAWD_FRAMES.jugLeft[1], CLAWD_FRAMES.jugRight[1]);
});

test('clawdMood: 세션 상태·연결 상태 매핑', () => {
  assert.equal(clawdMood('idle', 'open'), 'idle');
  assert.equal(clawdMood('thinking', 'open'), 'think');
  assert.equal(clawdMood('tool', 'open'), 'busy');
  assert.equal(clawdMood('awaiting-permission', 'open'), 'alert');
  assert.equal(clawdMood('exited', 'open'), 'doze');
  assert.equal(clawdMood('none', 'open'), 'doze');
  // 연결이 끊기면 무엇을 하고 있었든 존다
  assert.equal(clawdMood('thinking', 'closed'), 'doze');
  assert.equal(clawdMood('idle', 'connecting'), 'doze');
});

test('clawdVisualMood: 일시 상태(happy/error)는 idle 위에만 얹힌다', () => {
  const on = (o) => clawdVisualMood({ status: 'idle', conn: 'open', ...o });
  assert.equal(on({ transient: 'happy' }), 'happy');
  assert.equal(on({ transient: 'error' }), 'error');
  // 새 턴이 시작되면(think/busy) 반응보다 작업 표시가 우선
  assert.equal(clawdVisualMood({ status: 'thinking', conn: 'open', transient: 'happy' }), 'think');
  assert.equal(clawdVisualMood({ status: 'tool', conn: 'open', transient: 'error' }), 'busy');
  // 연결이 끊기면 반응도 무시하고 존다
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'closed', transient: 'happy' }), 'doze');
});

test('clawdVisualMood: sleep은 idle + 무활동 60s, 반응이 수면보다 우선', () => {
  const idleFor = (ms, extra) =>
    clawdVisualMood({ status: 'idle', conn: 'open', userIdleMs: ms, ...extra });
  assert.equal(idleFor(CLAWD_SLEEP_MS), 'sleep');
  assert.equal(idleFor(CLAWD_SLEEP_MS - 1), 'idle');
  assert.equal(idleFor(CLAWD_SLEEP_MS, { transient: 'happy' }), 'happy');
  // 턴 진행 중엔 유저가 자리를 비워도 잠들지 않는다
  assert.equal(
    clawdVisualMood({ status: 'tool', conn: 'open', userIdleMs: CLAWD_SLEEP_MS }),
    'busy',
  );
});

test('clawdVisualMood: juggle은 busy(도구 실행 중) + 서브에이전트 1개 이상', () => {
  assert.equal(clawdVisualMood({ status: 'tool', conn: 'open', subagents: 1 }), 'juggle');
  assert.equal(clawdVisualMood({ status: 'tool', conn: 'open', subagents: 0 }), 'busy');
  // thinking(결과를 읽는 중)엔 얹지 않는다
  assert.equal(clawdVisualMood({ status: 'thinking', conn: 'open', subagents: 2 }), 'think');
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'open', subagents: 2 }), 'idle');
  // 권한 응답 대기가 저글링보다 우선 — 사용자 행동이 필요한 상태를 가리면 안 된다
  assert.equal(clawdVisualMood({ status: 'awaiting-permission', conn: 'open', subagents: 2 }), 'alert');
});

test('clawdTurnEnd: 진행 중 → idle 전이만 턴 종료, isError가 happy/error를 가른다', () => {
  assert.equal(clawdTurnEnd('thinking', 'idle', { isError: false }), 'happy');
  assert.equal(clawdTurnEnd('tool', 'idle', { isError: true }), 'error');
  assert.equal(clawdTurnEnd('awaiting-permission', 'idle', null), 'happy');
  // 턴 종료가 아닌 전이들
  assert.equal(clawdTurnEnd('none', 'idle', null), null);
  assert.equal(clawdTurnEnd('idle', 'idle', null), null);
  assert.equal(clawdTurnEnd('exited', 'idle', null), null);
  assert.equal(clawdTurnEnd('thinking', 'tool', null), null);
  assert.equal(clawdTurnEnd('thinking', 'exited', { isError: true }), null);
  // 사용자가 직접 중단한 턴(인터럽트도 is_error result)은 실패 연출 없이 무반응
  assert.equal(clawdTurnEnd('tool', 'idle', { isError: true }, true), null);
  assert.equal(clawdTurnEnd('thinking', 'idle', { isError: false }, true), null);
});

test('eyeFrameFor: 데드존 안은 정면, 밖은 커서 쪽을 본다 (레거시 3프레임)', () => {
  assert.equal(eyeFrameFor(0), 'base');
  assert.equal(eyeFrameFor(-CLAWD_EYE_DEADZONE_PX), 'base');
  assert.equal(eyeFrameFor(CLAWD_EYE_DEADZONE_PX), 'base');
  assert.equal(eyeFrameFor(-(CLAWD_EYE_DEADZONE_PX + 1)), 'lookLeft');
  assert.equal(eyeFrameFor(CLAWD_EYE_DEADZONE_PX + 1), 'lookRight');
});

test('eyeOffsetFor: 중심이면 정면(0,0), 커서 각도를 2D로 따라간다', () => {
  assert.deepEqual(eyeOffsetFor(0, 0), { ex: 0, ey: 0 });
  // 오른쪽 아래로 멀리 → +x, +y 로 이동, 방향은 커서 각도 부호를 따른다
  const dr = eyeOffsetFor(1000, 1000);
  assert.ok(dr.ex > 0 && dr.ey > 0);
  const ul = eyeOffsetFor(-1000, -1000);
  assert.ok(ul.ex < 0 && ul.ey < 0);
  // 좌우 대칭
  const r = eyeOffsetFor(500, 0);
  const l = eyeOffsetFor(-500, 0);
  assert.equal(r.ex, -l.ex);
  assert.equal(r.ey, 0);
});

test('eyeOffsetFor: 크기는 최대치로 포화하고 그 이상 넘지 않는다', () => {
  const far = eyeOffsetFor(100000, 0);
  assert.ok(Math.abs(far.ex) <= CLAWD_EYE_MAX_X + 1e-6);
  const farY = eyeOffsetFor(0, 100000);
  assert.ok(Math.abs(farY.ey) <= CLAWD_EYE_MAX_Y + 1e-6);
  // 사거리 밖 거리에서 수평 최대치에 도달(순수 수평)
  assert.ok(Math.abs(eyeOffsetFor(CLAWD_EYE_RANGE_PX, 0).ex - CLAWD_EYE_MAX_X) < 1e-6);
  // 가까울수록 작다(단조 증가)
  assert.ok(Math.abs(eyeOffsetFor(30, 0).ex) < Math.abs(eyeOffsetFor(120, 0).ex));
});

test('openSubagentCount: 결과 미도착·입력 확정된 Task/Agent 도구만 센다', () => {
  const tool = (name, extra = {}) => ({
    kind: 'tool_use',
    name,
    streaming: false,
    result: null,
    ...extra,
  });
  const messages = [
    { kind: 'user-text', text: 'go' },
    tool('Task'), // 실행 중 → 1
    tool('Agent'), // 구명 병기 → 1
    tool('Task', { result: { content: 'done', isError: false } }), // 완료 → 제외
    tool('Task', { streaming: true }), // 입력 스트리밍 중(미실행) → 제외
    tool('Bash'), // 서브에이전트 아님 → 제외
  ];
  assert.equal(openSubagentCount(messages), 2);
  assert.equal(openSubagentCount([]), 0);
  assert.equal(openSubagentCount(undefined), 0);
});

// ----- 리듀서 통합: 픽스처 자작이 아니라 reduce-cli-event의 실제 출력 위에서
// juggle 판정이 열리고 닫히는지 고정한다(필드명 드리프트 감지선 — DA #24 #3).
// 페이로드는 fake-cli subagent 시나리오가 방출하는 wire format과 동일하다.

const taskToolUse = (id) => ({
  type: 'assistant',
  message: {
    id: `msg_${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Task', input: { prompt: '서브에이전트 작업' } }],
  },
  session_id: 'fake-session-1',
});

test('통합: Task tool_use → juggle 열림, tool_result → 닫힘 (리듀서 실출력 기준)', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, taskToolUse('toolu_task_1'));
  assert.equal(s.status, 'tool');
  assert.equal(openSubagentCount(s.messages), 1);
  assert.equal(
    clawdVisualMood({ status: s.status, conn: 'open', subagents: openSubagentCount(s.messages) }),
    'juggle',
  );
  s = reduceCliEvent(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_task_1', content: 'subagent done', is_error: false },
      ],
    },
    tool_use_result: { success: true },
    session_id: 'fake-session-1',
  });
  assert.equal(openSubagentCount(s.messages), 0);
});

test('통합: 고아 tool_use는 result가 합성 결과로 닫는다 — 영구 juggle/tool 오염 방지', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, taskToolUse('toolu_task_orphan'));
  assert.equal(openSubagentCount(s.messages), 1);
  // tool_result 없이 턴이 끝난다(인터럽트/크래시 고아 재현)
  s = reduceCliEvent(s, {
    type: 'result',
    subtype: 'success',
    is_error: true,
    usage: { input_tokens: 3, output_tokens: 1 },
    num_turns: 1,
    session_id: 'fake-session-1',
  });
  assert.equal(s.status, 'idle');
  assert.equal(openSubagentCount(s.messages), 0, '다음 턴의 juggle 판정을 오염시키지 않는다');
  const tool = s.messages.find((m) => m.kind === 'tool_use');
  assert.ok(tool.result && tool.result.isError, 'ToolCard가 "실행 중" 대신 오류로 표시된다');
});
