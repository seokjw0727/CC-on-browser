// CLAW'D — state-mapping.md의 "나머지 agent event" 커버리지 테스트.
//
// 기존 clawd.test.js가 원본 CLI 아트 전사와 idle/think/busy/juggle/sleep 어휘를 고정한다면,
// 이 파일은 그 위에 얹은 확장분(PreCompact→sweep / PostCompact→happy / WorktreeCreate→carry /
// Notification→notify / Idle(random)→read / working·juggling 티어)을 고정한다.
//
// 두 가지 원칙:
//   1. 단독 조건보다 **충돌 조합**을 먼저 본다 — 무드가 9개에서 13개로 늘면 회귀는
//      "각각은 맞는데 겹쳤을 때 엉뚱한 게 이긴다"로 나타난다.
//   2. 파생 신호는 자작 픽스처가 아니라 **reduce-cli-event의 실제 출력** 위에서 확인한다.
//      리듀서가 필드명을 바꾸면(kind/state/result) 여기가 먼저 깨져야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAWD_FRAMES,
  CLAWD_SLEEP_MS,
  CLAWD_READ_MIN_MS,
  CLAWD_READ_MAX_MS,
  CLAWD_READ_HOLD_MS,
  CLAWD_NOTIFY_MS,
  clawdVisualMood,
  clawdTier,
  clawdTransientWins,
  clawdSignals,
  runningSessionCount,
  isWorktreeTool,
} from '../src/lib/clawd.js';
import { reduceCliEvent } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';

function diffRows(a, b) {
  const rows = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) rows.push(i);
  return rows;
}
const eyeCount = (bits) => bits.join('').split('').filter((c) => c === '2').length;

// ----- 새 프레임의 실루엣 계약 -----

test('read: 눈만 한 행 아래(팔 행)로 내려간다 — 팔·다리는 base 그대로', () => {
  const f = CLAWD_FRAMES.read;
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, f), [1, 2], '눈 행과 팔 행만 다르다');
  assert.equal(eyeCount(f), 2);
  assert.equal(f[1], CLAWD_FRAMES.blink[1], '원래 눈 자리는 몸통으로 채워진다');
  assert.equal(f[2][5], '2');
  assert.equal(f[2][12], '2');
  assert.equal(f[4], CLAWD_FRAMES.base[4], '다리는 제자리');
});

test('sweepLeft/sweepRight: base에서 다리 행만 다르다 — 기울기는 CSS 몫', () => {
  for (const name of ['sweepLeft', 'sweepRight']) {
    const f = CLAWD_FRAMES[name];
    assert.deepEqual(diffRows(CLAWD_FRAMES.base, f), [4], `${name}: 다리 행만 다름`);
    assert.equal(f[1], CLAWD_FRAMES.base[1], `${name}: 눈은 정면 base 위치`);
    assert.equal(f[2], CLAWD_FRAMES.base[2], `${name}: 팔은 원본 아트 그대로`);
    assert.equal(eyeCount(f), 2);
  }
  // 좌우가 실제로 반대여야 교대했을 때 '쓸기'로 보인다
  assert.notEqual(CLAWD_FRAMES.sweepLeft[4], CLAWD_FRAMES.sweepRight[4]);
  assert.equal(CLAWD_FRAMES.sweepLeft[4], CLAWD_FRAMES.lookLeft[4], '다리는 look과 같은 반칸 이동');
  assert.equal(CLAWD_FRAMES.sweepRight[4], CLAWD_FRAMES.lookRight[4]);
});

test('carryLeft/carryRight: 집게는 claws로 들고 다리만 교대 — 상자는 CSS 소품', () => {
  for (const name of ['carryLeft', 'carryRight']) {
    const f = CLAWD_FRAMES[name];
    assert.deepEqual(diffRows(CLAWD_FRAMES.claws, f), [4], `${name}: claws와 다리 행만 다름`);
    assert.equal(eyeCount(f), 2);
  }
  assert.notEqual(CLAWD_FRAMES.carryLeft[4], CLAWD_FRAMES.carryRight[4], '뒤뚱 걸음');
});

