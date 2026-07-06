import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirs } from '../src/fs-api.js';

test('lists subdirectories, excluding hidden dirs and files', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fsapi-'));
  await fs.mkdir(path.join(base, 'visible-b'));
  await fs.mkdir(path.join(base, 'visible-a'));
  await fs.mkdir(path.join(base, '.hidden'));
  await fs.writeFile(path.join(base, 'file.txt'), 'x', 'utf8');
  const res = await listDirs(base);
  assert.equal(res.path, path.resolve(base));
  assert.equal(res.parent, path.dirname(path.resolve(base)));
  assert.deepEqual(res.dirs, ['visible-a', 'visible-b']);
});

test('empty path lists drives', async () => {
  const res = await listDirs('');
  assert.equal(res.path, '');
  assert.equal(res.parent, null);
  assert.ok(Array.isArray(res.dirs));
  assert.ok(res.dirs.length > 0);
  if (process.platform === 'win32') {
    assert.ok(res.dirs.includes('C:\\'));
    for (const d of res.dirs) assert.match(d, /^[A-Z]:\\$/);
  }
});

test('root path has null parent', async () => {
  const rootPath = process.platform === 'win32' ? 'C:\\' : '/';
  const res = await listDirs(rootPath);
  assert.equal(res.path, rootPath);
  assert.equal(res.parent, null);
});

test('relative path is rejected', async () => {
  await assert.rejects(listDirs('relative/dir'));
});

test('UNC/network paths are rejected', async () => {
  await assert.rejects(listDirs('\\\\server\\share'));
  await assert.rejects(listDirs('//server/share'));
  await assert.rejects(listDirs('\\\\?\\C:\\Users'));
});

test('symlinks are listed by name without following (lstat basis)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fsapi-link-'));
  const target = path.join(base, 'real-target');
  await fs.mkdir(target);
  const holder = path.join(base, 'holder');
  await fs.mkdir(holder);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(target, path.join(holder, 'link-dir'), linkType);
  } catch {
    t.skip('symlink creation not permitted in this environment');
    return;
  }
  // 타깃을 지워 dangling link로 만들어도 이름이 나열되어야 함 = 따라가지 않는다는 증거
  await fs.rmdir(target);
  const res = await listDirs(holder);
  assert.deepEqual(res.dirs, ['link-dir']);
});

test('EPERM yields empty dirs instead of throwing', async (t) => {
  t.mock.method(fs, 'readdir', async () => {
    const err = new Error('operation not permitted');
    err.code = 'EPERM';
    throw err;
  });
  const target = process.platform === 'win32' ? 'C:\\locked-dir' : '/locked-dir';
  const res = await listDirs(target);
  assert.deepEqual(res.dirs, []);
  assert.equal(res.path, path.resolve(target));
});
