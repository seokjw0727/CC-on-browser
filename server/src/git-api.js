// git-api.js — git worktree 조회 전용 API. **읽기만 한다**.
//
// 이 모듈이 실행하는 git 하위명령은 rev-parse / worktree list / status / log 넷뿐이고,
// 전부 조회형이다. worktree add·remove·prune, checkout, fetch 같은 변형 명령은 여기에
// 없고 앞으로도 이 모듈의 계약이 아니다(설계도 "조회 전용"). 인자는 항상 배열로 넘겨
// 셸을 거치지 않는다 — 브랜치명·경로가 명령 문자열에 끼어들 여지를 원천 차단한다.
//
// "git이 없다"와 "여기는 repo가 아니다"는 오류가 아니라 **정상 응답**이다. 둘 다
// 사용자가 고칠 수 있는 상태고, 화면은 그 둘을 다르게 안내해야 하므로 reason으로
// 구분해 200으로 돌려준다(claude-plugins의 exists=false와 같은 처방).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 한 번의 git 호출 상한. 로컬 조회라 넉넉하지만, 행 걸린 git이 패널을 잡지 않게 한다. */
const GIT_TIMEOUT_MS = 8_000;
/** stdout 상한 — 거대 repo의 status/log가 서버 메모리를 밀어내지 않게. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** 그래프에 담을 목표 커밋 수. repo 크기와 무관하게 SVG 높이를 유한하게 만든다. */
export const MAX_GRAPH_COMMITS = 60;
/** 갈래(HEAD) 하나에 최소한 보장하는 커밋 수 — worktree가 많아도 각자 맥락은 남긴다.
 *  총량은 worktree 수 × 이 값으로 묶이므로(최대 40×8) 여전히 유한하다. */
export const MIN_GRAPH_COMMITS_PER_HEAD = 8;
/** 카드로 그릴 최대 worktree 수. 넘으면 truncated=true로 알린다. */
export const MAX_WORKTREES = 40;
/** dirty 파일 수를 세다가 멈추는 지점 — 그 이상은 "40+"로 보여 주면 충분하다. */
const MAX_STATUS_ENTRIES = 500;

// 레코드/필드 구분자 — 커밋 제목에 줄바꿈·탭이 들어가도 파싱이 깨지지 않도록
// 본문에 나타날 수 없는 제어문자(US/RS)를 쓴다.
const FS = '\x1f';
const RS = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%P', '%s', '%an', '%aI'].join(FS) + RS;

/** 이 경로가 지금 **디렉터리로** 존재하는가. 판정 실패는 전부 "아니다"로 접는다. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * git 호출 한 번. 성공하면 stdout 문자열, 실패하면 code가 붙은 Error를 던진다.
 *
 * - `-c core.quotepath=false`: 한글·이모지 경로가 \303\251 형태로 8진 이스케이프되어
 *   돌아오는 것을 막는다(그대로 두면 파일명이 깨져 보인다).
 * - `--no-optional-locks`: 조회하는 것만으로 인덱스 잠금을 건드려 사용자가 같은 repo에서
 *   돌리는 git과 경합하지 않게 한다.
 * - `-c core.fsmonitor=false`: **읽기 전용 계약의 일부다**. fsmonitor가 켜진 저장소에서
 *   `git status`는 저장소 설정이 가리키는 훅을 실행하거나 내장 데몬을 띄운다 —
 *   조회 한 번이 임의의 명령을 돌리는 통로가 된다(codex 지적). --no-optional-locks는
 *   인덱스 쓰기만 막을 뿐 이것을 막지 못한다.
 * - GIT_TERMINAL_PROMPT=0: 자격증명 프롬프트로 프로세스가 영영 멈추는 경로를 없앤다.
 */
function runGit(args, cwd, { gitPath = 'git', timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout));
          return;
        }
        const failure = new Error(
          String(stderr || err.message || 'git failed').trim().split('\n')[0],
        );
        // ENOENT는 두 가지를 뭉뚱그린다: 실행 파일을 못 찾았거나, **cwd가 없거나**.
        // 세션이 열려 있던 디렉터리를 사용자가 지우거나 이름을 바꾸면 후자가 되는데,
        // 그것을 git-missing으로 보고하면 화면이 "git을 설치하고 PATH를 확인하라"고
        // 엉뚱한 일을 시킨다(codex 지적). 어느 쪽인지는 cwd를 직접 보면 알 수 있다.
        failure.code = err.code === 'ENOENT'
          ? (isDir(cwd) ? 'EGITMISSING' : 'EGITNOCWD')
          : 'EGITFAILED';
        failure.exitCode = typeof err.code === 'number' ? err.code : null;
        reject(failure);
      },
    );
  });
}

