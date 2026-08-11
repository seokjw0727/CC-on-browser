// attachments.js — 붙여넣기(paste)로 들어온 사진·파일을 "경로"로 바꿔 주는 층.
//
// 설계도(개정 2판)의 전제: 입력창에 붙여넣은 것은 첨부가 아니라 **경로 텍스트**가 된다.
// 그래서 이 모듈이 하는 일은 세 가지뿐이다.
//  ① listClipboardFiles — 탐색기에서 복사한 파일이면 OS 클립보드에서 **원본 경로**를
//     읽어 온다. 사본을 만들지 않아야 Claude가 원본을 그대로 읽고 고칠 수 있다.
//  ② saveClipboardFile — 스크린샷처럼 디스크에 실체가 없는 비트맵만 임시 폴더에 떨군다.
//  ③ cleanupStalePasteDirs — ②가 남긴 임시 폴더를 서버 기동 때 늦게 청소한다. 턴이
//     끝난 뒤에도 CLI가 다시 읽거나 세션을 재개할 수 있어 즉시 삭제하지 않는다.
//
// 경계: 클라이언트가 보내는 것은 파일 이름과 바이트뿐이고, 저장 위치는 서버가 정한다
// (claude-config.js와 같은 원칙 — 임의 경로 쓰기 창구를 열지 않는다). 파일 이름은
// 플랫폼과 무관하게 Windows 규칙으로 깎는다: 규칙이 하나여야 테스트가 결정적이고,
// Linux에서 만든 이름이 Windows에서 열리지 않는 사고도 막는다.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 임시 저장 루트의 이름 — tmpdir 안에서 우리 것을 식별하는 유일한 표식. */
export const PASTE_DIR_PREFIX = 'cc-on-browser-paste';

/** 붙여넣기 1건의 바이트 상한(디코드 후 기준). 넘으면 413 — preview의 상한과 같은 취지. */
export const MAX_PASTE_BYTES = 20 * 1024 * 1024;

// 청소 기준. 붙여넣은 스크린샷을 다음 날까지 다시 열어 볼 일은 사실상 없다.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 임시 저장 루트. 테스트는 root를 주입해 이 공용 디렉터리를 건드리지 않는다. */
export function pasteRoot() {
  return path.join(os.tmpdir(), PASTE_DIR_PREFIX);
}

/**
 * 루트가 "진짜 디렉터리"인지 본다 — 링크면 그 아래로는 한 발짝도 들어가지 않는다.
 * 붙여넣기 1건마다 랜덤인 것은 leaf 디렉터리뿐이고 루트 이름은 상수라, 서버가 처음 뜨기
 * 전에 같은 이름의 링크를 심어 둘 수 있다(공용 /tmp를 쓰는 Linux·macOS에서 성립한다).
 * 그 링크를 따라가면 저장은 남의 트리에 쓰고 청소는 그 트리를 재귀 삭제한다 — 하위
 * 엔트리를 lstat으로 거르는 것만으로는 시작점 자체를 막지 못한다.
 * @returns {Promise<'ok'|'missing'|'unsafe'>} 없는 것(첫 실행)은 문제가 아니다
 */
async function rootKind(root) {
  try {
    const st = await fs.lstat(root);
    return st.isDirectory() ? 'ok' : 'unsafe';
  } catch {
    return 'missing';
  }
}

// ---------------------------------------------------------------- 파일 이름 깎기

