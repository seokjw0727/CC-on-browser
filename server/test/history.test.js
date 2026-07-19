import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjects, listSessions, loadTranscript, listRecentSessions, deleteSession } from '../src/history.js';

const J = (o) => JSON.stringify(o);

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-history-'));
  const dir = path.join(root, 'C--fake-project');
  await fs.mkdir(dir, { recursive: true });

  const longText = '가'.repeat(120);
  const s1 = [
    J({ type: 'user', cwd: 'C:\\fake', message: { role: 'user', content: [{ type: 'text', text: '제목이 될 텍스트' }] } }),
    J({ type: 'system', subtype: 'init', session_id: 'aaaa-1111', cwd: 'C:\\fake', tools: [] }),
    J({ type: 'system', subtype: 'status', status: 'thinking' }),
    J({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '응' } } }),
    J({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '응답' }] } }),
    J({ type: 'result', subtype: 'success', result: '응답', session_id: 'aaaa-1111' }),
  ].join('\n') + '\n';
  const s2 = [
    J({ type: 'user', cwd: 'C:\\fake', message: { role: 'user', content: [{ type: 'text', text: longText }] } }),
    J({ type: 'result', subtype: 'success', result: 'ok', session_id: 'bbbb-2222' }),
  ].join('\n') + '\n';

  const f1 = path.join(dir, 'aaaa-1111.jsonl');
  const f2 = path.join(dir, 'bbbb-2222.jsonl');
  await fs.writeFile(f1, s1, 'utf8');
  await fs.writeFile(f2, s2, 'utf8');
  const oldT = new Date(Date.now() - 60_000);
  const newT = new Date();
  await fs.utimes(f1, oldT, oldT);
  await fs.utimes(f2, newT, newT);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not a session', 'utf8');
  return { root, dir };
}

test('listProjects scans projectsRoot and reads cwd from latest session', async () => {
  const { root } = await makeRoot();
  const projects = await listProjects(root);
  assert.equal(projects.length, 1);
  const p = projects[0];
  assert.equal(p.dirName, 'C--fake-project');
  assert.equal(p.cwd, 'C:\\fake');
  assert.equal(p.sessionCount, 2);
  assert.equal(typeof p.lastModified, 'number');
  assert.ok(p.lastModified > 0);
});

test('listProjects returns [] for missing root', async () => {
  const missing = path.join(os.tmpdir(), `cc-history-none-${Date.now()}`);
  assert.deepEqual(await listProjects(missing), []);
});

test('listSessions returns metadata sorted by mtime desc with 80-char titles', async () => {
  const { root } = await makeRoot();
  const sessions = await listSessions(root, 'C--fake-project');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'bbbb-2222');
  assert.equal(sessions[1].sessionId, 'aaaa-1111');
  assert.equal(sessions[1].title, '제목이 될 텍스트');
  assert.equal(sessions[0].title.length, 80);
  assert.ok(sessions[0].fileSize > 0);
  assert.equal(typeof sessions[0].mtime, 'number');
  assert.ok(sessions[0].mtime >= sessions[1].mtime);
});

test('loadTranscript keeps assistant/user/result and only first system/init', async () => {
  const { root } = await makeRoot();
  const { messages } = await loadTranscript(root, 'C--fake-project', 'aaaa-1111');
  assert.deepEqual(
    messages.map((m) => m.type),
    ['user', 'system', 'assistant', 'result'],
  );
  assert.equal(messages[1].subtype, 'init');
});