// ----- 무드 우선순위 -----

test('clawdVisualMood: doze > alert > carry > sweep > notify > juggle/busy > think', () => {
  const at = (over) => clawdVisualMood({ status: 'tool', conn: 'open', ...over });
  // 연결이 끊기면 보여 줄 세션이 없다 — 어떤 파생 신호보다 앞선다
  assert.equal(
    clawdVisualMood({ status: 'tool', conn: 'closed', carrying: true, compacting: true }),
    'doze',
  );
  // 권한 대기는 carry/sweep보다 앞선다 — 사용자 응답 없이는 무엇도 진행되지 않는다
  assert.equal(
    clawdVisualMood({
      status: 'awaiting-permission', conn: 'open', carrying: true, compacting: true,
    }),
    'alert',
  );
  assert.equal(at({ carrying: true, compacting: true }), 'carry');
  assert.equal(at({ compacting: true, subagents: 3 }), 'sweep');
  assert.equal(
    at({ transient: 'notify', transientSource: 'live', subagents: 3 }),
    'notify',
    'live 반응(알림)은 작업 중에도 보인다',
  );
  assert.equal(at({ subagents: 1 }), 'juggle');
  assert.equal(at({}), 'busy');
  // thinking에는 juggle을 얹지 않는다(서브에이전트 결과를 '읽는' 중은 생각이 맞다)
  assert.equal(clawdVisualMood({ status: 'thinking', conn: 'open', subagents: 2 }), 'think');
});

test('clawdVisualMood: 압축·나르기는 idle 위에도 얹힌다(턴 밖 /compact)', () => {
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'open', compacting: true }), 'sweep');
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'open', carrying: true }), 'carry');
});

test('clawdVisualMood: read는 idle 전용이고 sleep이 read를 이긴다', () => {
  const idle = (over) => clawdVisualMood({ status: 'idle', conn: 'open', ...over });
  assert.equal(idle({ reading: true }), 'read');
  assert.equal(idle({ reading: true, userIdleMs: CLAWD_SLEEP_MS }), 'sleep');
  assert.equal(idle({ reading: true, transient: 'happy' }), 'happy', '턴 종료 반응이 독서를 이긴다');
  assert.equal(clawdVisualMood({ status: 'tool', conn: 'open', reading: true }), 'busy');
});

test('clawdVisualMood: 새 인자를 생략하면 종전 동작 그대로(하위 호환)', () => {
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'open' }), 'idle');
  assert.equal(clawdVisualMood({ status: 'tool', conn: 'open', subagents: 0 }), 'busy');
  assert.equal(clawdVisualMood({ status: 'idle', conn: 'open', userIdleMs: CLAWD_SLEEP_MS }), 'sleep');
  assert.equal(clawdVisualMood({ status: 'none', conn: 'open' }), 'doze');
});

// ----- 티어 · transient 중재 -----

test('clawdTier: working 1/2/3+ 세션, juggling 1/2+ 서브에이전트 — tier 1은 종전 동작', () => {
  assert.equal(clawdTier('busy', { sessionsRunning: 0 }), 1, '집계 실패도 tier 1로 안전하게');
  assert.equal(clawdTier('busy', { sessionsRunning: 1 }), 1);
  assert.equal(clawdTier('busy', { sessionsRunning: 2 }), 2);
  assert.equal(clawdTier('busy', { sessionsRunning: 9 }), 3);
  assert.equal(clawdTier('think', { sessionsRunning: 3 }), 3);
  assert.equal(clawdTier('juggle', { subagents: 1 }), 1);
  assert.equal(clawdTier('juggle', { subagents: 5 }), 2);
  // 티어가 없는 무드는 항상 1 — CSS가 tier-1만 보고도 안전하다
  for (const m of ['idle', 'alert', 'sweep', 'carry', 'read', 'notify', 'happy', 'doze']) {
    assert.equal(clawdTier(m, { sessionsRunning: 9, subagents: 9 }), 1, m);
  }
  assert.equal(clawdTier('busy'), 1, '인자 생략도 안전');
});

