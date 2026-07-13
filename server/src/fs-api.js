// fs-api.js — cwd 피커용 디렉터리 탐색 API
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 로컬 단일 사용자 도구이므로, 서버(=사용자 PC)가 네이티브 폴더 선택 대화상자를
// 사용자 데스크톱에 여는 것이 안전하다. 경로는 PowerShell 스크립트에 문자열로
// 끼워넣지 않고 환경변수로 전달해 인젝션/이스케이프 문제를 원천 차단한다.
const FOLDER_DIALOG_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'CC-on-browser: 작업 디렉터리 선택'
$dlg.ShowNewFolderButton = $true
if ($env:CCOB_INIT_PATH -and (Test-Path -LiteralPath $env:CCOB_INIT_PATH)) {
  try { $dlg.SelectedPath = $env:CCOB_INIT_PATH } catch {}
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.Show() | Out-Null; $owner.Activate()
$res = $dlg.ShowDialog($owner)
$owner.Close()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
`;

const FOLDER_DIALOG_TIMEOUT_MS = 3 * 60_000;

/**
 * 네이티브 폴더 선택 대화상자를 띄우고 선택 경로를 반환한다.
 * @returns {Promise<{path: string|null, canceled: boolean}>} 취소/무선택 시 path=null.
 */
export function pickDirectory({ initialPath } = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('네이티브 폴더 선택은 Windows에서만 지원됩니다.'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', FOLDER_DIALOG_PS],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CCOB_INIT_PATH: initialPath || '' },
        },
      );
    } catch (err) {
      reject(err);
      return;
    }
    // PS 스크립트가 [Console]::OutputEncoding=UTF8로 출력하므로 UTF-8로 디코드 —
    // setEncoding으로 멀티바이트(한글 경로)가 청크 경계에서 깨지지 않게 한다.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '';
    let errOut = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* noop */ }
      resolve({ path: null, canceled: true });
    }, FOLDER_DIALOG_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { errOut += c.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const picked = out.trim();
      if (picked) resolve({ path: picked, canceled: false });
      else if (code === 0) resolve({ path: null, canceled: true });
      else reject(new Error(errOut.trim() || `folder dialog failed (code ${code})`));
    });
  });
}

const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

async function listDrives() {
  const checks = await Promise.allSettled(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`;
      await fs.stat(root);
      return root;
    }),
  );
  return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

// ----- @ 파일 태그용 — cwd 하위 파일을 질의로 검색해 상대경로(POSIX 구분자)를 반환 -----
// 로컬 단일 사용자 도구지만 거대한 트리를 무한정 훑지 않도록 방문/결과 상한을 둔다.
// 파일 "이름"만 반환하고 내용은 절대 읽지 않는다(listDirs와 동일 원칙).
const FILE_SEARCH_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'target', 'vendor', '.omc',
]);
const FILE_SEARCH_MAX_ENTRIES = 20_000; // 방문 상한(디렉터리 폭주 방지)
const FILE_SEARCH_MAX_RESULTS = 50;

function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

// 낮을수록 좋은 매치. -1이면 불일치(결과에서 제외). q는 소문자·트림된 질의.
function fileMatchScore(relLower, nameLower, q) {
  if (!q) return 0; // 빈 질의 — 전부 매치, 이후 경로 길이(얕은 순)로 정렬
  if (nameLower.startsWith(q)) return 0;
  if (nameLower.includes(q)) return 1;
  if (relLower.includes(q)) return 2;
  return isSubsequence(q, relLower) ? 3 : -1;
}

/**
 * cwd 하위 파일을 질의로 검색한다. BFS로 얕은 경로를 먼저 방문해 상한에 걸려도
 * 가까운 파일이 우선 담긴다. 숨김(.) 파일/폴더와 무거운 빌드 디렉터리는 건너뛴다.
 * @returns {Promise<string[]>} cwd 기준 상대경로 목록(POSIX '/' 구분자), 관련도순.
 */
export async function searchFiles(cwd, query = '', { limit = FILE_SEARCH_MAX_RESULTS } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error(`searchFiles requires an absolute cwd, got: ${String(cwd)}`);
  }
  if (cwd.startsWith('\\\\') || cwd.startsWith('//')) {
    throw new Error(`UNC/network paths are not allowed: ${cwd}`);
  }
  const root = path.resolve(cwd);
  const q = String(query ?? '').trim().toLowerCase();
  const results = [];
  let visited = 0;
  const queue = [root];
  while (queue.length && visited < FILE_SEARCH_MAX_ENTRIES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 권한 없음 등 — 조용히 건너뛴다
    }
    for (const e of entries) {
      visited += 1;
      if (visited > FILE_SEARCH_MAX_ENTRIES) break;
      if (e.name.startsWith('.')) continue; // 숨김 파일/폴더 제외
      if (e.isDirectory()) {
        if (!FILE_SEARCH_IGNORE_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue; // 심볼릭 링크·특수 파일은 제외(따라가지 않음)
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
      const score = fileMatchScore(rel.toLowerCase(), e.name.toLowerCase(), q);
      if (score >= 0) results.push({ rel, score });
    }
  }
  results.sort(
    (a, b) =>
      a.score - b.score ||
      a.rel.length - b.rel.length ||
      a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' }),
  );
  return results.slice(0, limit).map((r) => r.rel);
}

export async function listDirs(absPath) {
  if (absPath === '' || absPath == null) {
    const dirs = process.platform === 'win32' ? await listDrives() : ['/'];
    return { path: '', parent: null, dirs };
  }
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    throw new Error(`listDirs requires an absolute path, got: ${String(absPath)}`);
  }
  const resolved = path.resolve(absPath);
  // UNC/네트워크/디바이스 경로(\\server\share, \\?\..., //server/share) 거부
  if (
    absPath.startsWith('\\\\') ||
    absPath.startsWith('//') ||
    resolved.startsWith('\\\\')
  ) {
    throw new Error(`UNC/network paths are not allowed: ${absPath}`);
  }
  const parentDir = path.dirname(resolved);
  const parent = parentDir === resolved ? null : parentDir;
  let entries;
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return { path: resolved, parent, dirs: [] };
    }
    throw err;
  }
  // 심볼릭 링크는 따라가지 않고(lstat 기준) 이름만 나열. 파일 내용은 반환하지 않음.
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { path: resolved, parent, dirs };
}
