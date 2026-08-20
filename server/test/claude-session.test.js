import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ClaudeSession } from '../src/claude-session.js';
import { killTree } from '../src/kill-tree.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

function makeSession(scenario) {
  process.env.FAKE_SCENARIO = scenario;
  return new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
  });
}

function trackExit(session) {
  let code = null;
  let exited = false;
  const promise = new Promise((resolve) => {
    session.once('exit', (c) => {
      exited = true;
      code = c;
      resolve(c);
    });
  });
  return {
    promise,
    get exited() { return exited; },
    get code() { return code; },
  };
}

function waitForEvent(session, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for event'));
    }, timeoutMs);
    function onEvent(msg) {
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      session.off('event', onEvent);
    }
    session.on('event', onEvent);
  });
}

async function shutdown(session, exit) {
  session.stop();
  await exit.promise;
}

test('(a) start() returns initInfo; sessionId set after system/init', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    const initEventP = waitForEvent(session, (m) => m.type === 'system' && m.subtype === 'init');
    const initInfo = await session.start();
    assert.ok(Array.isArray(initInfo.commands));
    assert.ok(Array.isArray(initInfo.models));
    assert.ok(initInfo.models.some((m) => m.value === 'sonnet'));
    assert.equal(initInfo.account.email, 'fake@example.com');
    assert.equal(initInfo.output_style, 'default');
    await initEventP;
    assert.equal(session.sessionId, 'fake-session-1');
  } finally {
    await shutdown(session, exit);
  }
});

test('(b) echo scenario: 3 stream_events, then assistant, then result', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    const events = [];
    session.on('event', (m) => events.push(m));
    const resultP = waitForEvent(session, (m) => m.type === 'result');
    session.sendUserText('hello');
    await resultP;
    const types = events
      .filter((m) => ['stream_event', 'assistant', 'result'].includes(m.type))
      .map((m) => m.type);
    assert.deepEqual(types, ['stream_event', 'stream_event', 'stream_event', 'assistant', 'result']);
    const streamed = events
      .filter((m) => m.type === 'stream_event')
      .map((m) => m.event.delta.text)
      .join('');
    assert.equal(streamed, 'echo: hello');
    const assistant = events.find((m) => m.type === 'assistant');
    assert.equal(assistant.message.content[0].text, 'echo: hello');
  } finally {
    await shutdown(session, exit);
  }
});

test('(c) permission allow: permission_request -> respondPermission -> tool_result -> result', async () => {
  const session = makeSession('permission');
  const exit = trackExit(session);
  try {
    await session.start();
    const events = [];
    session.on('event', (m) => events.push(m));
    const permP = new Promise((resolve) => session.once('permission_request', resolve));
    const resultP = waitForEvent(session, (m) => m.type === 'result');
    session.sendUserText('write a file');
    const perm = await permP;
    assert.equal(perm.toolName, 'Write');
    assert.equal(perm.displayName, 'Write');
    assert.ok(perm.requestId);
    assert.equal(perm.toolUseId, 'toolu_1');
    assert.deepEqual(perm.input, { file_path: 'C:\\fake\\x.txt', content: 'hi' });
    assert.deepEqual(perm.suggestions, [
      { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
    ]);
    // 일반 권한 요청은 requires_user_interaction이 없다 → false로 정규화
    assert.equal(perm.requiresUserInteraction, false);

    // pending에 없는 requestId는 false
    assert.equal(session.respondPermission('nonexistent', { behavior: 'allow' }), false);
    assert.equal(
      session.respondPermission(perm.requestId, { behavior: 'allow', updatedInput: perm.input }),
      true,
    );
    // 같은 요청에 두 번째 응답은 false
    assert.equal(
      session.respondPermission(perm.requestId, { behavior: 'allow', updatedInput: perm.input }),
      false,
    );

    const result = await resultP;
    assert.equal(result.result, 'permission allowed');
    const toolResult = events.find(
      (m) => m.type === 'user' && Array.isArray(m.message?.content)
        && m.message.content.some((c) => c.type === 'tool_result'),
    );
    assert.ok(toolResult, 'tool_result user event should arrive before result');
    assert.equal(toolResult.message.content[0].tool_use_id, perm.toolUseId);
  } finally {
    await shutdown(session, exit);
  }
});

test('(d) permission deny: result arrives without tool_result', async () => {
  const session = makeSession('permission');
  const exit = trackExit(session);
  try {
    await session.start();
    const events = [];
    session.on('event', (m) => events.push(m));
    const permP = new Promise((resolve) => session.once('permission_request', resolve));
    const resultP = waitForEvent(session, (m) => m.type === 'result');
    session.sendUserText('write a file');
    const perm = await permP;
    assert.equal(
      session.respondPermission(perm.requestId, { behavior: 'deny', message: '사용자가 거부' }),
      true,
    );
    const result = await resultP;
    assert.equal(result.result, 'permission denied');
    const toolResult = events.find(
      (m) => m.type === 'user' && Array.isArray(m.message?.content)
        && m.message.content.some((c) => c.type === 'tool_result'),
    );
    assert.equal(toolResult, undefined);
  } finally {
    await shutdown(session, exit);
  }
});

test('(e) crash scenario: exit emitted; sendUserText after exit does not throw', async () => {
  const session = makeSession('crash');
  const exit = trackExit(session);
  await session.start();
  session.sendUserText('boom');
  const code = await exit.promise;
  assert.equal(code, 3);
  assert.doesNotThrow(() => session.sendUserText('after crash'));
});

test('(f) multi-turn: second sendUserText after result yields second result', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    const r1p = waitForEvent(session, (m) => m.type === 'result');
    session.sendUserText('one');
    const r1 = await r1p;
    assert.equal(r1.result, 'echo: one');
    assert.equal(r1.num_turns, 1);
    const r2p = waitForEvent(session, (m) => m.type === 'result' && m.result === 'echo: two');
    session.sendUserText('two');
    const r2 = await r2p;
    assert.equal(r2.num_turns, 2);
  } finally {
    await shutdown(session, exit);
  }
});

