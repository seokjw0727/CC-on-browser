// 설치된 플러그인 목록(읽기 전용) 모듈 + HTTP API 테스트.
//
// 모든 테스트는 임시 디렉터리를 주입한다 — 개발자의 실제 ~/.claude/plugins는 읽지 않는다.
//
// 계약 요약(설계도 §2 claude-plugins.js):
//  · 파일 없음 = 정상(exists=false, 빈 목록) — "설치한 적 없음"이 오류일 수는 없다
//  · 손상 JSON·모르는 스키마 버전·레코드 모양 위반 = EINVALIDPLUGINS → HTTP 400
//  · 설치 레코드는 합치지 않고 installs[] 그대로 보존(스코프마다 버전이 다르다)
//  · 키는 불투명 식별자, 표시용 분리는 마지막 '@'
//  · HTTP: 200 / 400(형식) / 401(무토큰) / 405(GET 외)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { defaultPluginsDir, listInstalledPlugins, splitPluginKey } from '../src/claude-plugins.js';

const fakeCliPath = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const TOKEN = 'plugins-token-xyz';

let tmpRoot = '';
let pluginsDir = '';
let pluginsFile = '';
let handle = null;
let base = '';

const api = (init = {}) =>
  fetch(`${base}/api/claude-plugins`, {
    ...init,
    headers: { 'x-auth-token': TOKEN, ...(init.headers || {}) },
  });

const writeFixture = (value) =>
  fs.writeFile(pluginsFile, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-plugins-'));
  pluginsDir = path.join(tmpRoot, '.claude', 'plugins');
  pluginsFile = path.join(pluginsDir, 'installed_plugins.json');
  await fs.mkdir(pluginsDir, { recursive: true });
  handle = await startServer({
    port: 0,
    token: TOKEN,
    cliPath: process.execPath,
    cliArgsPrefix: [fakeCliPath],
    projectsRoot: path.join(tmpRoot, 'projects'),
    claudeConfigPath: path.join(tmpRoot, '.claude', 'settings.json'),
    claudePluginsDir: pluginsDir,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// 픽스처는 테스트마다 지운다 — 앞 테스트가 남긴 파일에 기대지 않게(순서 의존 차단).
beforeEach(async () => {
  await fs.rm(pluginsFile, { force: true });
});

test('기본 경로는 홈의 .claude/plugins다', () => {
  assert.equal(defaultPluginsDir('/home/u'), path.join('/home/u', '.claude', 'plugins'));
});

test('표시용 키 분리는 마지막 @ 기준이다 — 스코프드 이름도 깨지지 않는다', () => {
  assert.deepEqual(splitPluginKey('codex@openai-codex'), {
    name: 'codex',
    marketplace: 'openai-codex',
  });
  assert.deepEqual(splitPluginKey('@acme/tool@shop'), { name: '@acme/tool', marketplace: 'shop' });
  // 구분자가 없거나 맨 앞에만 있으면 전체가 이름이다(마켓플레이스를 지어내지 않는다).
  assert.deepEqual(splitPluginKey('local-plugin'), { name: 'local-plugin', marketplace: '' });
  assert.deepEqual(splitPluginKey('@scoped'), { name: '@scoped', marketplace: '' });
});

test('파일이 없으면 오류가 아니라 빈 목록이다', async () => {
  const res = await listInstalledPlugins(pluginsDir);
  assert.equal(res.exists, false);
  assert.deepEqual(res.plugins, []);
  assert.equal(res.path, pluginsFile);
});

test('설치 레코드는 합치지 않고 스코프별로 모두 보존한다', async () => {
  await writeFixture({
    version: 2,
    plugins: {
      'zeta@market': [
        { scope: 'user', installPath: '/u/z', version: '1.0.0', installedAt: 'a', lastUpdated: 'b' },
      ],
      'alpha@market': [
        { scope: 'user', version: '2.0.0', lastUpdated: '2026-01-01T00:00:00.000Z' },
        {
          scope: 'project',
          projectPath: 'C:\\proj',
          version: '1.5.0',
          lastUpdated: '2026-02-01T00:00:00.000Z',
        },
      ],
    },
  });
  const { exists, plugins } = await listInstalledPlugins(pluginsDir);
  assert.equal(exists, true);
  // 목록 순서는 키 정렬 — 토글을 누르는 자리가 매번 흔들리지 않게.
  assert.deepEqual(plugins.map((p) => p.key), ['alpha@market', 'zeta@market']);
  const alpha = plugins[0];
  assert.equal(alpha.name, 'alpha');
  assert.equal(alpha.marketplace, 'market');
  assert.equal(alpha.installs.length, 2);
  assert.deepEqual(alpha.installs.map((i) => i.version), ['2.0.0', '1.5.0']);
  assert.deepEqual(alpha.installs.map((i) => i.scope), ['user', 'project']);
  assert.equal(alpha.installs[1].projectPath, 'C:\\proj');
  // 화면에 쓰는 필드만 남긴다 — installPath·gitCommitSha는 내보내지 않는다.
  assert.deepEqual(Object.keys(alpha.installs[0]).sort(), [
    'lastUpdated',
    'projectPath',
    'scope',
    'version',
  ]);
});

test('레코드 배열/항목 모양이 v2와 다르면 조용히 버리지 않고 알린다', async () => {
  await writeFixture({ version: 2, plugins: { 'a@m': 'not-an-array' } });
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });

  await writeFixture({ version: 2, plugins: { 'b@m': [{ scope: 'user' }, 3] } });
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });
});

test('손상된 JSON·모르는 버전·형식 불일치는 EINVALIDPLUGINS로 구분한다', async () => {
  await writeFixture('{ "version": 2, ');
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });

  await writeFixture({ version: 3, plugins: {} });
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });

  await writeFixture({ version: 2 });
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });

  await writeFixture('[]');
  await assert.rejects(listInstalledPlugins(pluginsDir), { code: 'EINVALIDPLUGINS' });
});

test('GET /api/claude-plugins — 인증 필요(무토큰·오류 토큰은 401)', async () => {
  const noToken = await fetch(`${base}/api/claude-plugins`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${base}/api/claude-plugins`, {
    headers: { 'x-auth-token': 'nope' },
  });
  assert.equal(badToken.status, 401);
});

test('GET /api/claude-plugins — 목록을 그대로 준다', async () => {
  await writeFixture({
    version: 2,
    plugins: { 'codex@openai-codex': [{ scope: 'user', version: '1.0.6' }] },
  });
  const res = await api();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, true);
  assert.deepEqual(body.plugins, [
    {
      key: 'codex@openai-codex',
      name: 'codex',
      marketplace: 'openai-codex',
      installs: [{ scope: 'user', projectPath: null, version: '1.0.6', lastUpdated: null }],
    },
  ]);
});

test('GET /api/claude-plugins — 손상 파일은 400(공통 catch에 맡기지 않는다)', async () => {
  await writeFixture('nope');
  const res = await api();
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid JSON/);
});

test('PUT/DELETE는 405 + Allow: GET — 쓰기 창구는 없다', async () => {
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const res = await api({ method });
    assert.equal(res.status, 405, `${method} should be rejected`);
    assert.equal(res.headers.get('allow'), 'GET');
  }
});
