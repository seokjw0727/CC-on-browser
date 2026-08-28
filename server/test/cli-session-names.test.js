import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readCliSessionNames,
  lookupCliSessionName,
  clearCliSessionNameCache,
  defaultNameStoreFile,
} from '../src/cli-session-names.js';

const J = (o) => JSON.stringify(o);

// 만든 픽스처 디렉터리를 모아 두었다가 파일이 끝날 때 한 번에 지운다 — makeRoot의
// 호출자가 스무 곳이라 각자 t.after를 달게 하는 대신 한 곳에서 치운다.
const madeRoots = [];
after(async () => {
  await Promise.all(madeRoots.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {})));
});

async function makeRoot(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cli-names-'));
  madeRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf8');
  }
  clearCliSessionNameCache(); // 픽스처마다 TTL을 기다리지 않는다
  return root;
}

// 영속 저장소 경로 — **테스트마다 임시 파일**을 준다. 기본값이 없는 인자라 주지 않으면
// 저장소 자체가 꺼지므로(부수효과 없음), 개발자의 실제 ~/.cc-on-browser는 어떤 경우에도
// 건드리지 않는다(instance-file.test.js의 tmpHome과 같은 규약).
async function makeStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-name-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return path.join(dir, 'session-names.json');
}

const readStoreFile = async (storeFile) => JSON.parse(await fs.readFile(storeFile, 'utf8'));

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

// ── 영속 저장소 ─────────────────────────────────────────────────────────────
// 이것이 이 기능의 존재 이유다: CLI는 프로세스가 끝나면 자기 <pid>.json을 지우므로,
// 살아 있는 동안 본 이름을 우리가 적어 두지 않으면 지난 세션의 cliName은 언제나 null이다.

test('저장소: 이름 파일이 사라져도 한 번 본 이름은 남는다', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot({ '13620.json': record() });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';

  const live = await readCliSessionNames(root, { storeFile });
  assert.equal(live.get(id), 'cc-on-browser-ca');

  // CLI 종료 = 이름 파일 삭제.
  await fs.rm(path.join(root, '13620.json'));
  clearCliSessionNameCache();

  const after = await readCliSessionNames(root, { storeFile });
  assert.equal(after.get(id), 'cc-on-browser-ca', '저장소가 폴백으로 이름을 돌려줘야 한다');
  assert.equal(await lookupCliSessionName(id, root, { storeFile }), 'cc-on-browser-ca');
});

test('저장소: storeFile을 주지 않으면 아무것도 쓰지 않는다(기본은 부수효과 없음)', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot({ '13620.json': record() });

  await readCliSessionNames(root); // 저장소 인자 없음
  await assert.rejects(fs.stat(storeFile), { code: 'ENOENT' });

  await fs.rm(path.join(root, '13620.json'));
  clearCliSessionNameCache();
  const after = await readCliSessionNames(root);
  assert.equal(after.size, 0, '저장소가 꺼져 있으면 폴백도 없다');
});

test('저장소: 살아 있는 이름이 저장된 이름을 이긴다', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot({ '13620.json': record({ name: '옛-이름' }) });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';
  await readCliSessionNames(root, { storeFile });

  // CLI에서 이름을 바꿨다 — 살아 있는 파일이 새 이름을 말한다.
  await fs.writeFile(path.join(root, '13620.json'), record({ name: '새-이름' }), 'utf8');
  clearCliSessionNameCache();

  const names = await readCliSessionNames(root, { storeFile });
  assert.equal(names.get(id), '새-이름');
  // 저장소도 새 이름으로 갱신돼, 파일이 사라진 뒤에도 새 이름이 남아야 한다.
  assert.equal((await readStoreFile(storeFile)).names[id].name, '새-이름');
});

test('저장소: 관찰한 이름만 적는다(폴백은 되먹이지 않는다)', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot({ '13620.json': record() });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';
  await readCliSessionNames(root, { storeFile });
  const firstAt = (await readStoreFile(storeFile)).names[id].at;

  // 이름 파일이 사라진 뒤의 조회는 폴백만 낼 뿐, 저장소를 건드리지 않아야 한다.
  await fs.rm(path.join(root, '13620.json'));
  clearCliSessionNameCache();
  await readCliSessionNames(root, { storeFile });

  const again = await readStoreFile(storeFile);
  assert.equal(again.names[id].at, firstAt, 'at이 조회 시각으로 갱신되면 안 된다');
});

test('저장소: 깨진 저장소는 빈 폴백으로 축약하고 다시 짓는다', async (t) => {
  const storeFile = await makeStore(t);
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.writeFile(storeFile, '{"names": {"aaa": {"name": "잘린', 'utf8');
  const root = await makeRoot({ '13620.json': record() });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';

  const names = await readCliSessionNames(root, { storeFile });
  assert.equal(names.get('aaa'), undefined, '깨진 저장소에서 값을 건져 오지 않는다');
  assert.equal(names.get(id), 'cc-on-browser-ca', '살아 있는 이름은 그대로 나온다');
  assert.equal((await readStoreFile(storeFile)).names[id].name, 'cc-on-browser-ca');
});

