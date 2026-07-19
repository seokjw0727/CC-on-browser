// E2E 전역 셋업 — fake CLI 스택 서버 2대(echo·permission)를 스폰한다.
// fake CLI의 시나리오는 서버 기동 시 고정되므로 시나리오별 서버가 필요하다.
// 수명주기 계약(설계도 §2): --port 0(OS 할당)으로 충돌 회피, stdout은 청크 누적
// 파싱으로 URL 획득, 준비 타임아웃·조기 종료 감지, 실패 시 이미 뜬 자식 정리.
// URL은 e2e/.state/servers.json 으로 worker에 전달한다(teardown이 삭제).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STATE_DIR = path.join(here, '.state');
const STATE_FILE = path.join(STATE_DIR, 'servers.json');
const READY_TIMEOUT_MS = 30_000;

function startFakeServer(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'dev-fake.mjs'), '--port', '0', '--scenario', scenario],
      {
        cwd: root,
        // FAKE_PLATFORM=linux: Windows에서도 cwd 직접 입력 UI를 띄워 네이티브
        // 폴더 대화상자 없이 자동화한다(dev-fake → startServer platform 주입).
        env: { ...process.env, FAKE_PLATFORM: 'linux' },
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
  rmSync(STATE_DIR, { recursive: true, force: true });
  const started = [];
  try {
    for (const scenario of ['echo', 'permission']) {
      started.push(await startFakeServer(scenario));
    }
    // 상태 기록 실패도 같은 정리 범위 — 서버만 남고 파일이 없는 상태를 만들지 않는다.
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(
      Object.fromEntries(started.map((s) => [s.scenario, { url: s.url, pid: s.pid }])),
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
