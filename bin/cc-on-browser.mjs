#!/usr/bin/env node
// cc-on-browser — 배포용 CLI 진입점. `npm start`와 전역 설치(bin)가 공용으로 쓴다.
// 서버 라이브러리(../server/src/server.js)를 인자 파싱·사전 점검·친절한 오류로 감싼다.
//
// 기본 실행은 "브라우저만 보이는" 모드다: 사전 점검을 마친 부모가 자신을 콘솔 없는
// 백그라운드 프로세스로 재실행하고 즉시 종료하면, 백그라운드 서버가 기본 브라우저를
// 연다. 클라이언트는 페이지 로드 시 WS를 상시 연결하므로(client/src/lib/store.jsx),
// 데몬 수명은 lifecycle.js 상태기계가 결정한다: 탭을 실제로 닫으면(pagehide 'bye'
// 신호) 짧은 유예 후 종료하고, 절전·노트북 리드 닫힘 등으로 연결만 유실되면
// 살아있는 CLI 세션이 있는 한 종료하지 않고 재접속을 기다린다(세션 돌연사 방지).
// --no-open 은 예전처럼 포그라운드 콘솔 서버로 남는다(로그 확인·개발용).
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/src/server.js';
import { createLifecycle } from '../server/src/lifecycle.js';

const selfPath = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(selfPath), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

const HELP = `Claude Code on Browser v${pkg.version}
Local-only web UI for the claude CLI. Binds to 127.0.0.1 only.

By default the server runs in the background (no console window), opens your
browser, and shuts down automatically once every tab is closed.

Usage: cc-on-browser [options]

Options:
  -p, --port <n>   Port to listen on (default: $PORT or 8787)
      --no-open    Do not open a browser or auto-exit; run a plain
                   foreground server until Ctrl+C
  -v, --version    Print the version and exit
  -h, --help       Show this help and exit

Environment:
  PORT                  Same as --port
  BROWSER               Command used to open the URL (default: OS default browser)
  CLAUDE_WEB_CLI_PATH   Absolute path to the claude CLI executable
                        (default: \`claude\` resolved from PATH)`;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

let port = Number(process.env.PORT) || 8787;
let noOpen = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--port' || arg === '-p') {
    port = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--no-open') {
    noOpen = true;
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

const isDaemon = process.env.CC_ON_BROWSER_DAEMON === '1';

// 포트 선점 검사 — 데몬이 EADDRINUSE로 조용히 죽는 대신 부모가 여기서 보고한다.
// (검사~데몬 bind 사이의 레이스는 감수: 로컬 단일 사용자 도구다.)
const assertPortFree = (p) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      fail(`Port ${p} is already in use. Pick another one with --port <n>.`);
    }
    if (err?.code === 'EACCES') {
      fail(`No permission to bind port ${p}. Try a port above 1024.`);
    }
    fail(String(err?.message ?? err));
  });
  probe.listen(p, '127.0.0.1', () => probe.close(resolve));
});

// 데몬이 실제로 떠서 '우리 토큰'에 응답할 때까지 짧게 폴링 — 데몬 stdio가
// ignore라 기동 실패(레이스 EADDRINUSE 등)가 조용히 묻히는 것을 부모가 대신
// 감지한다. 단순 TCP 확인은 assertPortFree~데몬 bind 사이 레이스에 끼어든
// 제3의 프로세스도 통과시키므로, 인증 REST(/api/bootstrap)로 신원까지 본다:
// 200이면 방금 발급한 토큰을 아는 우리 데몬이 확실하다.
const waitForDaemon = (p, authToken, timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const retry = () => {
    if (Date.now() >= deadline) resolve(false);
    else setTimeout(attempt, 100);
  };
  const attempt = () => {
    const req = http.get(
      { host: '127.0.0.1', port: p, path: '/api/bootstrap', headers: { 'x-auth-token': authToken } },
      (res) => {
        res.resume(); // 본문을 소비해 소켓을 해제
        if (res.statusCode === 200) resolve(true);
        else retry();
      },
    );
    req.on('error', retry);
  };
  attempt();
});

