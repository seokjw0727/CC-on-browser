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
import { defaultNameStoreFile } from '../server/src/cli-session-names.js';
import {
  readInstanceFile,
  writeInstanceFile,
  clearInstanceFile,
} from '../server/src/instance-file.js';

const selfPath = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(selfPath), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

const HELP = `CC on Browser v${pkg.version}
Local-only web UI for the claude CLI. Binds to 127.0.0.1 only.

By default the server runs in the background (no console window), opens your
browser, and shuts down automatically once every tab is closed.

If a background server is already running on the port, re-running this command
just opens a new browser tab into it instead of failing.

Usage: cc-on-browser [options]

Options:
  -p, --port <n>   Port to listen on (default: $PORT or 8787)
      --no-open    Do not open a browser or auto-exit; run a plain
                   foreground server until Ctrl+C
      --shortcut   (Windows) Create a "CC on Browser" shortcut on the
                   Desktop and in the Start Menu that launches with no console
                   window at all, then exit
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
let daemonWorker = false;
let shortcut = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--port' || arg === '-p') {
    port = Number(args[i + 1]);
    i += 1;
  } else if (arg === '--no-open') {
    noOpen = true;
  } else if (arg === '--shortcut') {
    shortcut = true;
  } else if (arg === '--daemon-worker') {
    // 내부 전용(도움말 비노출): 부모가 백그라운드 데몬 재실행에만 붙인다.
    daemonWorker = true;
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

// --shortcut은 --help/--version과 같은 자리에서 처리·종료한다: 아래의 CLI 경로 검사·
// 클라이언트 번들 확인·포트 검사·claude 프로브는 "서버를 띄울 때" 필요한 사전 점검이라,
// 바로가기 생성이 그런 무관한 사정으로 실패하면 안 된다(codex 지적).
if (shortcut) {
  const { runShortcutCommand } = await import('./shortcut.mjs');
  process.exit(await runShortcutCommand({
    pkgRoot,
    version: pkg.version,
    // CC_ON_BROWSER_TEST_PLATFORM: bin.test.js 전용 — Windows에서도 비-Windows 경로를
    // 밟아, 이 분기가 사전 점검들보다 앞에 있음을 실제 바로가기를 만들지 않고 검증한다.
    platform: process.env.CC_ON_BROWSER_TEST_PLATFORM || process.platform,
  }));
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

// 데몬 판별은 env가 아니라 argv 플래그로 한다. 데몬이 스폰한 CLI 세션의 자식
// 셸(예: 이 앱 안에서 연 터미널)에는 데몬의 env가 그대로 상속되므로, env 기반
// 판별은 거기서 `cc-on-browser`를 다시 실행할 때 조용히 데몬 모드로 오인 진입해
// URL 출력 없이 서버·브라우저만 띄우는 버그가 된다(실측 2026-07-19).
const isDaemon = daemonWorker;

// 포트 선점 검사 — 데몬이 EADDRINUSE로 조용히 죽는 대신 부모가 여기서 보고한다.
// (검사~데몬 bind 사이의 레이스는 감수: 로컬 단일 사용자 도구다.)
// 'free' | 'busy'를 돌려주고 즉시 fail하지 않는다: busy가 "우리 데몬이 아직 살아
// 있음"일 수 있고, 그때는 오류가 아니라 브라우저 탭만 새로 여는 게 맞다.
// EACCES 등 재사용과 무관한 오류만 여기서 바로 보고한다.
const probePort = (p) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      resolve('busy');
      return;
    }
    if (err?.code === 'EACCES') {
      fail(`No permission to bind port ${p}. Try a port above 1024.`);
    }
    fail(String(err?.message ?? err));
  });
  probe.listen(p, '127.0.0.1', () => probe.close(() => resolve('free')));
});

const portBusyMessage = (p) => `Port ${p} is already in use. Pick another one with --port <n>.`;

// 우리가 아는 bootstrap 응답은 수백 바이트다 — 이보다 크면 우리 서버가 아니다.
// (200을 준 뒤 본문을 끝없이 흘리는 서버로부터 메모리를 보호한다.)
const MAX_BOOTSTRAP_BODY = 64 * 1024;

// 인증 REST 한 번 — 주어진 토큰으로 200을 주고, 스스로 보고하는 포트까지 일치하면
// "그 토큰을 아는 우리 서버"가 확실하다. 포트까지 보는 이유: stale 신원 파일 뒤에
// 우연히 다른 HTTP 서비스가 같은 포트를 잡고 200을 줄 수도 있다(codex 지적).
//
// 타임아웃은 req.setTimeout이 아니라 **절대 타이머**로 건다: setTimeout은 "무응답
// 구간" 타이머라, 200을 준 뒤 본문을 조금씩 흘리는 서버에는 영원히 걸려 있을 수 있고
// 그러면 아래의 전체 deadline이 무의미해진다(codex 지적).
const identifyServer = (p, authToken, timeoutMs) => new Promise((resolve) => {
  let done = false;
  let req = null;
  const finish = (v) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { req?.destroy(); } catch { /* 이미 정리됨 */ }
    resolve(v);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  try {
    req = http.get(
      { host: '127.0.0.1', port: p, path: '/api/bootstrap', headers: { 'x-auth-token': authToken } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > MAX_BOOTSTRAP_BODY) finish(false);
        });
        res.on('end', () => {
          try {
            finish(JSON.parse(body)?.port === p);
          } catch {
            finish(false);
          }
        });
        res.on('error', () => finish(false));
      },
    );
  } catch {
    // 기록된 토큰에 헤더로 못 쓰는 문자(개행 등)가 있으면 http.get이 동기 throw한다 —
    // 손상된 기록으로 취급하고 조용히 실패한다(그러지 않으면 unhandled rejection으로
    // 스택 트레이스를 뿜는다 — codex 지적).
    finish(false);
    return;
  }
  req.on('error', () => finish(false));
});

// unref하지 않는다: 이 타이머만 남은 순간 이벤트 루프가 비면 대기 중인 top-level
// await가 그대로 버려지고 Node가 exit 13으로 끝난다(실측). 폴링 루프는 모두 짧은
// deadline으로 묶여 있어 ref된 타이머가 프로세스를 붙잡아 두는 시간도 그만큼이다.
const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

// 데몬이 실제로 떠서 '우리 토큰'에 응답할 때까지 짧게 폴링 — 데몬 stdio가
// ignore라 기동 실패(레이스 EADDRINUSE 등)가 조용히 묻히는 것을 부모가 대신
// 감지한다. 단순 TCP 확인은 포트 검사~데몬 bind 사이 레이스에 끼어든 제3의
// 프로세스도 통과시키므로, 인증 REST(/api/bootstrap)로 신원까지 본다.
const waitForDaemon = async (p, authToken, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await identifyServer(p, authToken, 2_000)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
};

// 포트를 쥔 게 "우리 데몬"인지 판정. 신원 파일이 없거나 인증이 안 되면 곧바로
// 실패로 단정하지 않고 짧은 deadline 안에서 재시도한다 — 확정을 미뤄야 하는
// 과도 구간이 실재한다(codex 지적):
//   · 다른 launcher의 포트 프로브가 순간적으로 포트를 쥐고 있는 경우
//   · 승자 데몬이 bind는 했지만 아직 신원 파일을 발행하지 않은 경우
//   · 종료 중인 데몬이 파일은 지웠지만 listener는 아직 놓지 않은 경우
// 포트가 비는 순간 즉시 포기한다(우리가 새로 띄우면 되므로) — 그 경우는 'free'로
// 구분해 돌려준다. 'busy'로 뭉개면 종료 중인 데몬이 포트를 놓는 순간 재실행이
// 오류로 죽는다(codex 지적).
// CC_ON_BROWSER_TEST_REUSE_MS: bin.test.js 전용 — 대기를 줄여 테스트를 빠르게.
const REUSE_DEADLINE_MS = Number(process.env.CC_ON_BROWSER_TEST_REUSE_MS) || 3_000;

/** @returns {Promise<{status:'reuse', record: object}|{status:'free'}|{status:'busy'}>} */
const findReusableDaemon = async (p, deadlineMs = REUSE_DEADLINE_MS) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const rec = readInstanceFile(p);
    // 한 번의 시도에 전체 deadline의 '남은 예산'만 준다 — 개별 타임아웃이 전체
    // deadline을 넘겨 버리지 않게(codex 지적). 최소 250ms는 확보한다.
    const budget = Math.max(250, deadline - Date.now());
    if (rec && (await identifyServer(p, rec.token, budget))) return { status: 'reuse', record: rec };
    if ((await probePort(p)) === 'free') return { status: 'free' };
    if (Date.now() >= deadline) return { status: 'busy' };
    await delay(100);
  }
};

// 유휴 데몬에게 "지금 내려 달라"고 부탁한다 — 버전 스큐를 조용히 고치는 유일한 경로.
// 서버는 살아있는 CLI 세션이나 원격 제어가 하나라도 있으면 409로 거절한다(그 판단은
// 서버가 한다 — 런처는 남의 작업을 죽일 근거를 갖고 있지 않다).
// @returns 'stopped' | 'busy' | 'error'
const requestShutdownIfIdle = (p, authToken, timeoutMs) => new Promise((resolve) => {
  let done = false;
  let req = null;
  const finish = (v) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { req?.destroy(); } catch { /* 이미 정리됨 */ }
    resolve(v);
  };
  const timer = setTimeout(() => finish('error'), timeoutMs);
  try {
    req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: p,
        path: '/api/shutdown-if-idle',
        headers: { 'x-auth-token': authToken, 'content-length': '0' },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) finish('stopped');
        else if (res.statusCode === 409) finish('busy');
        else finish('error'); // 501(구버전 서버엔 이 창구가 없다)·401·그 밖 모두
      },
    );
  } catch {
    finish('error');
    return;
  }
  req.on('error', () => finish('error'));
  req.end();
});

// 데몬이 실제로 포트를 놓을 때까지 짧게 기다린다 — 종료는 비동기라, 바로 이어서
// 새 데몬을 띄우면 EADDRINUSE로 죽는다.
const waitForPortFree = async (p, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await probePort(p)) === 'free') return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
};

const appUrl = (p, authToken) => `http://127.0.0.1:${p}/#token=${authToken}`;

