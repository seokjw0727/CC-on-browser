import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionTree, shortDir } from '../src/lib/sessionTree.js';

test('sessionId가 null인 두 라이브 세션은 절대 합쳐지지 않는다', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [
      { key: 'a', cwd: 'C:\\p', sessionId: null, status: 'idle' },
      { key: 'b', cwd: 'C:\\p', sessionId: null, status: 'idle' },
    ],
    projects: [],
    historyByDir: {},
    activeKey: 'a',
  });
  assert.equal(pinned.live.length, 2);
  assert.equal(others.length, 0);
});

test('재개된 라이브와 같은 non-null sessionId를 가진 히스토리 행은 숨겨진다', () => {
  const { pinned } = buildSessionTree({
    liveSessions: [{ key: 'a', cwd: 'C:\\p', sessionId: 's1', status: 'idle' }],
    projects: [{ dirName: 'C--p', cwd: 'C:\\p', sessionCount: 2, lastModified: 10 }],
    historyByDir: { 'C--p': [
      { sessionId: 's1', title: 'x', mtime: 5 },
      { sessionId: 's2', title: 'y', mtime: 4 },
    ] },
    activeKey: 'a',
  });
  assert.deepEqual(pinned.history.map((h) => h.sessionId), ['s2']);
});

test('활성 세션의 디렉토리가 pinned, 나머지는 others', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [{ key: 'a', cwd: 'C:\\p', sessionId: null, status: 'idle' }],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: 'a',
  });
  assert.equal(pinned.cwd, 'C:\\p');
  assert.equal(others.length, 1);
  assert.equal(others[0].cwd, 'C:\\q');
});

test('others 정렬: 라이브 있는 디렉토리 먼저, 그다음 mtime 내림차순', () => {
  const { others } = buildSessionTree({
    liveSessions: [
      { key: 'act', cwd: 'C:\\active', sessionId: null, status: 'idle' },
      { key: 'x', cwd: 'C:\\live', sessionId: null, status: 'idle' },
    ],
    projects: [
      { dirName: 'C--old', cwd: 'C:\\old', sessionCount: 1, lastModified: 1 },
      { dirName: 'C--new', cwd: 'C:\\new', sessionCount: 1, lastModified: 99 },
    ],
    historyByDir: {},
    activeKey: 'act',
  });
  assert.equal(others[0].cwd, 'C:\\live');
  assert.equal(others[1].cwd, 'C:\\new');
  assert.equal(others[2].cwd, 'C:\\old');
});

test('활성 세션이 없으면 pinned=null', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: null,
  });
  assert.equal(pinned, null);
  assert.equal(others.length, 1);
});

test('접힌(로드 안 된) 디렉토리는 historyLoaded=false, history=[]', () => {
  const { others } = buildSessionTree({
    liveSessions: [],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 3, lastModified: 10 }],
    historyByDir: {},
    activeKey: null,
  });
  assert.equal(others[0].historyLoaded, false);
  assert.equal(others[0].history.length, 0);
  assert.equal(others[0].count, 3);
});

test('접힌 디렉토리에 라이브 세션이 있으면 hasLive=true', () => {
  const { others } = buildSessionTree({
    liveSessions: [
      { key: 'act', cwd: 'C:\\active', sessionId: null, status: 'idle' },
      { key: 'x', cwd: 'C:\\q', sessionId: null, status: 'thinking' },
    ],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: 'act',
  });
  const q = others.find((n) => n.cwd === 'C:\\q');
  assert.equal(q.hasLive, true);
});

test('shortDir: 마지막 2 세그먼트로 축약', () => {
  assert.equal(shortDir('C:\\a\\b\\c'), '…\\b\\c');
  assert.equal(shortDir('C:\\a'), 'C:\\a');
  assert.equal(shortDir(''), '');
});