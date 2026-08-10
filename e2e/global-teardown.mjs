// E2E 전역 정리 — global-setup이 띄운 fake 서버들을 종료하고 상태 파일을 지운다.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, '.state', 'servers.json');

export default async function globalTeardown() {
  if (!existsSync(STATE_FILE)) return;
  let servers = {};
  try {
    servers = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { /* 손상된 상태 파일 — 지우기만 한다 */ }
  for (const entry of Object.values(servers)) {
    // 상태 파일에는 서버 항목 외에 경로 문자열(previewCwd)도 들어 있다.
    if (!entry || typeof entry !== 'object') continue;
    try { process.kill(entry.pid); } catch { /* 이미 종료 */ }
  }
  // Windows에서는 프로세스의 현재 디렉터리가 그 폴더를 잠근다. preview 시나리오의
  // CLI가 .state 안을 cwd로 쓰므로, 방금 죽인 프로세스가 완전히 사라질 때까지
  // 잠깐 재시도한다(그러지 않으면 EPERM으로 정리가 실패한다).
  //
  // 그래도 잠겨 있으면 경고만 남기고 넘어간다 — 정리 실패는 테스트 결과가 아니고,
  // 다음 실행의 global-setup이 같은 재시도로 .state를 통째로 다시 지운다.
  // 여기서 던지면 전부 통과한 실행이 exit 1로 뒤집힌다.
  //
  // 다만 삼키는 것은 "잠겨 있다"는 뜻의 오류뿐이다 — 그 밖의 실패는 조용히 넘기면
  // 정리가 된 것처럼 보이면서 상태가 남는다.
  const LOCKED = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
  try {
    rmSync(path.join(here, '.state'), {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (err) {
    if (!LOCKED.has(err?.code)) throw err;
    console.warn(
      `[e2e] .state 정리를 건너뜁니다(${err.code}) — 다음 실행의 셋업이 다시 시도합니다.`,
    );
  }
}