/**
 * `git worktree list --porcelain[ -z]` 파싱.
 *
 * 레코드는 빈 항목으로 구분되고, 각 항목은 `키 값` 또는 값 없는 단일 키다. 실측 키:
 * worktree(경로) / HEAD(sha) / branch(refs/heads/..) / bare / detached /
 * locked[ 사유] / prunable[ 사유].
 *
 * 구분자는 출력을 보고 정한다. `-z`가 붙으면 항목이 NUL로 끝나고, 그때만 경로와 잠금
 * 사유가 **날것 그대로** 온다. -z 없이는 줄바꿈 같은 문자가 든 값을 git이 C 인용으로
 * 감싸 보내므로("reason\nwhy"), 그 철자를 그대로 cwd로 쓰면 없는 디렉터리를 가리킨다
 * (codex 지적). 호출측은 -z를 먼저 쓰고 구버전 git에서만 물러선다.
 */
export function parseWorktreeList(stdout) {
  const out = [];
  let current = null;
  const text = String(stdout);
  const items = text.includes('\0') ? text.split('\0') : text.split('\n');
  for (const rawLine of items) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (current) out.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        lockReason: '',
        prunable: false,
      };
      continue;
    }
    if (!current) continue; // worktree 줄보다 앞선 키는 형식 위반 — 버린다
    if (key === 'HEAD') current.head = value || null;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') { current.locked = true; current.lockReason = value; }
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) out.push(current);
  return out;
}

/**
 * `git status --porcelain=v1 -z` 파싱 — 변경 파일 수 집계.
 *
 * -z 레코드는 `XY<공백>경로\0`이고, 이름변경/복사(R·C)만 **원본 경로 필드가 하나 더**
 * 뒤따른다. 그 필드를 건너뛰지 않으면 이름변경 한 건이 두 건으로 세어질 뿐 아니라,
 * 원본 경로의 첫 두 글자가 상태 코드로 잘못 읽혀 staged/unstaged까지 오염된다.
 *
 * X(인덱스)만이 아니라 Y(작업트리)도 봐야 한다 — git은 작업트리 쪽 이름변경을 ` R`처럼
 * Y 칼럼에 실어 보내고, 그때도 원본 경로 필드는 똑같이 따라온다(codex 지적).
 */
export function parseStatusCounts(stdout, { max = MAX_STATUS_ENTRIES } = {}) {
  const fields = String(stdout).split('\0');
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let total = 0;
  let capped = false;
  for (let i = 0; i < fields.length; i += 1) {
    const rec = fields[i];
    if (!rec) continue; // 마지막 빈 조각
    if (rec.length < 3) continue; // 형식 위반
    const x = rec[0];
    const y = rec[1];
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1; // 원본 경로 필드 소비
    if (total >= max) { capped = true; break; }
    total += 1;
    if (x === '?' && y === '?') untracked += 1;
    else {
      if (x !== ' ' && x !== '?') staged += 1;
      if (y !== ' ' && y !== '?') unstaged += 1;
    }
  }
  return { total, staged, unstaged, untracked, capped, clean: total === 0 };
}

/** `git log --format=LOG_FORMAT` 파싱. */
export function parseCommits(stdout) {
  const out = [];
  for (const chunk of String(stdout).split(RS)) {
    const rec = chunk.replace(/^\n/, '').trim();
    if (!rec) continue;
    const [sha, short, parents, subject, author, at] = rec.split(FS);
    if (!sha) continue;
    out.push({
      sha,
      short: short || sha.slice(0, 7),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      author: author ?? '',
      at: at || null,
    });
  }
  return out;
}

/**
 * 여러 갈래에서 따로 걷어 온 커밋을 하나의 위상 순서로 합친다 — 자식이 언제나 부모보다
 * 앞(위)에 오고, 그 제약 안에서는 최신 커밋이 먼저 온다.
 *
 * 왜 필요한가: 그래프를 `git log <head1> <head2> …` 한 번으로 걷으면 총 개수 상한이
 * 갈래들 사이에서 나뉘지 않는다. 한쪽 브랜치가 다른 쪽보다 상한만큼 앞서 있으면 뒤진
 * 쪽 HEAD가 목록에서 통째로 빠져, 그 worktree는 그래프에 나타나지도 못한다(codex 지적).
 * 그래서 갈래마다 따로 걷어 합치는데, 그 순간 git이 보장하던 정렬이 사라지므로 여기서
 * 다시 세운다. layoutCommits는 "부모가 뒤에 온다"를 전제로 레인을 잇는다.
 */
