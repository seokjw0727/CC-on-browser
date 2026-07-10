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

  constructor({ cliPath, cliArgsPrefix = [], cwd, model, permissionMode, effort, resumeSessionId } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    if (!cwd) throw new TypeError('cwd is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#cwd = cwd;
    this.#model = model;
    this.#permissionMode = permissionMode;
    // effort(low|medium|high|xhigh|max)는 spawn 전용 플래그 — 런타임 변경 채널이 없음을
    // v2.1.205 바이너리에서 확인("can't change server effort"). 변경은 --resume 재시작으로.
    this.#effort = effort;
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

    return this.#sendControlRequest({ subtype: 'initialize' }, INIT_TIMEOUT_MS);
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

  async setPermissionMode(mode) {
    await this.#sendControlRequest({ subtype: 'set_permission_mode', mode });
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
