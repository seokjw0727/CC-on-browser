// remote-control.js — `claude remote-control` 자식 프로세스 관리 + 그 출력 파서.
// claude-session.js와 같은 규율: 미문서 CLI 표면 지식은 이 파일 하나에 격리한다.
//
// 이 파일의 모든 형식 지식은 추측이 아니라 실측이다(2026-07-30, CLI v2.1.220, win32).
// 근거와 원시 캡처: .certify/design/2026-07-30-remote-control-running-dock-timestamps.html §3.1.2
//
// 실측에서 나온 세 가지 설계 제약:
//  1) `Environment ID:` 줄은 -v일 때만 나온다. URL 줄은 항상 나온다 →
//     환경 ID의 단일 진실은 URL이다(우리가 -v를 주더라도).
//  2) CLI는 같은 디렉터리의 2중 실행을 막아 주지 않는다(둘 다 Ready까지 간다) →
//     중복 방지는 전적으로 이 관리자의 책임이다. 단 관리자 밖에서 수동 실행한
//     CLI까지 막을 수는 없다.
//  3) 출력은 ESC[<N>A ESC[J 로 직전 N줄을 지우고 다시 그린다 → 같은 줄이 여러 번 온다.
//     그래서 파서는 멱등해야 하고, "알 수 없는 줄"은 아무 전이도 만들지 않아야 한다.
//
// 동시성 규율: start/stop/closeAll은 **하나의 직렬 큐**를 통과한다. 원격 제어 조작은
// 사용자가 버튼을 누를 때만 일어나는 희귀 이벤트라, 전역 직렬화의 비용은 없는 것과
// 같고 대신 "정리 중 재시작", "closeAll과 경합하는 start" 같은 인터리빙이 원천 소멸한다.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * cwd 정규화의 **단일 출처**. 이 관리자와 server.js의 keysForCwd가 반드시 같은
 * 함수를 써야 한다 — 서로 다른 realpath 구현을 쓰면 같은 디렉터리인데도 문자열이
 * 갈라진다. win32에서 실제로 갈렸다: fs.realpathSync는 8.3 단축명을 그대로 두는데
 * promises 쪽은 펴 버려, 원격 제어를 켜도 세션이 매칭되지 않아 pill이 꺼진 채로
 * 남았다(CI에서 재현). .native는 OS에 맡겨 단축명·심볼릭 링크·대소문자를 한 번에
 * 정규화한다.
 */
export function canonicalCwdSync(p) {
  return fs.realpathSync.native(p);
}

/** stop()에서 트리 종료 후 close를 기다리는 시간. 넘으면 강제 단계로 승급. */
export const STOP_GRACE_MS = 5_000;
/** 한 줄이 이보다 길면 그 줄은 버린다 — 폭주 출력에 대한 메모리 상한. */
export const MAX_LINE_LEN = 8 * 1024;
/** 예기치 않은 종료 사유에 실을 stderr 꼬리 줄 수와 줄당 길이. */
export const STDERR_TAIL_LINES = 3;
export const STDERR_TAIL_LINE_LEN = 200;
/** 세션 이름 상한 — CLI에 넘기기 전 위생 처리. */
export const MAX_NAME_LEN = 64;
/** 환경 ID 검증 상한 — 형식을 좁히지 않되 무한 길이는 막는다. */
const MAX_ENV_ID_LEN = 128;
/** 상태 낱말을 찾을 칸 수. 실측상 항상 3칸 안에 있다("·✔︎· Ready · 레포 · 브랜치").
 *  이 상한이 없으면 'Ready'라는 이름의 브랜치가 세션을 거짓 ready로 만든다. */
const STATUS_SEGMENT_LIMIT = 3;

const REMOTE_URL_HOST = 'claude.ai';
const REMOTE_URL_PATH = '/code';

// 관측된 상태 낱말 → 우리 상태. 완전한 문법이 아니므로 여기 없는 낱말은
// "전이 없음"이다(ready로도, error로도 만들지 않는다).
const STATUS_WORDS = new Map([
  ['Connecting', 'starting'],
  ['Reconnecting', 'starting'],
  ['Ready', 'ready'],
]);

