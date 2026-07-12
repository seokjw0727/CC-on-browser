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
