// fs-api.js — cwd 피커용 디렉터리 탐색 API
import fs from 'node:fs/promises';
import path from 'node:path';

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