export function orderCommits(commits) {
  const known = new Map(commits.map((c) => [c.sha, c]));
  // 아직 나오지 않은 자식 수. 0이 되어야 그 커밋을 낼 수 있다.
  const pending = new Map([...known.keys()].map((sha) => [sha, 0]));
  for (const c of commits) {
    for (const p of c.parents) {
      if (known.has(p)) pending.set(p, pending.get(p) + 1);
    }
  }
  const timeOf = (c) => {
    const t = Date.parse(c.at ?? '');
    return Number.isFinite(t) ? t : 0;
  };
  // 낼 수 있는 것 중 가장 최근 것을 고른다. n이 수백 규모라 선형 탐색으로 충분하다.
  const ready = commits.filter((c) => pending.get(c.sha) === 0);
  const out = [];
  const emitted = new Set();
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i += 1) {
      if (timeOf(ready[i]) > timeOf(ready[best])) best = i;
    }
    const c = ready.splice(best, 1)[0];
    if (emitted.has(c.sha)) continue;
    emitted.add(c.sha);
    out.push(c);
    for (const p of c.parents) {
      if (!known.has(p) || emitted.has(p)) continue;
      const left = pending.get(p) - 1;
      pending.set(p, left);
      if (left === 0) ready.push(known.get(p));
    }
  }
  // 순환(정상 git 이력에는 없다)으로 남은 것이 있으면 시간순으로 덧붙인다 — 빠뜨리지 않는다.
  if (out.length < known.size) {
    const rest = commits.filter((c) => !emitted.has(c.sha)).sort((a, b) => timeOf(b) - timeOf(a));
    for (const c of rest) {
      if (emitted.has(c.sha)) continue;
      emitted.add(c.sha);
      out.push(c);
    }
  }
  return out;
}

/**
 * 커밋 목록에 레인(x축 정수)을 배정한다 — 클라이언트는 이 좌표만 보고 SVG를 그린다.
 *
 * 레이아웃을 서버에 두는 이유: 순수 함수라 git 없이도 단위 테스트할 수 있고, 화면이
 * 바뀌어도 그래프의 위상은 한 곳에서만 정의된다. commits는 `git log --date-order`가
 * 준 순서(위가 최신)를 그대로 유지한다.
 *
 * 규칙은 통상적인 railroad 배치다. 각 레인은 "다음에 이 sha가 오면 그 자리를 잇는다"는
 * 예약을 들고 있다: 커밋은 자기를 예약한 레인 중 가장 왼쪽에 놓이고, 첫 부모가 그
 * 자리를 물려받으며, 나머지 부모는 빈 레인에 새로 예약된다.
 */
export function layoutCommits(commits) {
  /** @type {Array<string|null>} 레인 index -> 그 레인이 기다리는 sha */
  const lanes = [];
  const rows = [];
  const reserve = (sha) => {
    const free = lanes.indexOf(null);
    if (free !== -1) { lanes[free] = sha; return free; }
    lanes.push(sha);
    return lanes.length - 1;
  };
  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) lane = reserve(commit.sha);
    // 같은 sha를 여러 레인이 기다렸다면(병합 이후 합류) 왼쪽 하나만 남기고 비운다.
    for (let i = lane + 1; i < lanes.length; i += 1) {
      if (lanes[i] === commit.sha) lanes[i] = null;
    }
    lanes[lane] = null;
    const edges = [];
    commit.parents.forEach((parent, idx) => {
      // 이미 어떤 레인이 이 부모를 기다리면 그 레인으로 합류시킨다(중복 예약 금지).
      let parentLane = lanes.indexOf(parent);
      if (parentLane === -1) parentLane = idx === 0 ? (lanes[lane] = parent, lane) : reserve(parent);
      edges.push({ sha: parent, lane: parentLane });
    });
    // 오른쪽 끝의 빈 레인은 줄여 둔다 — 그래프 폭이 한 번 늘면 끝까지 남는 것을 막는다.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ ...commit, row, lane, edges });
  });
  const width = rows.reduce(
    (max, r) => Math.max(max, r.lane + 1, ...r.edges.map((e) => e.lane + 1)),
    1,
  );
  return { rows, lanes: width };
}

