import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirs, searchFiles } from '../src/fs-api.js';

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

test('searchFiles: 질의로 파일을 상대경로(POSIX)로 검색, 무시 디렉터리/숨김 제외', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-search-'));
  await fs.mkdir(path.join(base, 'src'));
  await fs.mkdir(path.join(base, 'src', 'lib'));
  await fs.mkdir(path.join(base, 'node_modules'));
  await fs.mkdir(path.join(base, '.git'));
  await fs.writeFile(path.join(base, 'README.md'), 'x', 'utf8');
  await fs.writeFile(path.join(base, 'src', 'index.js'), 'x', 'utf8');
  await fs.writeFile(path.join(base, 'src', 'lib', 'store.js'), 'x', 'utf8');
  await fs.writeFile(path.join(base, 'node_modules', 'pkg.js'), 'x', 'utf8');
  await fs.writeFile(path.join(base, '.git', 'config'), 'x', 'utf8');
  await fs.writeFile(path.join(base, '.env'), 'secret', 'utf8');

  const all = await searchFiles(base, '');
  // 무시 디렉터리(node_modules/.git)와 숨김(.env) 파일은 빠진다
  assert.ok(all.includes('README.md'));
  assert.ok(all.includes('src/index.js'));
  assert.ok(all.includes('src/lib/store.js'));
  assert.ok(!all.some((f) => f.includes('node_modules')));
  assert.ok(!all.some((f) => f.includes('.git')));
  assert.ok(!all.includes('.env'));
  // POSIX 구분자
  assert.ok(all.every((f) => !f.includes('\\')));

  // 질의는 파일명 우선(startsWith) → 경로 순으로 랭크
  const store = await searchFiles(base, 'store');
  assert.deepEqual(store, ['src/lib/store.js']);
  // 부분/서브시퀀스 매치
  assert.ok((await searchFiles(base, 'idx')).includes('src/index.js'));
  // 일치 없음
  assert.deepEqual(await searchFiles(base, 'zzzznope'), []);
});

test('searchFiles: 상대/UNC 경로는 거부', async () => {
  await assert.rejects(searchFiles('relative/dir', ''));
  await assert.rejects(searchFiles('\\\\server\\share', ''));
  await assert.rejects(searchFiles('//server/share', ''));
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
