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
  // 종료가 시작됐는가 — 서 있으면 새 세션을 받지 않는다. beginClosing() 주석 참조.
  #closing = false;

  constructor({ cliPath, cliArgsPrefix = [], ringLimit = RING_LIMIT, exitedRetentionMs = EXITED_RETENTION_MS } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#ringLimit = ringLimit;
    this.#exitedRetentionMs = exitedRetentionMs;
  }

  /**
   * 종료 시작 선언 — 이후 startSession()은 거부된다. 멱등.
   *
   * server.close()가 **가장 먼저** 부른다. stopAll()에서야 세우면 늦다: close()는
   * 그 전에 원격 제어 정리를 최대 12초 기다리고, 그 창에서 시작된 세션은 stopAll()의
   * 순회 밖에서 태어나 그대로 고아가 된다(codex 지적).
   */
  beginClosing() {
    this.#closing = true;
  }

  /** 새 CLI 세션을 spawn하고 initialize 왕복까지 마친 뒤 { key, initInfo } 반환. */
  async startSession({ cwd, model, permissionMode, effort, ultracode, resumeSessionId } = {}) {
    if (this.#closing) throw new Error('server is shutting down');
    const session = new ClaudeSession({
      cliPath: this.#cliPath,
      cliArgsPrefix: this.#cliArgsPrefix,
      cwd,
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      effort: effort || undefined,
      ultracode: ultracode === true,
      resumeSessionId: resumeSessionId || undefined,
    });
    const key = `s_${++this.#nextKey}`;
    const entry = {
      key,
      session,
      // 이 세션이 spawn된 작업 디렉터리 — ClaudeSession이 #cwd를 private으로 감추므로
      // 여기 한 벌 보관한다. cwdOf(key)(원격 제어의 대상 디렉터리 해석)의 유일한 출처.
      cwd: cwd ?? null,
      // 재개 원본 id — 초기화 중 session.sessionId가 아직 null인 창에서도
      // isSessionIdLive가 이 파일을 라이브로 취급해 삭제(409 방어)를 막는다.
      resumeSessionId: resumeSessionId || null,
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
      // 시작 후 **실제로** 적용된 노력 수준을 함께 돌려준다 — ultracode는 스폰 플래그가
      // 없어 initialize 뒤에 얹히므로 요청대로 걸렸는지는 세션만 안다(실패 시 effortLevel만
      // 적용된 상태). 이 값이 클라이언트 표시의 권위가 된다.
      return { key, initInfo, effort: session.effort ?? null, ultracode: session.ultracode };
    } catch (err) {
      this.#sessions.delete(key);
      // 장부에서 지운 프로세스는 stopAll()의 추적 밖이다 — 여기서 끝까지 정리하지
      // 않으면 초기화에 실패한 CLI가 아무도 죽일 수 없는 고아로 남는다(codex 지적).
      // 이미 죽은 프로세스면 terminate는 즉시 돌아온다.
      await session.terminate().catch(() => {});
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

  /**
   * exited 아닌 CLI 세션 존재 여부 — 데몬 수명 정책(lifecycle.js)이 "연결 유실 시
   * 보호할 세션이 있는가"를 판단하는 데 쓴다. 초기화 중 세션도 live로 간주하고,
   * 리플레이용으로 잠시 남은 종료 엔트리는 제외한다.
   */
  hasLiveSessions() {
    for (const entry of this.#sessions.values()) {
      if (!entry.exited) return true;
    }
    return false;
  }

  /**
   * 라이브(비-exited) 세션의 작업 디렉터리. 없거나 이미 종료된 키면 null.
   *
   * 원격 제어(remote-control.js)의 대상 디렉터리를 정하는 유일한 경로다 — 클라이언트가
   * 보낸 cwd 문자열을 신뢰하지 않고 서버가 자기 세션 장부에서 되찾기 위한 접근자.
   * 종료된 엔트리는 리플레이용으로 잠시 남아 있으므로 명시적으로 제외한다(그 디렉터리에
   * 대해 새 원격 제어를 여는 근거가 될 수 없다).
   */
  cwdOf(key) {
    const entry = this.#sessions.get(key);
    if (!entry || entry.exited) return null;
    return entry.cwd || null;
  }

  /** 라이브 세션의 [key, cwd] 목록 — 원격 제어 상태를 세션에 이어 붙일 때 쓴다. */
  liveSessionCwds() {
    const out = [];
    for (const entry of this.#sessions.values()) {
      if (!entry.exited) out.push({ key: entry.key, cwd: entry.cwd || null });
    }
    return out;
  }

  /**
   * 종료된(리플레이용으로 남은) 세션까지 포함한 cwd 문자열 목록.
   * 세션이 먼저 끝난 원격 제어를 클라이언트가 자기 것으로 알아보게 하는 용도 —
   * 심볼릭 링크·대소문자 차이를 클라이언트가 판정하지 못하므로, 서버가 realpath로
   * 묶어 준 "이 원격 제어에 해당하는 원본 철자들"을 내려보내기 위한 재료다.
   */
  allSessionCwds() {
    const out = [];
    for (const entry of this.#sessions.values()) {
      if (entry.cwd) out.push(entry.cwd);
    }
    return out;
  }

  /**
   * 주어진 CLI sessionId가 라이브(비-exited) 세션에서 사용 중인지 — 히스토리 삭제
   * API의 409 방어용. 현재 sessionId뿐 아니라 시작 시 받은 resumeSessionId도
   * 라이브로 취급한다(재개 초기화 중 보호).
   */
  isSessionIdLive(sessionId) {
    if (!sessionId) return false;
    for (const entry of this.#sessions.values()) {
      if (entry.exited) continue;
      if (entry.session.sessionId === sessionId || entry.resumeSessionId === sessionId) {
        return true;
      }
    }
    return false;
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
    // 신뢰모드는 스폰 시에만 진입 가능 — 제안 경유 우회(setMode: bypassPermissions)를
    // 서버에서 걸러낸다. 해당 항목만 제거하고 addRules 등 나머지 제안은 보존한다.
    const filteredPermissions =
      Array.isArray(updatedPermissions) && entry.session.spawnPermissionMode !== 'bypassPermissions'
        ? updatedPermissions.filter(
          (p) => !(p && p.type === 'setMode' && p.mode === 'bypassPermissions'),
        )
        : updatedPermissions;
    const result = behavior === 'allow'
      ? {
        behavior: 'allow',
        updatedInput: updatedInput ?? pending.input ?? {},
        ...(Array.isArray(filteredPermissions) && filteredPermissions.length > 0
          ? { updatedPermissions: filteredPermissions }
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

  setMaxThinkingTokens(key, maxThinkingTokens) {
    return this.#require(key).session.setMaxThinkingTokens(maxThinkingTokens);
  }

  /** 노력 수준 런타임 변경 (재시작 없음 — ClaudeSession.setEffort 주석 참조). */
  setEffort(key, effort, ultracode) {
    return this.#require(key).session.setEffort(effort, { ultracode });
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

  /**
   * 모든 세션을 완전히 종료하고 **실제 사망을 확인할 때까지** 기다린다(데몬 종료 경로).
   *
   * 예전에는 stop()만 뿌리고 즉시 반환했다 — 호출측이 곧바로 process.exit()하면
   * stop()의 unref된 kill 타이머는 발화하지 못하고, Windows에서는 부모가 죽어도
   * 자식이 살아남아 진행 중이던 claude 프로세스가 계속 돌았다. 그래서 async다.
   *
   * @returns {Promise<boolean>} 모든 세션의 사망을 확인했으면 true
   */
  async stopAll() {
    // 방어 — 호출측이 beginClosing()을 건너뛴 경로에서도 새 세션은 막는다.
    this.#closing = true;
    const pending = [];
    for (const entry of this.#sessions.values()) {
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      pending.push(entry.session.terminate());
    }
    const results = await Promise.allSettled(pending);
    return results.every((r) => r.status === 'fulfilled' && r.value !== false);
  }
}