/**
 * 경로 비교용 정규화 — realpath + 구분자 통일 + 끝 구분자 제거 + Windows 대소문자 무시.
 *
 * realpath가 반드시 먼저다. 비교 대상 두 경로의 출처가 다르기 때문이다: worktree 경로는
 * git이 준 실제 경로이고, 세션 cwd는 사용자가 입력했거나 OS가 준 철자다. Windows에서는
 * 후자가 8.3 단축 이름(예: LONGNA~1)일 수 있고, 어느 쪽이든 심볼릭 링크·junction일 수 있어
 * 문자열만으로는 같은 디렉터리를 같다고 판정하지 못한다. remote-control.js의
 * canonicalCwdSync가 같은 이유로 같은 처방을 쓴다.
 *
 * 지워진 경로에는 realpath가 실패하므로, **존재하는 가장 가까운 상위**를 정규화하고
 * 남은 조각을 도로 붙인다. 단순히 물러서면 안 되는 이유가 여기에 있다: 상위가 단축
 * 이름이면 존재하지 않는 잎 하나 때문에 경로 전체가 원문 철자로 남아, 같은 디렉터리가
 * 서로 다른 것으로 판정된다.
 */
export function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  const resolved = path.resolve(p);
  let base = resolved;
  const rest = [];
  let real = null;
  // 루트에 닿을 때까지 한 칸씩 올라가며 realpath가 통하는 지점을 찾는다.
  for (;;) {
    try {
      real = fs.realpathSync.native(base);
      break;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) break; // 루트까지 실패 — 원문 그대로 쓴다
      rest.unshift(path.basename(base));
      base = parent;
    }
  }
  let s = (real === null ? resolved : path.join(real, ...rest)).split('\\').join('/');
  // 끝 구분자만 떼되 POSIX 루트('/')는 남긴다 — 빈 문자열이 되면 "경로 없음"으로 읽혀
  // 루트에 놓인 worktree의 세션 배정이 통째로 실패한다(codex 지적).
  s = s.replace(/(?!^)\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/**
 * 이미 정규화된 두 경로에 대한 포함 판정. 경계에서 구분자를 요구하는 이유는 순수
 * startsWith가 `/a/project`를 `/a/project-2`의 상위로 오인하기 때문이다.
 *
 * 접두사를 만들 때 root가 이미 '/'로 끝나는지 봐야 한다 — POSIX 루트('/')에 구분자를
 * 덧붙이면 '//'가 되어 그 아래 무엇도 하위로 인정되지 않는다. Windows에서는 루트가
 * 'c:'로 정규화되어 이 경우가 생기지 않아, 리눅스 CI가 먼저 잡아냈다.
 */
export function containsNormalized(root, target) {
  if (!root || !target) return false;
  if (target === root) return true;
  return target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** dir이 root와 같거나 그 **하위**인가. */
export function isInside(root, dir) {
  return containsNormalized(normalizePath(root), normalizePath(dir));
}

/**
 * 세션 cwd를 worktree에 배정한다. 중첩 worktree가 있으면 **가장 깊은**(경로가 가장 긴)
 * 쪽 하나에만 붙인다 — 그러지 않으면 같은 세션이 부모·자식 카드에 중복해서 보인다.
 * @param {Array<{path: string}>} worktrees
 * @param {string} cwd
 * @returns {number} worktrees의 index, 없으면 -1
 */
export function assignToWorktree(worktrees, cwd) {
  // 정규화는 realpath 시스템 호출을 포함하므로 경로마다 한 번씩만 한다.
  const target = normalizePath(cwd);
  if (!target) return -1;
  let best = -1;
  let bestLen = -1;
  worktrees.forEach((wt, i) => {
    const root = normalizePath(wt.path);
    if (!containsNormalized(root, target)) return;
    if (root.length > bestLen) { best = i; bestLen = root.length; }
  });
  return best;
}

/**
 * 동시에 도는 git 프로세스 수 상한. worktree 40개를 Promise.all로 한꺼번에 조사하면
 * 조회 한 번이 프로세스 40개와 그 각각의 stdout 버퍼를 동시에 띄운다 — 패널을 두 번
 * 열면 그대로 두 배가 된다(codex 지적). 로컬 조회라 지연보다 자원 폭이 문제다.
 */
const GIT_CONCURRENCY = 6;

/** limit개씩만 동시에 도는 map. 의존성 없이 인덱스를 나눠 갖는 워커 방식. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * 한 worktree의 상태와 최근 커밋. 디렉터리가 지워졌거나 권한이 없으면 오류 대신
 * null을 담아 돌려준다 — worktree 하나가 사라졌다고 패널 전체가 실패하면 안 된다.
 *
 * 커밋 조회를 worktree 자기 경로가 아니라 **repoCwd**(이미 git이 통한다고 확인된
 * 디렉터리)에서 하는 이유: bare 저장소와 경로가 사라진(prunable) worktree는 자기
 * 경로에서 git을 돌릴 수 없다. 그 자리에서 물으면 멀쩡히 커밋이 있는 worktree가
 * "커밋 없음"으로 표시된다(codex 지적). 커밋은 저장소 공용 자산이라 어디서 물어도 같다.
 * 작업트리 상태(status)만은 그 worktree 자신에게 물어야 하므로 경로를 그대로 쓴다.
 */
async function inspectWorktree(wt, repoCwd, opts) {
  let status = null;
  let lastCommit = null;
  let unreadable = false;
  let head = wt.head;
  let branch = wt.branch;
  // bare에는 작업트리가 없다 — 상태를 묻는 것 자체가 무의미하므로 건너뛴다(오류 아님).
  if (!wt.bare) {
    try {
      status = parseStatusCounts(await runGit(['status', '--porcelain=v1', '-z'], wt.path, opts));
    } catch {
      unreadable = true; // 경로 삭제·권한 거부 — 카드는 그리되 상태만 비운다
    }
  }
  // `worktree list`는 bare 항목에 HEAD·branch 줄을 내지 않는다(실측). 그대로 두면
  // 멀쩡한 저장소가 "브랜치 없음 / 커밋 없음"으로 보이므로 저장소에 직접 묻는다.
  if (!head) {
    try {
      head = (await runGit(['rev-parse', 'HEAD'], wt.path, opts)).trim() || null;
    } catch {
      head = null; // 커밋이 하나도 없는 저장소 — 정상 상태다
    }
    if (head && !branch && !wt.detached) {
      try {
        const name = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path, opts)).trim();
        branch = name && name !== 'HEAD' ? name : null;
      } catch {
        branch = null; // 이름을 못 얻으면 카드가 sha로 대신 부른다
      }
    }
  }
  if (head) {
    try {
      const out = await runGit(
        ['log', '-1', `--format=${LOG_FORMAT}`, head, '--'],
        repoCwd,
        opts,
      );
      lastCommit = parseCommits(out)[0] ?? null;
    } catch {
      lastCommit = null; // 커밋 없는 repo(unborn HEAD) 포함
    }
  }
  return { status, lastCommit, unreadable, head, branch };
}