// 실행 중 데몬을 재사용했을 때의 한 줄. 버전은 **기록된 데몬의 것**을 쓴다 —
// 이 런처의 pkg.version을 쓰면 구버전 데몬을 재사용할 때 거짓말이 된다(codex 지적).
const alreadyRunningLine = (rec) =>
  `Already running${rec.version ? ` (v${rec.version})` : ''} on port ${rec.port}`
  + ' — opened a new browser tab.';

/** 살아있는 데몬으로 탭만 열고 성공 종료. warn이 있으면 그 한 줄을 먼저 낸다. */
const reuseDaemon = (rec, { warn } = {}) => {
  openBrowser(appUrl(rec.port, rec.token));
  console.log(alreadyRunningLine(rec));
  if (warn) console.warn(warn);
  process.exit(0);
};

// 버전이 어긋난 데몬을 만났을 때의 처리. 배경: 데몬은 브라우저를 닫아도 살아남고
// 재실행은 그 데몬을 재사용하는데, 정적 번들은 디스크에서 매번 읽힌다 — 업그레이드
// 직후 "새 클라이언트 + 구 서버"가 되어 새로 생긴 WS 메시지가 서버에서
// `unknown message type`으로 튕긴다(v1.9.3 데몬에서 setEffort가 그랬다).
//
// 유휴면 조용히 교체하고, 일하는 중이면 죽이지 않고 경고만 남긴 채 재사용한다.
// 여기서 돌아오면(=교체 성공) 호출측은 평소의 기동 경로를 그대로 탄다.
const replaceStaleDaemon = async (rec) => {
  const result = await requestShutdownIfIdle(rec.port, rec.token, 5_000);
  if (result === 'stopped') {
    if (await waitForPortFree(rec.port, 5_000)) {
      console.log(`Replacing the running v${rec.version ?? '?'} server with v${pkg.version}...`);
      return true;
    }
    // 내려가겠다고 답해 놓고 포트를 놓지 않았다. 재사용도 답이 아니다 — 곧 죽을
    // 서버로 탭을 열면 빈 화면이 된다. 사실대로 알리고 다시 시도하게 한다.
    fail([
      `The v${rec.version ?? '?'} background server accepted the shutdown request`,
      `  but did not release port ${rec.port}.`,
      '  Wait a moment and run this command again.',
    ].join('\n'));
  }
  const why = result === 'busy'
    ? 'it still has live sessions'
    : 'it did not accept the request';
  reuseDaemon(rec, {
    warn: [
      `WARNING: the background server is v${rec.version ?? '?'} but this launcher is v${pkg.version}.`,
      `  It was left running because ${why}.`,
      '  Close every session and re-run this command to pick up the new version.',
    ].join('\n'),
  });
  return false; // reuseDaemon이 process.exit 하므로 실제로는 닿지 않는다
};

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

