import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjects, listSessions, loadTranscript } from '../src/history.js';

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

test('rejects path escape in dirName/sessionId', async () => {
  const { root } = await makeRoot();
  await assert.rejects(listSessions(root, '..'));
  await assert.rejects(listSessions(root, 'a/b'));
  await assert.rejects(listSessions(root, 'a\\b'));
  await assert.rejects(loadTranscript(root, '..', 'aaaa-1111'));
  await assert.rejects(loadTranscript(root, 'C--fake-project', '..\\..\\x'));
  await assert.rejects(loadTranscript(root, 'C--fake-project', 'a/b'));
});