/**
 * rev-parse 실패를 원인별로 가른다. 전부 not-a-repo로 뭉뚱그리면 권한 오류·손상된
 * 저장소·소유권 경고가 전부 "여기는 git 저장소가 아닙니다"로 안내되어, 사용자가 실제로
 * 해야 할 일을 영영 알 수 없다(codex 지적).
 */
export function classifyRevParseError(err) {
  if (err?.code === 'EGITMISSING') return 'git-missing';
  // 기준 디렉터리 자체가 사라졌다 — 저장소 문제도, git 설치 문제도 아니다.
  if (err?.code === 'EGITNOCWD') return 'no-cwd';
  const msg = String(err?.message ?? '');
  if (/not a git repository|not a working tree/i.test(msg)) return 'not-a-repo';
  // git 2.35+의 안전 디렉터리 검사 — 저장소는 맞는데 소유자가 달라 거부된 상태다.
  if (/dubious ownership|safe\.directory/i.test(msg)) return 'unsafe-repo';
  return 'git-failed';
}

/**
 * "보여줄 것이 없다"는 정상 응답. 실패가 아니라 상태이므로 호출측은 이것을 200으로
 * 내보낸다. reason은 화면이 안내 문구를 고르는 유일한 근거다:
 *   no-session  — 조회 기준이 될 라이브 세션이 없다(서버 라우트가 붙인다)
 *   no-cwd      — 기준 디렉터리가 절대경로가 아니다
 *   git-missing — git 실행 파일을 찾지 못했다
 *   not-a-repo  — 그 디렉터리가 git 저장소가 아니다
 *   unsafe-repo — 저장소는 맞지만 소유자가 달라 git이 거부했다(safe.directory)
 *   git-failed  — git이 예상 밖의 이유로 실패했다(message에 첫 줄)
 */