test('(g) interrupt/setModel/setPermissionMode/setMaxThinkingTokens resolve on success control_response', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    await session.interrupt();
    await session.setModel('sonnet');
    await session.setPermissionMode('acceptEdits');
    await session.setMaxThinkingTokens(10000);
  } finally {
    await shutdown(session, exit);
  }
});

test('(h) effort 옵션이 spawn argv에 --effort로 전달된다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    effort: 'xhigh',
  });
  const exit = trackExit(session);
  try {
    const initInfo = await session.start();
    const argv = initInfo.argv; // fake-cli가 에코한 자신의 argv
    const i = argv.indexOf('--effort');
    assert.ok(i >= 0, `--effort not in argv: ${argv.join(' ')}`);
    assert.equal(argv[i + 1], 'xhigh');
  } finally {
    await shutdown(session, exit);
  }
});

test('(h2) setEffort: apply_flag_settings 제어 요청으로 런타임 변경 — 재시작 없음', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    effort: 'low',
  });
  const exit = trackExit(session);
  try {
    await session.start();
    assert.equal(session.effort, 'low');
    assert.equal(session.ultracode, false);
    await session.setEffort('max');
    // 프로세스는 살아 있다 — 변경이 재시작이 아니라는 계약의 핵심
    assert.equal(exit.exited, false);
    assert.equal(session.effort, 'max');

    await session.setEffort('xhigh', { ultracode: true });
    assert.equal(session.effort, 'xhigh');
    assert.equal(session.ultracode, true);
    // null = CLI 기본으로 되돌리기
    await session.setEffort(null);
    assert.equal(session.effort, undefined);
    assert.equal(session.ultracode, false);
  } finally {
    await shutdown(session, exit);
  }
});

test('(h3) setEffort 와이어 형상 — settings에 effortLevel·ultracode가 실린다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
  });
  const exit = trackExit(session);
  try {
    await session.start();
    // 픽스처가 되돌려주는 진단 필드로 실제 전송 형상을 단언한다 — 실 CLI v2.1.233의
    // /effort와 동일한 채널·필드(subtype/settings.effortLevel/settings.ultracode)를 쓴다.
    const res = await session.setEffort('xhigh', { ultracode: true });
    assert.equal(res.echo_request.subtype, 'apply_flag_settings');
    assert.deepEqual(res.echo_request.settings, { effortLevel: 'xhigh', ultracode: true });
    // settings는 shallow merge라 픽스처의 누적 상태로도 확인된다
    assert.deepEqual(res.flag_settings, { effortLevel: 'xhigh', ultracode: true });
    const res2 = await session.setEffort('low');
    assert.deepEqual(res2.echo_request.settings, { effortLevel: 'low', ultracode: false });
  } finally {
    await shutdown(session, exit);
  }
});

