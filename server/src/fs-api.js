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
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { path: resolved, parent, dirs };
}