// claude --version 존재 프로브 — 세션을 만들지 않아 구독을 소모하지 않는다.
// 실패(미설치·타임아웃)는 null: 경고만 내고 기동은 막지 않는다.
const probeClaudeVersion = (timeoutMs = 8_000) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(cliPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    resolve(null);
    return;
  }
  let out = '';
  const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => { clearTimeout(timer); resolve(null); });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve(code === 0 && out.trim() ? out.trim() : null);
  });
});

const warnClaudeMissing = () => {
  console.warn('WARNING: claude CLI not found or not responding.');
  console.warn('  Sessions will fail to start until it is available. Install it from');
  console.warn('  https://claude.com/claude-code, log in (run `claude`, then /login), and make');
  console.warn('  sure `claude` is on your PATH — or set CLAUDE_WEB_CLI_PATH to its absolute path.');
};

if (!noOpen && !isDaemon) {
  // 부모: 토큰을 만들어 데몬에 물려주고, URL을 출력한 뒤 곧바로 빠진다.
  const token = crypto.randomBytes(16).toString('hex');
  if (port !== 0 && (await probePort(port)) === 'busy') {
    // 포트가 이미 점유됨. 예전에는 여기서 곧바로 죽었다 — 브라우저를 닫은 뒤에도
    // 데몬이 잠시(또는 세션이 살아있으면 한참) 포트를 쥐고 있으므로, 탐색기·바로가기
    // 실행에서는 창만 깜빡이고 아무 일도 없는 것처럼 보였다. 우리 데몬이면 재사용한다.
    const found = await findReusableDaemon(port);
    if (found.status === 'reuse') {
      // 같은 버전이면 그대로 재사용, 다르면 교체를 시도한다(replaceStaleDaemon 참조).
      if (found.record.version === pkg.version) reuseDaemon(found.record);
      await replaceStaleDaemon(found.record);
    }
    if (found.status === 'busy') fail(portBusyMessage(port));
    // 'free' — 판정 중에 포트가 비었다(직전 데몬이 종료를 마쳤다 등). 오류가 아니라
    // 아래 정상 기동 경로로 그대로 떨어진다.
  }
  // CLI 프로브는 데몬 기동 대기와 병행 — 브라우저 열림을 지연시키지 않는다.
  // 포트 검사 통과 후에만 시작해, 조기 실패 경로에서는 실제 CLI를 호출하지 않는다.
  const cliProbe = probeClaudeVersion();
  // CC_ON_BROWSER_TEST_SKIP_DAEMON: bin.test.js 전용 — 진단 출력 경로를 데몬 없이 검증.
  if (!process.env.CC_ON_BROWSER_TEST_SKIP_DAEMON) {
    const child = spawn(process.execPath, [selfPath, ...args, '--daemon-worker'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CC_ON_BROWSER_TOKEN: token },
    });
    child.unref();
  }
  if (port !== 0) {
    // 데몬 stdio는 ignore라 startServer 실패가 조용히 묻힌다 — 우리 토큰에
    // 응답하는 데몬을 확인한 뒤에만 "성공" URL을 낸다. (랜덤 포트는 부모가
    // 포트를 몰라 스킵.)
    const listening = await waitForDaemon(port, token, 5_000);
    if (!listening) {
      // 동시 실행 레이스: 두 부모가 모두 포트 검사를 통과했다면 bind는 한쪽만
      // 성공한다. 우리 토큰에 응답이 없다면 승자의 신원 파일을 다시 읽어 그쪽을
      // 재사용한다(우리 데몬은 EADDRINUSE로 이미 죽었다 — codex 지적).
      const winner = await findReusableDaemon(port);
      if (winner.status === 'reuse') reuseDaemon(winner.record);
      fail(`The background server did not come up on port ${port}.\n`
        + 'Re-run with --no-open to see the underlying error.');
    }
    console.log(`CC on Browser v${pkg.version} — http://127.0.0.1:${port}/#token=${token}`);
  } else {
    console.log(`CC on Browser v${pkg.version} — random port; check the browser address bar.`);
  }
  console.log('Opening your browser... The server runs in the background (127.0.0.1 only)');
  console.log('and stops automatically once every tab is closed. (--no-open for a foreground server)');
  // 백그라운드 모드에서도 CLI 미설치를 즉시 알린다 — 이전에는 --no-open에서만 경고.
  const cliVersion = await cliProbe;
  if (cliVersion) console.log(`claude CLI: ${cliVersion}`);
  else warnClaudeMissing();
  process.exit(0);
}