// Windows가 파일 이름에 허용하지 않는 문자 + 제어문자(개행·탭 포함). 덩어리 하나를
// 밑줄 하나로 바꾼다 — 그냥 지우면 서로 다른 이름이 같은 이름으로 뭉개지고, 1:1로
// 바꾸면 제어문자 하나에 밑줄이 줄줄이 붙어 읽을 수 없게 된다.
const FORBIDDEN_RE = /[<>:"|?*\u0000-\u001f\u007f]+/g;

// CON·NUL 같은 장치 이름은 확장자를 붙여도 장치로 해석된다(CON.txt도 장치다).
// 판정은 첫 점 앞 조각으로 한다 — con.txt.png 역시 걸린다.
const RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const FALLBACK_NAME = 'pasted-file';
const MAX_NAME_LENGTH = 120;
// 길이는 문자 수와 바이트 수 둘 다로 잰다. Windows의 제한은 문자 수지만 POSIX의
// NAME_MAX는 **바이트** 255라, 한글 이름은 120자만 돼도 360바이트가 되어 Linux·macOS의
// writeFile이 ENAMETOOLONG으로 튄다(붙여넣은 사용자에겐 이유 없는 500으로 보인다).
const MAX_NAME_BYTES = 200;

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** 바이트 예산에 맞춰 자른다 — 코드포인트 단위라 서로게이트 쌍이 반토막 나지 않는다. */
function clampBytes(s, maxBytes) {
  if (byteLen(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = byteLen(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

const trimTrailing = (s) => s.replace(/[\s.]+$/, '');
// 앞뒤의 공백·점 제거. Windows는 끝의 점·공백을 조용히 버려 이름이 어긋나고, 앞쪽 점을
// 걷어내면 '.'·'..' 같은 이름이 애초에 만들어지지 않는다.
const trimEdges = (s) => trimTrailing(s.replace(/^[\s.]+/, ''));

/**
 * 클라이언트가 준 이름을 "그 디렉터리 안의 파일 하나"로만 성립하는 basename으로 깎는다.
 * @param {unknown} name 브라우저가 넘긴 원본 파일 이름
 * @returns {string} 항상 비어 있지 않은 안전한 파일 이름
 */
export function sanitizeFileName(name) {
  // 경로 구분자는 치환하지 않고 마지막 조각만 취한다 — '..\\..\\x.png'처럼 위로
  // 올라가려는 이름을 남기지 않으려면 basename 의미가 맞다.
  const raw = typeof name === 'string' ? name : '';
  let safe = trimEdges((raw.split(/[\\/]/).pop() ?? '').replace(FORBIDDEN_RE, '_'));
  if (!safe) return FALLBACK_NAME;
  if (RESERVED_RE.test(safe.split('.')[0])) safe = `_${safe}`;
  if (safe.length <= MAX_NAME_LENGTH && byteLen(safe) <= MAX_NAME_BYTES) return safe;

  // 길면 앞쪽을 남기고 자른다 — 확장자는 CLI가 파일 종류를 알아보는 단서라 지킨다.
  // 다만 점 뒤가 비정상적으로 길면 그건 확장자가 아니라 이름의 일부다.
  const ext = path.extname(safe);
  const keepExt = ext.length > 1 && ext.length <= 20 ? ext : '';
  // 문자 수로 먼저 자르고 남은 바이트 예산으로 한 번 더 — 확장자 몫은 예산에서 뺀다.
  const cut = clampBytes(safe.slice(0, MAX_NAME_LENGTH - keepExt.length), MAX_NAME_BYTES - byteLen(keepExt));
  const stem = trimTrailing(cut) || FALLBACK_NAME;
  return `${stem}${keepExt}`;
}

// ---------------------------------------------------------------- 임시 저장

function badBodyError(message) {
  const err = new Error(message);
  err.code = 'EBADBODY';
  return err;
}

function payloadError(message) {
  const err = new Error(message);
  // server.js가 본문 크기 초과에 이미 쓰는 코드 — 호출측이 413 하나로 매핑한다.
  err.code = 'EPAYLOAD';
  return err;
}

/**
 * base64를 "디코드가 되면 통과"가 아니라 **왕복이 일치해야** 통과로 본다.
 * Buffer.from은 알파벳 밖 문자를 조용히 버려서, 잘린 본문이나 엉뚱한 텍스트도
 * 그럴싸한 바이트가 되어 쓰레기 파일이 디스크에 남는다. 관대함은 패딩까지만 —
 * btoa는 '='를 붙이지만 떼고 보내는 클라이언트도 있어 그 차이는 무시한다.
 */
function decodeStrictBase64(data) {
  if (typeof data !== 'string') throw badBodyError('data must be a base64 string');
  const buf = Buffer.from(data, 'base64');
  const unpad = (s) => s.replace(/=+$/, '');
  if (unpad(buf.toString('base64')) !== unpad(data)) throw badBodyError('data is not valid base64');
  return buf;
}

/**
 * 붙여넣은 바이트를 임시 폴더에 저장하고 절대경로를 돌려준다.
 * @param {{name?: unknown, data?: unknown}} body data는 원시 base64(data: URL의 콤마 이후)
 * @param {{root?: string}} [options] root는 테스트 주입용
 * @returns {Promise<{path: string}>}
 */
export async function saveClipboardFile({ name, data } = {}, { root = pasteRoot() } = {}) {
  const buf = decodeStrictBase64(data);
  if (buf.byteLength > MAX_PASTE_BYTES) {
    throw payloadError(`pasted file exceeds ${MAX_PASTE_BYTES} bytes`);
  }
  // 루트가 링크로 바꿔치기돼 있으면 저장하지 않는다 — mkdir은 recursive여도 링크를
  // 순순히 따라가므로, 여기서 막지 않으면 붙여넣은 바이트가 남의 트리에 쓰인다.
  if (await rootKind(root) === 'unsafe') {
    throw new Error(`paste root is not a directory: ${root}`);
  }
  // 붙여넣기 한 번에 랜덤 디렉터리 하나. 같은 이름을 여러 번 붙여넣어도 앞의 것을
  // 덮어쓰지 않고(앞 턴의 경로가 계속 유효하다), 공용 tmp에서 경로를 미리 추측해
  // 심볼릭 링크를 심어 두는 장난도 통하지 않는다.
  const dir = path.join(root, crypto.randomBytes(12).toString('hex'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.resolve(dir, sanitizeFileName(name));
  // wx — 방금 만든 랜덤 디렉터리라 충돌할 리 없다. 그런데도 뭔가 있다면 우리가 만든
  // 것이 아니므로 따라 쓰지 않고 실패한다.
  await fs.writeFile(file, buf, { mode: 0o600, flag: 'wx' });
  return { path: file };
}

// ---------------------------------------------------------------- OS 클립보드 조회

// PowerShell 5.1은 STA 스레드에서만 클립보드를 읽는다(fs-api.js의 폴더 대화상자와 같은
// 이유로 -STA). 출력은 공백 분리로 파싱할 수 없어서(경로에 공백이 흔하다) JSON으로
// 받는다. @()로 감싸는 이유는 항목이 하나일 때 ConvertTo-Json이 배열을 스칼라로 풀어
// 버리기 때문이고, FullName만 뽑는 이유는 FileInfo 객체를 통째로 직렬화하지 않기 위해서다.
const CLIPBOARD_FILES_PS = [
  "$ErrorActionPreference='Stop'",
  // 한글 경로가 깨지지 않게 stdout을 BOM 없는 UTF-8로 고정한다(Node는 utf8로 디코드).
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
  '$files=@(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName })',
  'ConvertTo-Json -InputObject $files -Compress',
].join('\n');

// 클립보드 조회는 붙여넣기 직후 사용자를 기다리게 하는 경로다. 5초가 넘으면 그 자체로
// 실패로 보고 업로드 폴백으로 넘긴다.
const CLIPBOARD_TIMEOUT_MS = 5_000;

/** 기본 실행기 — stdout 문자열을 돌려준다(주입 exec도 같은 계약). */
function runPowerShell() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', CLIPBOARD_FILES_PS],
      { encoding: 'utf8', timeout: CLIPBOARD_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function parsePathList(out) {
  // 주입 exec가 child_process 관례대로 { stdout }을 줘도 받아 준다.
  const text = typeof out === 'string' ? out : (typeof out?.stdout === 'string' ? out.stdout : '');
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // 프로필 배너·에러 문구 등 JSON이 아닌 출력은 "목록 없음"으로 본다.
    return [];
  }
  // PowerShell 버전에 따라 항목이 하나면 스칼라, 비면 null이 나올 수 있다.
  if (typeof parsed === 'string') return parsed ? [parsed] : [];
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p) => typeof p === 'string' && p.length > 0);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * OS 클립보드에 담긴 **파일 경로 목록**(내용이 아니라 경로)을 돌려준다.
 * 실패·타임아웃·비JSON은 전부 빈 목록이다 — 호출측은 그때 업로드 폴백으로 간다.
 * @param {{platform?: string, exec?: () => Promise<string|{stdout: string}>}} [options]
 * @returns {Promise<string[]>} 존재가 확인된 경로만, 받은 순서 그대로
 */
export async function listClipboardFiles({ platform = process.platform, exec = runPowerShell } = {}) {
  // 원본 경로 조회는 Windows 전용이다. 다른 OS에서는 빈 목록 → 업로드 폴백(설계도 §4).
  if (platform !== 'win32') return [];
  let out;
  try {
    out = await exec();
  } catch {
    return [];
  }
  const candidates = parsePathList(out);
  const alive = await Promise.all(candidates.map(exists));
  // 경로 문자열은 정규화하지 않는다 — 대소문자·UNC·표기를 손대면 사용자가 입력창에서
  // 보게 될 문자열이 클립보드의 원본과 달라진다.
  return candidates.filter((_, i) => alive[i]);
}

// ---------------------------------------------------------------- 청소

/**
 * 임시 저장 루트에서 오래된 붙여넣기 디렉터리를 지운다(서버 기동 시 fire-and-forget).
 * @param {{root?: string, now?: number, maxAgeMs?: number}} [options]
 * @returns {Promise<number>} 실제로 지운 디렉터리 수
 */
export async function cleanupStalePasteDirs({
  root = pasteRoot(),
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  // 지우는 쪽이라 루트 확인이 더 중요하다 — 링크면 그 아래를 뒤지지도 않는다.
  if (await rootKind(root) !== 'ok') return 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // 한 번도 붙여넣은 적이 없으면 루트 자체가 없다 — 정상이다.
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    // isDirectory()는 링크를 따라가지 않는다(withFileTypes는 lstat 의미). 공용 tmp에
    // 누가 심어 둔 링크를 타고 남의 트리를 재귀 삭제하는 일을 여기서 끊는다.
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const st = await fs.lstat(dir);
      if (now - st.mtimeMs <= maxAgeMs) continue;
      // Windows는 방금 읽힌 파일 핸들이 남아 EBUSY로 튀는 일이 있어 재시도를 준다.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed += 1;
    } catch {
      // 사용 중이거나 권한이 없으면 건너뛴다 — 청소 실패가 서버 기동을 막아선 안 된다.
    }
  }
  return removed;
}