export function unavailableResult(reason, message = null) {
  return {
    available: false,
    reason,
    message,
    root: null,
    worktrees: [],
    graph: { rows: [], lanes: 0 },
    truncated: false,
    graphFailed: false,
  };
}

/**
 * 브랜치 표시만을 위한 "없음" 응답. unavailableResult와 reason 어휘는 같지만 몸통은
 * 따로 둔다 — 라벨 하나 그리는 쪽에 worktrees·graph 같은 빈 배열을 딸려 보내면, 두
 * 창구가 같은 계약을 공유하는 것처럼 보여 나중에 한쪽만 커질 때 어긋난다.
 */
export function unavailableBranch(reason, message = null) {
  return {
    available: false,
    reason,
    message,
    branch: null,
    head: null,
    detached: false,
  };
}

/**
 * "지금 HEAD가 어느 브랜치인가" 하나만 본다. collectWorktrees와 목적이 다르다:
 * 저쪽은 사용자가 패널을 열었을 때 한 번 도는 전경 조회라 worktree 전수 status와
 * 60커밋 그래프를 감수하지만, 이 함수의 결과는 **입력창 아래에 늘 떠 있는 라벨**이라
 * 세션을 옮길 때마다 다시 불린다. 그 자리에 전경 조회를 쓰면 라벨 한 줄 때문에
 * 저장소 전체를 훑게 된다.
 *
 * 그래서 흔한 경우(브랜치 위에 있음)를 git 호출 **한 번**으로 끝낸다. symbolic-ref는
 * rev-parse --abbrev-ref와 달리 커밋이 하나도 없는 저장소에서도 성공해 "아직 커밋은
 * 없지만 master에 있다"를 그대로 알려 준다 — 갓 만든 저장소가 빈 라벨로 보이지 않는
 * 유일한 경로다. 실패했을 때만 detached인지 저장소가 아닌지를 가르느라 호출이 한두 번
 * 더 붙는다.
 *
 * "커밋이 없다"를 따로 알리는 필드는 두지 않는다. 그런 저장소도 HEAD는 심볼릭이라 위의
 * 첫 경로로 브랜치 이름을 그대로 내고, 이 창구가 답할 질문("지금 어느 브랜치인가")에는
 * 그것으로 충분하다 — 커밋 유무는 패널이 답한다. 예전에 unborn 플래그를 두었을 때는
 * 정작 갓 만든 저장소가 false로, HEAD를 읽지 못하는 **손상된** 저장소가 true로 잡혀
 * 뜻이 정확히 뒤집혀 있었다(codex 지적).
 *
 * 던지지 않는다 — git이 없거나 repo가 아닌 것은 오류가 아니라 상태다(모듈 상단 주석).
 *
 * @param {string} cwd 세션의 작업 디렉터리(서버 장부에서 되찾은 값이어야 한다)
 * @returns {Promise<{available: boolean, reason: string|null, message: string|null,
 *   branch: string|null, head: string|null, detached: boolean}>}
 */
