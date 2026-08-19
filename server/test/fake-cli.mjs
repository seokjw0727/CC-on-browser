#!/usr/bin/env node
// 가짜 claude CLI — stream-json 프로토콜 모사 (계획서 "검증된 CLI 프로토콜" 절과 필드 동일).
// 시나리오는 환경변수 FAKE_SCENARIO로 선택:
//   echo(기본) | permission | crash | permission-crash(권한 요청 후 응답 전에 프로세스 사망)
//   | start-fail(스폰 직후 stderr 출력 후 즉시 종료 — --resume 실패류 재현)
//   | subagent(Task tool_use → 지연 → tool_result → result — 마스코트 juggle 관찰용)
//   | question(AskUserQuestion — can_use_tool에 requires_user_interaction:true, 실 CLI 2026-07-12 실측 미러)
//   | bulk(프롬프트 1회당 assistant 텍스트 N개 — 채팅 윈도잉 계약 e2e용)
//   | preview(cwd에 실제 HTML+CSS를 쓰고 Write→Edit tool_use/result 방출 — 미리보기 e2e용)
// 관찰용 env:
//   FAKE_ECHO_DELAY_MS     echo 응답 전 지연(기본 0 — 즉답, 테스트 계약 유지)
//   FAKE_SUBAGENT_MS       subagent 도구 실행 시간(기본 1500ms, 0 허용)
//   FAKE_BULK_COUNT        bulk 시나리오가 한 턴에 뱉는 메시지 수(기본 500)
//   FAKE_SUGGEST_BYPASS=1  permission 시나리오의 제안에 setMode(bypassPermissions) 추가
//                          — 신뢰모드 제안 필터(session-hub) 계약 검증용
//   FAKE_NO_FLAG_SETTINGS=1 apply_flag_settings를 모르는 구버전 CLI 흉내(error 응답)
//                          — 노력 수준 변경의 재시작 폴백 경로 검증용
// 지연 중 interrupt가 오면 대기 턴을 취소하고 is_error result로 닫는다(실 CLI 미러).
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { createJsonlParser } from '../src/jsonl.js';

// `claude remote-control` 분기 — stream-json 루프에 **들어가기 전에** 처리해야 한다.
// 이 인자로 불렸는데 아래 루프로 내려가면 오지 않을 stdin을 무한정 기다려, 원격 제어
// 실패 경로 e2e가 통과 대신 멈춰 버린다.
// 출력은 실 CLI(v2.1.220 / v2.1.233) 캡처를 그대로 미러한다 — ANSI 재그리기 포함.
// FAKE_RC=fail      로그인 실패 문구를 내고 즉시 종료(실패 경로용, 기본값).
// FAKE_RC=ok        Ready + URL을 내고 살아 있는다.
// FAKE_RC=prompt-ok v2.1.233의 최초 1회 동의 프롬프트를 **개행 없이** 낸 뒤 stdin의
//                   'y'를 기다렸다가 Ready로 간다. 답이 없으면(=stdin이 ignore면)
//                   실 CLI처럼 EOF에서 exit 0으로 조용히 죽는다.
// FAKE_RC=untrusted 워크스페이스 신뢰 오류를 stderr로 내고 exit 1.
if (process.argv.includes('remote-control')) {
  const ESC = String.fromCharCode(27); // 소스에 리터럴 제어문자를 두지 않는다
  const nameIdx = process.argv.indexOf('--name');
  const name = nameIdx >= 0 ? process.argv[nameIdx + 1] : 'fake';
  const mode = process.env.FAKE_RC || 'fail';
  const env = process.env.FAKE_RC_ENV || 'env_fake123';
  const readySeq = () =>
    'Remote Control v2.1.220\nSpawn mode: same-dir\n'
    + `Environment ID: ${env}\n`
    + `${ESC}[1A${ESC}[J·|· Connecting · ${name} · master\n`
    + `${ESC}[1A${ESC}[J·✔· Ready · ${name} · master\n`
    + '    Capacity: 0/32 · New sessions will be created in the current directory\n'
    + `Code anywhere with the Claude mobile app or https://claude.ai/code?environment=${env}\n`;
  // 죽이기 전까지 살아 있어야 한다. 미해결 top-level await만으로는 부족하다 —
  // Node가 "버려진 await"를 감지해 exit 13으로 종료한다(codex 지적, 실측 확인).
  // 이벤트 루프를 붙잡는 실제 핸들이 필요하다.
  const stayAlive = () => setInterval(() => {}, 1 << 30);
  if (mode === 'ok') {
    process.stdout.write(readySeq());
    stayAlive();
  } else if (mode === 'prompt-ok') {
    process.stdout.write('Enable Remote Control? (y/n) '); // 개행 없음(실측)
    process.stdin.setEncoding('utf8');
    let answered = false;
    process.stdin.on('data', (chunk) => {
      if (answered || !String(chunk).toLowerCase().includes('y')) return;
      answered = true;
      process.stdout.write(`\n${readySeq()}`);
      stayAlive();
    });
    // 실 CLI 미러: 아무도 답하지 않으면(stdin ignore → 즉시 EOF) 조용히 종료.
    process.stdin.on('end', () => {
      if (!answered) process.exit(0);
    });
  } else if (mode === 'untrusted') {
    process.stderr.write(
      'Error: Workspace not trusted. Please run `claude` in this directory first'
      + ' to review and accept the workspace trust dialog.\n',
      () => process.exit(1),
    );
  } else {
    // 쓰기가 flush된 뒤에 종료한다 — process.exit()를 바로 부르면 파이프에 실린
    // 실패 문구가 잘려 나가고, 서버는 사유 없는 "예기치 않은 종료"만 보게 된다.
    process.stdout.write('Error: You must be logged in to use Remote Control.\n', () => {
      process.exit(1);
    });
  }
  // 아래 stream-json 루프로 절대 내려가지 않는다(내려가면 오지 않을 stdin을 기다린다).
  await new Promise(() => {});
}

