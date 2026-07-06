#!/usr/bin/env node
// 가짜 claude CLI — stream-json 프로토콜 모사 (계획서 "검증된 CLI 프로토콜" 절과 필드 동일).
// 시나리오는 환경변수 FAKE_SCENARIO로 선택: echo(기본) | permission | crash
import { createJsonlParser } from '../src/jsonl.js';

const scenario = process.env.FAKE_SCENARIO || 'echo';
const SESSION_ID = 'fake-session-1';

let userCount = 0;
let permCounter = 0;
const pendingPermissions = new Map(); // request_id -> { toolUseId }

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitResult(text) {
  out({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: SESSION_ID,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
    num_turns: userCount,
    duration_ms: 42,
    is_error: false,
  });
}

function splitIntoThree(text) {
  const size = Math.ceil(text.length / 3) || 1;
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)];
}

function extractText(msg) {
  const content = msg?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }
  return '';
}

function handle(msg) {
  if (msg.type === 'control_request') {
    const { request_id: requestId, request } = msg;
    if (request?.subtype === 'initialize') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            commands: [{ name: 'help', description: 'Show help' }],
            models: [
              { value: 'sonnet', displayName: 'Claude Sonnet', description: 'balanced' },
              { value: 'opus', displayName: 'Claude Opus', description: 'most capable' },
            ],
            account: { email: 'fake@example.com', subscriptionType: 'pro' },
            output_style: 'default',
          },
        },
      });
      out({
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
        cwd: process.cwd(),
        tools: ['Bash', 'Read', 'Write'],
        model: 'sonnet',
      });
    } else {
      // interrupt / set_model / set_permission_mode 등 — 성공 응답
      out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
    }
    return;
  }

  if (msg.type === 'control_response') {
    // 서버의 권한 응답
    const requestId = msg.response?.request_id;
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    pendingPermissions.delete(requestId);
    const behavior = msg.response?.response?.behavior;
    if (behavior === 'allow') {
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: pending.toolUseId, content: 'tool ok', is_error: false }],
        },
        tool_use_result: { success: true },
        session_id: SESSION_ID,
      });
      emitResult('permission allowed');
    } else {
      emitResult('permission denied');
    }
    return;
  }

  if (msg.type === 'user') {
    userCount += 1;
    if (scenario === 'crash') {
      process.exit(3);
    }
    if (scenario === 'permission') {
      permCounter += 1;
      const requestId = `perm_${permCounter}`;
      const toolUseId = `toolu_${permCounter}`;
      pendingPermissions.set(requestId, { toolUseId });
      out({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          display_name: 'Write',
          input: { file_path: 'C:\\fake\\x.txt', content: 'hi' },
          description: 'Write file',
          permission_suggestions: [],
          tool_use_id: toolUseId,
        },
      });
      return;
    }
    // echo 시나리오: text_delta ×3 → assistant → result
    const reply = `echo: ${extractText(msg)}`;
    for (const part of splitIntoThree(reply)) {
      out({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } },
        session_id: SESSION_ID,
      });
    }
    out({
      type: 'assistant',
      message: { id: `msg_fake_${userCount}`, role: 'assistant', content: [{ type: 'text', text: reply }] },
      session_id: SESSION_ID,
    });
    emitResult(reply);
  }
}

const feed = createJsonlParser(handle, () => {});
process.stdin.on('data', feed);
process.stdin.on('end', () => process.exit(0));