let handle;
let lifecycle = null;
let closingDown = false;
// 이 데몬이 발행한 신원 파일 — 종료 시 "내 것만" 지우기 위한 좌표.
let published = null;

const shutdown = () => {
  if (closingDown) return;
  closingDown = true;
  // close()가 WS 종료 콜백을 재발화시켜도 무시되도록 lifecycle부터 정리한다.
  lifecycle?.dispose();
  // 신원 파일은 **listener를 놓기 전에** 동기로 지운다. 순서를 뒤집으면 그 사이
  // 후임 데몬이 같은 포트에 bind·발행할 수 있고, 우리가 그 파일을 지워 버린다
  // (instance-file.js의 TOCTOU 주석 참조 — codex 지적).
  if (published) {
    clearInstanceFile(published);
    published = null;
  }
  const finish = () => process.exit(0);
  if (handle) handle.close().then(finish, finish);
  else finish();
};

// 브라우저 생존 신호 → 수명 정책(lifecycle.js 상태기계)에 위임.
// lifecycle 생성 전 호출 가능성은 ?.로 방어(그 구간은 최초 접속 대기가 커버).
const onClientCountChange = (count, meta) => lifecycle?.onClientCountChange(count, meta);

// 부모가 넘긴 토큰은 확보 즉시 env에서 제거 — 로컬 API bearer token이 데몬이
// 스폰하는 CLI 세션과 그 자식 셸로 상속·유출되지 않게 한다(codex 지적).
const bootToken = process.env.CC_ON_BROWSER_TOKEN || crypto.randomBytes(16).toString('hex');
delete process.env.CC_ON_BROWSER_TOKEN;

