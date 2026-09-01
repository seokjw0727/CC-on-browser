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
import { listProjects, listSessions, loadTranscript, listRecentSessions, deleteSession } from './history.js';
import { listDirs, pickDirectory, searchFiles } from './fs-api.js';
import {
  attachSessions, collectBranch, collectWorktrees, unavailableBranch, unavailableResult,
} from './git-api.js';
import { aggregateDailyUsage, aggregateUsage, MAX_DAILY_DAYS } from './usage.js';
import { defaultConfigPath, readClaudeConfig, writeClaudeConfig } from './claude-config.js';
import { defaultPluginsDir, listInstalledPlugins } from './claude-plugins.js';
import { fetchQuota } from './quota.js';
import { canonicalCwdSync, createRemoteControl } from './remote-control.js';
import { createPreviewApi, PREVIEW_PREFIX } from './preview-api.js';
import { cleanupStalePasteDirs, listClipboardFiles, saveClipboardFile } from './attachments.js';

const VERSION_TIMEOUT_MS = 3_000;
// close()가 원격 제어 자식 정리를 기다리는 상한. remote-control.js의 stop 유예
// (기본 5초 × 2단계)보다 넉넉하되, 사용자가 체감할 만큼 길지는 않게.
const CLOSE_REMOTE_GRACE_MS = 12_000;
// close()가 CLI 세션 종료를 기다리는 상한. ClaudeSession.terminate의 내부 유예
// (우아한 종료 3초 + 강제 킬 확인 2초)보다 넉넉하게 잡는다 — 상한이 강제 킬보다
// 먼저 걸리면 "기다렸다"는 사실만 남고 고아는 그대로 남아, 이 기능이 무의미해진다.
const CLOSE_SESSIONS_GRACE_MS = 10_000;
// worktree 패널이 세션을 배정할 때 훑는 최근 세션 수. listRecentSessions는 상위 N개에
// 대해서만 파일 머리를 읽어 cwd를 뽑으므로(비용이 N에 비례) 상한을 둔다. 새 세션 모달의
// "더 보기"(50)보다 살짝 넉넉하게 잡아, worktree가 여럿인 프로젝트에서도 각 카드에
// 최소 몇 개씩은 걸리게 한다.
const WORKTREE_RECENT_SESSIONS = 60;
const USAGE_CACHE_MS = 30_000;
const QUOTA_CACHE_MS = 60_000;
// 일별 집계(돌아보기 잔디)는 최대 1년치 스캔이라 5h/7d보다 캐시를 길게 둔다
const DAILY_CACHE_MS = 5 * 60_000;
// --effort 허용값 (claude --help 실측)
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// npm 레지스트리의 dist-tag 'latest' 문서. 서버가 내는 **두 번째** 외부 요청이다 —
// 다른 하나는 quota.js의 api.anthropic.com 사용률 조회로, 그쪽은 /api/usage 폴링을
// 타고 자동으로 나간다. 이쪽은 사용자가 버튼을 눌렀을 때만 나가는 유일한 요청이며,
// 보내는 것은 이 URL의 GET 한 줄뿐이다(토큰·세션·경로·설치 식별자를 싣지 않는다).
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/cc-on-browser/latest';
// 사용자가 버튼을 누르고 기다리는 전경 요청이라 quota(4s)보다 살짝 길게 잡되,
// 행 걸린 네트워크가 설정 모달을 붙잡지 않도록 상한은 반드시 둔다.
const UPDATE_TIMEOUT_MS = 5_000;
// **성공만** 이만큼 캐시한다. 실패를 캐시하면 잠깐 오프라인이었다는 이유로 한 시간
// 동안 '확인 실패'가 굳어, 사용자가 다시 눌러도 아무 일도 일어나지 않는다.
const UPDATE_CACHE_MS = 60 * 60_000;

/**
 * 노력 수준 인자 검증 — start(스폰)와 setEffort(런타임) 공용.
 * 반환: {error} 또는 {effort, ultracode}.
 *
 * 이 검증이 유일한 방어선이다(v2.1.233 실측): CLI는 런타임 채널
 * (apply_flag_settings)의 effortLevel을 전혀 검증하지 않고 무효값에도 success를
 * 돌려주며, 스폰 --effort 무효값은 경고만 내고 조용히 기본 노력으로 대체한다.
 * ultracode는 엄격 boolean만 받는다 — 'false' 같은 문자열이 truthy로 새지 않도록.
 */
function readEffortArgs(msg) {
  const effort = msg.effort ?? null;
  if (effort !== null && !EFFORT_LEVELS.has(effort)) {
    return { error: `invalid effort: ${JSON.stringify(msg.effort)}` };
  }
  const raw = msg.ultracode;
  if (raw != null && typeof raw !== 'boolean') {
    return { error: `invalid ultracode: ${JSON.stringify(raw)}` };
  }
  return { effort, ultracode: raw === true };
}
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

