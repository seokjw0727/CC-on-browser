import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ClaudeSession } from '../src/claude-session.js';

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
    assert.equal(initInfo.models[0].value, 'sonnet');
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