try {
  handle = await startServer({
    port,
    token: bootToken,
    cliPath,
    staticDir,
    version: pkg.version,
    // 런처가 버전이 어긋난 유휴 데몬을 교체할 때 쓰는 창구 — 서버는 "유휴인가"만
    // 판정하고, 실제 종료(신원 파일 정리 포함)는 이 프로세스의 주인인 여기가 한다.
    onShutdownRequest: shutdown,
    onClientCountChange: noOpen ? undefined : onClientCountChange,
    // 붙여넣기 임시 폴더 청소는 실제 앱 기동에서만 켠다 — 이 부수효과가 startServer의
    // 기본값이면 테스트가 서버를 띄우는 것만으로 사용자 %TEMP%를 지운다.
    pasteCleanup: true,
    // CLI 세션 이름 저장소도 같은 이유로 여기서만 켠다(cli-session-names.js 참조).
    // CLI는 프로세스가 끝나면 자기 이름 파일을 지우므로, 이것이 없으면 지난 세션
    // 목록에는 이름이 하나도 남지 않는다.
    nameStoreFile: defaultNameStoreFile(),
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

// Ctrl+C·종료 시그널은 두 실행 모드 모두에 건다. --no-open에도 필요하다 —
// 이제 종료 경로가 원격 제어 자식 정리를 책임지므로, 여기가 비면 Ctrl+C가 그 정리를
// 통째로 건너뛰고 자식이 고아로 남는다(codex 지적).
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!noOpen) {
  // 데몬: 브라우저를 열고, 수명은 lifecycle 상태기계에 건다 — 최초 접속 90초 대기,
  // 의도적 탭 닫힘(bye)이면 10초 뒤 종료(기존 계약), 연결 유실(절전·리드 닫힘)이면
  // 살아있는 CLI 세션이 있는 한 무기한 재접속 대기(없으면 30분 유예).
  // 신원 파일 발행 — listen이 끝난 뒤에만 한다(먼저 쓰면 아직 응답하지 않는 포트를
  // 가리켜, 재실행이 그 토큰으로 인증을 시도하다 헛돈다). --port 0(랜덤)은 파일 키가
  // 성립하지 않아 발행·재사용 모두 비활성이다(instance-file.js 참조).
  if (port !== 0) {
    const record = {
      port: handle.port,
      token: handle.token,
      pid: process.pid,
      version: pkg.version,
    };
    if (writeInstanceFile(record)) published = record;
  }
  lifecycle = createLifecycle({
    hasLiveSessions: handle.hasLiveSessions,
    // 원격 제어가 살아 있으면 브라우저를 닫아도 데몬을 내리지 않는다.
    hasPinnedWork: handle.hasLiveRemoteControls,
    shutdown,
  });
  openBrowser(appUrl(handle.port, handle.token));
} else {
  console.log(`CC on Browser v${pkg.version} — http://127.0.0.1:${handle.port}/#token=${handle.token}`);
  console.log('Local-only server (127.0.0.1). Keep this URL private — the token grants access.');

  // claude --version 1회 — 세션을 만들지 않으므로 구독을 소모하지 않는다.
  // 서버의 메모이즈된 프로브를 공유해 첫 /api/bootstrap 응답도 이 결과를 재사용한다.
  const cliVersion = await handle.getClaudeVersion();
  if (cliVersion) {
    console.log(`claude CLI: ${cliVersion}`);
  } else {
    warnClaudeMissing();
  }
}
