// instance-file.js — "이 포트에서 지금 돌고 있는 데몬은 우리 것인가"를 판정하기 위한
// 신원 파일. bin(cc-on-browser.mjs)이 쓴다(lifecycle.js와 같은 런처 전용 모듈 계열).
//
// 왜 필요한가: 백그라운드 데몬은 브라우저를 닫은 뒤에도 잠시(의도적 닫힘 10초, 연결
// 유실이면 최대 30분, 살아있는 CLI 세션이 있으면 그보다 더) 포트를 잡고 있다. 그 동안
// 사용자가 cc-on-browser를 다시 실행하면 예전에는 "Port 8787 is already in use"로
// 죽었다 — 탐색기/바로가기 실행에서는 창만 깜빡이고 아무 일도 없는 것처럼 보인다.
// 이 파일이 있으면 부모는 "그 데몬이 우리 것"임을 확인하고 브라우저 탭만 새로 열 수 있다.
//
// 새 HTTP endpoint를 만들지 않는 이유: 인증 없는 /open 류 endpoint는 로컬 프로세스나
// 웹페이지가 마음대로 두드릴 수 있는 표면이 된다. 대신 이미 있는 인증 REST
// (/api/bootstrap)를 이 파일의 토큰으로 두드려 신원을 확인한다.
//
// 보안 경계: 파일에는 로컬 API 토큰이 들어간다. 디렉터리 0700 / 파일 0600으로 만들지만
// Windows에서 Node의 mode 비트는 기밀성 ACL을 설정하지 않으므로, 실질 보호는 사용자
// 프로필의 상속 ACL에 의존한다(~/.claude의 CLI 자격증명과 같은 신뢰 경계). 토큰이
// 프로필 밖에 영구 저장되거나 외부 호스트로 전송되는 일은 없다. SECURITY.md 참조.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const INSTANCE_DIR_NAME = '.cc-on-browser';

/** 신원 파일을 담는 디렉터리 — 홈 기준(테스트는 homeDir를 주입). */
export function instanceDir(homeDir = os.homedir()) {
  return path.join(homeDir, INSTANCE_DIR_NAME);
}

/**
 * 포트별 신원 파일 경로. port 0(OS 할당)은 파일 키가 성립하지 않아 null —
 * 호출자는 이때 기록·재사용을 모두 건너뛴다(랜덤 포트 데몬 여럿이 같은 파일을
 * 두고 다투거나, 다음 --port 0 실행이 엉뚱한 데몬을 찾는 것을 원천 차단).
 */
export function instancePath(port, homeDir = os.homedir()) {
  if (!Number.isInteger(port) || port <= 0) return null;
  return path.join(instanceDir(homeDir), `instance-${port}.json`);
}

// write~rename 사이에 프로세스가 강제 종료되면 토큰을 담은 tmp가 남을 수 있다.
// 발행에 성공한 직후 같은 포트의 오래된 잔여 tmp를 쓸어낸다. 진행 중인 다른
// 프로세스의 tmp를 지워 그쪽 rename을 깨뜨리지 않도록 충분히 오래된 것만 건드린다
// (그 경우에도 상대는 false를 받고 신원 파일 없이 계속 돌 뿐이라 치명적이지 않다).
const STALE_TMP_MS = 60_000;

function sweepStaleTmp(dir, file, now = Date.now()) {
  const prefix = `${path.basename(file)}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs >= STALE_TMP_MS) fs.unlinkSync(p);
    } catch {
      /* 경합으로 이미 사라졌거나 못 지워도 무시 */
    }
  }
}

/**
 * 신원 파일 기록 — tmp 파일에 쓴 뒤 rename으로 발행한다. 부분 기록된 JSON을 다른
 * 프로세스가 읽는 창을 만들지 않기 위해서다(rename은 같은 볼륨에서 교체가 원자적 —
 * Windows도 Node/libuv가 replace 의미로 처리한다). fsync는 하지 않는다: 이 파일은
 * "지금 이 데몬이 살아 있다"는 휘발성 사실이라 전원 장애 후 남아 있을 필요가 없다.
 * 실패는 조용히 false: 신원 파일은 편의 기능이라 데몬 기동을 막아선 안 된다.
 * @param {{port:number, token:string, pid?:number, version?:string}} record
 * @returns {boolean} 기록 성공 여부
 */
export function writeInstanceFile(record, homeDir = os.homedir()) {
  const file = instancePath(record?.port, homeDir);
  if (!file || !record?.token) return false;
  const dir = path.dirname(file);
  // 같은 프로세스가 여러 번 써도 충돌하지 않도록 tmp 이름에 pid를 넣는다.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        port: record.port,
        token: record.token,
        pid: record.pid ?? process.pid,
        version: record.version ?? null,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* tmp가 없거나 못 지워도 무시 */ }
    return false;
  }
  sweepStaleTmp(dir, file);
  return true;
}

/**
 * 신원 파일 읽기 — 없거나 손상됐거나 필수 필드가 빠지면 null(= 신원 미확인).
 * "파싱 실패 = 신뢰할 수 없음"으로 처리한다: 반쯤 읽힌 파일로 남의 서버를 우리
 * 데몬이라 오인하지 않게 하기 위함.
 * @returns {{port:number, token:string, pid:number|null, version:string|null}|null}
 */
export function readInstanceFile(port, homeDir = os.homedir()) {
  const file = instancePath(port, homeDir);
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.token !== 'string' || !parsed.token) return null;
  // 기록된 포트가 조회한 포트와 다르면(파일명 조작·수동 편집) 신뢰하지 않는다.
  if (parsed.port !== port) return null;
  return {
    port,
    token: parsed.token,
    pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
  };
}

/**
 * 내 신원 파일만 삭제. 종료 중인 데몬 A가 파일을 지우는 사이 후임 데몬 B가 같은
 * 포트에 자기 파일을 발행했을 수 있으므로, token이 내 것과 일치할 때만 지운다
 * (pid는 파일에 유효하게 기록돼 있을 때만 추가로 따진다 — 구버전 파일 호환).
 *
 * 한계(정직하게): read → unlink 사이에 파일이 교체되면 새 소유자의 파일을 지울 수
 * 있다. 파일시스템에 "일치할 때만 지우기"라는 원자 연산이 없어 pid 비교로도 이
 * TOCTOU는 닫히지 않는다. 그래서 호출자는 **listener를 해제하기 전에** 이걸 불러야
 * 한다 — 포트를 아직 우리가 쥐고 있는 동안에는 후임이 bind·발행할 수 없으므로
 * 정상 launcher끼리의 경합에서는 이 창이 열리지 않는다.
 * @returns {boolean} 실제로 지웠는지
 */
export function clearInstanceFile({ port, token, pid = process.pid }, homeDir = os.homedir()) {
  const file = instancePath(port, homeDir);
  if (!file || !token) return false;
  const cur = readInstanceFile(port, homeDir);
  if (!cur || cur.token !== token) return false;
  // pid는 기록돼 있을 때만 따진다(구버전 파일 호환).
  if (cur.pid != null && pid != null && cur.pid !== pid) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
