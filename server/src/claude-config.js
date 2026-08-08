// claude-config.js — Claude Code 사용자 전역 설정(~/.claude/settings.json) 읽기·쓰기.
//
// 이 모듈은 사용자가 브라우저 UI(설정 → Claude Code Config)에서 CLI 설정을 직접
// 편집할 수 있게 하려고 존재한다. 경로는 **서버가 정한 하나**뿐이다 — 클라이언트가
// 보내는 임의 경로는 받지 않는다(로컬 도구라도 임의 파일 쓰기 창구를 열지 않는다).
//
// 쓰기 규칙(설계도 §2 claude-config.js 행):
//  · JSON 파싱 + 최상위 객체 검증을 통과한 내용만 쓴다 — CLI가 읽지 못할 파일을
//    남기면 이후 모든 세션이 깨진다.
//  · 모든 쓰기는 프로세스 안에서 직렬화한다(동시 PUT 두 개가 서로의 검사·rename을
//    가로지르지 못하게). 실패한 쓰기가 큐를 오염시키지 않도록 체인은 항상 이어진다.
//  · 낙관적 잠금: expectedMtimeMs가 현재 파일과 다르면 ECONFLICT(다른 곳에서 수정됨).
//    null은 "파일이 없다고 보고 새로 만든다"는 뜻이라, 이미 있으면 역시 충돌이다.
//  · 원자적 교체: 같은 디렉터리의 고유 임시 파일에 배타 생성(O_EXCL, 0o600)으로 쓰고
//    rename한다. 기존 파일이 있으면 그 권한(mode)을 물려준다 — 사용자가 좁혀 둔
//    권한을 넓히지 않기 위해.
//  · 심볼릭 링크·비정규 파일은 거부한다(링크를 따라가 엉뚱한 파일을 덮어쓰지 않게).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 기본 대상 — 사용자 전역 설정 파일. */
export function defaultConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'settings.json');
}

/** 파일이 없을 때 편집기에 보여 줄 초기 내용 — 빈 문자열은 JSON으로 유효하지 않다. */
export const EMPTY_CONFIG = '{}';

// 새로 만드는 설정 파일의 권한 — 사용자만 읽고 쓴다. 이 파일에는 API 키·훅 명령 등
// 민감한 값이 들어갈 수 있어 기본 umask(0644)에 맡기지 않는다.
const NEW_FILE_MODE = 0o600;

// 읽기 플래그 — POSIX에서는 O_NOFOLLOW로 "링크면 열지도 않는다"를 커널에 맡긴다
// (열고 나서 lstat으로 확인하면 그 사이에 바꿔치기할 틈이 남는다). Windows에는
// 이 플래그가 없어 열린 뒤 lstat으로 확인한다.
const READ_FLAGS = process.platform === 'win32' || !fs.constants.O_NOFOLLOW
  ? fs.constants.O_RDONLY
  : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

function conflictError(message) {
  const err = new Error(message);
  err.code = 'ECONFLICT';
  return err;
}

function invalidError(message) {
  const err = new Error(message);
  err.code = 'EINVALIDCONFIG';
  return err;
}

/** 심볼릭 링크·디렉터리 등 "정규 파일이 아닌 대상"이면 거부. 없으면 null. */
async function statRegular(configPath) {
  let st;
  try {
    st = await fs.lstat(configPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile()) {
    throw invalidError('settings.json is not a regular file (symlink or directory)');
  }
  return st;
}

/**
 * 현재 설정 읽기.
 * @returns {Promise<{exists: boolean, content: string, mtimeMs: number|null, path: string}>}
 * 없으면 exists=false·content=EMPTY_CONFIG(편집기가 곧바로 쓸 수 있는 기준선).
 */
export async function readClaudeConfig(configPath = defaultConfigPath()) {
  // 링크 검사와 읽기 사이에 대상이 바뀌는 창(TOCTOU)을 없애기 위해, 열어 둔 핸들
  // 자체를 stat하고 그 핸들에서 읽는다 — 검사한 그 파일이 곧 읽는 파일이다.
  let handle;
  try {
    handle = await fs.open(configPath, READ_FLAGS);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { exists: false, content: EMPTY_CONFIG, mtimeMs: null, path: configPath };
    }
    // ELOOP = O_NOFOLLOW가 심볼릭 링크를 열기 전에 막았다(경쟁 없이 확실한 거부).
    if (err?.code === 'ELOOP') throw invalidError('settings.json is not a regular file (symlink)');
    if (err?.code === 'EISDIR') throw invalidError('settings.json is not a regular file');
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw invalidError('settings.json is not a regular file');
    // 심볼릭 링크는 lstat으로만 구분된다(open은 이미 따라간 뒤다) — 링크면 거부.
    const link = await fs.lstat(configPath).catch(() => null);
    if (link && link.isSymbolicLink()) {
      throw invalidError('settings.json is not a regular file (symlink)');
    }
    const content = await handle.readFile('utf8');
    return { exists: true, content, mtimeMs: st.mtimeMs, path: configPath };
  } finally {
    await handle.close().catch(() => {});
  }
}

// 쓰기 직렬화 큐 — 경로별로 하나. 실패는 여기서 흡수하고(catch) 다음 쓰기는 정상
// 진행한다. 그러지 않으면 거부된 프라미스가 체인에 남아 이후 모든 쓰기가 같은
// 오류로 죽는다(codex 지적).
const writeQueues = new Map();

