#!/usr/bin/env node
// 가짜 claude CLI — stream-json 프로토콜 모사 (계획서 "검증된 CLI 프로토콜" 절과 필드 동일).
// 시나리오는 환경변수 FAKE_SCENARIO로 선택:
//   echo(기본) | permission | crash | permission-crash(권한 요청 후 응답 전에 프로세스 사망)
//   | start-fail(스폰 직후 stderr 출력 후 즉시 종료 — --resume 실패류 재현)
//   | subagent(Task tool_use → 지연 → tool_result → result — 마스코트 juggle 관찰용)
// 관찰용 env:
//   FAKE_ECHO_DELAY_MS     echo 응답 전 지연(기본 0 — 즉답, 테스트 계약 유지)
//   FAKE_SUBAGENT_MS       subagent 도구 실행 시간(기본 1500ms, 0 허용)
import { createJsonlParser } from '../src/jsonl.js';

const scenario = process.env.FAKE_SCENARIO || 'echo';
const SESSION_ID = 'fake-session-1';
// 실 CLI처럼 system/init이 스폰된 --model을 보고하도록 argv를 미러링 (기본 sonnet)
const modelIdx = process.argv.indexOf('--model');
const SPAWNED_MODEL = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'sonnet';

// start-fail: 실 CLI가 잘못된 --resume 대상 등으로 initialize 응답 전에 죽는 상황
// (stderr "No conversation found with session ID: …" 후 exit 1 — v2.1.206 실측) 재현.
if (scenario === 'start-fail') {
  process.stderr.write('fake start failure: no conversation found\n');
  process.exit(1);
}

let userCount = 0;
let permCounter = 0;
const pendingPermissions = new Map(); // request_id -> { toolUseId }

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitResult(text, extra = {}) {
  out({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: SESSION_ID,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 300,
    },
    num_turns: userCount,
    duration_ms: 42,
    is_error: false,
    ...extra,
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
            // 실 CLI v2.1.205 initialize 응답을 미러링 (2026-07-08 E2E 캡처와 동일 형태)
            models: [
              { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (recommended)', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
              { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
              { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
              { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
              { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
            ],
            account: { email: 'fake@example.com', subscriptionType: 'pro' },
            output_style: 'default',
            // 픽스처 전용 진단: spawn argv 에코 (--effort 등 플래그 전달 검증용)
            argv: process.argv.slice(2),
          },
        },
      });
      out({
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
        cwd: process.cwd(),
        tools: ['Bash', 'Read', 'Write'],
        model: SPAWNED_MODEL,
      });
    } else {
      // 실 CLI v2.1.206 실측 미러: set_model은 로컬 커맨드 에코(user 이벤트, isReplay),
      // set_permission_mode는 system/status 이벤트를 성공 응답과 함께 방출한다.
      if (request?.subtype === 'set_model') {
        out({
          type: 'user',
          message: {
            role: 'user',
            content: `<local-command-stdout>Set model to ${request.model}</local-command-stdout>`,
          },
          session_id: SESSION_ID,
          parent_tool_use_id: null,
          isReplay: true,
        });
      }
      if (request?.subtype === 'set_permission_mode') {
        out({
          type: 'system',
          subtype: 'status',
          status: null,
          permissionMode: request.mode,
          session_id: SESSION_ID,
        });
      }
      // interrupt / set_model / set_permission_mode / set_max_thinking_tokens 등 — 성공 응답.
      // echo_request: 받은 요청을 그대로 되돌려주는 픽스처 전용 진단 필드(wire format 검증용).
      out({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { echo_request: request } },
      });
    }
    return;
  }

  if (msg.type === 'control_response') {
    // 서버의 권한 응답
    const requestId = msg.response?.request_id;
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    pendingPermissions.delete(requestId);
    const permissionResponse = msg.response?.response;
    if (permissionResponse?.behavior === 'allow') {
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: pending.toolUseId, content: 'tool ok', is_error: false }],
        },
        tool_use_result: { success: true },
        session_id: SESSION_ID,
      });
      // echo_response: 수신한 권한 응답을 그대로 되돌려주는 픽스처 전용 진단 필드
      emitResult('permission allowed', { echo_response: permissionResponse });
    } else {
      emitResult('permission denied', { echo_response: permissionResponse });
    }
    return;
  }

  if (msg.type === 'user') {
    userCount += 1;
    if (scenario === 'crash') {
      process.exit(3);
    }
    if (scenario === 'permission' || scenario === 'permission-crash') {
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
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Write' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
          tool_use_id: toolUseId,
        },
      });
      // permission-crash: 권한 응답이 오기 전에 프로세스가 죽는 상황(크래시) 재현.
      // 기본 250ms(테스트 신속), FAKE_CRASH_DELAY_MS로 조정 가능(수동 재현/관찰용).
      if (scenario === 'permission-crash') {
        setTimeout(() => process.exit(3), Number(process.env.FAKE_CRASH_DELAY_MS) || 250);
      }
      return;
    }
    if (scenario === 'subagent') {
      // Task 도구 실행 재현 — tool_use 확정 후 일정 시간 결과 미도착(서브에이전트
      // 실행 중) 상태를 유지한다. 마스코트 juggle 무드 관찰용.
      const toolUseId = `toolu_task_${userCount}`;
      // 0도 유효한 지연이다 — `|| 1500`은 0을 삼킨다
      const rawMs = process.env.FAKE_SUBAGENT_MS;
      const subagentMs =
        rawMs != null && rawMs !== '' && Number.isFinite(Number(rawMs)) ? Number(rawMs) : 1500;
      out({
        type: 'assistant',
        message: {
          id: `msg_task_${userCount}`,
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { prompt: '서브에이전트 작업' } }],
        },
        session_id: SESSION_ID,
      });
      setTimeout(() => {
        out({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'subagent done', is_error: false }],
          },
          tool_use_result: { success: true },
          session_id: SESSION_ID,
        });
        out({
          type: 'assistant',
          message: {
            id: `msg_task_sum_${userCount}`,
            role: 'assistant',
            content: [{ type: 'text', text: '서브에이전트 완료' }],
          },
          session_id: SESSION_ID,
        });
        emitResult('subagent turn done');
      }, subagentMs);
      return;
    }
    // echo 시나리오: text_delta ×3 → assistant → result
    const respond = () => {
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
    };
    const echoDelay = Number(process.env.FAKE_ECHO_DELAY_MS) || 0;
    if (echoDelay > 0) setTimeout(respond, echoDelay);
    else respond();
  }
}

const feed = createJsonlParser(handle, () => {});
process.stdin.on('data', feed);
process.stdin.on('end', () => process.exit(0));
