// claude.exe stream-json 브리지. 미문서 CLI 프로토콜 지식은 이 파일에 격리한다.
// 프로토콜 상세: docs/specs/2026-07-06-claude-code-on-browser-design.md §2(관측된 CLI 동작).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createJsonlParser } from './jsonl.js';
import { killTree as defaultKillTree } from './kill-tree.js';

const INIT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 30_000;
const STOP_KILL_TIMEOUT_MS = 5_000;
// terminate()가 stdin EOF만으로 우아하게 내려가길 기다리는 시간. 진행 중인 턴을
// 정리할 여유는 주되, 사용자가 브라우저를 닫고 기다리는 시간이므로 짧게 잡는다.
const TERMINATE_GRACE_MS = 3_000;
// 강제 트리 종료를 쏜 뒤 실제 사망을 확인하는 상한.
const TERMINATE_KILL_WAIT_MS = 2_000;

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
  // 자식 프로세스의 실제 사망 여부. #exited('close' 기반)와 일부러 분리한다 —
  // 손자(셸·MCP 서버 등)가 stdio 파이프를 물고 있으면 프로세스가 이미 죽은 뒤에도
  // 'close'는 오지 않는다. 종료 확인은 반드시 이쪽('exit')을 봐야 한다.
  #procExited = false;
  /** @type {Promise<boolean>|null} terminate()의 단일 종료 절차(멱등) */
  #terminating = null;
  #platform;
  #killTree;
  #stopKillTimeoutMs;
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
    // 플랫폼·트리 종료·정지 유예는 주입 가능하게 둔다(테스트용) — remote-control.js와 같은 규약.
    platform = process.platform,
    killTree = defaultKillTree,
    stopKillTimeoutMs = STOP_KILL_TIMEOUT_MS,
  } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    if (!cwd) throw new TypeError('cwd is required');
    this.#platform = platform;
    this.#killTree = killTree;
    this.#stopKillTimeoutMs = stopKillTimeoutMs;
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#cwd = cwd;
    this.#model = model;
    this.#permissionMode = permissionMode;
    // effort(low|medium|high|xhigh|max)는 시작 시 --effort로 전달하고, 이후에는
    // setEffort()의 런타임 채널로 바꾼다(재시작 불필요 — v2.1.233 실측, setEffort 주석 참조).
    this.#effort = effort;
    // ultracode는 --effort 값이 아니라 별개의 플래그 설정이다(CLI의 /effort ultracode는
    // effortLevel 'xhigh' + ultracode true를 함께 보낸다 — v2.1.233 동작 관찰).
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
      // POSIX에서만 자기 프로세스 그룹을 준다 — terminate()가 그룹 전체(-pid)를
      // 시그널해 CLI가 띄운 셸·MCP 서버까지 함께 정리하기 위해서다.
      // win32는 taskkill /T가 트리를 처리하므로 detached가 필요 없다
      // (remote-control.js의 spawnChild와 같은 선택).
      detached: this.#platform !== 'win32',
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
      this.#procExited = true; // 스폰 자체가 실패했다 — 죽일 프로세스가 없다
      this.#failPendingControl(err);
      this.#handleExit(null);
    });
    // 'exit'는 프로세스의 사망, 'close'는 stdio까지 닫힘. UI 이벤트 흐름은 종전대로
    // 'close'에 걸고, 종료 확인만 'exit'로 본다(#procExited 주석 참조).
    this.#proc.on('exit', () => { this.#procExited = true; });
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

  /**
   * 개별 세션 정지(UI의 "정지"). 우아한 종료를 요청하고 최후 수단으로만 kill한다.
   * 데몬 종료 경로는 이걸 쓰지 않는다 — terminate()를 쓴다(사유는 그쪽 주석).
   */
  stop() {
    if (!this.#proc || this.#exited) return;
    // terminate()가 이미 종료 절차를 쥐고 있으면 끼어들지 않는다 — 여기서 kill()을
    // 걸면 트리 정리 없이 직속 프로세스만 죽어 손자가 고아로 남는다.
    if (this.#terminating) return;
    try {
      this.#proc.stdin.end();
    } catch {
      // 이미 닫힌 스트림이면 무시
    }
    if (!this.#stopTimer) {
      this.#stopTimer = setTimeout(() => {
        if (this.#procExited) return;
        // 최후 수단도 **트리째** 정리한다. proc.kill()만 쏘면 자기 프로세스 그룹을
        // 가진 CLI(POSIX detached)의 자식 — 셸·MCP 서버 — 이 그대로 남는다(codex 지적).
        const pid = this.#proc?.pid;
        if (pid == null) {
          this.#proc?.kill();
          return;
        }
        try {
          const r = this.#killTree(pid, { platform: this.#platform, force: true });
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          // 주입된 killTree가 동기적으로 던져도 정지 요청을 실패로 만들지 않는다
        }
      }, this.#stopKillTimeoutMs);
      this.#stopTimer.unref?.();
    }
  }

  /**
   * 완전 종료 — 데몬이 내려갈 때 이 세션의 CLI 프로세스와 그 **자식 트리**까지 정리하고,
   * 실제로 죽었는지 확인한 뒤에야 resolve한다. 멱등(같은 Promise를 돌려준다).
   *
   * 왜 stop()으로 부족한가: stop()은 stdin만 닫고 즉시 반환하며, 그 5초 kill 타이머는
   * unref돼 있다. 데몬이 곧바로 process.exit()하면 타이머는 영영 발화하지 않고,
   * Windows에선 부모가 죽어도 자식이 살아남으므로 진행 중이던 claude 프로세스가
   * 고아로 남아 계속 돈다(토큰 소모). 그래서 종료 경로는 반드시 이 함수를 await한다.
   *
   * 흐름: stdin EOF로 우아한 종료 유도 → graceMs 대기 → 강제 트리 종료 →
   *       killWaitMs 안에 사망 재확인. 확인에 실패해도 resolve(false)한다 —
   *       데몬을 영원히 붙잡는 쪽이 더 나쁘다(사유는 로그로 남긴다).
   *
   * @returns {Promise<boolean>} **CLI 루트 프로세스**의 사망을 확인했으면 true.
   *   손자(셸·MCP 서버)까지의 사망은 확인하지 않는다 — pid를 알 수 없어서다.
   *   그쪽은 트리 종료의 best-effort이며, win32에서 루트가 먼저 우아하게 내려간
   *   경우에는 트리를 열거할 수 없어 CLI 자신의 정리에 맡긴다.
   */
  terminate({ graceMs = TERMINATE_GRACE_MS, killWaitMs = TERMINATE_KILL_WAIT_MS } = {}) {
    if (this.#terminating) return this.#terminating;
    this.#terminating = this.#runTerminate(graceMs, killWaitMs).then((dead) => {
      // 실패했다면 재시도 여지를 남긴다 — 캐시된 false를 붙들고 있으면 stop()도
      // terminate()도 다시는 아무 일도 하지 않는다(codex 지적).
      if (!dead) this.#terminating = null;
      return dead;
    });
    return this.#terminating;
  }

  async #runTerminate(graceMs, killWaitMs) {
    const proc = this.#proc;
    if (!proc) return true; // 아직 스폰 전 — 죽일 프로세스가 없다
    const { pid } = proc;
    // 종료 절차를 독점한다 — stop()의 타이머가 중간에 끼어들어 트리 정리 없이
    // 직속 프로세스만 죽이는 것을 막는다.
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }

    if (!this.#procExited) {
      try {
        proc.stdin.end();
      } catch {
        // 이미 닫힌 스트림이면 무시
      }
      await this.#waitForProcExit(graceMs);
    }

    // 강제 트리 종료. 우아하게 내려간 경우에도 POSIX에서는 한 번 더 쏜다 —
    // 그룹 리더가 죽어도 같은 프로세스 그룹의 손자는 남아 있을 수 있고, 대상이
    // 없으면 ESRCH로 무해하다(remote-control.js의 terminate와 같은 선택).
    // win32는 부모가 이미 죽었으면 taskkill /T가 트리를 열거할 수 없어 손자까지는
    // 보장하지 못한다 — 그 경우는 CLI 자신의 정리에 맡기는 명시적 한계다.
    if (pid != null && (!this.#procExited || this.#platform !== 'win32')) {
      try {
        await this.#killTree(pid, { platform: this.#platform, force: true });
      } catch {
        // 주입된 killTree가 던져도 종료 절차를 멈추지 않는다
      }
    }

    if (this.#procExited) return true;
    const dead = await this.#waitForProcExit(killWaitMs);
    if (!dead) {
      console.error(
        `[cc-on-browser] CLI 세션(pid ${pid})을 종료하지 못했습니다 —`
        + ' `claude` 프로세스가 남았는지 확인해 주세요.',
      );
    }
    return dead;
  }

  /**
   * 자식 프로세스의 'exit'를 상한과 함께 기다린다.
   * 타이머를 unref하지 않는다: 이건 종료 경로의 유한한 대기(최대 몇 초)이고,
   * unref하면 이벤트 루프가 비는 순간 Node가 그대로 빠져나가 정리를 건너뛴다.
   * @returns {Promise<boolean>} 상한 안에 죽었으면 true
   */
  #waitForProcExit(timeoutMs) {
    if (this.#procExited) return Promise.resolve(true);
    const proc = this.#proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const finish = (ok) => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        proc.off('exit', onExit);
        resolve(ok);
      };
      const onExit = () => finish(true);
      proc.on('exit', onExit);
      timer = setTimeout(() => finish(this.#procExited), timeoutMs);
    });
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