test('clawdTransientWins: error > happy > notify, 같은 순위는 새 이벤트가 갱신', () => {
  assert.equal(clawdTransientWins(null, 'notify'), true);
  assert.equal(clawdTransientWins('notify', 'happy'), true);
  assert.equal(clawdTransientWins('happy', 'error'), true);
  // 낮은 순위는 표시 중인 반응을 덮지 못한다 — 알림이 실패를 가리지 않게
  assert.equal(clawdTransientWins('error', 'happy'), false);
  assert.equal(clawdTransientWins('error', 'notify'), false);
  assert.equal(clawdTransientWins('happy', 'notify'), false);
  // 연속 알림은 타이머를 다시 감는다
  assert.equal(clawdTransientWins('notify', 'notify'), true);
  assert.equal(clawdTransientWins('happy', null), false);
});

test('독서 예약 구간은 수면 문턱보다 짧다 — "읽다가 잠든다" 순서가 성립', () => {
  assert.ok(CLAWD_READ_MIN_MS > 0 && CLAWD_READ_MIN_MS < CLAWD_READ_MAX_MS);
  assert.ok(CLAWD_READ_MAX_MS < CLAWD_SLEEP_MS, '상한이 수면 문턱보다 낮아야 read가 표시된다');
  assert.ok(CLAWD_READ_HOLD_MS > 0 && CLAWD_READ_HOLD_MS < CLAWD_READ_MIN_MS);
});

// ----- 파생 신호(순수) -----

test('isWorktreeTool: 전용 도구명과 `git worktree add` Bash를 모두 받는다', () => {
  assert.equal(isWorktreeTool({ name: 'EnterWorktree' }), true);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: '  git worktree add ../wt' } }), true);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git worktree list' } }), false);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git status' } }), false);
  // 셸 한 줄에 여러 명령이 이어져도, git 전역 옵션이 껴 있어도 잡는다(codex 지적)
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'cd repo && git worktree add ../wt' } }), true);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git -C repo worktree add -b feat ../wt' } }), true);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git status; git worktree add ../wt' } }), true);
  // 만들 경로가 없는 호출은 생성이 아니다
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git worktree add --help' } }), false);
  assert.equal(isWorktreeTool({ name: 'Bash', input: { command: 'git worktree add' } }), false);
  assert.equal(isWorktreeTool({ name: 'Bash' }), false, 'input 없음도 안전');
  assert.equal(isWorktreeTool(null), false);
});

test('clawdSignals: 단일 패스로 compacting/완료수/carrying/notice를 모은다', () => {
  assert.deepEqual(clawdSignals(undefined), {
    compacting: false, compactionsDone: 0, carrying: false, notices: 0, toolErrors: 0,
  });
  const s = clawdSignals([
    { kind: 'user-text', text: 'go' },
    { kind: 'compaction', state: 'done' },
    { kind: 'notice', text: 'a' },
    { kind: 'notice', text: 'b' },
    { kind: 'tool_use', name: 'EnterWorktree', streaming: false, result: null },
    { kind: 'compaction', state: 'running' },
  ]);
  assert.deepEqual(s, {
    compacting: true, compactionsDone: 1, carrying: true, notices: 2, toolErrors: 0,
  });
});

test('clawdSignals: 취소된 압축은 완료로 세지 않는다 — 축하 오발동 방지', () => {
  const canceled = clawdSignals([
    { kind: 'compaction', state: 'running' },
    { kind: 'compaction', state: 'canceled' },
  ]);
  assert.equal(canceled.compacting, false, '진행 표시는 꺼진다');
  assert.equal(canceled.compactionsDone, 0, '완료 카운터는 오르지 않는다');
  assert.equal(clawdSignals([{ kind: 'compaction', state: 'done' }]).compactionsDone, 1);
});

test('clawdSignals: 결과가 도착한/스트리밍 중인 worktree 도구는 carrying이 아니다', () => {
  const base = { kind: 'tool_use', name: 'EnterWorktree' };
  assert.equal(
    clawdSignals([{ ...base, streaming: false, result: { content: 'ok' } }]).carrying, false,
  );
  assert.equal(clawdSignals([{ ...base, streaming: true, result: null }]).carrying, false);
  assert.equal(clawdSignals([{ ...base, streaming: false, result: null }]).carrying, true);
});