test('(h4) ultracode 세션: --effort는 xhigh로 스폰하고 플래그는 initialize 뒤에 얹는다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    effort: 'xhigh',
    ultracode: true,
  });
  const exit = trackExit(session);
  try {
    const initInfo = await session.start();
    const argv = initInfo.argv;
    // 스폰 인자에는 'ultracode'가 아니라 CLI가 받는 xhigh만 나간다
    assert.equal(argv[argv.indexOf('--effort') + 1], 'xhigh');
    assert.equal(argv.includes('ultracode'), false);
    // start()가 반환될 때 플래그가 이미 적용돼 있다(핸드셰이크 뒤 순차 적용)
    assert.equal(session.ultracode, true);
    assert.equal(session.effort, 'xhigh');
  } finally {
    await shutdown(session, exit);
  }
});

test('(h5) ultracode 적용 실패는 세션 시작을 죽이지 않고 상태만 정직하게 남는다', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  process.env.FAKE_NO_FLAG_SETTINGS = '1'; // apply_flag_settings를 모르는 구버전 CLI 흉내
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    effort: 'xhigh',
    ultracode: true,
  });
  const exit = trackExit(session);
  try {
    const initInfo = await session.start(); // 거부되지 않는다
    assert.ok(Array.isArray(initInfo.models));
    // effortLevel은 --effort로 이미 걸렸고, 얹지 못한 플래그만 false로 남는다
    assert.equal(session.effort, 'xhigh');
    assert.equal(session.ultracode, false);
    // 런타임 변경도 실패를 그대로 알린다(클라이언트의 재시작 폴백 트리거)
    await assert.rejects(() => session.setEffort('max'), /apply_flag_settings/);
    // 실패한 값은 기억하지 않는다 — 이후 재시작 스폰 인자가 어긋나지 않도록
    assert.equal(session.effort, 'xhigh');
  } finally {
    delete process.env.FAKE_NO_FLAG_SETTINGS;
    await shutdown(session, exit);
  }
});

test('(i) start-fail: initialize 전에 죽으면 start()가 stderr 원인을 담아 거부한다', async () => {
  const session = makeSession('start-fail');
  const exit = trackExit(session);
  await assert.rejects(
    () => session.start(),
    (err) => {
      assert.match(err.message, /claude process exited \(code 1\)/);
      // stderr 꼬리가 에러 메시지에 실린다 — 사용자 토스트에 원인이 그대로 보이도록
      assert.match(err.message, /no conversation found/);
      return true;
    },
  );
  await exit.promise;
});

test('(j) set_model은 로컬 커맨드 에코(user, isReplay)를 방출한다 — v2.1.206 미러 고정', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    const echoP = waitForEvent(
      session,
      (m) => m.type === 'user' && typeof m.message?.content === 'string',
    );
    await session.setModel('sonnet');
    const echo = await echoP;
    assert.equal(echo.isReplay, true);
    assert.match(echo.message.content, /^<local-command-stdout>Set model to sonnet/);
  } finally {
    await shutdown(session, exit);
  }
});

test('(k) set_permission_mode는 system/status(permissionMode)를 방출한다 — v2.1.206 미러 고정', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    const statusP = waitForEvent(session, (m) => m.type === 'system' && m.subtype === 'status');
    await session.setPermissionMode('plan');
    const status = await statusP;
    assert.equal(status.permissionMode, 'plan');
    assert.equal(status.status, null);
  } finally {
    await shutdown(session, exit);
  }
});