const scenario = process.env.FAKE_SCENARIO || 'echo';
const SESSION_ID = 'fake-session-1';
// 실 CLI v2.1.205 initialize 응답 미러(2026-07-08 E2E 캡처, 2026-07-11 실 캡처로 재확인 —
// 완전 일치). init/assistant의 모델 해석에도 재사용하므로 상수로 분리.
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (recommended)', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];
// 모델 보고 형상 — 실 CLI 실측(2026-07-11, opus[1m] 캡처):
//   system/init.model = 해석 id, [1m] 접미사 유지('claude-opus-4-8[1m]')
//   assistant message.model = 해석 id, [1m] 접미사 탈락('claude-opus-4-8')
// --model 생략 기본은 'default' — 자기 카탈로그의 default 행과 일관(DA #22).
const resolveModel = (v) => MODELS.find((m) => m.value === v)?.resolvedModel ?? v;
// 1M 여부는 선택된 카탈로그 행의 양쪽 필드로 판정 — fable처럼 resolvedModel에서
// 접미사가 탈락하는 행은 문자열 검사만으론 자기 카탈로그와 모순된다(codex 지적).
const is1mModel = (v) => {
  const e = MODELS.find((m) => m.value === v || m.resolvedModel === v);
  const fields = e ? [e.value, e.resolvedModel] : [v];
  return fields.some((s) => String(s ?? '').includes('[1m]'));
};
const modelIdx = process.argv.indexOf('--model');
const SPAWNED_MODEL = (modelIdx >= 0 ? process.argv[modelIdx + 1] : null) ?? 'default';
const INIT_MODEL = resolveModel(SPAWNED_MODEL);
// set_model이 갱신하므로 let — 이후 assistant는 새 모델의 bare id를,
// result.modelUsage는 접미사 유지 해석 id 키를 보고(실 CLI 미러).
let currentModel = INIT_MODEL;
let currentIs1m = is1mModel(SPAWNED_MODEL);
let assistantModel = INIT_MODEL.replace(/\[1m\]$/, '');

// start-fail: 실 CLI가 잘못된 --resume 대상 등으로 initialize 응답 전에 죽는 상황
// (stderr "No conversation found with session ID: …" 후 exit 1 — v2.1.206 실측) 재현.
if (scenario === 'start-fail') {
  process.stderr.write('fake start failure: no conversation found\n');
  process.exit(1);
}

let userCount = 0;
let permCounter = 0;
// apply_flag_settings의 누적 상태(shallow merge) — 실 CLI엔 되읽을 채널이 없으므로
// 픽스처에서만 보관해 진단 필드(flag_settings)로 노출한다.
let flagSettings = {};
const pendingPermissions = new Map(); // request_id -> { toolUseId }
// 지연 턴(FAKE_ECHO_DELAY_MS/FAKE_SUBAGENT_MS)의 대기 타이머 — interrupt가
// 취소한다(실 CLI처럼). 기본 즉답 모드에선 항상 비어 있어 동작 불변.
const pendingTurnTimers = new Set();