const openBrowser = (url) => {
  // 토큰이 hex라 URL에 셸 특수문자가 없다 — 그대로 넘겨도 안전.
  let child;
  const browserCmd = process.env.BROWSER;
  try {
    if (browserCmd) {
      child = spawn(browserCmd, [url], { stdio: 'ignore', detached: true, windowsHide: true });
    } else if (process.platform === 'win32') {
      // cmd start의 첫 따옴표 인자는 창 제목으로 먹히므로 빈 제목을 끼운다.
      child = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore', detached: true });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
  } catch {
    return;
  }
  child.on('error', () => { /* 브라우저 실행 실패 → FIRST_CONNECT 유예가 서버를 정리한다 */ });
  child.unref();
};

if (!noOpen && !isDaemon) {
  // 부모: 토큰을 만들어 데몬에 물려주고, URL을 출력한 뒤 곧바로 빠진다.
  const token = crypto.randomBytes(16).toString('hex');
  if (port !== 0) await assertPortFree(port);
  const child = spawn(process.execPath, [selfPath, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CC_ON_BROWSER_DAEMON: '1', CC_ON_BROWSER_TOKEN: token },
  });
  child.unref();
  if (port !== 0) {
    // 데몬 stdio는 ignore라 startServer 실패가 조용히 묻힌다 — 우리 토큰에
    // 응답하는 데몬을 확인한 뒤에만 "성공" URL을 낸다. (랜덤 포트는 부모가
    // 포트를 몰라 스킵.)
    const listening = await waitForDaemon(port, token, 5_000);
    if (!listening) {
      fail(`The background server did not come up on port ${port}.\n`
        + 'Re-run with --no-open to see the underlying error.');
    }
    console.log(`Claude Code on Browser v${pkg.version} — http://127.0.0.1:${port}/#token=${token}`);
  } else {
    console.log(`Claude Code on Browser v${pkg.version} — random port; check the browser address bar.`);
  }
  console.log('Opening your browser... The server runs in the background (127.0.0.1 only)');
  console.log('and stops automatically once every tab is closed. (--no-open for a foreground server)');
  process.exit(0);
}

let handle;
let lifecycle = null;
let closingDown = false;

const shutdown = () => {
  if (closingDown) return;
  closingDown = true;
  // close()가 WS 종료 콜백을 재발화시켜도 무시되도록 lifecycle부터 정리한다.
  lifecycle?.dispose();
  const finish = () => process.exit(0);
  if (handle) handle.close().then(finish, finish);
  else finish();
};

// 브라우저 생존 신호 → 수명 정책(lifecycle.js 상태기계)에 위임.
// lifecycle 생성 전 호출 가능성은 ?.로 방어(그 구간은 최초 접속 대기가 커버).
const onClientCountChange = (count, meta) => lifecycle?.onClientCountChange(count, meta);

try {
  handle = await startServer({
    port,
    token: process.env.CC_ON_BROWSER_TOKEN || crypto.randomBytes(16).toString('hex'),
    cliPath,
    staticDir,
    onClientCountChange: noOpen ? undefined : onClientCountChange,
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

if (!noOpen) {
  // 데몬: 브라우저를 열고, 수명은 lifecycle 상태기계에 건다 — 최초 접속 90초 대기,
  // 의도적 탭 닫힘(bye)이면 10초 뒤 종료(기존 계약), 연결 유실(절전·리드 닫힘)이면
  // 살아있는 CLI 세션이 있는 한 무기한 재접속 대기(없으면 30분 유예).
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  lifecycle = createLifecycle({ hasLiveSessions: handle.hasLiveSessions, shutdown });
  openBrowser(`http://127.0.0.1:${handle.port}/#token=${handle.token}`);
} else {
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
}