/**
 * 레지스트리가 말하는 최신 배포 버전. 성공 판정은 **HTTP 200 AND version이 비지 않은
 * 문자열**뿐이고, 그 밖(타임아웃·네트워크 오류·비200·JSON 아님·version이 문자열이
 * 아님)은 전부 null이다 — 부가 기능이라 어떤 실패도 사용자에게 원문 오류를 보일
 * 이유가 없고, 원문을 흘리면 응답이 실패 종류마다 달라져 UI가 분기를 떠안는다.
 * redirect는 명시 차단한다: 이 GET에 추종이 필요 없고, 모르는 호스트로 끌려가는
 * 것이 '확인 실패'보다 나쁘다(quota.js와 같은 선택).
 */
async function fetchLatestVersion(fetchFn) {
  let res;
  try {
    res = await fetchFn(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  // res.ok(200~299)가 아니라 정확히 200만 받는다 — 이 엔드포인트가 본문을 싣고
  // 돌려주는 응답은 200뿐이고, 204·206 같은 나머지 2xx는 "성공했지만 읽을 것이
  // 없다"라서 아래 json()에서 어차피 터진다. 여기서 거르면 실패 경로가 하나로 모인다.
  if (!res || res.status !== 200) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const latest = body?.version;
  return typeof latest === 'string' && latest ? latest : null;
}

// /api/* 경로별 허용 메서드. 405의 Allow 헤더와 "이 메서드를 받아 주는가" 판정이 같은
// 표에서 나와야 둘이 어긋나지 않는다 — 표에 없는 경로는 지금까지처럼 GET 전용이다.
const API_METHODS = {
  '/api/sessions': ['GET', 'DELETE'],
  '/api/claude-config': ['GET', 'PUT'],
  '/api/clipboard-files': ['POST'],
  '/api/paste-file': ['POST'],
  '/api/shutdown-if-idle': ['POST'],
};

export async function startServer({
  port = 8787,
  host = '127.0.0.1',
  token,
  cliPath,
  cliArgsPrefix = [],
  projectsRoot,
  // CLI가 세션 이름을 적어 두는 디렉터리(기본 ~/.claude/sessions) — 테스트 주입용.
  // 세션 목록과 라이브 세션의 cliName이 모두 여기서 나온다(cli-session-names.js).
  sessionsRoot,
  // 우리가 본 CLI 세션 이름을 적어 두는 파일. **기본 꺼짐**이고 앱 진입점
  // (bin/cc-on-browser.mjs)만 defaultNameStoreFile()로 켠다 — pasteCleanup과 같은 선택이다.
  // 켜져 있으면 startServer를 띄우는 것만으로 사용자 홈에 파일이 생기므로, 부수효과를
  // 갖는 쪽이 옵트인해야 한다. 끝난 CLI가 자기 이름 파일을 지우기 때문에, 이것이 꺼져
  // 있으면 지난 세션 목록의 cliName은 언제나 null이다(cli-session-names.js 머리말).
  nameStoreFile,
  staticDir,
  exitedRetentionMs,
  quotaFetcher, // 테스트 주입용 — 기본은 quota.js의 공식 사용률 조회
  // 테스트 주입용 — 전역 fetch와 같은 시그니처. 통합 테스트가 registry.npmjs.org로
  // 실제로 나가지 않게 하는 유일한 창구다. 여기가 fetchLatestVersion 자체가 아니라
  // fetch인 이유: 비200·형식 불일치 같은 '수용 기준' 분기를 가짜가 대신 판정해
  // 버리면 테스트가 코드가 아니라 가짜를 검증하게 된다.
  registryFetch = fetch,
  // 이 서버가 보고할 자기 버전(/api/bootstrap). 클라이언트 번들이 자기 빌드 버전과
  // 견줘 "구 데몬 + 새 번들" 스큐를 알아채는 데 쓴다 — 그 상태에서는 새로 생긴 WS
  // 메시지가 unknown message type으로 튕긴다. 모르면 null(구버전과 구분되지 않는다).
  version = null,
  // 유휴일 때 이 데몬을 내려도 되는가 — bin이 자기 shutdown()을 건다.
  // 없으면 /api/shutdown-if-idle은 501로 거절한다(그 판단은 프로세스 주인의 몫).
  onShutdownRequest,
  onClientCountChange, // WS 클라이언트 수 변화 알림 — bin이 브라우저 생존 신호로 쓴다.
  // 계약: 연결(open) 시 (count) 단항 호출, 종료(close) 시 (count, {bye}) —
  // bye는 "이 소켓이 bye 신호 후 TTL 내에 닫혔는가"(의도적 탭 닫힘 판별, lifecycle.js 참조).
  byeMarkTtlMs = BYE_MARK_TTL_MS, // 테스트 주입용
  directoryPicker, // 테스트 주입용 — 기본은 fs-api.js의 네이티브 폴더 선택 대화상자
  platform = process.platform, // 테스트 주입용 — E2E가 비-Windows UI(cwd 직접 입력 폴백)를 강제
  remoteControl, // 테스트 주입용 — 기본은 remote-control.js의 실제 자식 프로세스 관리자
  closeRemoteGraceMs = CLOSE_REMOTE_GRACE_MS, // 테스트 주입용 — 정리 대기 상한
  closeSessionsGraceMs = CLOSE_SESSIONS_GRACE_MS, // 테스트 주입용 — 세션 종료 대기 상한
  // 설정 편집 API가 다루는 유일한 파일. 기본은 사용자 전역 ~/.claude/settings.json이며,
  // 테스트는 임시 경로를 주입해 실제 홈 설정을 절대 건드리지 않는다.
  claudeConfigPath = defaultConfigPath(),
  // 설치된 플러그인 목록을 읽는 디렉터리(읽기 전용). 기본은 ~/.claude/plugins.
  claudePluginsDir = defaultPluginsDir(),
  previewApi, // 테스트 주입용 — 기본은 preview-api.js의 티켓 저장소(시계·TTL 실제값)
  // 테스트 주입용 — 기본은 attachments.js의 실제 구현. 주입하면 실제 OS 클립보드
  // (PowerShell)와 공용 tmp의 붙여넣기 폴더를 건드리지 않는다.
  attachmentsApi,
  // 기동 시 지난 실행이 남긴 붙여넣기 임시 폴더를 청소할지. **기본 꺼짐**이고 앱
  // 진입점(bin/cc-on-browser.mjs)만 켠다 — 켜져 있으면 startServer를 띄우는 것만으로
  // 사용자 %TEMP%의 파일이 지워져, 테스트가 개발자 머신의 어제 붙여넣기를 날린다.
  // 부수효과를 갖는 쪽이 옵트인해야 한다.
  pasteCleanup = false,
} = {}) {
  if (!token) throw new TypeError('token is required');
  if (!cliPath) throw new TypeError('cliPath is required');

  const hub = new SessionHub({ cliPath, cliArgsPrefix, exitedRetentionMs, sessionsRoot, nameStoreFile });
  // 목록 endpoint와 hub가 **같은 저장소**를 봐야 라이브에서 본 이름이 지난 세션 목록에
  // 그대로 나타난다 — 한 벌로 묶어 두 endpoint에 같은 값을 넘긴다.
  const nameStore = { storeFile: nameStoreFile };
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
  let updateCache = { at: 0, promise: null };
  // `${days}:${로컬 YYYY-MM-DD}` -> { at, promise } — 키에 날짜를 넣어 자정 직후
  // 어제 캐시가 오늘 시계열로 오인되는 것을 차단(설계도 §2 server.js).
  const dailyCache = new Map();
  const getQuota = quotaFetcher ?? fetchQuota;
  const pickDir = directoryPicker ?? pickDirectory;
  // 결과물 미리보기 — 티켓 발급/서빙. 읽기 범위는 라이브 세션 cwd 안으로 제한된다.
  const preview = previewApi ?? createPreviewApi({ platform });
  // 붙여넣기 첨부 — OS 클립보드의 파일 경로 조회와 비트맵 임시 저장.
  const attachments = attachmentsApi
    ?? { cleanupStalePasteDirs, listClipboardFiles, saveClipboardFile };

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
    // 세션이 끝나면 그 세션이 발급한 미리보기 티켓도 즉시 무효화한다 — 티켓의 유효
    // 범위는 "라이브 세션의 작업 디렉터리"이므로, 세션이 사라진 뒤에도 TTL까지
    // 살아 있으면 그 계약이 깨진다.
    if (msg?.type === 'exit') preview.revokeSession(msg.key);
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
      // remote-control.js와 **같은 함수**를 쓴다 — 다른 realpath 구현을 쓰면
      // win32의 8.3 단축명에서 문자열이 갈려 매칭이 통째로 실패한다.
      return foldCase(canonicalCwdSync(p));
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
  const cwdsForCwd = (canonical) => {
    // keysForCwd와 **같은 정규화**를 써야 한다. canonicalOf는 win32에서 대소문자를
    // 접어 돌려주는데 canonical(관리자의 cwd)은 원래 표기 그대로라, 접지 않고 비교하면
    // win32에서 이 목록이 항상 비고 "세션이 먼저 끝난 원격 제어를 끄는" 경로가 죽는다.
    const want = foldCase(canonical);
    return [...new Set(hub.allSessionCwds().filter((p) => canonicalOf(p) === want))];
  };

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

  // reqId: 요청-응답을 짝지어야 하는 창구(setEffort)의 상관자 — 없으면 null.
  const sendError = (ws, { key = null, startId = null, reqId = null, message }) => {
    sendTo(ws, { type: 'error', key, startId, reqId, message: String(message) });
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
          const args = readEffortArgs(msg);
          if (args.error) {
            sendError(ws, { startId, message: args.error });
            return;
          }
          try {
            const { key: newKey, initInfo, effort, ultracode } = await hub.startSession({
              cwd: msg.cwd,
              model: msg.model,
              permissionMode: msg.permissionMode,
              effort: args.effort,
              // ultracode는 스폰 플래그가 없어 initialize 직후 런타임 채널로 얹힌다
              // (ClaudeSession.start 참조).
              ultracode: args.ultracode,
              resumeSessionId: msg.resumeSessionId,
            });
            sendTo(ws, { type: 'started', startId, key: newKey, initInfo });
            // 이름 조회는 init 이벤트에서 시작되므로 여기 오기 전에 끝났을 수 있고,
            // 그때의 방송은 아직 이 세션을 모르는 탭에서 버려진다. started 바로 뒤에
            // 한 번 더 보내 그 창을 메운다(codex 지적) — 늦게 끝난 조회는 방송이 맡는다.
            const named = hub.cliNameOf(newKey);
            if (named) {
              sendTo(ws, {
                type: 'sessionName',
                key: newKey,
                sessionId: named.sessionId,
                cliName: named.cliName,
              });
            }
            // 시작 시점의 실효 노력 수준을 같은 창구(effortSet)로 알린다 — ultracode를
            // 요청했는데 얹지 못한 세션(구버전 CLI·미지원 모델)에서 UI만 울트라코드로
            // 남는 것을 막는다. 성공한 경우엔 클라이언트가 이미 표시하던 값과 같아
            // 아무 변화도 만들지 않는다.
            broadcast({ type: 'effortSet', key: newKey, effort, ultracode });
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
        case 'setModel': {
          // 모델 런타임 변경 — CLI의 control 응답을 확인한 **뒤에만** 성공을 알린다.
          // 예전에는 아무 ack도 보내지 않아, 클라이언트가 전송 성공만 보고 낙관적으로
          // 피커를 바꿨다: CLI가 거부한 모델(인식 불가 id·조직 제한·consent 미승인)에서
          // 화면만 새 모델로 남아 실제 세션과 어긋났다. setEffort와 같은 reqId 규약으로
          // 성공은 전 소켓 방송(다른 탭도 같이 맞춰진다), 실패는 요청 소켓에만 돌려준다.
          const reqId = msg.reqId ?? null;
          const model = typeof msg.model === 'string' ? msg.model : null;
          if (!model) {
            sendError(ws, { key, reqId, message: `invalid model: ${JSON.stringify(msg.model)}` });
            return;
          }
          try {
            await hub.setModel(key, model);
          } catch (err) {
            // 바깥 catch로 새면 reqId가 빠져 요청자가 자기 요청의 결론으로 짝지을 수 없다.
            sendError(ws, { key, reqId, message: err?.message ?? err });
            return;
          }
          // reqId 없이 온 요청(구버전 클라이언트)도 방송한다 — reqId:null이라 대기표를
          // 결착시키지 않고, 그쪽은 예전처럼 낙관 갱신으로 동작한다(추가 전용 프로토콜).
          broadcast({ type: 'modelSet', key, reqId, model });
          return;
        }
        case 'setPermissionMode':
          await hub.setPermissionMode(key, msg.mode);
          return;
        case 'setEffort': {
          // 노력 수준 런타임 변경 — 성공하면 세션 재시작 없이 적용된다.
          // 이 ack(effortSet)를 못 받은 클라이언트는(구버전 CLI의 error 또는 타임아웃)
          // 예전 방식인 --resume 재시작으로 폴백한다.
          //
          // reqId는 성공·실패 어느 경로로든 그대로 되돌려준다 — 성공은 전 소켓 방송이고
          // 실패는 일반 error 프레임이라, 이 상관자가 없으면 클라이언트가 남의 탭의
          // 성공이나 무관한 error를 자기 요청의 결론으로 오인한다(codex 지적).
          const reqId = msg.reqId ?? null;
          const args = readEffortArgs(msg);
          if (args.error) {
            sendError(ws, { key, reqId, message: args.error });
            return;
          }
          try {
            await hub.setEffort(key, args.effort, args.ultracode);
          } catch (err) {
            sendError(ws, { key, reqId, message: err?.message ?? err });
            return;
          }
          broadcast({
            type: 'effortSet', key, reqId, effort: args.effort, ultracode: args.ultracode,
          });
          return;
        }
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
          // CLI 세션 이름은 링버퍼에 없다(session-hub.#refreshCliName 참조) — 재접속한
          // 탭이 이름을 잃지 않도록 여기서 한 번 더 보낸다.
          if (replay.cliName) {
            sendTo(ws, {
              type: 'sessionName',
              key,
              sessionId: replay.cliNameSessionId,
              cliName: replay.cliName,
            });
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
          // reqId를 되돌려준다 — 이 프레임을 받는 쪽은 대개 "구 데몬에 새 클라이언트"라,
          // 상관자가 없으면 요청자가 ack 타임아웃(5초)을 기다린 뒤에야 폴백을 고른다.
          // 지금 이 서버는 setEffort를 알지만, 다음 스큐에서 같은 일이 반복되지 않도록
          // 미지의 메시지에도 상관자를 실어 보낸다.
          sendError(ws, {
            key,
            reqId: msg.reqId ?? null,
            message: `unknown message type: ${msg.type}`,
          });
      }
    } catch (err) {
      sendError(ws, { key, message: err?.message ?? err });
    }
  }

  // 요청 본문(JSON) 읽기 — 쓰기 API(PUT /api/claude-config, POST /api/paste-file)용.
  // 상한을 두는 이유: 로컬 도구라도 무한정 버퍼링하면 메모리로 서버를 죽일 수 있다.
  const MAX_BODY_BYTES = 1024 * 1024; // 1MB — settings.json에는 과분한 여유
  // 붙여넣기 업로드만 예외적으로 크다. 상한은 **경로별**로 준다 — 기본값을 올리면
  // 설정 저장 창구까지 32MB를 버퍼링하게 되어, 상한을 둔 이유가 사라진다.
  // 20MB 바이너리가 base64로 약 4/3배 부풀고 JSON 이스케이프가 더 얹히는 몫까지 여유.
  const MAX_PASTE_BODY_BYTES = 32 * 1024 * 1024;
  function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          // 소켓을 여기서 끊지 않는다 — 응답(413)을 먼저 내보내야 클라이언트가
          // 네트워크 오류가 아니라 이유를 받는다. 정리는 호출측이 응답 후에 한다.
          req.pause();
          reject(Object.assign(new Error('request body too large'), { code: 'EPAYLOAD' }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(new Error('request body must be a JSON object'));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`invalid request body: ${err.message}`));
        }
      });
      req.on('error', reject);
    });
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

  // PUT /api/claude-config — 본문 {content, expectedMtimeMs}로 설정 파일을 교체.
  // 잘못된 JSON·형식은 400, 다른 곳에서 수정됐으면 409, 파일시스템 오류는 500.
  async function handleWriteConfig(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err?.code === 'EPAYLOAD') {
        json(res, 413, { error: String(err.message) });
        // 응답을 다 내보낸 뒤에 남은 업로드를 끊는다.
        res.on('finish', () => req.destroy());
      } else {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    const { content, expectedMtimeMs } = body ?? {};
    if (typeof content !== 'string') {
      json(res, 400, { error: 'content must be a string' });
      return;
    }
    // 생략은 허용하지 않는다 — 빠뜨린 필드가 "파일 없음"(=새로 만들기)으로 해석되면
    // 실수로 기존 설정을 건너뛰고 덮어쓰는 요청이 만들어진다. 무한대·NaN도 거부.
    if (expectedMtimeMs !== null && !Number.isFinite(expectedMtimeMs)) {
      json(res, 400, { error: 'expectedMtimeMs must be a finite number or null' });
      return;
    }
    try {
      const { mtimeMs } = await writeClaudeConfig(content, expectedMtimeMs, claudeConfigPath);
      json(res, 200, { ok: true, mtimeMs });
    } catch (err) {
      if (err?.code === 'ECONFLICT') json(res, 409, { error: String(err.message) });
      else if (err?.code === 'EINVALIDCONFIG') json(res, 400, { error: String(err.message) });
      else json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // POST /api/paste-file — 본문 {name, data(원시 base64)}를 임시 폴더에 저장하고 절대경로 반환.
  // 스크린샷처럼 디스크에 실체가 없는 붙여넣기의 폴백 창구다(탐색기에서 복사한 파일은
  // /api/clipboard-files의 원본 경로를 쓴다). 저장 위치는 서버가 정한다 —
  // claude-config와 같은 원칙으로, 클라이언트가 주는 것은 이름과 바이트뿐이다.
  async function handlePasteFile(req, res) {
    let body;
    try {
      body = await readJsonBody(req, MAX_PASTE_BODY_BYTES);
    } catch (err) {
      if (err?.code === 'EPAYLOAD') {
        json(res, 413, { error: String(err.message) });
        // 응답을 다 내보낸 뒤에 남은 업로드를 끊는다(handleWriteConfig와 같은 처방).
        res.on('finish', () => req.destroy());
      } else {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    try {
      const saved = await attachments.saveClipboardFile({ name: body?.name, data: body?.data });
      json(res, 200, { path: saved.path });
    } catch (err) {
      // EBADBODY = 클라이언트가 준 값이 base64가 아님, EPAYLOAD = 디코드 후 상한 초과.
      // 그 밖(디스크 가득·권한 거부)은 클라이언트 잘못이 아니므로 500으로 분류한다.
      if (err?.code === 'EBADBODY') json(res, 400, { error: String(err.message) });
      else if (err?.code === 'EPAYLOAD') json(res, 413, { error: String(err.message) });
      else json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  async function handleApi(req, res, url) {
    // 인증·Origin 검사가 먼저다 — 본문을 읽거나 파일에 손대기 전에 통과해야 한다.
    if (!originAllowed(req.headers.origin) || !tokenEquals(req.headers['x-auth-token'])) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/sessions') {
      await handleDeleteSession(res, url);
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/claude-config') {
      await handleWriteConfig(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clipboard-files') {
      // 본문 없는 POST다. GET이 아닌 이유는 부작용이 없어서가 아니라, 브라우저가
      // 링크·프리페치로 흘려보낼 수 있는 창구에 OS 클립보드 조회를 두지 않기 위해서다.
      let paths = [];
      try {
        paths = await attachments.listClipboardFiles({ platform });
      } catch {
        // 조회 실패(PowerShell 부재·타임아웃)는 오류가 아니라 "목록 없음"이다 —
        // 클라이언트는 빈 목록을 받으면 곧바로 업로드 폴백으로 넘어간다.
        paths = [];
      }
      json(res, 200, { paths });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/paste-file') {
      await handlePasteFile(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown-if-idle') {
      // 런처가 "구버전 데몬을 조용히 교체"할 때만 쓰는 창구. 안전 조건은 하나다:
      // **일하고 있으면 절대 내리지 않는다**. 살아있는 CLI 세션이나 원격 제어가
      // 하나라도 있으면 409로 거절하고, 런처는 그 데몬을 그대로 재사용한다.
      // (브라우저 탭 유무는 보지 않는다 — 탭은 곧 다시 열리므로 판단 근거가 아니다.)
      if (hub.hasLiveSessions() || rc.hasLive()) {
        json(res, 409, { error: 'busy', reason: 'live sessions or remote controls' });
        return;
      }
      if (typeof onShutdownRequest !== 'function') {
        json(res, 501, { error: 'shutdown not supported' });
        return;
      }
      // 응답을 먼저 흘려보내고 종료를 예약한다 — close()가 이 소켓까지 끊으므로
      // 순서를 뒤집으면 런처가 응답 대신 ECONNRESET을 본다.
      json(res, 200, { stopping: true });
      setTimeout(() => onShutdownRequest(), 0).unref?.();
      return;
    }
    // 여기까지 왔다면 이 경로가 받는 메서드가 아니다 — POST 전용 경로에 온 GET도 포함.
    const allowed = API_METHODS[url.pathname] ?? ['GET'];
    if (!allowed.includes(req.method)) {
      json(res, 405, { error: 'method not allowed' }, { allow: allowed.join(', ') });
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
            version, // 번들 버전과 견주기 위한 서버(데몬) 버전 — 없으면 null
          });
          return;
        case '/api/update-check': {
          // 사용자가 명시적으로 버튼을 눌렀을 때만 나가는 외부 요청이다(자동 조회 없음,
          // 설계도 §4). 브라우저가 직접 레지스트리를 치지 않고 서버를 거치는 이유는
          // CORS 회피와 "무엇이 밖으로 나가는가"의 창구를 한 곳으로 모으기 위함이다.
          if (!updateCache.promise || Date.now() - updateCache.at > UPDATE_CACHE_MS) {
            const promise = Promise.resolve()
              .then(() => fetchLatestVersion(registryFetch))
              .catch(() => null)
              .then((latest) => {
                // 실패는 캐시하지 않는다 — 단, 그 사이 들어선 새 캐시는 건드리지 않는다.
                if (latest == null && updateCache.promise === promise) {
                  updateCache = { at: 0, promise: null };
                }
                return latest;
              });
            updateCache = { at: Date.now(), promise };
          }
          const latest = await updateCache.promise;
          // current는 런처가 넘긴 패키지 버전이고 **null일 수 있다**. 그래도 200이다 —
          // 비교 가능 여부 판정은 클라이언트 몫이고, 서버는 무엇을 알아냈는지만 보고한다.
          json(res, 200, latest
            ? { latest, current: version }
            : { latest: null, current: version, error: 'update check failed' });
          return;
        }
        case '/api/projects':
          json(res, 200, await listProjects(projectsRoot));
          return;
        case '/api/sessions':
          json(res, 200, await listSessions(projectsRoot, url.searchParams.get('dir'), sessionsRoot, nameStore));
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
          json(res, 200, await listRecentSessions(projectsRoot, limit, sessionsRoot, nameStore));
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
        case '/api/preview-ticket': {
          // 결과물 미리보기 티켓 발급. 여기까지 온 요청은 이미 토큰·Origin 검사를
          // 통과했다. 경로 격리의 기준 cwd는 **클라이언트 말이 아니라** 서버의 세션
          // 장부에서 되찾는다(remote-control과 같은 원칙) — 라이브 세션이 아니면 404.
          const key = url.searchParams.get('key');
          const filePath = url.searchParams.get('path');
          try {
            const issued = await preview.issue({
              sessionKey: key,
              cwd: key ? hub.cwdOf(key) : null,
              filePath,
            });
            // 발급은 realpath/stat를 await하므로, 그 사이에 세션이 끝나면 exit 방송의
            // 폐기가 **삽입 전에** 지나가 죽은 세션의 티켓이 살아남는다(codex 지적).
            // 반환 직후 생존을 다시 확인하고, 아니면 방금 만든 티켓을 되돌린다.
            if (!key || !hub.cwdOf(key)) {
              preview.revoke(issued.ticket);
              json(res, 404, { error: 'session is not live' });
              return;
            }
            json(res, 200, issued);
          } catch (err) {
            // 예상한 실패(EPREVIEW*)는 자기 status를, 없는 파일은 404를 쓴다.
            // 그 밖의 파일시스템 오류(EACCES/EIO 등)는 클라이언트 잘못이 아니므로 500.
            const status = err?.status ?? (err?.code === 'ENOENT' ? 404 : 500);
            json(res, status, { error: String(err?.message ?? err) });
          }
          return;
        }
        case '/api/worktrees': {
          // git worktree 조회(읽기 전용). git을 **어느 디렉터리에서 돌릴지**는 클라이언트가
          // 아니라 서버가 정한다 — preview-ticket과 같은 원칙으로, 기준 cwd는 세션 key로
          // 서버 장부에서 되찾는다. 임의 경로 문자열을 받으면 이 창구가 "아무 디렉터리에서나
          // 하위 프로세스를 띄우는 창구"가 된다.
          const key = url.searchParams.get('key');
          const cwd = key ? hub.cwdOf(key) : null;
          if (!cwd) {
            // 라이브 세션이 아니다 — 실패가 아니라 "보여줄 것이 없는" 정상 상태다.
            json(res, 200, unavailableResult('no-session'));
            return;
          }
          const result = await collectWorktrees(cwd);
          // 세션 목록 조회가 실패해도 worktree 자체는 보여 준다. 이 블록이 던지면
          // 아래 공통 catch가 그것을 400("클라이언트 잘못")으로 보고하는데, 히스토리
          // 디렉터리를 못 읽은 것은 요청의 잘못이 아니다(codex 지적). 대신 세션 칸이
          // 비었다는 사실을 flag로 알려, 화면이 "세션 없음"과 혼동하지 않게 한다.
          result.sessionsUnavailable = false;
          if (result.available) {
            try {
              // 세션↔디렉터리 판정은 서버만 할 수 있다(realpath). 다만 최근 세션 목록은
              // mtime 상위 N개만 cwd를 읽으므로, 그보다 오래된 세션은 카드에 실리지 않는다 —
              // 이 패널은 "지금 무엇이 어디서 돌고 있나"를 보는 곳이라 그 절단을 감수한다.
              const recent = await listRecentSessions(
                projectsRoot, WORKTREE_RECENT_SESSIONS, sessionsRoot, nameStore,
              );
              attachSessions(result.worktrees, {
                // cliName을 함께 실어 준다 — 이 탭이 아직 모르는 세션(다른 탭에서 연
                // 세션, 동기화 전)도 사용자가 터미널에서 부르던 이름으로 보이게 하는
                // 유일한 경로다. 아직 이름이 없으면 null이고, 그때는 sessionId로 내려간다.
                live: hub.liveSessionCwds().map((s) => ({
                  ...s,
                  cliName: hub.cliNameOf(s.key)?.cliName ?? null,
                })),
                past: recent.filter((s) => !hub.isSessionIdLive(s.sessionId)),
              });
            } catch {
              result.sessionsUnavailable = true;
            }
          }
          json(res, 200, result);
          return;
        }
        case '/api/branch': {
          // 입력창 아래 브랜치 칩이 쓰는 경량 조회. /api/worktrees와 **기준 디렉터리를
          // 정하는 규칙은 같고**(세션 key → 서버 장부의 cwd), 값이 훨씬 싸다는 점만
          // 다르다. 이 창구가 있는 이유는 그 비용 차이 자체다 — 늘 떠 있는 라벨을
          // worktree 전경 조회로 채우면 세션을 옮길 때마다 저장소를 통째로 훑는다.
          const key = url.searchParams.get('key');
          const cwd = key ? hub.cwdOf(key) : null;
          if (!cwd) {
            json(res, 200, unavailableBranch('no-session'));
            return;
          }
          json(res, 200, await collectBranch(cwd));
          return;
        }
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
        case '/api/claude-plugins':
          // 설정 편집기의 "플러그인" 탭 재료 — 설치 목록만 읽는다(켬/끔은 settings.json).
          // 오류 분류를 여기서 끝내는 이유는 claude-config GET과 같다(아래 공통 catch의
          // "그 외 400"에 맡기면 권한·IO 오류가 클라이언트 잘못으로 보고된다).
          try {
            json(res, 200, await listInstalledPlugins(claudePluginsDir));
          } catch (err) {
            if (err?.code === 'EINVALIDPLUGINS') json(res, 400, { error: String(err.message) });
            else json(res, 500, { error: String(err?.message ?? err) });
          }
          return;
        case '/api/claude-config':
          // 설정 편집기(설정 → Claude Code Config)의 로드. 경로는 서버가 정한
          // 하나뿐이고, content는 원문 그대로 준다(사용자 포매팅·주석 없는 JSON 보존).
          // 오류 분류는 여기서 끝낸다 — 아래 공통 catch의 "그 외는 400"에 맡기면
          // 권한·IO 오류(EACCES/EPERM/EIO)가 클라이언트 잘못으로 보고된다.
          try {
            json(res, 200, await readClaudeConfig(claudeConfigPath));
          } catch (err) {
            if (err?.code === 'EINVALIDCONFIG') json(res, 400, { error: String(err.message) });
            else json(res, 500, { error: String(err?.message ?? err) });
          }
          return;
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

  // GET /preview/<ticket>/<relpath> — 티켓만으로 여는 미리보기 서빙.
  // 메인 토큰을 요구하지 않는다: 티켓 자체가 "이 디렉터리, 30분" 한정 capability이고,
  // iframe/img가 직접 여는 URL에 토큰을 실을 수 없기 때문이다(preview-api.js 서두 참조).
  //
  // 경로는 WHATWG URL이 정규화한 pathname이 아니라 **원본 요청 라인**에서 뽑는다.
  // new URL()은 '..'·'%2e%2e'·'\'를 미리 접어 버려서, 티켓 스코프 안으로 접히는
  // 상위 참조가 거부되지 않고 조용히 통과한다(codex 지적). 스코프 밖으로 나가는
  // 경우는 '/preview/' 접두사째 사라져 여기 오지도 않지만, 계약("상위 참조 거부")은
  // 원본 경로로 판정해야 실제로 성립한다.
  const PREVIEW_ERRORS = {
    EPREVIEWARG: [400, 'invalid preview path'],
    EPREVIEWTICKET: [404, 'preview link expired or unknown'],
    EPREVIEWTYPE: [415, 'not a previewable file'],
    EPREVIEWSIZE: [413, 'file is too large to preview'],
  };

  async function handlePreview(req, res, rawPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    try {
      await preview.serve(req, res, rawPath);
    } catch (err) {
      // 이 경로는 토큰이 아니라 티켓으로 열린다 — 원문 오류 메시지를 그대로 흘리면
      // 없는 하위 리소스 요청 하나로 세션 절대경로가 노출된다. 분류만 돌려준다.
      const mapped = PREVIEW_ERRORS[err?.code];
      const [status, message] = mapped
        ?? (err?.code === 'ENOENT'
          ? [404, 'not found']
          : err?.status === 409
            ? [409, 'file changed during read']
            : [500, 'internal error']);
      // iframe/fetch가 opaque origin에서 상태를 읽을 수 있게 성공과 같은 CORS 정책을
      // 오류에도 준다(없으면 네트워크 오류로만 보여 원인을 알 수 없다).
      json(res, status, { error: message }, { 'access-control-allow-origin': '*' });
    }
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
    // 정적 SPA fallback보다 **먼저** 가로챈다 — 만료·오작동 티켓이 index.html 200으로
    // 떨어지면 클라이언트가 실패를 성공으로 오인한다.
    //
    // 정규화 전 원본 경로(쿼리·프래그먼트 제외)로 판정한다. 절대 URL 형식으로 온
    // 요청은 그런 형태를 쓰지 않는 로컬 클라이언트가 아니므로 정규화된 값으로 폴백.
    // **라우팅도 원본으로** 해야 한다 — `/preview/<t>/%2e%2e/%2e%2e/x`처럼 정규화가
    // 접두사째 지워 버리는 요청이 미리보기 오류가 아니라 SPA 200으로 떨어지기 때문
    // (codex 지적). 둘 중 하나라도 미리보기 경로면 미리보기 처리기로 보낸다.
    const rawPath = req.url.startsWith('/') ? req.url.split(/[?#]/)[0] : url.pathname;
    if (rawPath.startsWith(PREVIEW_PREFIX) || url.pathname.startsWith(PREVIEW_PREFIX)) {
      handlePreview(req, res, rawPath).catch(() => {
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

  // 지난 실행이 남긴 붙여넣기 임시 폴더 청소. **기다리지 않는다** — 청소는 서버가
  // 준비됐는지와 아무 상관이 없고, tmp 트리 순회가 느린 날 브라우저를 붙잡을 이유가
  // 없다. 대신 catch를 반드시 달아 실패가 unhandled rejection으로 프로세스를 죽이지
  // 않게 한다(다음 기동에서 다시 시도하면 그만인 일이다).
  if (pasteCleanup) {
    Promise.resolve()
      .then(() => attachments.cleanupStalePasteDirs())
      .catch(() => { /* 청소 실패는 기능에 영향이 없다 */ });
  }

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
      // 종료 선언이 가장 먼저다 — 아래 원격 제어 정리를 기다리는 동안(최대 12초)
      // 시작된 세션은 stopAll()의 순회 밖에서 태어나 고아가 된다(codex 지적).
      hub.beginClosing();
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
      // CLI 세션도 **실제 사망을 확인할 때까지** 기다린다. 이걸 기다리지 않으면
      // 데몬이 먼저 process.exit()하고, Windows에서는 부모가 죽어도 자식이 살아남아
      // 진행 중이던 claude 프로세스가 그대로 계속 돈다(고아 — 토큰까지 소모한다).
      // 상한이 있는 이유는 원격 제어 쪽과 같다: 정리가 걸려도 손쓸 수 없는 데몬으로
      // 남지는 않아야 한다. 다만 그 상한은 강제 킬이 이미 발행된 뒤에 걸린다.
      try {
        const allDead = await Promise.race([
          hub.stopAll(),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), closeSessionsGraceMs);
            t.unref?.();
          }),
        ]);
        if (allDead !== true) {
          console.error(
            '[cc-on-browser] CLI 세션 정리를 확인하지 못한 채 종료합니다 —'
            + ' `claude` 프로세스가 남았는지 확인해 주세요.',
          );
        }
      } catch (err) {
        // 정리 실패를 삼키지 않는다 — 실패는 곧 "자식이 남았을 수 있다"는 뜻이다.
        console.error(`[cc-on-browser] CLI 세션 정리 실패: ${err?.message ?? err}`);
      } finally {
        // 어떤 실패에도 리스너는 반드시 놓는다 — 여기서 빠져나가지 못하면 포트를 쥔
        // 채 응답도 하지 않는 데몬이 되어 사용자가 손쓸 방법이 사라진다.
        for (const ws of sockets) {
          try { ws.terminate(); } catch { /* noop */ }
        }
        sockets.clear();
        wss.close();
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
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
