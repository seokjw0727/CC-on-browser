// session-hub.js — 다중 ClaudeSession 관리 + 세션별 이벤트 링버퍼(리플레이용).
// WS 지식은 없고 'broadcast' 이벤트로 서버(server.js)에 위임한다.
import { EventEmitter } from 'node:events';
import { ClaudeSession } from './claude-session.js';
import { lookupCliSessionName } from './cli-session-names.js';

const RING_LIMIT = 1000;
// 종료된 세션 엔트리는 재접속 리플레이(attachReplay)를 위해 잠시 유지한 뒤 소거한다.
// 그렇지 않으면 세션을 반복 생성/종료하는 장기 구동에서 링버퍼가 무한 누적된다.
const EXITED_RETENTION_MS = 30 * 60_000;
// CLI 세션 이름 조회 재시도 상한 — 이름 파일이 init보다 늦게 쓰이는 창을 넘기기 위한
// 값이다. 세션 하나가 이 횟수를 넘겨도 못 찾으면 이름 없이 간다(기존 제목으로 폴백).
const CLI_NAME_MAX_TRIES = 10;
// 재시도 간격. 리더의 캐시 TTL(3초)보다 길어야 한다 — 짧으면 같은 '없음'이 캐시에서
// 그대로 돌아와 재시도 예산만 태운다. 재시도는 **타이머로** 돈다: CLI 이벤트에만 기대면
// init 직후 조용해진 세션에서 늦게 쓰인 이름을 영영 못 본다(codex 지적).
const CLI_NAME_RETRY_MS = 3_500;

export class SessionHub extends EventEmitter {
  #cliPath;
  #cliArgsPrefix;
  #ringLimit;
  #exitedRetentionMs;
  #lookupSessionName;
  #cliNameRetryMs;
  #cliNameMaxTries;
  /** @type {Map<string, {key, session, ring: {seq,payload}[], nextSeq, pendingPermissions: Map, exited, exitCode}>} */
  #sessions = new Map();
  #nextKey = 0;
  // 종료가 시작됐는가 — 서 있으면 새 세션을 받지 않는다. beginClosing() 주석 참조.
  #closing = false;

  constructor({
    cliPath,
    cliArgsPrefix = [],
    ringLimit = RING_LIMIT,
    exitedRetentionMs = EXITED_RETENTION_MS,
    // CLI가 세션 이름을 적어 두는 디렉터리 — 목록 endpoint와 **같은 값**이어야 한다.
    // 서버가 주입한 경로를 여기에 넘기지 않으면 라이브 세션만 기본 경로를 본다.
    sessionsRoot,
    // 이름 저장소 파일 — 목록 endpoint와 **같은 값**이어야 한다. 끝난 CLI가 자기
    // 이름 파일을 지우므로, 여기서 본 이름이 저장소에 남아야 지난 세션 목록이 그것을
    // 다시 찾는다(cli-session-names.js 머리말). 주지 않으면 저장소를 쓰지 않는다.
    nameStoreFile,
    // (sessionId) => Promise<string|null> — CLI가 붙인 세션 이름 조회. 테스트 주입용.
    lookupSessionName = (sessionId) => (
      lookupCliSessionName(sessionId, sessionsRoot, { storeFile: nameStoreFile })
    ),
    // 이름 재조회의 간격·횟수 — 테스트 주입용(예산 소진 경로를 초 단위로 기다리지 않기 위해).
    cliNameRetryMs = CLI_NAME_RETRY_MS,
    cliNameMaxTries = CLI_NAME_MAX_TRIES,
  } = {}) {
    super();
    if (!cliPath) throw new TypeError('cliPath is required');
    this.#cliPath = cliPath;
    this.#cliArgsPrefix = cliArgsPrefix;
    this.#ringLimit = ringLimit;
    this.#exitedRetentionMs = exitedRetentionMs;
    this.#lookupSessionName = lookupSessionName;
    this.#cliNameRetryMs = cliNameRetryMs;
    this.#cliNameMaxTries = cliNameMaxTries;
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
      // CLI가 이 세션에 붙인 이름 — sessionId가 확정된 뒤 한 번 조회해 채운다.
      // 재접속 리플레이에 실어야 하므로 방송만 하지 않고 엔트리에도 남긴다.
      cliName: null,
      cliNameId: null, // cliName이 어느 sessionId의 이름인가 — 포크로 id가 바뀌면 버린다
      cliNameFor: null, // 지금 조회 중인 sessionId (중복 조회 방지 래치)
      cliNameTries: 0, // 못 찾았을 때의 재시도 횟수 (CLI가 이름 파일을 늦게 쓰는 창 대비)
      cliNameTimer: null, // 예약된 재조회 — 세션이 조용해도 돌게 하는 것이 목적
      // 마지막으로 **조회를 시도한** sessionId. 성공한 id(cliNameId)와 따로 두어야 한다:
      // 한 번도 못 찾은 채 id가 바뀌는 경우가 바로 예산을 물려받으면 안 되는 경우다.
      cliNameAttemptedId: null,
      ring: [],
      nextSeq: 1,
      pendingPermissions: new Map(),
      exited: false,
      exitCode: null,
    };

