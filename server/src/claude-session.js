// claude.exe stream-json 브리지. 미문서 CLI 프로토콜 지식은 이 파일에 격리한다.
// 프로토콜 상세: docs/superpowers/plans/2026-07-06-claude-code-on-browser.md "검증된 CLI 프로토콜" 절.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createJsonlParser } from './jsonl.js';

const INIT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 30_000;
const STOP_KILL_TIMEOUT_MS = 5_000;

export class ClaudeSession extends EventEmitter {
  #cliPath;
  #cliArgsPrefix;
  #cwd;
  #model;
  #permissionMode;
  #effort;
  // 요청(스폰 인자)과 실제 적용 상태를 분리해 둔다 — 얹기에 실패한 플래그를 적용된
  // 것처럼 기억하면 UI가 CLI 상태를 잘못 광고한다.
  #ultracodeRequested;
  #ultracode = false;
  #resumeSessionId;
  #proc = null;
  #exited = false;
  #stopTimer = null;
  #nextRequestId = 0;
  /** 최근 stderr 라인(최대 3) — 조기 종료 시 원인("No conversation found…")을 에러 메시지에 싣는다 */
  #stderrTail = [];
  /** @type {Map<string, object>} requestId -> 원본 can_use_tool 메시지 */
  #pendingPermissions = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  #pendingControl = new Map();

  sessionId = null;