function scheduleTurn(fn, ms) {
  const t = setTimeout(() => {
    pendingTurnTimers.delete(t);
    fn();
  }, ms);
  pendingTurnTimers.add(t);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// turn: 지연 콜백이 나중에 실행돼도 자기 턴 번호를 보존한다(전역 userCount는
// 그 사이 다음 send로 증가했을 수 있다 — codex 지적).
function emitResult(text, extra = {}, turn = userCount) {
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
    // 실 CLI 미러(2026-07-11 캡처): 키 = 접미사 유지 해석 id, 값에 contextWindow가
    // 직접 실린다 — 클라이언트 CTX 분모의 1차 출처.
    modelUsage: {
      [currentModel]: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 1200,
        cacheCreationInputTokens: 300,
        webSearchRequests: 0,
        costUSD: 0.001,
        contextWindow: currentIs1m ? 1_000_000 : 200_000,
        maxOutputTokens: 64000,
      },
    },
    num_turns: turn,
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
            // goal: 컴포저의 낙관 렌더는 여기 광고된 커맨드만 슬래시 커맨드로 인식한다
            // (Composer.submit의 `known` 판정) — E2E가 GOAL 배지를 띄우려면 필요하다.
            commands: [
              { name: 'help', description: 'Show help' },
              { name: 'goal', description: 'Set the session goal' },
            ],
            models: MODELS,
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
        // 실 CLI는 별칭을 해석해 보고한다 — 'opus[1m]' 스폰 → 'claude-opus-4-8[1m]' (실측)
        model: INIT_MODEL,
      });
    } else {
      // 실 CLI v2.1.206 실측 미러: set_model은 로컬 커맨드 에코(user 이벤트, isReplay),
      // set_permission_mode는 system/status 이벤트를 성공 응답과 함께 방출한다.
      if (request?.subtype === 'set_model') {
        // 이후 턴의 assistant·result가 새 모델을 보고하도록 갱신 —
        // 스테일 모델 경로를 픽스처로 재현 가능하게(DA #22 codex 교차검증).
        currentModel = resolveModel(request.model);
        currentIs1m = is1mModel(request.model);
        assistantModel = currentModel.replace(/\[1m\]$/, '');
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
      // 노력 수준 런타임 변경 — 실 CLI v2.1.233 실측: settings가 객체이면 success,
      // 객체가 아니면(null·배열) error. 여기서 명시적으로 처리하는 이유: 아래 포괄
      // 성공 응답에 묻히면 "구버전 CLI라면 실패했을 요청"까지 우연히 통과해 테스트가
      // 계약을 검증하지 못한다(codex 지적). FAKE_NO_FLAG_SETTINGS=1이면 그 구버전을
      // 흉내 내 error를 돌려준다(폴백 경로 e2e·통합 테스트용).
      if (request?.subtype === 'apply_flag_settings') {
        const bad = !request.settings || typeof request.settings !== 'object'
          || Array.isArray(request.settings);
        if (process.env.FAKE_NO_FLAG_SETTINGS === '1' || bad) {
          out({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: process.env.FAKE_NO_FLAG_SETTINGS === '1'
                ? 'unknown control request subtype: apply_flag_settings'
                : 'apply_flag_settings requires `settings` to be an object',
            },
          });
          return;
        }
        // 적용값을 기억해 두고 진단 필드로 되돌려준다(실 CLI엔 되읽을 채널이 없다).
        flagSettings = { ...flagSettings, ...request.settings };
        out({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { echo_request: request, flag_settings: flagSettings },
          },
        });
        return;
      }
      // interrupt는 지연 턴의 대기 타이머를 취소하고 실 CLI처럼 is_error result로
      // 턴을 닫는다(codex 지적 — 취소 없이는 지연 응답이 그대로 방출돼 "중단했는데
      // 성공 result가 오는" 비현실 상태). 즉답 모드에선 타이머가 없어 동작 불변.
      if (request?.subtype === 'interrupt' && pendingTurnTimers.size > 0) {
        for (const t of pendingTurnTimers) clearTimeout(t);
        pendingTurnTimers.clear();
        emitResult('interrupted', { is_error: true });
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
    if (pending.question) {
      // AskUserQuestion 응답 — 실 CLI 미러(2026-07-12 실측): allow의 updatedInput.answers
      // (질문 텍스트 → 답변 문자열)로 CLI가 tool_result 텍스트를 합성한다.
      // answers가 비면 비-오류 "did not answer" 결과(건너뛰기 경로).
      if (permissionResponse?.behavior === 'allow') {
        const answers = permissionResponse.updatedInput?.answers ?? {};
        const pairs = Object.entries(answers)
          .map(([q, a]) => `"${q}"="${a}"`)
          .join(', ');
        const content = pairs
          ? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
          : 'The user did not answer the questions.';
        out({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: pending.toolUseId, content, is_error: false }],
          },
          tool_use_result: { questions: permissionResponse.updatedInput?.questions ?? [], answers },
          session_id: SESSION_ID,
        });
        emitResult('question answered', { echo_response: permissionResponse });
      } else {
        emitResult('question denied', { echo_response: permissionResponse });
      }
      return;
    }
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
    // 지연 콜백이 실행되는 시점엔 전역 userCount가 다음 send로 증가했을 수 있다 —
    // 이 턴의 번호를 캡처해 message id·num_turns 오염을 막는다(codex 지적).
    const turn = userCount;
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
            // 실 CLI가 신뢰모드 진입을 제안하는 형상 재현 — addRules와 함께 보내
            // "금지 항목만 걸러지고 나머지는 보존"되는 부분 필터 계약을 검증한다.
            ...(process.env.FAKE_SUGGEST_BYPASS === '1'
              ? [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]
              : []),
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
    if (scenario === 'question') {
      // AskUserQuestion — 실 CLI v2.1.207 실측(2026-07-12) 미러: 권한 요청과 같은
      // can_use_tool 채널로 오되 requires_user_interaction:true가 실리고,
      // input.questions[]에 질문/선택지가 담긴다. permission_suggestions는 없다.
      permCounter += 1;
      const requestId = `q_${permCounter}`;
      const toolUseId = `toolu_q_${permCounter}`;
      pendingPermissions.set(requestId, { toolUseId, question: true });
      out({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          display_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '좋아하는 색은?',
                header: '색상',
                options: [
                  { label: '빨강', description: '따뜻한 색상' },
                  { label: '파랑', description: '시원한 색상' },
                ],
                multiSelect: false,
              },
            ],
          },
          tool_use_id: toolUseId,
          requires_user_interaction: true,
        },
      });
      return;
    }
    if (scenario === 'bgtask') {
      // 백그라운드 작업 재현 — 실 CLI v2.1.220 실측 이벤트 그대로.
      // 도크의 유일한 출처가 이 스냅샷이므로, 형식이 어긋나면 도크가 통째로 빈다.
      const toolUseId = `toolu_bg_${turn}`;
      const taskId = `b${turn}xyz`;
      out({
        type: 'assistant',
        message: {
          id: `msg_bg_${turn}`,
          role: 'assistant',
          model: assistantModel,
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'sleep 40', run_in_background: true },
          }],
        },
        session_id: SESSION_ID,
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Command running in background with ID: ${taskId}. …`,
            is_error: false,
          }],
        },
        session_id: SESSION_ID,
      });
      out({
        type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId,
        description: 'sleep 40', task_type: 'local_bash', session_id: SESSION_ID,
      });
      out({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: taskId, task_type: 'local_bash', description: 'sleep 40' }],
        session_id: SESSION_ID,
      });
      out({
        type: 'assistant',
        message: {
          id: `msg_bg_txt_${turn}`,
          role: 'assistant',
          model: assistantModel,
          content: [{ type: 'text', text: '백그라운드로 돌렸습니다.' }],
        },
        session_id: SESSION_ID,
      });
      out({ type: 'result', subtype: 'success', result: '백그라운드로 돌렸습니다.', session_id: SESSION_ID });
      return;
    }

    if (scenario === 'preview') {
      // 결과물 미리보기 e2e용 — **실제로** cwd 안에 파일을 만들고, 그 파일을 가리키는
      // Write(첫 턴)/Edit(이후 턴) tool_use + 성공 tool_result를 뱉는다. 미리보기는
      // 디스크의 진짜 파일을 티켓으로 여는 기능이라, 이벤트만 흉내 내면 검증이 안 된다.
      // 상대 리소스(같은 디렉터리의 CSS)도 같이 만들어 티켓 스코프를 확인할 수 있게 한다.
      const dir = process.cwd();
      const htmlPath = nodePath.join(dir, 'preview-artifact.html');
      const cssPath = nodePath.join(dir, 'preview-artifact.css');
      const first = !nodeFs.existsSync(htmlPath);
      const heading = first ? 'PREVIEW-V1' : 'PREVIEW-V2';
      nodeFs.writeFileSync(cssPath, 'h1{color:rgb(0,128,0)}\n');
      nodeFs.writeFileSync(
        htmlPath,
        `<!doctype html><html><head><meta charset="utf-8">`
        + `<link rel="stylesheet" href="preview-artifact.css"></head>`
        + `<body><h1 id="head">${heading}</h1></body></html>\n`,
      );
      const toolUseId = `toolu_prev_${turn}`;
      out({
        type: 'assistant',
        message: {
          id: `msg_prev_${turn}`,
          role: 'assistant',
          model: assistantModel,
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: first ? 'Write' : 'Edit',
            input: first
              ? { file_path: htmlPath, content: `<h1>${heading}</h1>` }
              : { file_path: htmlPath, old_string: 'PREVIEW-V1', new_string: 'PREVIEW-V2' },
          }],
        },
        session_id: SESSION_ID,
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `${first ? 'Created' : 'Updated'} ${htmlPath}`,
            is_error: false,
          }],
        },
        tool_use_result: { success: true },
        session_id: SESSION_ID,
      });
      emitResult(first ? 'wrote artifact' : 'edited artifact', {}, turn);
      return;
    }

    if (scenario === 'subagent') {
      // Task 도구 실행 재현 — tool_use 확정 후 일정 시간 결과 미도착(서브에이전트
      // 실행 중) 상태를 유지한다. 마스코트 juggle 무드 관찰용.
      const toolUseId = `toolu_task_${turn}`;
      // 0도 유효한 지연이다 — `|| 1500`은 0을 삼킨다
      const rawMs = process.env.FAKE_SUBAGENT_MS;
      const subagentMs =
        rawMs != null && rawMs !== '' && Number.isFinite(Number(rawMs)) ? Number(rawMs) : 1500;
      out({
        type: 'assistant',
        message: {
          id: `msg_task_${turn}`,
          role: 'assistant',
          model: assistantModel, // 실 CLI 미러: assistant엔 [1m] 탈락 bare id (실측)
          content: [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { prompt: '서브에이전트 작업' } }],
        },
        session_id: SESSION_ID,
      });
      scheduleTurn(() => {
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
            id: `msg_task_sum_${turn}`,
            role: 'assistant',
            model: assistantModel,
            content: [{ type: 'text', text: '서브에이전트 완료' }],
          },
          session_id: SESSION_ID,
        });
        emitResult('subagent turn done', {}, turn);
      }, subagentMs);
      return;
    }
    if (scenario === 'bulk') {
      // 대량 메시지 시나리오 — 채팅 목록 윈도잉(client/src/lib/chat-window.js)의
      // 계약을 e2e로 검증하려면 한 번의 전송으로 수백 개의 정상 이벤트가 CLI→서버→
      // WS→리듀서 경로를 그대로 통과해야 한다. 사용자 프롬프트마다 FAKE_BULK_COUNT개의
      // assistant 텍스트 메시지를 순서대로 뱉는다(각 메시지에 순번을 실어 창 경계를 단언).
      const n = Number(process.env.FAKE_BULK_COUNT) || 500;
      for (let i = 0; i < n; i++) {
        out({
          type: 'assistant',
          message: {
            id: `msg_bulk_${turn}_${i}`,
            role: 'assistant',
            model: assistantModel,
            content: [{ type: 'text', text: `bulk-${i}` }],
          },
          session_id: SESSION_ID,
        });
      }
      // 프롬프트에 'raw'가 들어오면 미지의 구조화 이벤트를 하나 더 흘린다 — 리듀서가
      // kind:'raw'로 담고 뷰는 디버그 토글로만 노출하므로, 그 토글이 Message의 memo에
      // 삼켜지지 않는지 e2e가 관측할 지점이 된다(echo 시나리오는 raw를 만들지 않아
      // 검증할 수가 없었다). 프롬프트로 가른 이유는 기본 bulk 턴의 아이템 수를
      // 창 계약 단언과 어긋나지 않게 유지하려는 것이다.
      if (extractText(msg).includes('raw')) {
        out({ type: 'ccob_fake_unknown', note: 'debug probe', session_id: SESSION_ID });
      }
      emitResult(`bulk ${n} done`, {}, turn);
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
        message: { id: `msg_fake_${turn}`, role: 'assistant', model: assistantModel, content: [{ type: 'text', text: reply }] },
        session_id: SESSION_ID,
      });
      emitResult(reply, {}, turn);
    };
    const echoDelay = Number(process.env.FAKE_ECHO_DELAY_MS) || 0;
    if (echoDelay > 0) scheduleTurn(respond, echoDelay);
    else respond();
  }
}

const feed = createJsonlParser(handle, () => {});
process.stdin.on('data', feed);
process.stdin.on('end', () => process.exit(0));