test('listRecentSessions aggregates across projects, mtime desc, with cwd/title', async () => {
  const { root, dir } = await makeRoot(); // C--fake-project: aaaa(old), bbbb(new)
  // 두 번째 프로젝트 — 가장 최신 세션(cccc)
  const dir2 = path.join(root, 'D--other-proj');
  await fs.mkdir(dir2, { recursive: true });
  const s3 = [
    J({ type: 'user', cwd: 'D:\\other', message: { role: 'user', content: [{ type: 'text', text: '다른 프로젝트 세션' }] } }),
    J({ type: 'result', subtype: 'success', result: 'ok', session_id: 'cccc-3333' }),
  ].join('\n') + '\n';
  const f3 = path.join(dir2, 'cccc-3333.jsonl');
  await fs.writeFile(f3, s3, 'utf8');
  const newest = new Date(Date.now() + 60_000);
  await fs.utimes(f3, newest, newest);

  const recent = await listRecentSessions(root);
  // 전 프로젝트에서 모아 mtime 내림차순 — cccc(미래) > bbbb(now) > aaaa(과거)
  assert.deepEqual(recent.map((r) => r.sessionId), ['cccc-3333', 'bbbb-2222', 'aaaa-1111']);
  assert.equal(recent[0].dirName, 'D--other-proj');
  assert.equal(recent[0].cwd, 'D:\\other');
  assert.equal(recent[0].title, '다른 프로젝트 세션');
  assert.equal(recent[2].cwd, 'C:\\fake');
  // 대화 크기 — stat 그대로의 정확한 바이트(한글 멀티바이트 포함) 배선 검증
  assert.equal(recent[0].fileSize, Buffer.byteLength(s3, 'utf8'));
  assert.ok(recent.every((r) => Number.isFinite(r.fileSize) && r.fileSize > 0));
  // limit 적용
  const limited = await listRecentSessions(root, 2);
  assert.deepEqual(limited.map((r) => r.sessionId), ['cccc-3333', 'bbbb-2222']);
  // notes.txt(비 .jsonl)는 세션으로 잡히지 않는다
  assert.ok(recent.every((r) => !r.sessionId.includes('notes')));
  void dir;
});

test('listRecentSessions returns [] for missing root', async () => {
  const missing = path.join(os.tmpdir(), `cc-recent-none-${Date.now()}`);
  assert.deepEqual(await listRecentSessions(missing), []);
});

test('rejects path escape in dirName/sessionId', async () => {
  const { root } = await makeRoot();
  await assert.rejects(listSessions(root, '..'));
  await assert.rejects(listSessions(root, 'a/b'));
  await assert.rejects(listSessions(root, 'a\\b'));
  await assert.rejects(loadTranscript(root, '..', 'aaaa-1111'));
  await assert.rejects(loadTranscript(root, 'C--fake-project', '..\\..\\x'));
  await assert.rejects(loadTranscript(root, 'C--fake-project', 'a/b'));
});

test('deleteSession removes only the target jsonl permanently', async () => {
  const { root, dir } = await makeRoot();
  await deleteSession(root, 'C--fake-project', 'aaaa-1111');
  await assert.rejects(fs.access(path.join(dir, 'aaaa-1111.jsonl')), { code: 'ENOENT' });
  // 다른 세션 파일·비세션 파일은 그대로
  await fs.access(path.join(dir, 'bbbb-2222.jsonl'));
  await fs.access(path.join(dir, 'notes.txt'));
});

test('deleteSession rejects bad names and missing files', async () => {
  const { root } = await makeRoot();
  // 경로 탈출·형식 위반 — 파일시스템 접근 전에 거부
  await assert.rejects(deleteSession(root, '..', 'aaaa-1111'));
  await assert.rejects(deleteSession(root, 'a/b', 'aaaa-1111'));
  await assert.rejects(deleteSession(root, 'C--fake-project', 'a/b'));
  await assert.rejects(deleteSession(root, 'C--fake-project', 'a b'), /invalid sessionId/);
  await assert.rejects(deleteSession(root, 'C--fake-project', 'a*b'), /invalid sessionId/);
  // 없는 파일/디렉터리는 ENOENT (호출측 404 매핑)
  await assert.rejects(deleteSession(root, 'C--fake-project', 'no-such'), { code: 'ENOENT' });
  await assert.rejects(deleteSession(root, 'no-such-dir', 'aaaa-1111'), { code: 'ENOENT' });
});

test('deleteSession blocks symlink/junction escape out of projectsRoot', async (t) => {
  const { root } = await makeRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-outside-'));
  await fs.writeFile(path.join(outside, 'victim.jsonl'), '{}\n', 'utf8');
  try {
    await fs.symlink(outside, path.join(root, 'evil-link'), 'junction');
  } catch (err) {
    t.skip(`symlink unavailable on this platform: ${err.code}`);
    return;
  }
  await assert.rejects(deleteSession(root, 'evil-link', 'victim'), /invalid dirName/);
  await fs.access(path.join(outside, 'victim.jsonl')); // 링크 밖 파일은 살아 있어야 한다
  await fs.rm(outside, { recursive: true, force: true });
});