test('저장소: 항목이 깨져도 나머지는 살린다', async (t) => {
  const storeFile = await makeStore(t);
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.writeFile(storeFile, J({
    version: 1,
    names: {
      good: { name: '살아남는다', at: 5 },
      blank: { name: '   ', at: 5 },
      typed: { name: 42, at: 5 },
      '': { name: '키가 없다', at: 5 },
    },
  }), 'utf8');
  const root = await makeRoot();

  const names = await readCliSessionNames(root, { storeFile });
  assert.deepEqual([...names.keys()], ['good']);
});

test('저장소: 상한을 넘으면 at이 오래된 것부터 버린다', async (t) => {
  const storeFile = await makeStore(t);
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  // 상한(500)을 넘겨 채운다 — at은 뒤로 갈수록 최신.
  const seeded = {};
  for (let i = 0; i < 520; i++) seeded[`old-${String(i).padStart(4, '0')}`] = { name: `n${i}`, at: i };
  await fs.writeFile(storeFile, J({ version: 1, names: seeded }), 'utf8');

  const root = await makeRoot({ '13620.json': record() });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';
  await readCliSessionNames(root, { storeFile });

  const stored = (await readStoreFile(storeFile)).names;
  assert.equal(Object.keys(stored).length, 500);
  assert.ok(stored[id], '방금 관찰한 이름은 반드시 남는다');
  assert.equal(stored['old-0000'], undefined, '가장 오래된 항목이 먼저 나간다');
  assert.ok(stored['old-0519'], '가장 최신 항목은 남는다');
});

test('저장소: 바뀐 것이 없으면 파일을 다시 쓰지 않는다', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot({ '13620.json': record() });
  await readCliSessionNames(root, { storeFile });

  // 파일에 우리가 쓰지 않는 표식을 심는다 — 다시 쓰였다면 writeStore가 version·names만
  // 내보내므로 표식이 사라진다. mtime 해상도에 기대지 않는 증거다(codex 지적).
  const marked = { ...(await readStoreFile(storeFile)), marker: '건드리지-않음' };
  await fs.writeFile(storeFile, J(marked), 'utf8');

  clearCliSessionNameCache();
  await readCliSessionNames(root, { storeFile });

  assert.equal((await readStoreFile(storeFile)).marker, '건드리지-않음');
});

test('저장소: 조회 캐시는 (sessionsRoot, storeFile) 쌍으로 갈린다', async (t) => {
  const storeA = await makeStore(t);
  const storeB = await makeStore(t);
  const root = await makeRoot({ '13620.json': record() });
  const id = 'd8dc5975-96c6-4ef5-aec2-d059e0ac8877';

  // A에만 이름을 기억시킨 뒤 이름 파일을 없앤다.
  await readCliSessionNames(root, { storeFile: storeA });
  await fs.rm(path.join(root, '13620.json'));
  clearCliSessionNameCache();

  // 같은 root라도 저장소가 다르면 결과가 달라야 한다 — TTL 안에서 연달아 부른다.
  const fromA = await readCliSessionNames(root, { storeFile: storeA });
  const fromB = await readCliSessionNames(root, { storeFile: storeB });
  assert.equal(fromA.get(id), 'cc-on-browser-ca');
  assert.equal(fromB.get(id), undefined, 'B의 조회가 A의 캐시를 물려받으면 안 된다');
});

test('저장소: 동시 조회가 서로의 이름을 지우지 않는다', async (t) => {
  const storeFile = await makeStore(t);
  // 여덟 갈래를 **같은 틱에** 띄운다. 쓰기가 직렬화되지 않으면 여덟이 모두 같은 (빈)
  // 스냅샷을 읽고 각자 덮어써, 마지막 하나만 살아남는다 — 둘로는 우연히 순차 실행돼
  // 통과할 수 있어 수를 늘렸다(codex 지적).
  const ids = Array.from({ length: 8 }, (_, i) => `id-${i}`);
  const roots = await Promise.all(
    ids.map((id) => makeRoot({ '1.json': record({ sessionId: id, name: `name-${id}` }) })),
  );
  // makeRoot가 캐시를 비우므로, 픽스처를 **다 만든 뒤에** 조회를 한꺼번에 띄운다.
  clearCliSessionNameCache();
  await Promise.all(roots.map((root) => readCliSessionNames(root, { storeFile })));

  const stored = (await readStoreFile(storeFile)).names;
  for (const id of ids) {
    assert.equal(stored[id]?.name, `name-${id}`, `${id}의 이름이 남의 발행에 지워졌다`);
  }
});

test('저장소: 관찰한 이름이 없으면 파일을 만들지 않는다', async (t) => {
  const storeFile = await makeStore(t);
  const root = await makeRoot(); // 이름 파일 없음
  await readCliSessionNames(root, { storeFile });
  await assert.rejects(fs.stat(storeFile), { code: 'ENOENT' });
});

test('defaultNameStoreFile: 앱 소유 디렉터리 아래를 가리킨다', () => {
  const p = defaultNameStoreFile('/fake/home');
  assert.equal(p, path.join('/fake/home', '.cc-on-browser', 'session-names.json'));
});