// 바이너리 문자열에서 확인한 실패 문구. 부분 일치로 본다 — 앞에 "Error: " 같은 장식이 붙는다.
const ERROR_MARKERS = [
  'You must be logged in to use Remote Control.',
  'Remote Control requires claude.ai subscription auth.',
  "Remote Control is disabled by your organization's policy",
  'Remote Control is not available inside a cloud session.',
  'Remote Control is only available when using Claude via api.anthropic.com.',
  'Your organization requires Trusted Devices for Remote Control',
  'is already running in this directory',
  'Remote Control session expired.',
  'Remote Control Failed',
];

/**
 * CSI 시퀀스와 고립 ESC 제거. 실측상 CR은 없었지만 방어적으로 함께 지운다.
 * 화면 재그리기(ESC[1A ESC[J)가 줄 머리에 붙어 오므로 이걸 지우지 않으면
 * 상태 낱말이 있는 줄을 못 알아본다.
 */
export function stripAnsi(input) {
  return String(input ?? '')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/**
 * 줄에서 claude.ai 원격 제어 URL을 구조적으로 뽑는다.
 * 정규식으로 `?environment=`를 직접 긁지 않는다 — 쿼리 순서가 바뀌면 깨지기 때문.
 * URL 토큰만 느슨하게 집어낸 뒤 new URL()로 해석하고, 통과한 **원본 문자열**을 돌려준다
 * (재조립하지 않는다 — 우리가 모르는 파라미터를 잃지 않기 위해).
 * 호스트는 포트까지 포함한 host로 본다 — claude.ai:444 같은 변형을 통과시키지 않는다.
 * @returns {{url: string, environmentId: string} | null}
 */
export function parseRemoteUrl(line) {
  const tokens = String(line ?? '').match(/https?:\/\/[^\s"'<>]+/g);
  if (!tokens) return null;
  for (const raw of tokens) {
    // 문장 끝 구두점이 붙어 오는 경우를 흡수
    const trimmed = raw.replace(/[.,)\]]+$/, '');
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    if (u.host !== REMOTE_URL_HOST) continue;
    if (u.pathname !== REMOTE_URL_PATH) continue;
    const env = u.searchParams.get('environment');
    if (!env || env.length > MAX_ENV_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(env)) continue;
    return { url: trimmed, environmentId: env };
  }
  return null;
}

/**
 * 출력 한 줄 → 부분 상태 패치. 모르는 줄이면 null(= 전이 없음).
 * 순수 함수 — node --test로 고정한다.
 * @returns {null | {state?, environmentId?, url?, capacity?, error?, idFromUrl?}}
 */
export function parseRemoteControlLine(rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;

  // 실측된 상태 줄은 전부 '·'로 칸이 나뉘고, 실측된 오류 줄은 전부 평문이다.
  // 오류 문구를 상태 줄에서 찾지 않음으로써 레포/브랜치 이름이 거짓 오류를 만드는 길을 막는다.
  if (!line.includes('·')) {
    for (const marker of ERROR_MARKERS) {
      if (line.includes(marker)) return { error: line };
    }
  }

  const patch = {};

  const url = parseRemoteUrl(line);
  if (url) {
    patch.url = url.url;
    patch.environmentId = url.environmentId;
    patch.idFromUrl = true;
  } else {
    // -v 전용 줄. URL이 없을 때의 보조 출처일 뿐이라 URL이 이미 있으면 apply가 무시한다.
    const idOnly = line.match(/^Environment ID:\s*(\S+)$/);
    if (idOnly && idOnly[1].length <= MAX_ENV_ID_LEN && /^[A-Za-z0-9_-]+$/.test(idOnly[1])) {
      patch.environmentId = idOnly[1];
      patch.idFromUrl = false;
    }
  }

  const cap = line.match(/\bCapacity:\s*(\d+)\s*\/\s*(\d+)/);
  if (cap) patch.capacity = { used: Number(cap[1]), max: Number(cap[2]) };

  // 상태 낱말은 앞쪽 칸에만 있다(예: "·✔︎· Ready · CC-on-browser · master").
  const segs = line.split('·', STATUS_SEGMENT_LIMIT);
  for (const seg of segs) {
    const word = STATUS_WORDS.get(seg.trim());
    if (word) {
      patch.state = word;
      break;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * CLI에 넘길 세션 이름 위생 처리.
 * 허용 문자를 좁게 화이트리스트한다 — 이 이름은 CLI가 상태 줄에 그대로 되울려 주므로,
 * 넓게 두면 이름 하나로 우리 파서에 가짜 URL이나 가짜 오류를 주입할 수 있다.
 */
export function sanitizeName(raw, cwd) {
  const clean = (s) => String(s ?? '')
    .replace(/[^A-Za-z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
  const cleaned = clean(raw);
  if (cleaned) return cleaned;
  const base = cwd ? clean(path.basename(cwd)) : '';
  return base || 'cc-on-browser';
}

/** 기본 트리 종료. win32는 taskkill /T, POSIX는 프로세스 그룹 시그널. */
function defaultKillTree(pid, { platform, force }) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      let child;
      try {
        child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        resolve();
        return;
      }
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      return;
    }
    // detached로 띄웠으므로 -pid가 프로세스 그룹 전체다.
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* 이미 죽음 */
      }
    }
    resolve();
  });
}

