// session-hub.js — 다중 ClaudeSession 관리 + 세션별 이벤트 링버퍼(리플레이용).
// WS 지식은 없고 'broadcast' 이벤트로 서버(server.js)에 위임한다.
import { EventEmitter } from 'node:events';
import { ClaudeSession } from './claude-session.js';

const RING_LIMIT = 1000;
// 종료된 세션 엔트리는 재접속 리플레이(attachReplay)를 위해 잠시 유지한 뒤 소거한다.
// 그렇지 않으면 세션을 반복 생성/종료하는 장기 구동에서 링버퍼가 무한 누적된다.
const EXITED_RETENTION_MS = 30 * 60_000;

export class SessionHub extends EventEmitter {
  #cliPath;
  #cliArgsPrefix;
  #ringLimit;
  #exitedRetentionMs;
  /** @type {Map<string, {key, session, ring: {seq,payload}[], nextSeq, pendingPermissions: Map, exited, exitCode}>} */
  #sessions = new Map();
  #nextKey = 0;

  constructor({ cliPath, cliArgsPrefix = [], ringLimit = RING_LIMIT, exitedRetentionMs = EXITED_RETENTION_MS } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#ringLimit = ringLimit;
    this.#exitedRetentionMs = exitedRetentionMs;
  }

  /** 새 CLI 세션을 spawn하고 initialize 왕복까지 마친 뒤 { key, initInfo } 반환. */
  async startSession({ cwd, model, permissionMode, resumeSessionId } = {}) {
    const session = new ClaudeSession({
      cliPath: this.#cliPath,
      cliArgsPrefix: this.#cliArgsPrefix,
      cwd,
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      resumeSessionId: resumeSessionId || undefined,
    });
    const key = `s_${++this.#nextKey}`;
    const entry = {
      key,
      session,
      ring: [],
      nextSeq: 1,
      pendingPermissions: new Map(),
      exited: false,
      exitCode: null,
    };

    session.on('event', (payload) => this.#pushEvent(entry, payload));
    session.on('raw', (line) => this.#pushEvent(entry, { type: 'raw', line }));
    session.on('permission_request', (info) => {
      entry.pendingPermissions.set(info.requestId, info);
      this.emit('broadcast', { type: 'permission_request', key, ...info });
    });
    session.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.pendingPermissions.clear();
      this.emit('broadcast', { type: 'exit', key, code });
      // 유예 창(리플레이 계약) 후 엔트리 소거 → 링버퍼 무한 누적 방지.
      // 소거 후 attach는 'unknown session key'로 떨어지고, 클라이언트는
      // /api/transcript + resumeSessionId로 복구할 수 있어 계약을 깨지 않는다.
      if (this.#exitedRetentionMs >= 0 && this.#exitedRetentionMs !== Infinity) {
        entry.cleanupTimer = setTimeout(() => {
          if (this.#sessions.get(key) === entry) this.#sessions.delete(key);
        }, this.#exitedRetentionMs);
        entry.cleanupTimer.unref?.();
      }
    });

    this.#sessions.set(key, entry);
    try {
      const initInfo = await session.start();
      return { key, initInfo };
    } catch (err) {
      this.#sessions.delete(key);
      session.stop();
      throw err;
    }
  }

  #pushEvent(entry, payload) {
    const seq = entry.nextSeq++;
    entry.ring.push({ seq, payload });
    if (entry.ring.length > this.#ringLimit) entry.ring.shift();
    this.emit('broadcast', { type: 'event', key: entry.key, seq, payload });
  }

  #require(key) {
    const entry = this.#sessions.get(key);
    if (!entry) throw new Error(`unknown session key: ${key}`);
    return entry;
  }

  has(key) {
    return this.#sessions.has(key);
  }

  /** 사용자 텍스트 전송. 세션이 종료/중단되어 쓸 수 없으면 false. */
  sendText(key, text) {
    return this.#require(key).session.sendUserText(String(text ?? ''));
  }

  /**
   * 권한 요청에 응답. behavior 'allow'|'deny'.
   * allow 시 updatedPermissions(수락한 permission_suggestions)를 CLI에 그대로 전달 —
   * "항상 허용" 류 영구 규칙은 CLI가 이 필드를 받아야 저장된다.
   * pending에 없는 requestId면 false.
   */
  respondPermission(key, requestId, { behavior, updatedInput, updatedPermissions, message } = {}) {
    const entry = this.#require(key);
    const pending = entry.pendingPermissions.get(requestId);
    if (!pending) return false;
    const result = behavior === 'allow'
      ? {
        behavior: 'allow',
        updatedInput: updatedInput ?? pending.input ?? {},
        ...(Array.isArray(updatedPermissions) && updatedPermissions.length > 0
          ? { updatedPermissions }
          : {}),
      }
      : { behavior: 'deny', message: message || '사용자가 거부했습니다' };
    entry.pendingPermissions.delete(requestId);
    const ok = entry.session.respondPermission(requestId, result);
    if (ok) this.emit('broadcast', { type: 'permission_resolved', key, requestId });
    return ok;
  }

  interrupt(key) {
    return this.#require(key).session.interrupt();
  }

  setModel(key, model) {
    return this.#require(key).session.setModel(model);
  }

  setPermissionMode(key, mode) {
    return this.#require(key).session.setPermissionMode(mode);
  }

  /** 링버퍼에서 afterSeq 이후 이벤트 + 미해결 권한 요청 + 종료 상태 반환 (재접속 리플레이용). */
  attachReplay(key, afterSeq = 0) {
    const entry = this.#require(key);
    const after = Number.isFinite(afterSeq) ? afterSeq : 0;
    return {
      key,
      events: entry.ring.filter((e) => e.seq > after),
      pendingPermissions: [...entry.pendingPermissions.values()],
      exited: entry.exited,
      exitCode: entry.exitCode,
    };
  }

  stop(key) {
    this.#require(key).session.stop();
  }

  stopAll() {
    for (const entry of this.#sessions.values()) {
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      entry.session.stop();
    }
  }
}
