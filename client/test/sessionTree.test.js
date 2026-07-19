import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionTree, shortDir, deriveSessionTitle, mergeRecentSessions } from '../src/lib/sessionTree.js';

test('deriveSessionTitle: 첫 사용자 발화를 요약하고 커맨드 래퍼/빈 발화는 건너뛴다', () => {
  assert.equal(
    deriveSessionTitle([
      { kind: 'command', name: 'help' },
      { kind: 'user-text', text: '   ' },
      { kind: 'user-text', text: '리팩터링 도와줘\n부탁해' },
      { kind: 'user-text', text: '두 번째' },
    ]),
    '리팩터링 도와줘 부탁해',
  );
  // <…>로 시작하는 래퍼성 발화는 제목으로 쓰지 않는다
  assert.equal(deriveSessionTitle([{ kind: 'user-text', text: '<command-name>/x</command-name>' }]), '');
  // 사용자 발화가 없으면 빈 문자열(호출측 폴백)
  assert.equal(deriveSessionTitle([{ kind: 'assistant-text', text: 'hi' }]), '');
  assert.equal(deriveSessionTitle([]), '');
  assert.equal(deriveSessionTitle(), '');
  // 길이 제한
  assert.equal(deriveSessionTitle([{ kind: 'user-text', text: 'a'.repeat(200) }], 60).length, 60);
});

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

test('mergeRecentSessions: (dirName,sessionId) dedupe — 서버 항목이 로컬 캡처를 덮는다', () => {
  const merged = mergeRecentSessions({
    fetched: [{ dirName: 'd1', cwd: 'C:\\p', sessionId: 's1', title: '서버 제목', mtime: 10 }],
    closedLocal: [{ dirName: 'd1', cwd: 'C:\\p', sessionId: 's1', title: '로컬 제목', mtime: 99 }],
    liveIds: new Set(),
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, '서버 제목');
  // 같은 sessionId라도 dirName이 다르면 별개 항목
  const twoDirs = mergeRecentSessions({
    fetched: [{ dirName: 'd1', sessionId: 's1', mtime: 1 }],
    closedLocal: [{ dirName: 'd2', sessionId: 's1', mtime: 2 }],
    liveIds: new Set(),
  });
  assert.equal(twoDirs.length, 2);
});

test('mergeRecentSessions: 라이브 세션 제외 + 로컬 캡처는 top-N 밖이어도 유지(재절단 없음)', () => {
  const fetched = [
    { dirName: 'd1', sessionId: 'live-1', mtime: 30 },
    { dirName: 'd1', sessionId: 'old-1', mtime: 20 },
  ];
  const closedLocal = [
    // 서버 top-N 밖의 방금 닫힌 세션 — 닫힘 시각(mtime=40)이라 맨 위로 온다
    { dirName: 'd2', sessionId: 'just-closed', mtime: 40 },
  ];
  const merged = mergeRecentSessions({ fetched, closedLocal, liveIds: new Set(['live-1']) });
  assert.deepEqual(merged.map((s) => s.sessionId), ['just-closed', 'old-1']);
});

test('mergeRecentSessions: dirName/sessionId 없는 항목은 제외, 기본 인자 안전', () => {
  const merged = mergeRecentSessions({
    fetched: [{ dirName: 'd1', sessionId: 's1', mtime: 1 }, { sessionId: 'no-dir', mtime: 9 }, null],
    closedLocal: [{ dirName: 'd2', cwd: 'C:\\x', sessionId: null, mtime: 9 }],
  });
  assert.deepEqual(merged.map((s) => s.sessionId), ['s1']);
  assert.deepEqual(mergeRecentSessions(), []);
  assert.deepEqual(mergeRecentSessions({}), []);
});