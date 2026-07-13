// server.js — HTTP(REST + 정적 서빙) + WebSocket 허브. 127.0.0.1 전용.
// WS/REST 스키마: docs/superpowers/plans/2026-07-06-claude-code-on-browser.md "WS 프로토콜" 절.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { SessionHub } from './session-hub.js';
import { listProjects, listSessions, loadTranscript } from './history.js';
import { listDirs, pickDirectory, searchFiles } from './fs-api.js';
import { aggregateUsage } from './usage.js';
import { fetchQuota } from './quota.js';

const VERSION_TIMEOUT_MS = 3_000;
const USAGE_CACHE_MS = 30_000;
const QUOTA_CACHE_MS = 60_000;
// --effort 허용값 (spawn 전용 — claude --help 실측)
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function startServer({
  port = 8787,
  host = '127.0.0.1',
  token,
  cliPath,
  cliArgsPrefix = [],
  projectsRoot,
  staticDir,
  exitedRetentionMs,
  quotaFetcher, // 테스트 주입용 — 기본은 quota.js의 공식 사용률 조회
  onClientCountChange, // WS 클라이언트 수 변화 알림 — bin이 브라우저 생존 신호로 쓴다
  directoryPicker, // 테스트 주입용 — 기본은 fs-api.js의 네이티브 폴더 선택 대화상자
} = {}) {
  if (!token) throw new TypeError('token is required');
  if (!cliPath) throw new TypeError('cliPath is required');

  const hub = new SessionHub({ cliPath, cliArgsPrefix, exitedRetentionMs });
  /** @type {Set<import('ws').WebSocket>} */
  const sockets = new Set();
  let boundPort = null;
  let versionPromise = null;
  let usageCache = { at: 0, promise: null };
  let quotaCache = { at: 0, promise: null };
  const getQuota = quotaFetcher ?? fetchQuota;
  const pickDir = directoryPicker ?? pickDirectory;

  const tokenBuf = Buffer.from(String(token));
  const tokenEquals = (candidate) => {
    if (typeof candidate !== 'string') return false;
    const buf = Buffer.from(candidate);
    return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
  };

  // Origin 헤더가 존재하면 로컬 오리진만 허용.
  const originAllowed = (origin) => {
    if (origin == null || origin === '') return true;
    return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
  };

  const getClaudeVersion = () => {
    if (!versionPromise) {
      versionPromise = new Promise((resolve) => {
        let child;
        try {
          child = spawn(cliPath, [...cliArgsPrefix, '--version'], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
          });
        } catch {
          resolve(null);
          return;
        }
        let out = '';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(out.trim() || null);
        };
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* noop */ }
          finish();
        }, VERSION_TIMEOUT_MS);
        timer.unref?.();
        child.on('error', finish);
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.on('close', finish);
      });
    }
    return versionPromise;
  };

  hub.on('broadcast', (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });

  const sendTo = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const sendError = (ws, { key = null, startId = null, message }) => {
    sendTo(ws, { type: 'error', key, startId, message: String(message) });
  };

  async function handleWsMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendError(ws, { message: 'invalid JSON message' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      sendError(ws, { message: 'message must have a type' });
      return;
    }
    const key = typeof msg.key === 'string' ? msg.key : null;
    try {
      switch (msg.type) {
        case 'start': {
          const startId = msg.startId ?? null;
          const effort = msg.effort ?? null;
          if (effort !== null && !EFFORT_LEVELS.has(effort)) {
            sendError(ws, { startId, message: `invalid effort: ${JSON.stringify(msg.effort)}` });
            return;
          }
          try {
            const { key: newKey, initInfo } = await hub.startSession({
              cwd: msg.cwd,
              model: msg.model,
              permissionMode: msg.permissionMode,
              effort,
              resumeSessionId: msg.resumeSessionId,
            });
            sendTo(ws, { type: 'started', startId, key: newKey, initInfo });
          } catch (err) {
            sendError(ws, { startId, message: err?.message ?? err });
          }
          return;
        }
        case 'send': {
          const ok = hub.sendText(key, msg.text);
          if (!ok) sendError(ws, { key, message: 'session is not running' });
          return;
        }
        case 'permission': {
          const ok = hub.respondPermission(key, msg.requestId, {
            behavior: msg.behavior,
            updatedInput: msg.updatedInput,
            updatedPermissions: msg.updatedPermissions,
            message: msg.message,
          });
          if (!ok) sendError(ws, { key, message: `no pending permission request: ${msg.requestId}` });
          return;
        }
        case 'interrupt':
          await hub.interrupt(key);
          return;
        case 'setModel':
          await hub.setModel(key, msg.model);
          return;
        case 'setPermissionMode':
          await hub.setPermissionMode(key, msg.mode);
          return;
        case 'setThinking': {
          // null(또는 생략) = CLI 기본(자동), 0 = 끔, 양의 정수 = 사고 토큰 예산.
          // 강제 변환 금지 — ""/false/[] 류가 Number()로 0(사고 끔)이 되는 것을 차단한다.
          const raw = msg.maxThinkingTokens;
          const isValid =
            raw == null || (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0);
          if (!isValid) {
            sendError(ws, { key, message: `invalid maxThinkingTokens: ${JSON.stringify(raw)}` });
            return;
          }
          await hub.setMaxThinkingTokens(key, raw ?? null);
          return;
        }
        case 'attach': {
          const replay = hub.attachReplay(key, Number(msg.afterSeq) || 0);
          for (const { seq, payload } of replay.events) {
            sendTo(ws, { type: 'event', key, seq, payload });
          }
          for (const info of replay.pendingPermissions) {
            sendTo(ws, { type: 'permission_request', key, ...info });
          }
          if (replay.exited) sendTo(ws, { type: 'exit', key, code: replay.exitCode });
          return;
        }
        case 'stop':
          hub.stop(key);
          return;
        default:
          sendError(ws, { key, message: `unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendError(ws, { key, message: err?.message ?? err });
    }
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  async function handleApi(req, res, url) {
    if (!originAllowed(req.headers.origin) || !tokenEquals(req.headers['x-auth-token'])) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    try {
      switch (url.pathname) {
        case '/api/bootstrap':
          json(res, 200, {
            claudeVersion: await getClaudeVersion(),
            defaultCwd: os.homedir(),
            port: boundPort,
            platform: process.platform, // 클라이언트가 네이티브 폴더 선택 버튼 노출 판단
          });
          return;
        case '/api/projects':
          json(res, 200, await listProjects(projectsRoot));
          return;
        case '/api/sessions':
          json(res, 200, await listSessions(projectsRoot, url.searchParams.get('dir')));
          return;
        case '/api/transcript':
          json(res, 200, await loadTranscript(
            projectsRoot,
            url.searchParams.get('dir'),
            url.searchParams.get('sessionId'),
          ));
          return;
        case '/api/browse':
          json(res, 200, await listDirs(url.searchParams.get('path') ?? ''));
          return;
        case '/api/files':
          // @ 파일 태그 자동완성 — cwd 하위 파일을 질의로 검색(상대경로만 반환).
          json(res, 200, {
            files: await searchFiles(
              url.searchParams.get('cwd') ?? '',
              url.searchParams.get('q') ?? '',
            ),
          });
          return;
        case '/api/pick-directory':
          // 네이티브 폴더 선택 대화상자를 사용자 데스크톱에 띄우고 선택 경로를 반환.
          // 사용자가 응답할 때까지 블록되는 GET(로컬 도구라 허용). 취소 시 path=null.
          json(res, 200, await pickDir({ initialPath: url.searchParams.get('path') || undefined }));
          return;
        case '/api/usage': {
          if (!usageCache.promise || Date.now() - usageCache.at > USAGE_CACHE_MS) {
            const promise = aggregateUsage(projectsRoot).catch((err) => {
              // 실패는 캐시하지 않는다 — 단, 그 사이 설치된 새 캐시는 건드리지 않는다
              if (usageCache.promise === promise) usageCache = { at: 0, promise: null };
              throw err;
            });
            usageCache = { at: Date.now(), promise };
          }
          if (!quotaCache.promise || Date.now() - quotaCache.at > QUOTA_CACHE_MS) {
            // 공식 사용률은 실패해도 응답을 막지 않는다 — null 폴백(다음 주기 재시도)
            const promise = Promise.resolve()
              .then(() => getQuota())
              .catch(() => null)
              .then((quota) => {
                if (quota == null && quotaCache.promise === promise) {
                  quotaCache = { at: 0, promise: null };
                }
                return quota;
              });
            quotaCache = { at: Date.now(), promise };
          }
          const [local, quota] = await Promise.all([usageCache.promise, quotaCache.promise]);
          json(res, 200, { ...local, quota });
          return;
        }
        default:
          json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        json(res, 404, { error: 'not found' });
      } else {
        json(res, 400, { error: String(err?.message ?? err) });
      }
    }
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    };
    if (!staticDir) {
      notFound();
      return;
    }
    const root = path.resolve(staticDir);
    let rel;
    try {
      rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      rel = '';
    }
    let target = path.resolve(root, rel || 'index.html');
    // 경로 탈출 방지 — 루트 밖이면 SPA fallback으로 처리.
    if (target !== root && !target.startsWith(root + path.sep)) {
      target = path.join(root, 'index.html');
    }
    let data;
    try {
      const st = await fs.stat(target);
      if (st.isDirectory()) throw Object.assign(new Error('is directory'), { code: 'EISDIR' });
      data = await fs.readFile(target);
    } catch {
      // SPA fallback → index.html
      target = path.join(root, 'index.html');
      try {
        data = await fs.readFile(target);
      } catch {
        notFound();
        return;
      }
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${boundPort ?? port}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(() => {
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    serveStatic(req, res, url.pathname).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      } else {
        res.end();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${host}:${boundPort ?? port}`);
    } catch {
      socket.destroy();
      return;
    }
    const authorized = url.pathname === '/ws'
      && tokenEquals(url.searchParams.get('token'))
      && originAllowed(req.headers.origin);
    if (!authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      onClientCountChange?.(sockets.size);
      ws.on('close', () => {
        sockets.delete(ws);
        onClientCountChange?.(sockets.size);
      });
      ws.on('error', () => { /* 소켓 오류는 close로 정리 */ });
      ws.on('message', (data) => handleWsMessage(ws, data));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  boundPort = server.address().port;

  const close = () => new Promise((resolve) => {
    hub.stopAll();
    for (const ws of sockets) {
      try { ws.terminate(); } catch { /* noop */ }
    }
    sockets.clear();
    wss.close();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  return { server, port: boundPort, token, close, getClaudeVersion };
}