test('(l) question: AskUserQuestion 요청은 requiresUserInteraction=true, allow+answers가 tool_result로 반영된다', async () => {
  const session = makeSession('question');
  const exit = trackExit(session);
  try {
    await session.start();
    const events = [];
    session.on('event', (m) => events.push(m));
    const permP = new Promise((resolve) => session.once('permission_request', resolve));
    const resultP = waitForEvent(session, (m) => m.type === 'result');
    session.sendUserText('색을 물어봐');
    const perm = await permP;
    assert.equal(perm.toolName, 'AskUserQuestion');
    // 질문/권한 구분 신호 — 실 CLI v2.1.207 실측(2026-07-12)
    assert.equal(perm.requiresUserInteraction, true);
    assert.ok(Array.isArray(perm.input.questions));
    const q = perm.input.questions[0];
    assert.equal(q.question, '좋아하는 색은?');
    assert.equal(q.options.length, 2);

    // 실측 응답 형식: allow + updatedInput{...input, answers:{질문: 라벨}}
    assert.equal(
      session.respondPermission(perm.requestId, {
        behavior: 'allow',
        updatedInput: { ...perm.input, answers: { [q.question]: q.options[0].label } },
      }),
      true,
    );
    const result = await resultP;
    assert.equal(result.echo_response.behavior, 'allow');
    assert.deepEqual(result.echo_response.updatedInput.answers, { '좋아하는 색은?': '빨강' });
    const toolResult = events.find(
      (m) => m.type === 'user' && Array.isArray(m.message?.content)
        && m.message.content.some((c) => c.type === 'tool_result'),
    );
    assert.ok(toolResult, 'tool_result user event should arrive before result');
    assert.match(toolResult.message.content[0].content, /Your questions have been answered/);
    assert.deepEqual(toolResult.tool_use_result.answers, { '좋아하는 색은?': '빨강' });
  } finally {
    await shutdown(session, exit);
  }
});

test('(m) 신뢰모드 가드: 비신뢰 스폰 세션의 bypassPermissions 전환은 거부되고 CLI에 전송되지 않는다', async () => {
  const session = makeSession('echo'); // permissionMode 미지정 = 비신뢰 스폰
  const exit = trackExit(session);
  try {
    await session.start();
    assert.equal(session.spawnPermissionMode, undefined);
    const statuses = [];
    session.on('event', (m) => {
      if (m.type === 'system' && m.subtype === 'status') statuses.push(m.permissionMode);
    });
    await assert.rejects(
      () => session.setPermissionMode('bypassPermissions'),
      /신뢰모드는 세션 시작 시에만/,
    );
    // 미전송 검증 — fake-cli는 set_permission_mode마다 system/status를 방출하고
    // stdin을 직렬 처리하므로, 이어지는 plan 전환의 status가 도착한 시점에
    // bypass status가 관측되지 않았다면 애초에 CLI로 나가지 않은 것이다.
    const statusP = waitForEvent(session, (m) => m.type === 'system' && m.subtype === 'status');
    await session.setPermissionMode('plan');
    await statusP;
    assert.deepEqual(statuses, ['plan']);
  } finally {
    await shutdown(session, exit);
  }
});

test('(n) 신뢰모드 스폰 세션: --permission-mode 전달, 타 모드 전환 후 신뢰모드 복귀 허용', async () => {
  process.env.FAKE_SCENARIO = 'echo';
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  const exit = trackExit(session);
  try {
    const initInfo = await session.start();
    assert.equal(session.spawnPermissionMode, 'bypassPermissions');
    const i = initInfo.argv.indexOf('--permission-mode');
    assert.ok(i >= 0, `--permission-mode not in argv: ${initInfo.argv.join(' ')}`);
    assert.equal(initInfo.argv[i + 1], 'bypassPermissions');
    await session.setPermissionMode('plan');
    // 신뢰모드로 시작한 세션은 복귀 가능 — 스폰 계보가 기준이므로 거부되지 않는다
    const statusP = waitForEvent(
      session,
      (m) => m.type === 'system' && m.subtype === 'status' && m.permissionMode === 'bypassPermissions',
    );
    await session.setPermissionMode('bypassPermissions');
    await statusP;
  } finally {
    await shutdown(session, exit);
  }
});

test('(g2) setMaxThinkingTokens wire format — subtype/필드명이 실측 프로토콜과 일치', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  try {
    await session.start();
    // fake-cli가 echo_request로 요청 원문을 되돌려준다 — 필드명 오타/드리프트를 고정
    const budget = await session.setMaxThinkingTokens(31999);
    assert.equal(budget.echo_request.subtype, 'set_max_thinking_tokens');
    assert.equal(budget.echo_request.max_thinking_tokens, 31999);

    const off = await session.setMaxThinkingTokens(0);
    assert.equal(off.echo_request.max_thinking_tokens, 0);

    const auto = await session.setMaxThinkingTokens(null);
    assert.equal(auto.echo_request.max_thinking_tokens, null);
  } finally {
    await shutdown(session, exit);
  }
});

// ── 완전 종료(terminate) ────────────────────────────────────────────────────
// 배경: stop()은 stdin만 닫고 즉시 반환하며 kill 타이머가 unref돼 있다. 데몬이 곧바로
// process.exit()하면 그 타이머는 발화하지 못하고, Windows에선 부모가 죽어도 자식이
// 살아남아 진행 중이던 claude가 고아로 남았다. terminate()는 그 계약을 뒤집는다 —
// **실제 사망을 확인한 뒤에만** resolve한다.

