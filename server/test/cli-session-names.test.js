import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readCliSessionNames,
  lookupCliSessionName,
  clearCliSessionNameCache,
} from '../src/cli-session-names.js';

const J = (o) => JSON.stringify(o);

async function makeRoot(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cli-names-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf8');
  }
  clearCliSessionNameCache(); // 픽스처마다 TTL을 기다리지 않는다
  return root;
}

// 실제 파일 모양 (실측 2026-08-23, CLI v2.1.235)
const record = (over = {}) => J({
  pid: 13620,
  sessionId: 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877',
  cwd: 'C:\\Users\\x\\Documents\\CC-on-browser',
  startedAt: 1787390254498,
  version: '2.1.235',
  kind: 'interactive',
  entrypoint: 'sdk-cli',
  messagingSocketPath: '\\\\.\\pipe\\cc-msg-abc',
  name: 'cc-on-browser-ca',
  nameSource: 'derived',
  nameSince: 1787390254499,
  ...over,
});

test('readCliSessionNames: sessionId → name 맵을 만든다', async () => {
  const root = await makeRoot({ '13620.json': record() });
  const names = await readCliSessionNames(root);
  assert.equal(names.get('d8dc5975-96c6-4ef5-aec2-d059e0ac8877'), 'cc-on-browser-ca');
  assert.equal(names.size, 1);
});

test('readCliSessionNames: 이름 외의 필드는 내보내지 않는다', async () => {
  const root = await makeRoot({ '13620.json': record() });
  const names = await readCliSessionNames(root);
  // 값은 문자열 이름 하나뿐 — pid/cwd/messagingSocketPath가 따라 나가면 안 된다.
  for (const value of names.values()) assert.equal(typeof value, 'string');
  assert.deepEqual([...names.values()], ['cc-on-browser-ca']);
});

test('readCliSessionNames: .key 등 .json이 아닌 이웃 파일은 건너뛴다', async () => {
  const root = await makeRoot({
    '13620.json': record(),
    '13620.6a8ee4528b778ccff891c7430d6ca7009e29ac98eabbeddefc9952dbe27340da.key': 'not json',
  });
  const names = await readCliSessionNames(root);
  assert.equal(names.size, 1);
});

test('readCliSessionNames: 깨진 JSON은 그 파일만 건너뛴다', async () => {
  const root = await makeRoot({
    'broken.json': '{"sessionId": "x", "nam',
    '13620.json': record(),
  });
  const names = await readCliSessionNames(root);
  assert.equal(names.size, 1);
  assert.equal(names.get('d8dc5975-96c6-4ef5-aec2-d059e0ac8877'), 'cc-on-browser-ca');
});

test('readCliSessionNames: 이름/ID가 비었으면 제외한다', async () => {
  const root = await makeRoot({
    'blank-name.json': record({ sessionId: 'aaa', name: '   ' }),
    'no-name.json': record({ sessionId: 'bbb', name: undefined }),
    'no-id.json': record({ sessionId: '', name: '이름만-있음' }),
    'ok.json': record({ sessionId: 'ccc', name: 'ok-name' }),
  });
  const names = await readCliSessionNames(root);
  assert.deepEqual([...names.keys()], ['ccc']);
});

test('readCliSessionNames: 같은 sessionId가 여럿이면 nameSince가 최신인 것을 쓴다', async () => {
  const root = await makeRoot({
    'old.json': record({ pid: 1, sessionId: 'same', name: '옛-이름', nameSince: 1000 }),
    'new.json': record({ pid: 2, sessionId: 'same', name: '새-이름', nameSince: 2000 }),
  });
  const names = await readCliSessionNames(root);
  assert.equal(names.get('same'), '새-이름');
});

test('readCliSessionNames: nameSince가 없으면 startedAt으로 최신을 가린다', async () => {
  const root = await makeRoot({
    'a.json': record({ sessionId: 'same', name: '옛-이름', nameSince: undefined, startedAt: 10 }),
    'b.json': record({ sessionId: 'same', name: '새-이름', nameSince: undefined, startedAt: 20 }),
  });
  const names = await readCliSessionNames(root);
  assert.equal(names.get('same'), '새-이름');
});

test('readCliSessionNames: nameSource가 user여도 그대로 쓴다', async () => {
  const root = await makeRoot({
    'u.json': record({ sessionId: 'u1', name: '내가-지은-이름', nameSource: 'user' }),
  });
  const names = await readCliSessionNames(root);
  assert.equal(names.get('u1'), '내가-지은-이름');
});

test('readCliSessionNames: 디렉터리가 없으면 빈 맵(던지지 않는다)', async () => {
  clearCliSessionNameCache();
  const names = await readCliSessionNames(path.join(os.tmpdir(), 'cc-cli-names-absent-xyz'));
  assert.equal(names.size, 0);
});

test('readCliSessionNames: 반환한 맵을 고쳐도 캐시가 오염되지 않는다', async () => {
  const root = await makeRoot({ '13620.json': record() });
  const first = await readCliSessionNames(root);
  first.set('침입', '오염');
  first.delete('d8dc5975-96c6-4ef5-aec2-d059e0ac8877');
  const second = await readCliSessionNames(root); // 캐시 히트
  assert.equal(second.get('d8dc5975-96c6-4ef5-aec2-d059e0ac8877'), 'cc-on-browser-ca');
  assert.equal(second.has('침입'), false);
});

test('lookupCliSessionName: 단건 조회 — 없으면 null', async () => {
  const root = await makeRoot({ '13620.json': record() });
  assert.equal(
    await lookupCliSessionName('d8dc5975-96c6-4ef5-aec2-d059e0ac8877', root),
    'cc-on-browser-ca',
  );
  assert.equal(await lookupCliSessionName('없는-id', root), null);
  assert.equal(await lookupCliSessionName('', root), null);
  assert.equal(await lookupCliSessionName(null, root), null);
});
