// server.js — HTTP(REST + 정적 서빙) + WebSocket 허브. 127.0.0.1 전용.
// WS/REST 스키마: docs/superpowers/plans/2026-07-06-claude-code-on-browser.md "WS 프로토콜" 절.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { SessionHub } from './session-hub.js';
import { listProjects, listSessions, loadTranscript, listRecentSessions, deleteSession } from './history.js';
import { listDirs, pickDirectory, searchFiles } from './fs-api.js';
import { aggregateDailyUsage, aggregateUsage, MAX_DAILY_DAYS } from './usage.js';
import { fetchQuota } from './quota.js';
import { createRemoteControl } from './remote-control.js';

const VERSION_TIMEOUT_MS = 3_000;
// close()가 원격 제어 자식 정리를 기다리는 상한. remote-control.js의 stop 유예
// (기본 5초 × 2단계)보다 넉넉하되, 사용자가 체감할 만큼 길지는 않게.
const CLOSE_REMOTE_GRACE_MS = 12_000;
const USAGE_CACHE_MS = 30_000;
const QUOTA_CACHE_MS = 60_000;
// 일별 집계(돌아보기 잔디)는 최대 1년치 스캔이라 5h/7d보다 캐시를 길게 둔다
const DAILY_CACHE_MS = 5 * 60_000;
// --effort 허용값 (spawn 전용 — claude --help 실측)
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// 'bye'(의도적 탭 닫힘 신호) 수신 후 이 시간 내에 소켓이 닫혀야 bye-close로 인정.
// 절전 등으로 close가 한참 뒤에 도착한 경우를 의도적 닫힘으로 오분류하지 않기 위한 TTL.
export const BYE_MARK_TTL_MS = 15_000;

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
  onClientCountChange, // WS 클라이언트 수 변화 알림 — bin이 브라우저 생존 신호로 쓴다.
  // 계약: 연결(open) 시 (count) 단항 호출, 종료(close) 시 (count, {bye}) —
  // bye는 "이 소켓이 bye 신호 후 TTL 내에 닫혔는가"(의도적 탭 닫힘 판별, lifecycle.js 참조).
  byeMarkTtlMs = BYE_MARK_TTL_MS, // 테스트 주입용
  directoryPicker, // 테스트 주입용 — 기본은 fs-api.js의 네이티브 폴더 선택 대화상자
  platform = process.platform, // 테스트 주입용 — E2E가 비-Windows UI(cwd 직접 입력 폴백)를 강제
  remoteControl, // 테스트 주입용 — 기본은 remote-control.js의 실제 자식 프로세스 관리자
  closeRemoteGraceMs = CLOSE_REMOTE_GRACE_MS, // 테스트 주입용 — 정리 대기 상한
} = {}) {
  if (!token) throw new TypeError('token is required');
  if (!cliPath) throw new TypeError('cliPath is required');

  const hub = new SessionHub({ cliPath, cliArgsPrefix, exitedRetentionMs });
  const rc = remoteControl ?? createRemoteControl({ cliPath, cliArgsPrefix });
  /** @type {Set<import('ws').WebSocket>} */
  const sockets = new Set();
  /** @type {WeakMap<import('ws').WebSocket, {at: number, seq: number}>} ws -> bye 수신 시각·연결 세대 */
  const byeMarks = new WeakMap();
  // WS 연결 세대 카운터 — bye 수신 후 새 연결이 생겼다면(세대 증가) 그 bye는 "이전
  // episode"의 것(예: 새로고침에서 새 소켓 open 후 구 소켓 close가 늦게 도착)이라
  // 의도적 닫힘 판정에 쓰지 않는다. 시계 비교는 같은 ms 해상도에서 모호해 세대로 판정.
  let openSeq = 0;
  let boundPort = null;
  let versionPromise = null;
  let usageCache = { at: 0, promise: null };
  let quotaCache = { at: 0, promise: null };
  // `${days}:${로컬 YYYY-MM-DD}` -> { at, promise } — 키에 날짜를 넣어 자정 직후
  // 어제 캐시가 오늘 시계열로 오인되는 것을 차단(설계도 §2 server.js).
  const dailyCache = new Map();
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

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  hub.on('broadcast', (msg) => {
    broadcast(msg);
    // 세션이 끝나면 각 원격 제어에 붙은 keys가 달라진다. 원격 프로세스 변화에만
    // 방송을 걸어 두면, 종료된 세션의 pill이 다음 원격 이벤트까지 켜진 채로 남는다
    // (codex 지적). 켜진 원격 제어가 있을 때만 덧붙여 잡음을 만들지 않는다.
    if (msg?.type === 'exit' && rc.snapshot().length > 0) broadcast(remoteControlMessage());
  });

  // 원격 제어 상태 메시지. 관리자는 canonical cwd만 알고 세션 key는 모르므로, 지금 그
  // 디렉터리를 쓰는 라이브 세션 key들을 여기서 붙여 준다 — 클라이언트가 cwd 문자열을
  // 스스로 정규화하지 않고도(realpath는 서버만 할 수 있다) 자기 상태를 찾게 하기 위해.
  //
  // 동일성 판정은 **문자열이 아니라 파일시스템**으로 한다. 시작 요청에 쓰인 철자를
  // 기억해 두는 별칭 장부 방식은, 다른 철자(심링크·junction·대소문자·끝 구분자)로
  // 시작된 세션을 놓치고, 별칭이 다른 곳을 가리키게 바뀌면 엉뚱한 상태에 key를 붙이며,
  // 정리되지 않고 계속 자란다(codex 지적). realpathSync는 세션 수가 한 자릿수이고
  // 방송이 드물어(상태 전이·새 연결) 비용이 문제되지 않는다.
  // win32는 파일시스템이 대소문자를 구분하지 않고, realpath가 드라이브 문자·구성요소
  // 대소문자를 입력에 따라 다르게 돌려주는 경우가 있다(CI에서 실제로 keys가 비었다).
  // realpath로 심볼릭 링크·8.3 단축명을 편 뒤, win32에서만 대소문자를 접어 비교한다.
  const foldCase = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  const canonicalOf = (p) => {
    try {
      return foldCase(fsSync.realpathSync(p));
    } catch {
      return null; // 지워졌거나 접근 불가 — 매칭에서 조용히 빠진다
    }
  };
  const keysForCwd = (canonical) => {
    const want = foldCase(canonical);
    return hub
      .liveSessionCwds()
      .filter((s) => s.cwd && canonicalOf(s.cwd) === want)
      .map((s) => s.key);
  };

  // 이 원격 제어에 해당하는 "세션이 쓴 원본 cwd 철자"들. 세션이 먼저 끝나면 keys가
  // 비는데, 그때도 클라이언트가 자기 것으로 알아보고 끌 수 있어야 한다. 클라이언트가
  // 스스로 심링크·대소문자를 판정할 수 없으므로 서버가 realpath로 묶어서 내려준다
  // (raw session.cwd 문자열 비교는 그 경우에 실패한다 — codex 지적).
  const cwdsForCwd = (canonical) => [
    ...new Set(hub.allSessionCwds().filter((p) => canonicalOf(p) === canonical)),
  ];

  const remoteControlMessage = () => ({
    type: 'remoteControl',
    states: rc.snapshot().map((s) => ({
      ...s,
      keys: keysForCwd(s.cwd),
      cwds: cwdsForCwd(s.cwd),
    })),
  });

  rc.on('change', () => broadcast(remoteControlMessage()));

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
        case 'bye':
          // 클라이언트 pagehide(실제 탭 닫힘)의 best-effort 신호 — 곧 닫힐 소켓을
          // "의도적 닫힘"으로 마킹한다. 응답 없음.
          byeMarks.set(ws, { at: Date.now(), seq: openSeq });
          return;
        case 'ping':
          // 절전 복귀 헬스체크 — half-open 소켓 판별용 왕복.
          sendTo(ws, { type: 'pong' });
          return;
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
            // 이미 원격 제어가 켜진 디렉터리에 새 세션이 열리면 그 세션에도 keys가
            // 붙어야 한다 — 안 그러면 새 탭의 pill만 꺼진 것처럼 보인다(codex 지적).
            if (rc.snapshot().length > 0) broadcast(remoteControlMessage());
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
        case 'remoteControl': {
          // 클라이언트는 세션 key만 보낸다 — 대상 디렉터리는 서버가 자기 장부에서 되찾는다.
          // WS로 온 임의 경로 문자열을 장기 원격 제어 대상으로 삼지 않기 위한 규율.
          const cwd = key ? hub.cwdOf(key) : null;
          if (msg.action === 'stop') {
            // 끄기는 예외를 하나 둔다: 세션이 먼저 끝났는데 원격 제어만 살아 있는 경우
            // key로는 대상을 찾을 수 없어, UI에서 끌 방법이 사라진다(codex 지적).
            // 이때는 **우리가 이미 클라이언트에 알려 준** 항목의 cwd만 받아들인다 —
            // 임의 경로를 여는 권한이 아니라, 이미 도는 것 중에서 고르는 것뿐이다.
            const known = rc.snapshot().some((s) => s.cwd === msg.cwd);
            const target = cwd ?? (known ? msg.cwd : null);
            if (!target) {
              sendError(ws, { key, message: '중지할 원격 제어를 찾지 못했습니다' });
              return;
            }
            await rc.stop(target);
            broadcast(remoteControlMessage());
            return;
          }
          if (!cwd) {
            sendError(ws, { key, message: '원격 제어는 실행 중인 세션에서만 켤 수 있습니다' });
            return;
          }
          if (msg.action === 'start') {
            await rc.start(cwd, { name: msg.name });
          } else {
            sendError(ws, { key, message: `unknown remoteControl action: ${msg.action}` });
            return;
          }
          // 관리자의 'change'는 start()가 반환되기 **전에** 나가므로, 그 시점 스냅샷은
          // 이 요청으로 새로 라이브가 된 세션을 아직 반영하지 못할 수 있다. 요청 소켓에만
          // 보내면 다른 탭은 그 낡은 상태에 갇힌다(codex 지적) — 전 소켓에 다시 방송한다.
          // 멱등 start(이미 ready)라 change가 아예 없는 경우도 이 방송이 덮어 준다.
          broadcast(remoteControlMessage());
          return;
        }
        default:
          sendError(ws, { key, message: `unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendError(ws, { key, message: err?.message ?? err });
    }
  }

  function json(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  // DELETE /api/sessions?dir=..&sessionId=.. — 세션 히스토리 파일 영구 삭제.
  // 라이브(재개 초기화 중 포함) 세션 파일은 409로 거부, 없으면 404,
  // 예상 밖 파일 오류(EACCES/EPERM/EBUSY)는 500, 그 외 검증 오류는 400.
  async function handleDeleteSession(res, url) {
    const dir = url.searchParams.get('dir');
    const sessionId = url.searchParams.get('sessionId');
    if (!dir || !sessionId) {
      json(res, 400, { error: 'dir and sessionId are required' });
      return;
    }
    if (hub.isSessionIdLive(sessionId)) {
      json(res, 409, { error: 'session is currently live' });
      return;
    }
    // 파일이 이미 사라진 뒤(외부 삭제) 404로 수렴하는 경우에도 집계 캐시는 낡았을 수
    // 있으므로, 성공·404 공통으로 무효화한다(최대 캐시 수명 30초/5분 잔존 방지).
    const invalidateUsageCaches = () => {
      usageCache = { at: 0, promise: null };
      dailyCache.clear();
    };
    try {
      await deleteSession(projectsRoot, dir, sessionId);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        invalidateUsageCaches();
        json(res, 404, { error: 'not found' });
      } else if (err?.code == null) {
        // code 없는 Error = deleteSession의 자체 검증(invalid dirName/sessionId) → 400
        json(res, 400, { error: String(err?.message ?? err) });
      } else {
        // 그 외 파일시스템 오류(EACCES/EPERM/EBUSY/EIO/EROFS …)는 서버 오류로 분류
        json(res, 500, { error: String(err?.message ?? err) });
      }
      return;
    }
    invalidateUsageCaches();
    json(res, 200, { ok: true });
  }

  async function handleApi(req, res, url) {
    if (!originAllowed(req.headers.origin) || !tokenEquals(req.headers['x-auth-token'])) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/sessions') {
      await handleDeleteSession(res, url);
      return;
    }
    if (req.method !== 'GET') {
      const allow = url.pathname === '/api/sessions' ? 'GET, DELETE' : 'GET';
      json(res, 405, { error: 'method not allowed' }, { allow });
      return;
    }
    try {
      switch (url.pathname) {
        case '/api/bootstrap':
          json(res, 200, {
            claudeVersion: await getClaudeVersion(),
            defaultCwd: os.homedir(),
            port: boundPort,
            platform, // 클라이언트가 네이티브 폴더 선택 버튼 노출 판단
          });
          return;
        case '/api/projects':
          json(res, 200, await listProjects(projectsRoot));
          return;
        case '/api/sessions':
          json(res, 200, await listSessions(projectsRoot, url.searchParams.get('dir')));
          return;
        case '/api/recent-sessions': {
          // 전 프로젝트 세션을 mtime순으로 집계 — 새 세션 모달의 "지난 세션" 목록.
          // limit: 생략 시 12, 비정수는 400(usage-daily와 동일 계약), 1..50 clamp.
          const rawLimit = url.searchParams.get('limit');
          let limit = 12;
          if (rawLimit != null) {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed)) {
              json(res, 400, { error: 'limit must be an integer' });
              return;
            }
            limit = Math.max(1, Math.min(50, parsed));
          }
          json(res, 200, await listRecentSessions(projectsRoot, limit));
          return;
        }
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
        case '/api/usage-daily': {
          // 사이드바 "돌아보기" 잔디용 일별 집계. days: 정수만 허용(그 외 400), 1..365 clamp.
          const raw = url.searchParams.get('days') ?? String(MAX_DAILY_DAYS);
          const parsed = Number(raw);
          if (!Number.isInteger(parsed)) {
            json(res, 400, { error: 'days must be an integer' });
            return;
          }
          const days = Math.max(1, Math.min(MAX_DAILY_DAYS, parsed));
          const today = new Date();
          const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          const key = `${days}:${dateKey}`;
          const hit = dailyCache.get(key);
          if (!hit || Date.now() - hit.at > DAILY_CACHE_MS) {
            const promise = aggregateDailyUsage(projectsRoot, Date.now(), days).catch((err) => {
              // 실패는 캐시하지 않는다 — 그 사이 설치된 새 캐시는 건드리지 않는다
              if (dailyCache.get(key)?.promise === promise) dailyCache.delete(key);
              throw err;
            });
            // 만료 키(지난 날짜·다른 창) 정리 — 맵이 자라기만 하지 않게
            for (const [k, v] of dailyCache) {
              if (Date.now() - v.at > DAILY_CACHE_MS) dailyCache.delete(k);
            }
            dailyCache.set(key, { at: Date.now(), promise });
          }
          json(res, 200, await dailyCache.get(key).promise);
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
      openSeq += 1;
      onClientCountChange?.(sockets.size);
      // 재접속 복구 — 원격 제어 상태는 세션별 링버퍼(attachReplay)에 없고
      // /api/bootstrap도 store로 흐르지 않으므로, 연결 직후 이 소켓에만 스냅샷을 준다.
      // 상태가 비어 있어도 보낸다: "아무것도 안 켜져 있음"도 복구해야 할 사실이다.
      sendTo(ws, remoteControlMessage());
      ws.on('close', () => {
        sockets.delete(ws);
        const mark = byeMarks.get(ws);
        // elapsed >= 0: 시계 역행 방어. seq === openSeq: bye 이후 새 연결이 없었어야 유효.
        const elapsed = mark !== undefined ? Date.now() - mark.at : NaN;
        const bye = mark !== undefined
          && elapsed >= 0 && elapsed <= byeMarkTtlMs
          && mark.seq === openSeq;
        onClientCountChange?.(sockets.size, { bye });
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

  // 멱등 종료. 원격 제어 자식을 **먼저** 확실히 정리한 뒤에 리스너를 놓는다 —
  // 순서가 바뀌면 데몬이 먼저 사라지고 자식이 고아로 남는다.
  //
  // 다만 그 대기에는 반드시 상한이 있어야 한다. 상한이 없으면 정리가 걸릴 때
  // "포트를 쥔 채 신원 파일도 없고 시그널에도 응답하지 않는" 데몬이 되어 사용자가
  // 손쓸 방법이 사라진다(codex 지적). 자식 하나를 놓치는 것보다 그쪽이 더 나쁘다 —
  // 상한을 넘기면 사유를 남기고 리스너를 놓는다.
  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await Promise.race([
          rc.closeAll(),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), closeRemoteGraceMs);
            t.unref?.();
          }).then((r) => {
            if (r === 'timeout') {
              console.error(
                '[cc-on-browser] 원격 제어 정리가 제한 시간을 넘겨 그대로 종료합니다 —'
                + ' `claude remote-control` 프로세스가 남았는지 확인해 주세요.',
              );
            }
          }),
        ]);
      } catch (err) {
        // 정리 실패를 삼키지 않는다 — 실패는 곧 "자식이 남았을 수 있다"는 뜻이다.
        console.error(`[cc-on-browser] 원격 제어 정리 실패: ${err?.message ?? err}`);
      }
      hub.stopAll();
      for (const ws of sockets) {
        try { ws.terminate(); } catch { /* noop */ }
      }
      sockets.clear();
      wss.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    })();
    return closing;
  };

  return {
    server,
    port: boundPort,
    token,
    close,
    getClaudeVersion,
    // 바인딩 래퍼로 노출 — private field 접근이 있는 메서드 참조를 그대로 넘기지 않는다.
    hasLiveSessions: () => hub.hasLiveSessions(),
    // 데몬 수명 정책이 "브라우저가 없어도 붙잡아 둘 일이 있는가"를 묻는 창구.
    hasLiveRemoteControls: () => rc.hasLive(),
  };
}