function alive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return;
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('(o) terminate(): stdin EOF를 무시하는 세션도 강제 종료하고 사망을 확인한다', async () => {
  const session = makeSession('hang');
  const info = await session.start();
  const { pid } = info;
  assert.ok(pid, 'fake CLI가 진단 필드로 pid를 보고해야 한다');
  assert.equal(alive(pid), true, '시작 직후에는 살아 있어야 한다');

  // graceMs를 짧게 준다 — hang 픽스처는 EOF에 절대 내려가지 않으므로 유예는 낭비다.
  const dead = await session.terminate({ graceMs: 200, killWaitMs: 5000 });
  assert.equal(dead, true, 'terminate는 사망을 확인하고 true를 돌려줘야 한다');
  await waitDead(pid);
});

test('(o2) terminate()는 멱등 — 두 번 불러도 같은 종료 절차를 공유한다', async () => {
  const session = makeSession('hang');
  const info = await session.start();
  const first = session.terminate({ graceMs: 100, killWaitMs: 5000 });
  const second = session.terminate({ graceMs: 100, killWaitMs: 5000 });
  assert.equal(first, second, '두 번째 호출은 진행 중인 Promise를 그대로 돌려준다');
  assert.equal(await first, true);
  await waitDead(info.pid);
});

test('(o3) 이미 종료된 세션의 terminate()는 즉시 true', async () => {
  const session = makeSession('echo');
  const exit = trackExit(session);
  const info = await session.start();
  session.stop();
  await exit.promise;
  await waitDead(info.pid);

  const startedAt = Date.now();
  assert.equal(await session.terminate(), true);
  // 유예(3초)를 태우지 않고 곧바로 돌아와야 한다 — 종료 경로의 지연은 사용자가 기다린다.
  assert.ok(Date.now() - startedAt < 1000, '이미 죽은 프로세스를 기다리지 않는다');
});
// 아래 두 건은 트리 종료를 **가짜로** 주입해 관측한다(진짜로 죽이면 호출 여부를
// 구분할 수 없다). 그래서 각 테스트는 끝에서 진짜 트리 종료로 뒷정리한다 —
// 안 그러면 살아남은 자식이 테스트 러너의 이벤트 루프를 붙잡는다.
function spyKillTree() {
  const calls = [];
  return { calls, fn: (pid, opts) => { calls.push({ pid, ...opts }); return Promise.resolve(); } };
}

async function reallyKill(pid) {
  await killTree(pid, { platform: process.platform, force: true });
  await waitDead(pid);
}

test('(o4) stop()의 최후 수단은 트리째 종료한다 — 단일 kill은 CLI의 자식을 남긴다', async () => {
  process.env.FAKE_SCENARIO = 'hang';
  const spy = spyKillTree();
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    stopKillTimeoutMs: 100, // 5초 유예를 테스트에서 기다릴 이유는 없다
    killTree: spy.fn,
  });
  const info = await session.start();
  session.stop(); // hang 픽스처는 EOF에 안 내려간다 → 최후 수단이 발화한다
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(spy.calls.length, 1, '트리 종료가 정확히 한 번 발화해야 한다');
  assert.equal(spy.calls[0].pid, info.pid);
  assert.equal(spy.calls[0].force, true);
  await reallyKill(info.pid);
});

test('(o5) terminate()가 실패하면 재시도 여지를 남긴다 — 실패를 캐시하지 않는다', async () => {
  process.env.FAKE_SCENARIO = 'hang';
  const spy = spyKillTree(); // 아무것도 죽이지 않는다 = 강제 종료 실패 재현
  const session = new ClaudeSession({
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    cwd: process.cwd(),
    killTree: spy.fn,
  });
  const info = await session.start();
  assert.equal(await session.terminate({ graceMs: 50, killWaitMs: 100 }), false);
  assert.equal(spy.calls.length, 1);
  // 실패한 결과를 캐시해 버리면 이후 어떤 경로로도 이 프로세스를 죽일 수 없다.
  assert.equal(await session.terminate({ graceMs: 50, killWaitMs: 100 }), false);
  assert.equal(spy.calls.length, 2, '두 번째 terminate가 실제로 다시 시도해야 한다');
  await reallyKill(info.pid);
});