    session.on('event', (payload) => {
      this.#pushEvent(entry, payload);
      // 이벤트가 sessionId를 확정한 직후가 유일하게 이름을 찾을 수 있는 시점이다
      // (이름 파일은 sessionId로만 이어진다). 조회는 비동기지만 이벤트 스트림을
      // 붙잡지 않는다 — 실패하든 늦든 세션 진행에는 아무 영향이 없다.
      this.#refreshCliName(entry);
    });
    session.on('raw', (line) => this.#pushEvent(entry, { type: 'raw', line }));
    session.on('permission_request', (info) => {
      entry.pendingPermissions.set(info.requestId, info);
      this.emit('broadcast', { type: 'permission_request', key, ...info });
    });
    session.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.pendingPermissions.clear();
      // 죽은 세션의 이름을 계속 찾을 이유가 없다 — 예약된 재조회를 접는다.
      this.#clearCliNameTimer(entry);
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

  /**
   * CLI가 붙인 세션 이름을 조회해 sessionName으로 방송한다 — sessionId 하나당 한 번.
   *
   * 링버퍼에 넣지 않고 별도 메시지로 보내는 이유: 링은 CLI 이벤트를 그대로 되쏘는
   * 채널이라, 우리가 만든 메시지를 섞으면 클라이언트의 CLI 이벤트 리듀서가 모르는
   * payload를 받는다. 대신 엔트리에 남겨 attachReplay가 재접속 때 다시 보낸다.
   *
   * 재개 세션에서 옛 이름이 따라붙지 않는 것은 조회 키가 **지금 이 프로세스가 보고한**
   * sessionId이기 때문이다(entry는 항상 null에서 시작한다).
   */
  #refreshCliName(entry) {
    const sessionId = entry.session.sessionId;
    if (!sessionId) return;
    // 포크·/clear 등으로 id가 바뀌면 이전 id에 대해 쌓인 상태를 통째로 버린다 — 이름과
    // 재시도 예산 둘 다. 판정 기준은 **마지막으로 시도한** id다: 성공한 id로 재면 한 번도
    // 못 찾은 채 id가 바뀐 경우에 예산이 그대로 넘어가, 새 id는 영영 조회되지 않는다.
    // 서버 장부만 지우면 이미 옛 이름을 그리고 있는 화면이 남으므로 함께 알린다.
    if (entry.cliNameAttemptedId !== null && entry.cliNameAttemptedId !== sessionId) {
      const hadName = entry.cliName;
      entry.cliName = null;
      entry.cliNameId = null;
      entry.cliNameFor = null; // 진행 중이던 옛 id 조회의 결과는 아래 가드에서 버려진다
      entry.cliNameAttemptedId = null;
      entry.cliNameTries = 0;
      this.#clearCliNameTimer(entry);
      if (hadName) {
        this.emit('broadcast', { type: 'sessionName', key: entry.key, sessionId, cliName: null, reset: true });
      }
    }
    if (entry.cliName && entry.cliNameId === sessionId) return; // 이미 찾았다
    if (entry.cliNameFor === sessionId) return; // 같은 id로 조회가 진행 중
    // 재조회가 이미 예약돼 있으면 이벤트로 앞당기지 않는다. 이 가드가 없으면 스트리밍
    // 한 턴의 이벤트 폭주가 재시도 예산을 수백 ms 만에 태워 버리는데, 그 시도들은 전부
    // 리더의 같은 캐시(3초)를 보므로 결과도 같다 — 예산만 잃고 이름은 못 찾는다.
    if (entry.cliNameTimer) return;
    if (entry.cliNameTries >= this.#cliNameMaxTries) return;
    entry.cliNameTries++;
    entry.cliNameAttemptedId = sessionId;
    entry.cliNameFor = sessionId; // 먼저 세워 같은 id로 중복 조회하지 않는다
    // 주입된 조회기가 **동기적으로** 던져도 CLI 이벤트 핸들러로 새어 나가면 안 된다 —
    // 호출 자체를 promise 체인 안으로 넣는다(codex 지적).
    Promise.resolve()
      .then(() => this.#lookupSessionName(sessionId))
      .then((name) => {
        const cliName = typeof name === 'string' ? name.trim() : '';
        // 조회가 도는 사이 세션이 정리됐거나 id가 또 바뀌었으면 버린다.
        if (this.#sessions.get(entry.key) !== entry) return;
        if (entry.cliNameFor !== sessionId) return;
        entry.cliNameFor = null;
        if (!cliName) {
          // 이름 파일이 아직 없을 수 있다 — 다음 CLI 이벤트를 기다리지 않고 예약한다.
          this.#scheduleCliNameRetry(entry);
          return;
        }
        entry.cliName = cliName;
        entry.cliNameId = sessionId;
        this.#clearCliNameTimer(entry);
        this.emit('broadcast', { type: 'sessionName', key: entry.key, sessionId, cliName });
      })
      .catch(() => {
        // 이름은 있으면 좋은 정보다 — 못 찾으면 클라이언트가 기존 제목으로 폴백한다.
        if (entry.cliNameFor === sessionId) entry.cliNameFor = null;
        this.#scheduleCliNameRetry(entry);
      });
  }

  /**
   * 다음 이름 조회를 예약한다 — CLI 이벤트가 없어도 도는 유일한 경로.
   *
   * 이벤트에만 기대면 init 직후 사용자가 아무것도 하지 않는 세션에서, 그 뒤에 쓰인
   * 이름을 영영 보지 못한다(codex 지적). 타이머는 unref하므로 이것 때문에 데몬이
   * 살아 있지는 않고, 종료·정리 경로에서 함께 해제된다.
   */
  #scheduleCliNameRetry(entry) {
    if (entry.cliNameTimer || entry.exited) return;
    if (entry.cliNameTries >= this.#cliNameMaxTries) return;
    entry.cliNameTimer = setTimeout(() => {
      entry.cliNameTimer = null;
      if (this.#sessions.get(entry.key) !== entry || entry.exited) return;
      this.#refreshCliName(entry);
    }, this.#cliNameRetryMs);
    entry.cliNameTimer.unref?.();
  }

  #clearCliNameTimer(entry) {
    if (!entry.cliNameTimer) return;
    clearTimeout(entry.cliNameTimer);
    entry.cliNameTimer = null;
  }

  /**
   * 지금까지 확인된 CLI 세션 이름과 그 id — 없으면 null.
   *
   * 세션 시작 응답(started)을 보낸 **직후** 서버가 읽는다. 이름 조회는 init 이벤트에서
   * 시작되므로 startSession()이 반환하기 전에 끝날 수 있고, 그때의 broadcast는 아직
   * 세션을 모르는 탭에서 버려진다(codex 지적). 그 창을 이 접근자가 메운다.
   */
  cliNameOf(key) {
    const entry = this.#sessions.get(key);
    if (!entry || !entry.cliName) return null;
    return { sessionId: entry.cliNameId, cliName: entry.cliName };
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

  /**
   * 라이브 세션의 {key, cwd, sessionId} 목록 — 원격 제어 상태를 세션에 이어 붙일 때와
   * worktree 패널이 디렉터리별 세션을 묶을 때 쓴다.
   *
   * sessionId가 함께 나가는 이유: key는 이 데몬 프로세스 안에서만 뜻이 있어, 그 key를
   * 모르는 화면(방금 연 탭, 동기화 전)은 세션을 이름 없이 그릴 수밖에 없다. sessionId는
   * 디스크의 트랜스크립트와 같은 값이라 그런 화면도 최소한의 식별자를 얻는다.
   * 아직 CLI가 id를 알려주기 전이면 null이다.
   */
  liveSessionCwds() {
    const out = [];
    for (const entry of this.#sessions.values()) {
      if (entry.exited) continue;
      out.push({
        key: entry.key,
        cwd: entry.cwd || null,
        sessionId: entry.session?.sessionId ?? null,
      });
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
      // 이름은 링버퍼 밖에 있으므로 리플레이가 따로 실어 준다 — 안 그러면 재접속한
      // 탭에서만 세션 이름이 사라진다.
      cliName: entry.cliName,
      cliNameSessionId: entry.cliNameId,
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
      this.#clearCliNameTimer(entry);
      pending.push(entry.session.terminate());
    }
    const results = await Promise.allSettled(pending);
    return results.every((r) => r.status === 'fulfilled' && r.value !== false);
  }
}