export async function collectBranch(cwd, { gitPath = 'git', timeoutMs } = {}) {
  const opts = { gitPath, timeoutMs };

  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    return unavailableBranch('no-cwd');
  }

  try {
    const name = (await runGit(['symbolic-ref', '--short', 'HEAD'], cwd, opts)).trim();
    if (name) {
      return {
        available: true, reason: null, message: null,
        branch: name, head: null, detached: false,
      };
    }
  } catch (err) {
    // git이 없거나 기준 디렉터리가 사라졌으면 아래 판정도 전부 같은 이유로 실패한다 —
    // 헛돌지 않게 여기서 끝낸다.
    if (err?.code === 'EGITMISSING') return unavailableBranch('git-missing', err?.message ?? null);
    if (err?.code === 'EGITNOCWD') return unavailableBranch('no-cwd', err?.message ?? null);
    // 그 밖의 실패는 아직 "detached HEAD"인지 "저장소가 아님"인지 모른다. 아래에서 가른다.
  }

  // 저장소인지부터 확정한다. collectWorktrees와 같은 이유로 --show-toplevel이 아니라
  // --git-common-dir를 쓴다(bare 저장소에서도 나온다).
  try {
    const commonDir = (await runGit(['rev-parse', '--git-common-dir'], cwd, opts)).trim();
    if (!commonDir) return unavailableBranch('not-a-repo');
  } catch (err) {
    return unavailableBranch(classifyRevParseError(err), err?.message ?? null);
  }

  // 저장소는 맞는데 HEAD가 심볼릭 참조가 아니다 = detached. 라벨은 짧은 sha로 대신한다.
  try {
    const short = (await runGit(['rev-parse', '--short', 'HEAD'], cwd, opts)).trim();
    if (short) {
      return {
        available: true, reason: null, message: null,
        branch: null, head: short, detached: true,
      };
    }
  } catch (err) {
    // 저장소는 맞다고 확인해 놓고 HEAD를 읽지 못했다 = 브랜치도 sha도 말할 수 없다.
    // 이것을 "커밋이 없는 저장소"로 넘기면 손상된 저장소가 정상인 척 보인다.
    return unavailableBranch('git-failed', err?.message ?? null);
  }
  return unavailableBranch('git-failed', 'HEAD를 읽지 못했습니다');
}

/**
 * worktree 전경 조회. 던지지 않고 항상 결과 객체를 돌려준다.
 *
 * @param {string} cwd 세션의 작업 디렉터리(서버 장부에서 되찾은 값이어야 한다)
 * @returns {Promise<{available: boolean, reason: string|null, root: string|null,
 *   worktrees: object[], graph: {rows: object[], lanes: number}, truncated: boolean}>}
 */
export async function collectWorktrees(cwd, { gitPath = 'git', timeoutMs } = {}) {
  const opts = { gitPath, timeoutMs };

  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    return unavailableResult('no-cwd');
  }

  // --git-common-dir로 먼저 판정한다. --show-toplevel은 bare 저장소에서 실패하므로,
  // 그것을 판정 기준으로 삼으면 bare 저장소에서 연 세션이 "저장소가 아님"으로 잘못
  // 안내된다(codex 지적). 공용 git 디렉터리는 bare에서도 나온다.
  let commonDir;
  try {
    commonDir = (await runGit(['rev-parse', '--git-common-dir'], cwd, opts)).trim();
  } catch (err) {
    return unavailableResult(classifyRevParseError(err), err?.message ?? null);
  }
  if (!commonDir) return unavailableResult('not-a-repo');

  // 표시용 최상위 경로. bare에는 작업트리가 없으므로 공용 git 디렉터리를 대신 보여준다.
  let root;
  try {
    root = (await runGit(['rev-parse', '--show-toplevel'], cwd, opts)).trim();
  } catch {
    root = '';
  }
  if (!root) root = path.resolve(cwd, commonDir);

  let listed;
  try {
    // -z를 먼저 쓴다 — 줄바꿈이 든 경로·잠금 사유가 C 인용으로 위장되지 않는 유일한
    // 형식이다. worktree list의 -z는 git 2.36부터라, 없으면 한 번만 물러선다.
    let raw;
    try {
      raw = await runGit(['worktree', 'list', '--porcelain', '-z'], cwd, opts);
    } catch (zErr) {
      if (zErr?.code === 'EGITMISSING') throw zErr;
      raw = await runGit(['worktree', 'list', '--porcelain'], cwd, opts);
    }
    listed = parseWorktreeList(raw);
  } catch (err) {
    if (err?.code === 'EGITMISSING') return unavailableResult('git-missing');
    return unavailableResult('git-failed', err?.message ?? null);
  }

  const truncated = listed.length > MAX_WORKTREES;
  const kept = listed.slice(0, MAX_WORKTREES);

  const details = await mapLimit(kept, GIT_CONCURRENCY, (wt) => inspectWorktree(wt, cwd, opts));
  const worktrees = kept.map((wt, i) => ({
    ...wt,
    // bare 항목은 head·branch를 inspectWorktree가 저장소에 물어 채운다.
    head: details[i].head,
    branch: details[i].branch,
    name: path.basename(wt.path) || wt.path,
    // git worktree list의 첫 항목이 주 worktree다(실측: --porcelain은 항상 주 것을 먼저 낸다).
    isMain: i === 0,
    status: details[i].status,
    lastCommit: details[i].lastCommit,
    unreadable: details[i].unreadable,
    sessions: { live: [], past: [] },
  }));

  // 그래프는 모든 worktree의 HEAD에서 각각 거슬러 올라간다 — 브랜치들이 어디서 갈라져
  // 어디서 만나는지가 이 패널의 요점이라, 현재 브랜치만 보면 의미가 없다.
  //
  // 한 번의 `git log head1 head2 …`로 걷지 않는 이유는 상한 배분이다. 그렇게 하면 총
  // 상한을 앞선 브랜치가 다 써 버려, 뒤진 브랜치의 HEAD가 목록에 아예 없을 수 있다.
  // 갈래마다 자기 몫을 걷고 합친 뒤 orderCommits로 다시 정렬한다.
  const heads = [...new Set(worktrees.map((w) => w.head).filter(Boolean))];
  const perHead = heads.length
    ? Math.max(MIN_GRAPH_COMMITS_PER_HEAD, Math.floor(MAX_GRAPH_COMMITS / heads.length))
    : 0;
  let graph = { rows: [], lanes: 0 };
  let graphFailed = false;
  if (heads.length) {
    const walks = await mapLimit(heads, GIT_CONCURRENCY, async (head) => {
      try {
        return parseCommits(await runGit(
          ['log', `--max-count=${perHead}`, `--format=${LOG_FORMAT}`, head, '--'],
          cwd,
          opts,
        ));
      } catch {
        return null; // 커밋 없는 repo(unborn HEAD) 등 — 이 갈래만 빠진다
      }
    });
    if (walks.every((w) => w === null)) {
      // 전부 실패했다면 "커밋이 없다"가 아니라 "못 읽었다"이다 — 화면이 구분해야 한다.
      graphFailed = true;
    } else {
      const seen = new Set();
      const merged = [];
      for (const commits of walks) {
        for (const c of commits ?? []) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          merged.push(c);
        }
      }
      graph = layoutCommits(orderCommits(merged));
    }
  }

  return {
    available: true, reason: null, message: null, root, worktrees, graph, truncated, graphFailed,
  };
}

