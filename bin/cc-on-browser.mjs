#!/usr/bin/env node
// cc-on-browser — 배포용 CLI 진입점. `npm start`와 전역 설치(bin)가 공용으로 쓴다.
// 서버 라이브러리(../server/src/server.js)를 인자 파싱·사전 점검·친절한 오류로 감싼다.
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/src/server.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

const HELP = `Claude Code on Browser v${pkg.version}
Local-only web UI for the claude CLI. Binds to 127.0.0.1 only.

Usage: cc-on-browser [options]

Options:
  -p, --port <n>   Port to listen on (default: $PORT or 8787)
  -v, --version    Print the version and exit
  -h, --help       Show this help and exit

Environment:
  PORT                  Same as --port
  CLAUDE_WEB_CLI_PATH   Absolute path to the claude CLI executable
                        (default: \`claude\` resolved from PATH)`;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

let port = Number(process.env.PORT) || 8787;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--port' || arg === '-p') {
    port = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--version' || arg === '-v') {
    console.log(pkg.version);
    process.exit(0);
  } else if (arg === '--help' || arg === '-h') {
    console.log(HELP);
    process.exit(0);
  } else {
    fail(`Unknown option: ${arg}\n\n${HELP}`);
  }
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail('Invalid --port value: expected an integer between 0 and 65535.');
}

let cliPath = process.env.CLAUDE_WEB_CLI_PATH;
if (cliPath) {
  if (!existsSync(cliPath)) {
    fail(`CLAUDE_WEB_CLI_PATH points to a file that does not exist:\n  ${cliPath}`);
  }
} else {
  // bare 이름은 Node spawn이 OS PATH에서 해석한다 — 설치 위치가 어디든 동작.
  cliPath = process.platform === 'win32' ? 'claude.exe' : 'claude';
}

const staticDir = path.join(pkgRoot, 'client', 'dist');
if (!existsSync(path.join(staticDir, 'index.html'))) {
  fail('Client bundle not found (client/dist/index.html).\n'
    + 'Running from a source checkout? Build it first:\n'
    + '  npm run install:all && npm run build');
}

let handle;
try {
  handle = await startServer({
    port,
    token: crypto.randomBytes(16).toString('hex'),
    cliPath,
    staticDir,
  });
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    fail(`Port ${port} is already in use. Pick another one with --port <n>.`);
  }
  if (err?.code === 'EACCES') {
    fail(`No permission to bind port ${port}. Try a port above 1024.`);
  }
  throw err;
}

console.log(`Claude Code on Browser v${pkg.version} — http://127.0.0.1:${handle.port}/#token=${handle.token}`);
console.log('Local-only server (127.0.0.1). Keep this URL private — the token grants access.');

// claude --version 1회 — 세션을 만들지 않으므로 구독을 소모하지 않는다.
// 서버의 메모이즈된 프로브를 공유해 첫 /api/bootstrap 응답도 이 결과를 재사용한다.
const cliVersion = await handle.getClaudeVersion();
if (cliVersion) {
  console.log(`claude CLI: ${cliVersion}`);
} else {
  console.warn('WARNING: claude CLI not found or not responding.');
  console.warn('  Sessions will fail to start until it is available. Install it from');
  console.warn('  https://claude.com/claude-code, log in (run `claude`, then /login), and make');
  console.warn('  sure `claude` is on your PATH — or set CLAUDE_WEB_CLI_PATH to its absolute path.');
}
