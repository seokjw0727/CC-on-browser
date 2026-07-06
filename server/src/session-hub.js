// session-hub.js — 다중 ClaudeSession 관리 + 세션별 이벤트 링버퍼(리플레이용).
// WS 지식은 없고 'broadcast' 이벤트로 서버(server.js)에 위임한다.
import { EventEmitter } from 'node:events';
import { ClaudeSession } from './claude-session.js';

const RING_LIMIT = 1000;

export class SessionHub extends EventEmitter {
  #cliPath;
  #cliArgsPrefix;
  #ringLimit;
  /** @type {Map<string, {key, session, ring: {seq,payload}[], nextSeq, pendingPermissions: Map, exited, exitCode}>} */
  #sessions = new Map();
  #nextKey = 0;

  constructor({ cliPath, cliArgsPrefix = [], ringLimit = RING_LIMIT } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#ringLimit = ringLimit;
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

  sendText(key, text) {
    this.#require(key).session.sendUserText(String(text ?? ''));
  }

  /**
   * 권한 요청에 응답. behavior 'allow'|'deny'.
   * pending에 없는 requestId면 false.
   */
  respondPermission(key, requestId, { behavior, updatedInput, message } = {}) {
    const entry = this.#require(key);
    const pending = entry.pendingPermissions.get(requestId);
    if (!pending) return false;
    const result = behavior === 'allow'
      ? { behavior: 'allow', updatedInput: updatedInput ?? pending.input ?? {} }
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
    for (const entry of this.#sessions.values()) entry.session.stop();
  }
}