/**
 * worktree 카드에 세션을 얹는다. cwd 비교는 **서버만** 할 수 있는 일이다 — 클라이언트는
 * realpath를 모르므로 심볼릭 링크·대소문자에서 어긋난다(store-reducer의 remoteControls가
 * 같은 이유로 cwd 대신 key를 쓴다). 여기서도 클라이언트에는 판정 결과(key/sessionId)만
 * 넘기고, 화면에 쓸 이름은 클라이언트가 자기 우선순위(sessionDisplayTitle)로 정한다.
 *
 * @param {object[]} worktrees collectWorktrees의 결과 배열(제자리 수정)
 * @param {{live?: Array<{key: string, cwd: string|null}>, past?: Array<{cwd: string, dirName: string, sessionId: string, title?: string, mtime?: number}>}} sessions
 */
export function attachSessions(worktrees, { live = [], past = [] } = {}) {
  for (const s of live) {
    if (!s?.cwd) continue;
    const i = assignToWorktree(worktrees, s.cwd);
    // sessionId·cliName도 함께 넘긴다 — key를 아직 모르는 탭(다른 탭에서 연 세션,
    // 동기화 전)이 세션을 이름 없이 그리지 않게 하는 폴백 재료다. 표시할 이름을 고르는
    // 우선순위 자체는 여전히 클라이언트가 정한다(sessionDisplayTitle).
    if (i !== -1) {
      worktrees[i].sessions.live.push({
        key: s.key,
        sessionId: s.sessionId ?? null,
        cliName: s.cliName ?? null,
      });
    }
  }
  const liveIds = new Set(live.map((s) => s?.sessionId).filter(Boolean));
  for (const s of past) {
    if (!s?.cwd || liveIds.has(s.sessionId)) continue;
    const i = assignToWorktree(worktrees, s.cwd);
    if (i === -1) continue;
    worktrees[i].sessions.past.push({
      dirName: s.dirName,
      sessionId: s.sessionId,
      // title(첫 발화 요약)과 cliName(CLI가 붙인 이름)을 둘 다 그대로 넘긴다 —
      // 어느 쪽을 보여줄지는 클라이언트의 sessionDisplayTitle이 정한다.
      title: s.title ?? '',
      cliName: s.cliName ?? null,
      mtime: s.mtime ?? 0,
    });
  }
  for (const wt of worktrees) {
    wt.sessions.past.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  }
  return worktrees;
}
