// fake-cli로 전체 스택을 기동하는 개발/스모크용 스크립트.
// 실제 claude.exe를 실행하지 않으므로 구독을 소모하지 않는다.
//
// 사용법:
//   node scripts/dev-fake.mjs [--port 8788] [--scenario echo|permission|crash]
//
// 시나리오는 fake-cli가 자신의 env(FAKE_SCENARIO)에서 읽으므로(spawn 시 부모 env 상속),
// --scenario 는 이 프로세스의 FAKE_SCENARIO 를 설정하는 셸 중립적 방법이다.
// (POSIX: FAKE_SCENARIO=permission node ... / PowerShell: $env:FAKE_SCENARIO='permission' 도 동작)
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 && args[portIdx + 1]
  ? Number(args[portIdx + 1])
  : (Number(process.env.PORT) || 8788);
const scenarioIdx = args.indexOf('--scenario');
if (scenarioIdx >= 0 && args[scenarioIdx + 1]) {
  process.env.FAKE_SCENARIO = args[scenarioIdx + 1];
}

const handle = await startServer({
  port,
  token: crypto.randomBytes(16).toString('hex'),
  cliPath: process.execPath,
  cliArgsPrefix: [path.join(root, 'server', 'test', 'fake-cli.mjs')],
  staticDir: path.join(root, 'client', 'dist'),
});

console.log(`[dev-fake] scenario=${process.env.FAKE_SCENARIO || 'echo'}`);
console.log(`[dev-fake] http://127.0.0.1:${handle.port}/#token=${handle.token}`);
