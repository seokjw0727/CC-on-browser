// E2E 전역 셋업 — fake CLI 스택 서버 3대(echo·permission·bulk)를 스폰한다.
// fake CLI의 시나리오는 서버 기동 시 고정되므로 시나리오별 서버가 필요하다.
// 수명주기 계약(설계도 §2): --port 0(OS 할당)으로 충돌 회피, stdout은 청크 누적
// 파싱으로 URL 획득, 준비 타임아웃·조기 종료 감지, 실패 시 이미 뜬 자식 정리.
// URL은 e2e/.state/servers.json 으로 worker에 전달한다(teardown이 삭제).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STATE_DIR = path.join(here, '.state');
const STATE_FILE = path.join(STATE_DIR, 'servers.json');
// 세션 히스토리 루트 — 반드시 격리한다. 서버 기본값은 사용자의 실제
// ~/.claude/projects라, 삭제를 다루는 테스트가 진짜 대화 기록을 지울 수 있다.
const PROJECTS_ROOT = path.join(STATE_DIR, 'projects');
// Claude Code 설정 편집기가 다룰 파일 — 반드시 격리한다. 서버 기본값은 사용자의
// 실제 ~/.claude/settings.json이라, 저장을 다루는 테스트가 진짜 CLI 설정을 덮어쓴다.
const CLAUDE_CONFIG = path.join(STATE_DIR, 'claude-config', 'settings.json');
// preview 시나리오가 **실제 파일**을 쓰는 작업 디렉터리 — 레포가 아니라 테스트 소유
// 임시 디렉터리여야 한다(teardown이 .state를 통째로 지운다).
const PREVIEW_CWD = path.join(STATE_DIR, 'preview-cwd');
const READY_TIMEOUT_MS = 30_000;

// 가짜 트랜스크립트 씨앗 — history.js의 파싱 규칙(cwd는 아무 줄의 cwd 필드,
// 제목은 첫 비-meta user 메시지)에 맞춘 최소 형태. 정렬은 mtime 기준이므로
// 파일 쓰기 순서가 아니라 utimes로 명시한다(파일시스템 타임스탬프 해상도 무관).
// cwd는 반드시 실재하는 디렉터리여야 한다 — 재개는 그 경로를 작업 디렉터리로
// CLI를 스폰하므로, 가짜 경로를 넣으면 spawn이 ENOENT로 죽는다.
const SEED_SESSIONS = [
  { dirName: 'e2e-seed-alpha-dir', rel: '.', sessionId: 'e2e-seed-alpha', title: 'E2E 씨앗 알파', ageMs: 60_000 },
  { dirName: 'e2e-seed-beta-dir', rel: 'client', sessionId: 'e2e-seed-beta', title: 'E2E 씨앗 베타', ageMs: 120_000 },
];

function seedProjects() {
  const now = Date.now();
  for (const seed of SEED_SESSIONS) {
    const s = { ...seed, cwd: path.resolve(root, seed.rel) };
    const dir = path.join(PROJECTS_ROOT, s.dirName);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${s.sessionId}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'summary', cwd: s.cwd, sessionId: s.sessionId }),
        JSON.stringify({ type: 'user', cwd: s.cwd, message: { role: 'user', content: s.title } }),
      ].join('\n') + '\n',
    );
    const t = new Date(now - s.ageMs);
    utimesSync(file, t, t);
  }
}

function startFakeServer(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'dev-fake.mjs'), '--port', '0', '--scenario', scenario],
      {
        cwd: root,
        // FAKE_PLATFORM=linux: Windows에서도 cwd 직접 입력 UI를 띄워 네이티브
        // 폴더 대화상자 없이 자동화한다(dev-fake → startServer platform 주입).
        // FAKE_PROJECTS_ROOT: 히스토리 루트를 테스트 소유 임시 디렉터리로 격리.
        env: {
          ...process.env,
          FAKE_PLATFORM: 'linux',
          FAKE_PROJECTS_ROOT: PROJECTS_ROOT,
          // 설정 편집 테스트가 실제 ~/.claude/settings.json을 건드리지 않게 한다.
          FAKE_CLAUDE_CONFIG: CLAUDE_CONFIG,
          // bulk 시나리오의 한 턴 분량 — 채팅 윈도잉(기본 창 200)의 경계를 넘겨야
          // "창 상한 · 더 보기 · 모두 불러오기"를 관측할 수 있다.
          FAKE_BULK_COUNT: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let out = '';
    let errOut = '';
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 이미 죽었으면 무시 */ }
      reject(new Error(`[e2e] ${scenario} 서버 기동 실패: ${msg}\nstdout:\n${out}\nstderr:\n${errOut}`));
    };
    const timer = setTimeout(() => fail(`${READY_TIMEOUT_MS}ms 내 URL 미출력`), READY_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d; // 청크 분할 대비 누적 후 매번 재검사
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ scenario, url: m[0], pid: child.pid });
      }
    });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => { clearTimeout(timer); fail(String(e?.message ?? e)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(`준비 전 조기 종료 (exit ${code})`);
    });
  });
}

async function reclaimStaleServers() {
  if (!existsSync(STATE_FILE)) return;
  let stale = {};
  try {
    stale = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return; // 손상된 파일 — 신원 확인 불가, 삭제만 한다
  }
  for (const { url, pid } of Object.values(stale)) {
    const m = String(url ?? '').match(/^http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]+)$/);
    if (!m || !Number.isInteger(pid)) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${m[1]}/api/bootstrap`, {
        headers: { 'x-auth-token': m[2] },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) process.kill(pid);
    } catch { /* 응답 없음 = 이미 죽었거나 다른 프로세스 — 건드리지 않는다 */ }
  }
}

export default async function globalSetup() {
  if (!existsSync(path.join(root, 'client', 'dist', 'index.html'))) {
    throw new Error('[e2e] client/dist가 없습니다. 먼저 빌드하세요: npm run build');
  }
  // 이전 비정상 종료의 stale 서버 회수 — 기록된 pid는 재사용됐을 수 있으므로
  // 무조건 kill하지 않고, 저장된 URL의 토큰으로 /api/bootstrap이 200을 주는
  // 경우(= 그 토큰을 아는 우리 dev-fake가 확실)에만 종료한다(codex 지적).
  await reclaimStaleServers();
  // teardown과 같은 이유로 재시도한다 — 직전 실행의 CLI가 .state 안 cwd를 놓는 데
  // 시간이 걸리면 Windows에서 EPERM이 나고, 그러면 셋업 자체가 죽는다.
  rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  // 서버를 띄우기 전에 시딩 — 첫 요청부터 목록이 결정적이어야 한다.
  seedProjects();
  // preview 시나리오가 파일을 쓸 격리 cwd. 스펙이 이 경로를 cwd 입력란에 넣는다.
  mkdirSync(PREVIEW_CWD, { recursive: true });
  const started = [];
  try {
    for (const scenario of ['echo', 'permission', 'bulk', 'bgtask', 'preview']) {
      started.push(await startFakeServer(scenario));
    }
    // 상태 기록 실패도 같은 정리 범위 — 서버만 남고 파일이 없는 상태를 만들지 않는다.
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(
      {
        ...Object.fromEntries(started.map((s) => [s.scenario, { url: s.url, pid: s.pid }])),
        // 스펙이 cwd 입력란에 넣을 경로 — 서버 목록과 같은 파일로 전달한다.
        previewCwd: PREVIEW_CWD,
      },
      null,
      2,
    ));
  } catch (err) {
    for (const s of started) {
      try { process.kill(s.pid); } catch { /* 이미 종료 */ }
    }
    throw err;
  }
}