  constructor({
    cliPath, cliArgsPrefix = [], cwd, model, permissionMode, effort, ultracode = false, resumeSessionId,
  } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    if (!cwd) throw new TypeError('cwd is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#cwd = cwd;
    this.#model = model;
    this.#permissionMode = permissionMode;
    // effort(low|medium|high|xhigh|max)는 시작 시 --effort로 전달하고, 이후에는
    // setEffort()의 런타임 채널로 바꾼다(재시작 불필요 — v2.1.233 실측, setEffort 주석 참조).
    this.#effort = effort;
    // ultracode는 --effort 값이 아니라 별개의 플래그 설정이다(CLI의 /effort ultracode는
    // effortLevel 'xhigh' + ultracode true를 함께 보낸다 — v2.1.233 바이너리 실측).
    // 스폰 인자로는 전달할 수 없어 initialize 직후 setEffort로 얹는다(start() 참조).
    this.#ultracodeRequested = ultracode === true;
    this.#resumeSessionId = resumeSessionId;
  }

  async start() {
    if (this.#proc) throw new Error('session already started');
    const args = [
      ...this.#cliArgsPrefix,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      ...(this.#model ? ['--model', this.#model] : []),
      ...(this.#permissionMode ? ['--permission-mode', this.#permissionMode] : []),
      ...(this.#effort ? ['--effort', this.#effort] : []),
      ...(this.#resumeSessionId ? ['--resume', this.#resumeSessionId] : []),
    ];
    this.#proc = spawn(this.#cliPath, args, {
      cwd: this.#cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // 종료된 프로세스에 쓰다 EPIPE로 죽지 않도록.
    this.#proc.stdin.on('error', () => {});

    const feedStdout = createJsonlParser(
      (msg) => this.#handleMessage(msg),
      (line) => this.emit('raw', line),
    );
    this.#proc.stdout.on('data', feedStdout);

    let errBuf = '';
    this.#proc.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
      let idx;
      while ((idx = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, idx).replace(/\r$/, '');
        errBuf = errBuf.slice(idx + 1);
        if (line) {
          this.#stderrTail = [...this.#stderrTail, line].slice(-3);
          this.emit('raw', line);
        }
      }
    });

    this.#proc.on('error', (err) => {
      this.#failPendingControl(err);
      this.#handleExit(null);
    });
    this.#proc.on('close', (code) => this.#handleExit(code));

    const initInfo = await this.#sendControlRequest({ subtype: 'initialize' }, INIT_TIMEOUT_MS);
    // ultracode는 스폰 플래그가 없으므로 initialize가 끝난 뒤에 얹는다 — 핸드셰이크와
    // 경쟁시키지 않으려 반드시 응답 이후다. 실패해도 세션 시작 자체는 살린다:
    // effortLevel은 이미 --effort로 적용됐고 ultracode는 그 위의 부가 모드일 뿐이다.
    if (this.#ultracodeRequested) {
      try {
        await this.setEffort(this.#effort ?? null, { ultracode: true });
      } catch (err) {
        this.emit('raw', `ultracode 적용 실패 (노력 수준은 유지): ${err?.message ?? err}`);
      }
    }
    return initInfo;
  }

  sendUserText(text) {
    return this.#write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  respondPermission(requestId, result) {
    if (!this.#pendingPermissions.has(requestId)) return false;
    this.#pendingPermissions.delete(requestId);
    this.#write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: result },
    });
    return true;
  }

  async interrupt() {
    await this.#sendControlRequest({ subtype: 'interrupt' });
  }

  async setModel(model) {
    await this.#sendControlRequest({ subtype: 'set_model', model });
  }

  /** 스폰 시 --permission-mode로 전달된 모드 (미지정이면 undefined = CLI 기본 default) */
  get spawnPermissionMode() {
    return this.#permissionMode;
  }

  async setPermissionMode(mode) {
    // 신뢰모드는 스폰 시에만 진입 가능 — 런타임 전환 요청은 CLI에 보내지 않고 거부한다.
    // 신뢰모드로 스폰된 세션만 타 모드로 갔다가 복귀할 수 있다.
    if (mode === 'bypassPermissions' && this.#permissionMode !== 'bypassPermissions') {
      throw new Error('신뢰모드는 세션 시작 시에만 설정할 수 있습니다');
    }
    await this.#sendControlRequest({ subtype: 'set_permission_mode', mode });
  }

  /** 현재 노력 수준 — 스폰 인자 또는 마지막 setEffort 성공값 (미지정이면 undefined = CLI 기본) */
  get effort() {
    return this.#effort;
  }

  /** ultracode 플래그가 **실제로 적용됐는가** — 요청만 하고 실패한 경우는 false. */
  get ultracode() {
    return this.#ultracode;
  }

  /**
   * 노력 수준 런타임 변경 — 세션 재시작 없이 실행 중 프로세스에 적용한다.
   * CLI v2.1.233 실측: 우리와 동일한 stream-json 스폰에서 apply_flag_settings 제어
   * 요청이 success를 돌려준다(바이너리 설명: "Shallow-merge flag-settings patch —
   * same shape as SDKControlApplyFlagSettingsRequest.settings"). CLI 자신의 /effort도
   * 같은 채널·같은 필드를 쓴다. settings는 shallow merge라 바꿀 키만 싣는다.
   *
   * 주의: 이 채널은 값을 검증하지 않는다 — effortLevel:'bogus-level'도 success다(실측).
   * 즉 success는 "요청 수용"이지 "유효값 적용"이 아니므로, 허용값 검증은 호출측
   * (server.js EFFORT_LEVELS)이 책임진다. 그 검증이 유일한 방어선이다.
   *
   * 구버전 CLI(이 subtype 미지원)는 error를 돌려주므로, 호출측은 그 실패를 보고
   * 예전 방식(--resume 재시작)으로 폴백할 수 있다.
   */
  async setEffort(effortLevel, { ultracode = false } = {}) {
    const res = await this.#sendControlRequest({
      subtype: 'apply_flag_settings',
      settings: { effortLevel: effortLevel ?? null, ultracode: ultracode === true },
    });
    // 성공한 뒤에만 기억한다 — 실패한 값이 남으면 이후 재시작 스폰 인자가 실제 CLI
    // 상태와 어긋난다.
    this.#effort = effortLevel ?? undefined;
    this.#ultracode = ultracode === true;
    return res;
  }

  /**
   * 사고(확장 thinking) 예산 변경 — null = CLI 기본(자동), 0 = 사고 끔, 양수 = 토큰 예산.
   * CLI v2.1.205 바이너리의 내부 클라이언트(setMaxThinkingTokens)와 동일 채널·필드
   * (subtype/max_thinking_tokens)를 실측해 사용한다. set_model과 같은 미문서 인터페이스.
   */
  async setMaxThinkingTokens(maxThinkingTokens) {
    return this.#sendControlRequest({
      subtype: 'set_max_thinking_tokens',
      max_thinking_tokens: maxThinkingTokens,
    });
  }

  stop() {
    if (!this.#proc || this.#exited) return;
    try {
      this.#proc.stdin.end();
    } catch {
      // 이미 닫힌 스트림이면 무시
    }
    if (!this.#stopTimer) {
      this.#stopTimer = setTimeout(() => {
        if (!this.#exited) this.#proc.kill();
      }, STOP_KILL_TIMEOUT_MS);
      this.#stopTimer.unref?.();
    }
  }

  #canWrite() {
    return !!this.#proc && !this.#exited && this.#proc.stdin && this.#proc.stdin.writable;
  }

  #write(obj) {
    if (!this.#canWrite()) return false;
    try {
      this.#proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  #sendControlRequest(request, timeoutMs = CONTROL_TIMEOUT_MS) {
    const requestId = `req_${++this.#nextRequestId}`;
    return new Promise((resolve, reject) => {
      if (!this.#canWrite()) {
        reject(new Error('session is not running'));
        return;
      }
      const timer = setTimeout(() => {
        this.#pendingControl.delete(requestId);
        reject(new Error(`control request ${request.subtype} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pendingControl.set(requestId, { resolve, reject, timer });
      if (!this.#write({ type: 'control_request', request_id: requestId, request })) {
        this.#pendingControl.delete(requestId);
        clearTimeout(timer);
        reject(new Error('failed to write to claude stdin'));
      }
    });
  }

  #handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'control_response') {
      const requestId = msg.response?.request_id;
      const pending = requestId != null ? this.#pendingControl.get(requestId) : undefined;
      if (pending) {
        this.#pendingControl.delete(requestId);
        clearTimeout(pending.timer);
        if (msg.response?.subtype === 'success') {
          pending.resolve(msg.response.response ?? {});
        } else {
          pending.reject(new Error(msg.response?.error || `control request failed (${msg.response?.subtype})`));
        }
        return;
      }
      // 매칭되지 않은 control_response는 관찰용으로 event로 흘린다.
      this.emit('event', msg);
      return;
    }

    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      const requestId = msg.request_id;
      this.#pendingPermissions.set(requestId, msg);
      this.emit('permission_request', {
        requestId,
        toolName: msg.request.tool_name,
        displayName: msg.request.display_name ?? msg.request.tool_name,
        input: msg.request.input,
        description: msg.request.description,
        suggestions: msg.request.permission_suggestions ?? [],
        toolUseId: msg.request.tool_use_id,
        // 실 CLI v2.1.207 실측(2026-07-12): AskUserQuestion처럼 "사용자에게 묻는" 요청은
        // 같은 can_use_tool 채널에 requires_user_interaction:true가 실려 온다 —
        // 권한 상승 요청(이 필드 없음)과의 구분 신호. 없으면 false로 정규화.
        requiresUserInteraction: msg.request.requires_user_interaction === true,
      });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.sessionId = msg.session_id;
    } else if (msg.type === 'result' && msg.session_id) {
      this.sessionId = msg.session_id;
    }
    this.emit('event', msg);
  }

  #failPendingControl(err) {
    for (const [, pending] of this.#pendingControl) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pendingControl.clear();
  }

  #handleExit(code) {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    const detail = this.#stderrTail.length ? ` — ${this.#stderrTail.join(' / ')}` : '';
    this.#failPendingControl(new Error(`claude process exited (code ${code})${detail}`));
    this.#pendingPermissions.clear();
    this.emit('exit', code);
  }
}