test('runningSessionCount: thinking|tool 세션만 센다 (Map·배열 모두)', () => {
  const sessions = new Map([
    ['a', { status: 'tool' }],
    ['b', { status: 'idle' }],
    ['c', { status: 'thinking' }],
    ['d', { status: 'awaiting-permission' }],
    ['e', { status: 'exited' }],
  ]);
  assert.equal(runningSessionCount(sessions), 2);
  assert.equal(runningSessionCount([{ status: 'thinking' }, null, { status: 'idle' }]), 1);
  assert.equal(runningSessionCount(undefined), 0);
  assert.equal(runningSessionCount(new Map()), 0);
});

// ----- 리듀서 통합 -----

test('통합: /compact 진행 → 완료가 sweep을 켰다 끄고 완료 카운터를 올린다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  const during = clawdSignals(s.messages);
  assert.equal(during.compacting, true);
  assert.equal(
    clawdVisualMood({ status: s.status, conn: 'open', compacting: during.compacting }),
    'sweep',
  );

  s = reduceCliEvent(s, {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 90_000, post_tokens: 12_000 },
  });
  const after = clawdSignals(s.messages);
  assert.equal(after.compacting, false, '완료되면 sweep이 꺼진다');
  assert.equal(after.compactionsDone, during.compactionsDone + 1, '증가분이 happy의 근거');
});

test('통합: 인터럽트로 끝난 압축은 canceled — 완료 카운터가 오르지 않는다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, { type: 'system', subtype: 'status', status: 'compacting' });
  s = reduceCliEvent(s, { type: 'result', subtype: 'error_during_execution', is_error: true });
  const sig = clawdSignals(s.messages);
  assert.equal(sig.compacting, false);
  assert.equal(sig.compactionsDone, 0);
});

test('통합: system notification → notice 증가(알림 반응의 근거)', () => {
  let s = createSessionState();
  const before = clawdSignals(s.messages).notices;
  s = reduceCliEvent(s, { type: 'system', subtype: 'notification', message: '승인이 필요합니다' });
  assert.equal(clawdSignals(s.messages).notices, before + 1);
  // 작업 중에도 표시된다 — 그러지 않으면 2.4s가 통째로 묻힌다
  assert.equal(
    clawdVisualMood({
      status: 'tool', conn: 'open', transient: 'notify', transientSource: 'live',
    }),
    'notify',
  );
});

test('통합: worktree 생성 도구가 열리면 carry, 결과가 오면 닫힌다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'msg_wt',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'wt1', name: 'Bash', input: { command: 'git worktree add ../feat' } },
      ],
    },
    session_id: 'fake-session-1',
  });
  assert.equal(clawdSignals(s.messages).carrying, true);
  assert.equal(
    clawdVisualMood({ status: s.status, conn: 'open', carrying: true }),
    'carry',
    'carry가 busy를 대체한다',
  );

  s = reduceCliEvent(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'wt1', content: 'Preparing worktree' }],
    },
  });
  assert.equal(clawdSignals(s.messages).carrying, false);
});

test('통합: 턴이 끝나면 열린 worktree 도구도 합성 결과로 닫혀 carry가 고착되지 않는다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'msg_wt2',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'wt2', name: 'EnterWorktree', input: { branch: 'feat' } }],
    },
    session_id: 'fake-session-1',
  });
  assert.equal(clawdSignals(s.messages).carrying, true);
  s = reduceCliEvent(s, { type: 'result', subtype: 'success', is_error: false });
  assert.equal(clawdSignals(s.messages).carrying, false, '고아 도구는 턴 종료가 닫는다');
});

// ----- 도구 실패(PostToolUseFailure) -----

