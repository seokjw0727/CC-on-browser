// fake-cli로 전체 스택을 기동하는 개발/스모크용 스크립트.
// 실제 claude.exe를 실행하지 않으므로 구독을 소모하지 않는다.
//
// 사용법:
//   node scripts/dev-fake.mjs [--port 8788] [--scenario echo|permission|question|crash|subagent]
// 관찰용 env(선택): FAKE_ECHO_DELAY_MS(echo 응답 지연 — thinking 유지),
//   FAKE_SUBAGENT_MS(subagent 도구 실행 시간 — 마스코트 juggle 관찰)
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
  // FAKE_PROJECTS_ROOT: E2E 전용 — 세션 히스토리 루트를 임시 디렉터리로 갈아 끼운다.
  // 미설정 시 실제 ~/.claude/projects. "지난 세션" 목록·삭제를 테스트하려면 반드시
  // 격리해야 한다 — 그러지 않으면 테스트가 사용자의 진짜 대화 기록을 지운다.
  projectsRoot: process.env.FAKE_PROJECTS_ROOT || undefined,
  // FAKE_PLATFORM: E2E 전용 — 'linux'를 주면 Windows에서도 cwd 직접 입력 UI가 떠
  // 네이티브 폴더 대화상자 없이 자동화할 수 있다. 미설정 시 실제 플랫폼.
  platform: process.env.FAKE_PLATFORM || undefined,
  // FAKE_CLAUDE_CONFIG: E2E 전용 — 설정 편집기가 다룰 파일을 임시 경로로 갈아 끼운다.
  // 미설정 시 실제 ~/.claude/settings.json. 이 파일은 CLI 전체의 설정이라, 편집
  // 테스트를 격리하지 않으면 사용자의 진짜 설정을 덮어쓴다(projectsRoot와 같은 이유).
  claudeConfigPath: process.env.FAKE_CLAUDE_CONFIG || undefined,
});

console.log(`[dev-fake] scenario=${process.env.FAKE_SCENARIO || 'echo'}`);
console.log(`[dev-fake] http://127.0.0.1:${handle.port}/#token=${handle.token}`);
