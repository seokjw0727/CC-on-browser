import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjects, listSessions, loadTranscript, listRecentSessions, deleteSession } from '../src/history.js';
import { clearCliSessionNameCache } from '../src/cli-session-names.js';

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
    J({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 117013, postTokens: 3171 } }),
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

test('loadTranscript keeps assistant/user/result, first system/init, and compact_boundary', async () => {
  const { root } = await makeRoot();
  const { messages } = await loadTranscript(root, 'C--fake-project', 'aaaa-1111');
  assert.deepEqual(
    messages.map((m) => m.type),
    ['user', 'system', 'assistant', 'system', 'result'],
  );
  assert.equal(messages[1].subtype, 'init');
  // system/status·stream_event는 계속 버린다 — 통과 대상은 압축 경계뿐
  assert.equal(messages[3].subtype, 'compact_boundary');
  assert.equal(messages[3].compactMetadata.postTokens, 3171, '재개 CTX의 출처');
});

test('loadTranscript: compact_boundary가 init보다 앞서도 진짜 첫 init이 살아남는다', async () => {
  // 경계를 sawInit 래치에 태우면 그 뒤의 init이 "두 번째 init"으로 오인돼 버려진다.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-history-b-'));
  const dir = path.join(root, 'C--proj');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'dddd-4444.jsonl'),
    [
      J({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 10 } }),
      J({ type: 'system', subtype: 'init', session_id: 'dddd-4444', cwd: 'C:\\p', tools: [] }),
      J({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 20 } }),
      J({ type: 'system', subtype: 'init', session_id: 'dddd-4444-dup' }),
      J({ type: 'result', subtype: 'success', result: 'ok', session_id: 'dddd-4444' }),
    ].join('\n') + '\n',
    'utf8',
  );
  const { messages } = await loadTranscript(root, 'C--proj', 'dddd-4444');
  assert.deepEqual(
    messages.map((m) => `${m.type}/${m.subtype}`),
    ['system/compact_boundary', 'system/init', 'system/compact_boundary', 'result/success'],
    '경계는 여러 개 다 통과, init은 첫 것만 (뒤의 중복 init은 계속 폐기)',
  );
  assert.equal(messages[1].session_id, 'dddd-4444', '살아남은 init이 진짜 첫 init');
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

// CLI가 붙인 이름(~/.claude/sessions)은 트랜스크립트에 없다 — 별도 디렉터리를 읽어
// sessionId로 이어 붙인다. 이름이 없는 세션은 null이어야 한다(표시가 기존 title로 폴백).
test('listRecentSessions/listSessions join cliName by sessionId', async () => {
  const { root } = await makeRoot();
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-names-'));
  await fs.writeFile(
    path.join(sessionsRoot, '4321.json'),
    J({ pid: 4321, sessionId: 'aaaa-1111', name: 'cc-on-browser-ec', nameSource: 'derived', nameSince: 5 }),
    'utf8',
  );
  clearCliSessionNameCache();

  const recent = await listRecentSessions(root, 12, sessionsRoot);
  const byId = Object.fromEntries(recent.map((r) => [r.sessionId, r]));
  assert.equal(byId['aaaa-1111'].cliName, 'cc-on-browser-ec');
  assert.equal(byId['bbbb-2222'].cliName, null); // 이름 파일이 없는 세션
  // 기존 필드는 그대로다 — cliName은 title을 대체하지 않고 나란히 실린다.
  assert.equal(byId['aaaa-1111'].title, '제목이 될 텍스트');

  clearCliSessionNameCache();
  const sessions = await listSessions(root, 'C--fake-project', sessionsRoot);
  const s = sessions.find((x) => x.sessionId === 'aaaa-1111');
  assert.equal(s.cliName, 'cc-on-browser-ec');
  assert.equal(sessions.find((x) => x.sessionId === 'bbbb-2222').cliName, null);
});

test('cliName is null when the CLI sessions directory does not exist', async () => {
  const { root } = await makeRoot();
  clearCliSessionNameCache();
  const absent = path.join(os.tmpdir(), `cc-names-absent-${process.pid}`);
  const recent = await listRecentSessions(root, 12, absent);
  assert.ok(recent.length > 0);
  assert.ok(recent.every((r) => r.cliName === null));
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