// 우리가 마지막으로 쓴 내용의 지문 — 경로 -> {mtimeMs, hash}.
// mtime만으로는 "같은 밀리초 안에 일어난 외부 수정"을 구분할 수 없다(파일시스템
// 시간 해상도가 ms인데 연속 쓰기는 그보다 빠르다). 기준 mtime이 일치할 때 한 번 더
// 내용을 대조해, 그 자리에 있는 파일이 정말 우리가 남긴 그 파일인지 확인한다.
const lastWritten = new Map();

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function enqueueWrite(configPath, job) {
  const prev = writeQueues.get(configPath) ?? Promise.resolve();
  const run = prev.then(job, job);
  // 큐 꼬리는 성공/실패를 구분하지 않는 "완료" 신호만 남긴다.
  const tail = run.then(
    () => {},
    () => {},
  );
  writeQueues.set(configPath, tail);
  tail.then(() => {
    if (writeQueues.get(configPath) === tail) writeQueues.delete(configPath);
  });
  return run;
}

/**
 * 설정 저장 — 검증 → (직렬화) → 충돌 검사 → 원자적 교체.
 * @param {string} content 파일에 쓸 원문(그대로 저장한다 — 포매팅 보존)
 * @param {number|null} expectedMtimeMs 마지막으로 읽은 mtime. null이면 "파일 없음"을 기대.
 * @returns {Promise<{mtimeMs: number, path: string}>}
 * @throws code=EINVALIDCONFIG(잘못된 JSON/최상위 비객체·비정규 파일) | ECONFLICT(외부 수정)
 */
export async function writeClaudeConfig(
  content,
  expectedMtimeMs = null,
  configPath = defaultConfigPath(),
) {
  if (typeof content !== 'string') throw invalidError('content must be a string');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw invalidError(`invalid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidError('settings.json must contain a JSON object');
  }

  return enqueueWrite(configPath, async () => {
    const st = await statRegular(configPath);
    // 낙관적 잠금 — 읽은 뒤 다른 곳(에디터·CLI·다른 탭)에서 바뀌었으면 덮지 않는다.
    if (expectedMtimeMs == null) {
      if (st) throw conflictError('settings.json already exists');
    } else if (!st) {
      throw conflictError('settings.json was removed');
    } else if (st.mtimeMs !== expectedMtimeMs) {
      throw conflictError('settings.json was modified elsewhere');
    } else {
      // mtime이 같아도 내용이 우리가 남긴 것과 다르면 그 사이에 누군가 덮어썼다는 뜻.
      const fingerprint = lastWritten.get(configPath);
      if (fingerprint && fingerprint.mtimeMs === st.mtimeMs) {
        const current = await fs.readFile(configPath, 'utf8').catch(() => null);
        if (current != null && sha(current) !== fingerprint.hash) {
          throw conflictError('settings.json was modified elsewhere');
        }
      }
    }

    const dir = path.dirname(configPath);
    await fs.mkdir(dir, { recursive: true }); // ~/.claude가 아직 없을 수 있다
    const tmp = path.join(dir, `.settings.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      // wx = 배타 생성(이미 있으면 실패) — 남의 임시 파일을 덮지 않는다.
      handle = await fs.open(tmp, 'wx', NEW_FILE_MODE);
      await handle.writeFile(content, 'utf8');
      // rename 전에 디스크로 밀어낸다 — 교체 직후 전원이 끊겨도 빈 파일이 남지 않게.
      await handle.sync().catch(() => {});
      await handle.close();
      handle = null;
      // 기존 파일의 권한을 물려받는다(사용자가 좁혀 둔 권한을 넓히지 않기 위해).
      // POSIX에서는 이 보장이 실패하면 쓰기 자체를 중단한다 — 권한이 조용히
      // 넓어진 파일을 남기느니 저장을 거절하는 편이 안전하다(SECURITY.md의 약속).
      // Windows의 chmod는 읽기 전용 비트만 다루는 흉내라 실패해도 무시한다.
      if (st) {
        if (process.platform === 'win32') await fs.chmod(tmp, st.mode & 0o777).catch(() => {});
        else await fs.chmod(tmp, st.mode & 0o777);
      }
      await fs.rename(tmp, configPath);
    } catch (err) {
      await handle?.close().catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {}); // 실패 경로마다 임시 파일 정리
      throw err;
    }
    let after = await fs.stat(configPath);
    // 버전(mtime)은 성공한 쓰기마다 반드시 증가해야 한다. 파일시스템의 시간 해상도가
    // 거칠면(Windows·일부 ext4) 교체 전후의 mtime이 같은 값으로 찍혀, 낡은
    // expectedMtimeMs가 그대로 통과해 남의 저장을 덮어쓸 수 있다(codex 지적).
    if (st && after.mtimeMs <= st.mtimeMs) {
      const bumped = new Date(st.mtimeMs + 1);
      await fs.utimes(configPath, bumped, bumped).catch(() => {});
      after = await fs.stat(configPath);
    }
    // 다음 저장이 "이 파일이 아직 우리 것인가"를 확인할 수 있도록 지문을 남긴다.
    lastWritten.set(configPath, { mtimeMs: after.mtimeMs, hash: sha(content) });
    return { mtimeMs: after.mtimeMs, path: configPath };
  });
}