test('clawdSignals: 실패로 끝난 도구 호출 수를 센다 — 증가분이 error의 근거', () => {
  const tool = (extra) => ({ kind: 'tool_use', name: 'Bash', streaming: false, ...extra });
  const sig = clawdSignals([
    tool({ result: { content: 'nope', isError: true } }),
    tool({ result: { content: 'ok', isError: false } }),
    tool({ result: null }), // 아직 실행 중 — 실패가 아니다
    tool({ streaming: true, result: null }), // 입력 스트리밍 중
    tool({ result: { content: 'boom', isError: true } }),
  ]);
  assert.equal(sig.toolErrors, 2);
  assert.equal(clawdSignals([]).toolErrors, 0);
  assert.equal(clawdSignals(undefined).toolErrors, 0);
});

test('clawdSignals: 실행 중인 worktree 도구는 carrying이면서 실패로 세지 않는다', () => {
  const sig = clawdSignals([
    { kind: 'tool_use', name: 'EnterWorktree', streaming: false, result: null },
  ]);
  assert.deepEqual(
    { carrying: sig.carrying, toolErrors: sig.toolErrors },
    { carrying: true, toolErrors: 0 },
  );
});

test('clawdVisualMood: live 반응(도구 실패)은 작업 중에도 보이고, turn 반응은 idle에만', () => {
  const working = { status: 'tool', conn: 'open' };
  // 도구 하나가 실패한 순간 — 턴이 끝나기 전에 알려야 의미가 있다
  assert.equal(clawdVisualMood({ ...working, transient: 'error', transientSource: 'live' }), 'error');
  // 턴 종료 반응은 종전 계약 그대로 — 새 턴이 시작되면 작업 표시가 이긴다
  assert.equal(clawdVisualMood({ ...working, transient: 'error' }), 'busy');
  assert.equal(clawdVisualMood({ ...working, transient: 'error', transientSource: 'turn' }), 'busy');
  // live 반응도 권한 대기·나르기·쓸기는 이기지 못한다(사용자 행동·진행 중인 작업이 우선)
  assert.equal(
    clawdVisualMood({
      status: 'awaiting-permission', conn: 'open', transient: 'error', transientSource: 'live',
    }),
    'alert',
  );
  assert.equal(
    clawdVisualMood({ ...working, carrying: true, transient: 'error', transientSource: 'live' }),
    'carry',
  );
  // 연결이 끊기면 어떤 반응도 무시하고 존다
  assert.equal(
    clawdVisualMood({ status: 'tool', conn: 'closed', transient: 'error', transientSource: 'live' }),
    'doze',
  );
});

test('알림 지속 시간 상수가 따로 있다 — 반응과 독립적으로 조절 가능', () => {
  assert.ok(CLAWD_NOTIFY_MS > 0);
});

test('통합: 도구 하나가 is_error로 실패하면 턴이 끝나기 전에 카운터가 오른다', () => {
  let s = createSessionState();
  s = reduceCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'msg_e',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'e1', name: 'Bash', input: { command: 'false' } }],
    },
    session_id: 'fake-session-1',
  });
  assert.equal(clawdSignals(s.messages).toolErrors, 0, '아직 실행 중');

  s = reduceCliEvent(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'e1', content: 'exit 1', is_error: true },
      ],
    },
  });
  assert.equal(clawdSignals(s.messages).toolErrors, 1, '턴이 끝나기 전에 실패가 보인다');
  // 이 시점 세션은 아직 진행 중(thinking)이므로 live 반응이라야 화면에 나온다
  assert.equal(
    clawdVisualMood({ status: s.status, conn: 'open', transient: 'error', transientSource: 'live' }),
    'error',
  );
});

test('통합: carry 프레임의 좌우 다리는 look 포즈의 반칸 이동과 정확히 같다', () => {
  assert.equal(CLAWD_FRAMES.carryLeft[4], CLAWD_FRAMES.lookLeft[4]);
  assert.equal(CLAWD_FRAMES.carryRight[4], CLAWD_FRAMES.lookRight[4]);
  assert.equal(CLAWD_FRAMES.carryLeft[1], CLAWD_FRAMES.claws[1], '집게는 claws 그대로');
  assert.equal(CLAWD_FRAMES.carryRight[1], CLAWD_FRAMES.claws[1]);
});