/**
 * cwd 하나당 `claude remote-control` 자식 하나를 관리한다.
 *
 * 상태: starting → ready → (stopping) → stopped | error
 * 'change' 이벤트로 스냅샷 전체를 emit한다(서버가 그대로 방송).
 */
export function createRemoteControl({
  cliPath,
  cliArgsPrefix = [],
  spawnFn = spawn,
  platform = process.platform,
  killTree = defaultKillTree,
  resolveCwd = async (p) => canonicalCwdSync(p),
  stopGraceMs = STOP_GRACE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
} = {}) {
  if (!cliPath) throw new TypeError('cliPath is required');

  const emitter = new EventEmitter();
  /** @type {Map<string, object>} canonical cwd -> entry */
  const entries = new Map();
  /** @type {Map<string, string>} 시작에 쓰인 원본 경로 -> canonical cwd.
   *  심볼릭 링크가 나중에 지워져 realpath가 실패해도 stop이 대상을 찾게 해 준다. */
  const aliases = new Map();
  let closed = false;

  // ----- 전역 직렬 큐 -----
  let opChain = Promise.resolve();
  const serial = (fn) => {
    // 앞선 작업의 실패가 뒤를 막지 않도록 성공/실패 모두에서 이어 붙인다.
    const run = opChain.then(fn, fn);
    opChain = run.then(() => {}, () => {});
    return run;
  };

  const publicState = (e) => ({
    cwd: e.cwd,
    name: e.name,
    state: e.state,
    environmentId: e.environmentId,
    url: e.url,
    capacity: e.capacity,
    error: e.error,
    startedAt: e.startedAt,
  });

  const snapshot = () => [...entries.values()].map(publicState);
  const emitChange = () => emitter.emit('change', snapshot());

  const apply = (entry, patch) => {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'idFromUrl') continue;
      if (k === 'error') {
        // 구체적으로 파싱된 오류가 먼저다 — 나중의 일반적 종료 사유가 덮지 않는다.
        if (entry.error != null) continue;
        entry.error = v;
        entry.state = 'error';
        changed = true;
        continue;
      }
      if (k === 'environmentId') {
        // URL에서 온 id가 권위. -v 전용 줄이 뒤늦게 와도 url과 어긋나게 만들지 않는다.
        if (patch.idFromUrl !== true && entry.url != null) continue;
      }
      if (k === 'state') {
        // stopping/error 중에는 자식의 늦은 상태 줄이 우리를 되살리지 못한다.
        if (entry.state === 'stopping' || entry.state === 'error') continue;
      }
      if (k === 'capacity') {
        const cur = entry.capacity;
        if (cur && cur.used === v.used && cur.max === v.max) continue;
        entry.capacity = v;
        changed = true;
        continue;
      }
      if (entry[k] === v) continue;
      entry[k] = v;
      changed = true;
    }
    return changed;
  };

  /** 완성된 줄만 파싱하고, 남은 조각은 그 뒤에 상한을 건다(선-파싱 후-절단). */
  const feed = (entry, chunk) => {
    entry.buf += chunk;
    let changed = false;
    let idx;
    while ((idx = entry.buf.indexOf('\n')) >= 0) {
      const line = entry.buf.slice(0, idx);
      entry.buf = entry.buf.slice(idx + 1);
      if (line.length > MAX_LINE_LEN) continue;
      const patch = parseRemoteControlLine(line);
      if (patch && apply(entry, patch)) changed = true;
    }
    // 개행 없이 길어지는 잔여만 잘라낸다 — 위에서 완성 줄을 먼저 소비했으므로
    // 큰 청크의 앞부분(Ready·URL)이 통째로 버려지지 않는다.
    if (entry.buf.length > MAX_LINE_LEN) entry.buf = entry.buf.slice(-MAX_LINE_LEN);
    if (changed) emitChange();
  };

  /** close 시점의 미종결 마지막 줄 — 여기에 구체적 오류가 실려 있을 수 있다. */
  const flushBuf = (entry) => {
    const rest = entry.buf;
    entry.buf = '';
    if (!rest || rest.length > MAX_LINE_LEN) return false;
    const patch = parseRemoteControlLine(rest);
    return patch ? apply(entry, patch) : false;
  };

  const feedErr = (entry, chunk) => {
    entry.errBuf += chunk;
    let idx;
    while ((idx = entry.errBuf.indexOf('\n')) >= 0) {
      const line = stripAnsi(entry.errBuf.slice(0, idx)).trim();
      entry.errBuf = entry.errBuf.slice(idx + 1);
      if (line) {
        entry.stderrTail = [...entry.stderrTail, line.slice(0, STDERR_TAIL_LINE_LEN)]
          .slice(-STDERR_TAIL_LINES);
      }
    }
    if (entry.errBuf.length > MAX_LINE_LEN) entry.errBuf = entry.errBuf.slice(-MAX_LINE_LEN);
  };

  const flushErr = (entry) => {
    const rest = stripAnsi(entry.errBuf).trim();
    entry.errBuf = '';
    if (rest) {
      entry.stderrTail = [...entry.stderrTail, rest.slice(0, STDERR_TAIL_LINE_LEN)]
        .slice(-STDERR_TAIL_LINES);
    }
  };

  const onChildClose = (entry, generation, code, signal) => {
    if (entry.generation !== generation) return; // 구세대 — 현재 상태를 건드리지 않는다
    entry.closedSeen = true;
    flushBuf(entry);
    flushErr(entry);
    entry.child = null;
    if (entry.state === 'stopping') {
      // stop()의 대기자가 최종 상태를 확정한다 — 여기서 앞질러 쓰지 않는다.
    } else if (entry.error != null) {
      entry.state = 'error'; // 이미 구체적 사유를 파싱해 뒀다 — 그대로 둔다
    } else {
      entry.state = 'error';
      const tail = entry.stderrTail.join(' / ');
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      entry.error = tail
        ? `원격 제어가 예기치 않게 종료되었습니다 (${how}): ${tail}`
        : `원격 제어가 예기치 않게 종료되었습니다 (${how})`;
    }
    emitChange();
  };

  const spawnChild = (entry) => {
    const args = [...cliArgsPrefix, 'remote-control', '--name', entry.name, '-v'];
    const child = spawnFn(cliPath, args, {
      cwd: entry.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX에서만 자기 프로세스 그룹을 준다 — stop()이 그룹 전체를 시그널하기 위해.
      // win32는 taskkill /T가 트리를 처리하므로 detached가 필요 없다.
      detached: platform !== 'win32',
    });
    entry.child = child;
    const { generation } = entry;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c) => {
      if (entry.generation !== generation) return;
      feed(entry, c);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c) => {
      if (entry.generation !== generation) return;
      feedErr(entry, c);
    });

    child.on('error', (err) => {
      if (entry.generation !== generation) return;
      if (entry.error == null) {
        entry.error = `원격 제어를 시작하지 못했습니다: ${err?.message ?? err}`;
        entry.state = 'error';
      }
      emitChange();
    });

    child.on('close', (code, signal) => onChildClose(entry, generation, code, signal));
  };

  const safeKill = (pid, force) => {
    try {
      const r = killTree(pid, { platform, force });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* 주입된 killTree가 동기적으로 던져도 종료 절차를 멈추지 않는다 */
    }
  };

  /**
   * 자식을 죽이고 실제 close까지 기다린다.
   * @returns {Promise<boolean>} 정말로 닫혔으면 true. false면 프로세스가 아직 살아 있을 수 있다.
   */
  const terminate = (entry) => new Promise((resolve) => {
    const child = entry.child;
    if (!child || entry.closedSeen) {
      resolve(true);
      return;
    }
    const { pid } = child;
    let settled = false;
    let timer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      resolve(ok);
    };
    child.once('close', () => {
      // POSIX: 그룹 리더가 죽어도 같은 그룹의 워커가 남아 있을 수 있다 —
      // 마지막으로 한 번 그룹 전체를 쓸어 준다(대상이 없으면 무해).
      if (platform !== 'win32' && pid != null) safeKill(pid, true);
      done(true);
    });
    if (pid == null) {
      done(true);
      return;
    }
    safeKill(pid, false);
    if (settled) return; // killTree가 동기적으로 close를 유발한 경우 — 타이머를 걸지 않는다
    timer = setTimeoutFn(() => {
      timer = null;
      safeKill(pid, true);
      if (settled) return;
      timer = setTimeoutFn(() => done(false), stopGraceMs);
      timer?.unref?.();
    }, stopGraceMs);
    timer?.unref?.();
  });

  /** 이미 잡고 있는 엔트리를 실제로 중지한다(직렬 큐 안에서만 호출). */
  const stopEntry = async (entry) => {
    if (!entry.child) {
      // 자식이 이미 없으면 "끔"으로 확정하고 오류 문구도 지운다.
      // error를 남겨 두면 UI가 그 항목을 계속 '켜진 것'으로 보고 시작 버튼을 주지 않아,
      // 죽은 항목에서 영원히 빠져나오지 못하는 막다른 길이 된다(codex 지적).
      entry.state = 'stopped';
      entry.error = null;
      emitChange();
      return publicState(entry);
    }
    entry.state = 'stopping';
    entry.error = null; // 중지는 사용자의 의도 — 이전 오류 문구를 끌고 가지 않는다
    emitChange();
    const ok = await terminate(entry);
    if (ok) {
      entry.child = null;
      entry.killFailed = false;
      entry.state = 'stopped';
    } else {
      // 죽이지 못했다 — 살아 있다고 보고해야 데몬이 먼저 내려가 고아를 만들지 않는다.
      // 실패 사실을 남겨 둔다: 이후 start가 같은 종료를 처음부터 다시 기다리지 않고
      // 곧바로 거절하도록(그러지 않으면 유예 시간만큼 멈춰 선다).
      entry.killFailed = true;
      entry.state = 'error';
      entry.error = '원격 제어 프로세스를 종료하지 못했습니다. 수동으로 종료해야 할 수 있습니다.';
    }
    emitChange();
    return publicState(entry);
  };

  const findEntry = async (rawCwd) => {
    const viaAlias = aliases.get(rawCwd);
    if (viaAlias && entries.has(viaAlias)) return entries.get(viaAlias);
    if (entries.has(rawCwd)) return entries.get(rawCwd);
    try {
      const canon = await resolveCwd(rawCwd);
      return entries.get(canon) ?? null;
    } catch {
      return null;
    }
  };

  const doStart = async (rawCwd, { name } = {}) => {
    if (closed) throw new Error('remote control manager is closed');
    if (!rawCwd) throw new TypeError('cwd is required');
    const cwd = await resolveCwd(rawCwd);
    if (closed) throw new Error('remote control manager is closed');
    aliases.set(rawCwd, cwd);

    const existing = entries.get(cwd);
    if (existing && (existing.state === 'starting' || existing.state === 'ready')) {
      return publicState(existing);
    }
    // stopped/error인데 자식이 아직 살아 있으면 먼저 확실히 죽인다 — 안 그러면 고아가 된다.
    if (existing && existing.child) {
      // 이미 한 번 죽이는 데 실패한 자식이면 다시 시도해도 같은 유예만 태운다 —
      // 곧바로 거절한다.
      if (!existing.killFailed) await stopEntry(existing);
      // 그 정리가 실패했다면(자식이 아직 살아 있다면) **새로 띄우지 않는다**.
      // 여기서 그냥 진행하면 엔트리를 갈아 끼우면서 옛 자식을 장부에서 놓쳐,
      // 아무도 죽일 수 없는 프로세스가 남는다 — 재시도 버튼이 곧 고아 생성기가 된다
      // (codex 지적).
      if (existing.child) {
        throw new Error(
          '이전 원격 제어 프로세스를 종료하지 못해 다시 시작할 수 없습니다.'
          + ' 해당 프로세스를 직접 종료한 뒤 다시 시도해 주세요.',
        );
      }
    }
    if (closed) throw new Error('remote control manager is closed');

    const entry = {
      cwd,
      name: sanitizeName(name, cwd),
      state: 'starting',
      environmentId: null,
      url: null,
      capacity: null,
      error: null,
      startedAt: now(),
      generation: (existing?.generation ?? 0) + 1,
      child: null,
      closedSeen: false,
      stderrTail: [],
      buf: '',
      errBuf: '',
    };
    entries.set(cwd, entry);
    try {
      spawnChild(entry);
    } catch (err) {
      entry.state = 'error';
      entry.error = `원격 제어를 시작하지 못했습니다: ${err?.message ?? err}`;
    }
    emitChange();
    return publicState(entry);
  };

  const doStop = async (rawCwd) => {
    if (!rawCwd) return null;
    const entry = await findEntry(rawCwd);
    if (!entry) return null;
    return stopEntry(entry);
  };

  const doCloseAll = async () => {
    // 새로 생긴 엔트리가 있을 수 있으니 비워질 때까지 훑는다.
    for (let round = 0; round < 5; round++) {
      const live = [...entries.values()].filter((e) => e.child);
      if (live.length === 0) return;
      for (const entry of live) await stopEntry(entry);
    }
  };

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    /** 지정 디렉터리의 원격 제어 시작. starting/ready면 아무것도 하지 않는다(idempotent). */
    start: (rawCwd, opts) => serial(() => doStart(rawCwd, opts)),

    /** 중지하고 자식 close까지 기다린다. 죽이지 못하면 error 상태로 남겨 계속 붙잡는다. */
    stop: (rawCwd) => serial(() => doStop(rawCwd)),

    snapshot,

    /**
     * 데몬 수명 정책이 참조하는 "붙잡아 둘 작업이 있는가".
     * 자식 핸들이 남아 있으면 상태와 무관하게 살아 있는 것으로 센다 —
     * 정리에 실패한 프로세스를 두고 데몬이 먼저 죽으면 고아가 되기 때문.
     */
    hasLive: () => {
      for (const e of entries.values()) {
        if (e.child) return true;
        if (e.state === 'starting' || e.state === 'ready' || e.state === 'stopping') return true;
      }
      return false;
    },

    /** 서버 종료 경로. 호출 즉시 새 start를 막고, 모든 자식을 정리한다. 멱등. */
    closeAll: () => {
      closed = true; // 큐에 이미 들어와 있던 start도 자기 차례에 이걸 보고 거부된다
      return serial(() => doCloseAll());
    },
  };
}
