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
  for (const { pid } of Object.values(servers)) {
    try { process.kill(pid); } catch { /* 이미 종료 */ }
  }
  rmSync(path.join(here, '.state'), { recursive: true, force: true });
}
