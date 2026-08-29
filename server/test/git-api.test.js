// git-api.js — worktree 조회 테스트.
//
// 두 층으로 나눈다. 파서·레이아웃·경로 판정은 순수 함수라 git 없이 고정 픽스처로
// 검증하고, collectWorktrees만 임시 디렉터리에 **실제** repo와 연결 worktree를 만들어
// 확인한다(실 git 출력 형식이 이 모듈의 유일한 계약이므로 가짜 출력으로는 지킬 수 없다).
// git이 없는 기계에서는 그 층만 조용히 건너뛴다 — 파서 층은 언제나 돈다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assignToWorktree,
  attachSessions,
  classifyRevParseError,
  collectWorktrees,
  isInside,
  layoutCommits,
  mapLimit,
  normalizePath,
  orderCommits,
  parseCommits,
  parseStatusCounts,
  parseWorktreeList,
  MAX_GRAPH_COMMITS,
} from '../src/git-api.js';

const FS_SEP = '\x1f';
const RS_SEP = '\x1e';
const logRec = (sha, short, parents, subject, author = 'A', at = '2026-01-01T00:00:00+00:00') =>
  [sha, short, parents, subject, author, at].join(FS_SEP) + RS_SEP;

// ----- parseWorktreeList -----

describe('parseWorktreeList', () => {
  test('주/연결 worktree와 detached·bare·locked·prunable 키를 읽는다', () => {
    const out = parseWorktreeList([
      'worktree C:/repo',
      'HEAD abc123',
      'branch refs/heads/master',
      '',
      'worktree C:/repo-wt/feature',
      'HEAD def456',
      'detached',
      'locked in use',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree C:/repo.git',
      'bare',
      '',
    ].join('\n'));
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], {
      path: 'C:/repo', head: 'abc123', branch: 'master',
      bare: false, detached: false, locked: false, lockReason: '', prunable: false,
    });
    assert.equal(out[1].detached, true);
    assert.equal(out[1].branch, null);
    assert.equal(out[1].locked, true);
    assert.equal(out[1].lockReason, 'in use');
    assert.equal(out[1].prunable, true);
    assert.equal(out[2].bare, true);
  });

  test('CRLF와 끝 빈 줄 없는 입력도 같은 결과', () => {
    const out = parseWorktreeList('worktree /a\r\nHEAD aa\r\nbranch refs/heads/main');
    assert.equal(out.length, 1);
    assert.equal(out[0].branch, 'main');
    assert.equal(out[0].head, 'aa');
  });

  test('공백이 든 경로를 자르지 않는다', () => {
    const out = parseWorktreeList('worktree C:/My Projects/repo one\nHEAD aa\n');
    assert.equal(out[0].path, 'C:/My Projects/repo one');
  });

  test('-z 출력(NUL 구분)도 같은 결과를 낸다', () => {
    const z = [
      'worktree /a', 'HEAD aa', 'branch refs/heads/main', '',
      'worktree /b', 'HEAD bb', 'detached', '',
    ].join('\0') + '\0';
    const out = parseWorktreeList(z);
    assert.equal(out.length, 2);
    assert.equal(out[0].branch, 'main');
    assert.equal(out[1].detached, true);
  });

  test('-z에서는 줄바꿈이 든 잠금 사유가 레코드를 쪼개지 않는다', () => {
    // -z 없이 오면 git이 "reason\nwhy"처럼 인용해 보내지만, -z에서는 날것으로 온다.
    const z = ['worktree /a', 'HEAD aa', 'locked reason\nwhy is locked', '', ].join('\0') + '\0';
    const out = parseWorktreeList(z);
    assert.equal(out.length, 1);
    assert.equal(out[0].locked, true);
    assert.equal(out[0].lockReason, 'reason\nwhy is locked');
  });

  test('빈 입력 → 빈 배열', () => {
    assert.deepEqual(parseWorktreeList(''), []);
  });
});

// ----- parseStatusCounts -----

describe('parseStatusCounts', () => {
  test('스테이지/작업트리/미추적을 각각 센다', () => {
    const z = ['M  a.js', ' M b.js', 'MM c.js', '?? d.js', 'A  e.js'].join('\0') + '\0';
    const c = parseStatusCounts(z);
    assert.equal(c.total, 5);
    assert.equal(c.untracked, 1);
    assert.equal(c.staged, 3); // M_, MM, A_
    assert.equal(c.unstaged, 2); // _M, MM
    assert.equal(c.clean, false);
  });

  test('이름변경(R)·복사(C)의 원본 경로 필드를 한 건으로 흡수한다', () => {
    // R 레코드는 `R  new\0old\0` — old를 소비하지 않으면 두 건으로 세어진다.
    const z = ['R  new.js', 'old.js', 'C  copy.js', 'src.js', 'M  z.js'].join('\0') + '\0';
    const c = parseStatusCounts(z);
    assert.equal(c.total, 3);
    assert.equal(c.staged, 3);
  });

  test('작업트리 쪽 이름변경(Y 칼럼 R)도 원본 경로 필드를 흡수한다', () => {
    // ` R new\0old\0M  next\0` — old를 소비하지 않으면 상한(2)에 걸려 capped가 거짓으로 선다.
    const z = [' R new.js', 'old.js', 'M  next.js'].join('\0') + '\0';
    const c = parseStatusCounts(z, { max: 2 });
    assert.equal(c.total, 2);
    assert.equal(c.unstaged, 1);
    assert.equal(c.staged, 1);
    assert.equal(c.capped, false);
  });

  test('깨끗한 트리 → clean', () => {
    const c = parseStatusCounts('');
    assert.equal(c.total, 0);
    assert.equal(c.clean, true);
    assert.equal(c.capped, false);
  });

  test('상한을 넘으면 capped', () => {
    const z = Array.from({ length: 10 }, (_, i) => `M  f${i}.js`).join('\0') + '\0';
    const c = parseStatusCounts(z, { max: 4 });
    assert.equal(c.total, 4);
    assert.equal(c.capped, true);
  });
});

// ----- parseCommits -----

describe('parseCommits', () => {
  test('필드를 순서대로 읽고 부모를 쪼갠다', () => {
    const out = parseCommits(
      logRec('aaa', 'aaa1', 'bbb ccc', 'merge: 합치기') + logRec('bbb', 'bbb1', '', '최초 커밋'),
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].parents, ['bbb', 'ccc']);
    assert.equal(out[0].subject, 'merge: 합치기');
    assert.deepEqual(out[1].parents, []);
  });

  test('제목에 줄바꿈·탭이 있어도 레코드가 깨지지 않는다', () => {
    const out = parseCommits(logRec('aaa', 'aaa1', '', 'fix:\t줄바꿈 없는 제목'));
    assert.equal(out.length, 1);
    assert.equal(out[0].subject, 'fix:\t줄바꿈 없는 제목');
  });

  test('빈 출력 → 빈 배열', () => {
    assert.deepEqual(parseCommits(''), []);
  });
});

// ----- layoutCommits -----

describe('layoutCommits', () => {
  test('선형 이력은 레인 하나', () => {
    const { rows, lanes } = layoutCommits([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    assert.equal(lanes, 1);
    assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
    assert.deepEqual(rows[0].edges, [{ sha: 'b', lane: 0 }]);
    assert.deepEqual(rows[2].edges, []);
  });

  test('갈라진 두 머리는 서로 다른 레인을 쓰고 공통 조상에서 합류한다', () => {
    // f(=feature) 와 m(=master)이 base에서 갈라진 모습
    const { rows, lanes } = layoutCommits([
      { sha: 'm2', parents: ['base'] },
      { sha: 'f2', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);
    assert.equal(lanes, 2);
    assert.equal(rows[0].lane, 0);
    assert.equal(rows[1].lane, 1);
    // 둘 다 base를 기다리지만 base는 한 레인(가장 왼쪽)에만 놓인다
    assert.equal(rows[2].lane, 0);
    assert.equal(rows[2].row, 2);
  });

  test('병합 커밋은 부모마다 간선을 낸다', () => {
    const { rows } = layoutCommits([
      { sha: 'merge', parents: ['m1', 'f1'] },
      { sha: 'm1', parents: ['base'] },
      { sha: 'f1', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);
    assert.equal(rows[0].edges.length, 2);
    const targetLanes = rows[0].edges.map((e) => e.lane);
    assert.equal(new Set(targetLanes).size, 2, '두 부모는 다른 레인으로 간다');
    assert.equal(rows[1].lane, targetLanes[0]);
    assert.equal(rows[2].lane, targetLanes[1]);
  });

  test('row는 입력 순서를 그대로 보존한다', () => {
    const { rows } = layoutCommits([
      { sha: 'a', parents: [] }, { sha: 'b', parents: [] }, { sha: 'c', parents: [] },
    ]);
    assert.deepEqual(rows.map((r) => r.row), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => r.sha), ['a', 'b', 'c']);
  });

  test('빈 입력 → lanes 1, 행 없음', () => {
    const { rows, lanes } = layoutCommits([]);
    assert.deepEqual(rows, []);
    assert.equal(lanes, 1);
  });
});

// ----- orderCommits -----

describe('orderCommits', () => {
  const c = (sha, parents, at) => ({ sha, parents, at, short: sha, subject: sha, author: 'A' });

  test('자식이 언제나 부모보다 앞에 온다', () => {
    // 일부러 뒤섞어 넣는다 — 갈래별로 따로 걷어 합치면 이런 순서로 들어온다.
    const out = orderCommits([
      c('base', [], '2026-01-01T00:00:00Z'),
      c('b', ['base'], '2026-01-03T00:00:00Z'),
      c('a', ['base'], '2026-01-02T00:00:00Z'),
    ]);
    const at = (sha) => out.findIndex((x) => x.sha === sha);
    assert.ok(at('a') < at('base'), 'a는 부모 base보다 앞');
    assert.ok(at('b') < at('base'), 'b는 부모 base보다 앞');
  });

  test('제약 안에서는 최신 커밋이 먼저 온다', () => {
    const out = orderCommits([
      c('old', ['base'], '2026-01-02T00:00:00Z'),
      c('new', ['base'], '2026-01-09T00:00:00Z'),
      c('base', [], '2026-01-01T00:00:00Z'),
    ]);
    assert.deepEqual(out.map((x) => x.sha), ['new', 'old', 'base']);
  });

  test('창 밖의 부모(모르는 sha)는 제약이 되지 않는다', () => {
    const out = orderCommits([c('a', ['unknown-parent'], '2026-01-01T00:00:00Z')]);
    assert.deepEqual(out.map((x) => x.sha), ['a']);
  });

  test('중복 없이 전부 한 번씩 나온다', () => {
    const input = [
      c('m', ['a', 'b'], '2026-01-05T00:00:00Z'),
      c('a', ['base'], '2026-01-03T00:00:00Z'),
      c('b', ['base'], '2026-01-04T00:00:00Z'),
      c('base', [], '2026-01-01T00:00:00Z'),
    ];
    const out = orderCommits(input);
    assert.equal(out.length, 4);
    assert.equal(new Set(out.map((x) => x.sha)).size, 4);
    assert.equal(out[0].sha, 'm');
    assert.equal(out[3].sha, 'base');
  });

  test('날짜가 없거나 깨져도 빠뜨리지 않는다', () => {
    const out = orderCommits([c('a', ['base'], null), c('base', [], 'not-a-date')]);
    assert.deepEqual(out.map((x) => x.sha), ['a', 'base']);
  });

  test('빈 입력 → 빈 배열', () => {
    assert.deepEqual(orderCommits([]), []);
  });
});

// ----- classifyRevParseError -----

describe('classifyRevParseError', () => {
  const err = (message, code) => Object.assign(new Error(message), { code });

  test('진짜 비-repo만 not-a-repo로 부른다', () => {
    assert.equal(
      classifyRevParseError(err('fatal: not a git repository (or any of the parent directories): .git')),
      'not-a-repo',
    );
  });

  test('소유권 거부는 따로 구분한다', () => {
    assert.equal(
      classifyRevParseError(err('fatal: detected dubious ownership in repository at /x')),
      'unsafe-repo',
    );
  });

  test('실행 파일 부재는 git-missing', () => {
    assert.equal(classifyRevParseError(err('spawn git ENOENT', 'EGITMISSING')), 'git-missing');
  });

  test('그 밖의 실패를 비-repo로 위장하지 않는다', () => {
    // 권한 오류·손상·타임아웃이 "저장소가 아닙니다"로 안내되면 사용자가 할 일을 알 수 없다.
    assert.equal(classifyRevParseError(err('fatal: cannot access .git: Permission denied')), 'git-failed');
    assert.equal(classifyRevParseError(err('error: object file is empty')), 'git-failed');
    assert.equal(classifyRevParseError(err('')), 'git-failed');
  });
});

// ----- 경로 판정 -----

describe('isInside / assignToWorktree', () => {
  const abs = (...p) => path.resolve(os.tmpdir(), ...p);

  test('같은 경로와 하위 경로는 참', () => {
    assert.equal(isInside(abs('repo'), abs('repo')), true);
    assert.equal(isInside(abs('repo'), abs('repo', 'src', 'a')), true);
  });

  test('형제 경로의 접두 일치를 하위로 오인하지 않는다', () => {
    assert.equal(isInside(abs('repo'), abs('repo-2')), false);
    assert.equal(isInside(abs('repo'), abs('repository')), false);
  });

  test('끝 구분자와 혼합 구분자에 흔들리지 않는다', () => {
    assert.equal(isInside(`${abs('repo')}${path.sep}`, abs('repo', 'src')), true);
    assert.equal(normalizePath(`${abs('repo')}${path.sep}`), normalizePath(abs('repo')));
  });

  test('빈 값은 항상 거짓', () => {
    assert.equal(isInside('', abs('repo')), false);
    assert.equal(isInside(abs('repo'), ''), false);
  });

  test('루트 경로가 빈 문자열로 뭉개지지 않는다', () => {
    // 끝 구분자 제거가 '/'까지 먹으면 루트에 놓인 worktree의 배정이 통째로 실패한다.
    const root = path.parse(path.resolve(os.tmpdir())).root; // '/' 또는 'C:\'
    assert.notEqual(normalizePath(root), '');
    assert.equal(isInside(root, abs('anything')), true);
  });

  test('중첩 worktree는 가장 깊은 쪽 하나에만 배정된다', () => {
    const wts = [{ path: abs('repo') }, { path: abs('repo', 'wt', 'feature') }];
    assert.equal(assignToWorktree(wts, abs('repo', 'src')), 0);
    assert.equal(assignToWorktree(wts, abs('repo', 'wt', 'feature', 'src')), 1);
    assert.equal(assignToWorktree(wts, abs('elsewhere')), -1);
  });
});

// ----- attachSessions -----

describe('attachSessions', () => {
  const abs = (...p) => path.resolve(os.tmpdir(), ...p);
  const fresh = () => [
    { path: abs('repo'), sessions: { live: [], past: [] } },
    { path: abs('repo-wt'), sessions: { live: [], past: [] } },
  ];

  test('라이브·지난 세션 모두 식별자만 담는다(표시할 이름은 클라이언트 몫)', () => {
    const wts = attachSessions(fresh(), {
      live: [
        { key: 'k1', cwd: abs('repo', 'src'), sessionId: 'live-1' },
        { key: 'k2', cwd: abs('repo-wt'), cliName: '터미널 이름' },
      ],
      past: [{ cwd: abs('repo'), dirName: 'd', sessionId: 's1', title: '지난 것', mtime: 5 }],
    });
    assert.deepEqual(wts[0].sessions.live, [{ key: 'k1', sessionId: 'live-1', cliName: null }]);
    // sessionId를 아직 모르는 세션도 key만으로 실린다(null로 명시).
    assert.deepEqual(wts[1].sessions.live, [{ key: 'k2', sessionId: null, cliName: '터미널 이름' }]);
    assert.equal(wts[0].sessions.past.length, 1);
    assert.equal(wts[0].sessions.past[0].sessionId, 's1');
  });

  test('라이브인 세션은 지난 목록에 겹쳐 담지 않는다', () => {
    const wts = attachSessions(fresh(), {
      live: [{ key: 'k1', cwd: abs('repo'), sessionId: 's1' }],
      past: [{ cwd: abs('repo'), dirName: 'd', sessionId: 's1', mtime: 1 }],
    });
    assert.equal(wts[0].sessions.past.length, 0);
  });

  test('지난 세션은 최신순으로 정렬된다', () => {
    const wts = attachSessions(fresh(), {
      past: [
        { cwd: abs('repo'), dirName: 'd', sessionId: 'old', mtime: 1 },
        { cwd: abs('repo'), dirName: 'd', sessionId: 'new', mtime: 9 },
      ],
    });
    assert.deepEqual(wts[0].sessions.past.map((s) => s.sessionId), ['new', 'old']);
  });

  test('cwd 없는 세션과 어느 worktree에도 없는 세션은 조용히 무시된다', () => {
    const wts = attachSessions(fresh(), {
      live: [{ key: 'k1', cwd: null }, { key: 'k2', cwd: abs('somewhere-else') }],
    });
    assert.equal(wts[0].sessions.live.length + wts[1].sessions.live.length, 0);
  });
});

// ----- mapLimit -----

describe('mapLimit', () => {
  // 이 풀이 사라지면 worktree 40개짜리 repo에서 조회 한 번이 git 프로세스 40개를
  // 한꺼번에 띄운다(codex 지적). 동시 실행 최댓값을 직접 관찰해 못 박는다.
  const spy = (limit) => {
    let inFlight = 0;
    let peak = 0;
    const fn = async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, 1); });
      inFlight -= 1;
      return item * 2;
    };
    return { fn, limit, peak: () => peak };
  };

  test('동시 실행 수가 상한을 넘지 않는다', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const s = spy(6);
    const out = await mapLimit(items, 6, s.fn);
    assert.equal(out.length, 40);
    assert.ok(s.peak() <= 6, `동시 실행 최댓값 ${s.peak()} > 6`);
    assert.ok(s.peak() > 1, '직렬로 도는 것도 아니어야 한다');
  });

  test('결과 순서는 입력 순서 그대로다', async () => {
    const s = spy(3);
    const out = await mapLimit([1, 2, 3, 4, 5], 3, s.fn);
    assert.deepEqual(out, [2, 4, 6, 8, 10]);
  });

  test('빈 입력과 상한 초과 입력 모두 안전하다', async () => {
    assert.deepEqual(await mapLimit([], 6, async () => 1), []);
    assert.deepEqual(await mapLimit([7], 6, async (x) => x + 1), [8]);
  });
});

// ----- collectWorktrees: 인자 검증(git 불필요) -----

describe('collectWorktrees 인자 검증', () => {
  test('상대경로·빈 값은 no-cwd', async () => {
    for (const bad of ['', null, undefined, 'relative/path', 42]) {
      const r = await collectWorktrees(bad);
      assert.equal(r.available, false, `${String(bad)} 는 거부되어야 한다`);
      assert.equal(r.reason, 'no-cwd');
      assert.deepEqual(r.worktrees, []);
    }
  });

  test('git 실행 파일이 없으면 오류가 아니라 git-missing 결과', async () => {
    const r = await collectWorktrees(os.tmpdir(), {
      gitPath: path.join(os.tmpdir(), 'ccob-no-such-git-binary'),
    });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'git-missing');
  });
});

// ----- collectWorktrees: 실제 repo -----

const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

const gitAvailable = await run('git', ['--version'], os.tmpdir()).then(() => true, () => false);

describe('collectWorktrees (실제 git repo)', { skip: gitAvailable ? false : 'git 없음' }, () => {
  let root;
  let main;
  let linked;

  // 커밋 신원과 기본 브랜치는 **이 repo 안에만** 설정한다 — 사용자의 전역 git 설정을
  // 읽지도 바꾸지도 않는다(-c 로 호출마다 주입).
  const IDENT = [
    '-c', 'user.name=ccob test', '-c', 'user.email=ccob@test.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master',
  ];
  const git = (args, cwd) => run('git', [...IDENT, ...args], cwd);

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-git '));
    main = path.join(root, 'main repo'); // 공백 있는 경로로 인용 처리까지 함께 검증
    linked = path.join(root, 'wt-feature');
    await fs.mkdir(main, { recursive: true });
    await git(['init'], main);
    await fs.writeFile(path.join(main, 'a.txt'), 'hello\n');
    await git(['add', '.'], main);
    await git(['commit', '-m', 'base: 최초 커밋'], main);
    await git(['branch', 'feature'], main);
    await git(['worktree', 'add', linked, 'feature'], main);
    // 연결 worktree에서만 커밋을 하나 더 쌓아 두 머리가 갈라지게 한다
    await fs.writeFile(path.join(linked, 'b.txt'), 'feature\n');
    await git(['add', '.'], linked);
    await git(['commit', '-m', 'feat: 갈래 커밋'], linked);
    // 주 worktree는 더럽게 둔다 — clean/dirty 구분을 실제로 확인하려고
    await fs.writeFile(path.join(main, 'a.txt'), 'changed\n');
    await fs.writeFile(path.join(main, 'untracked.txt'), 'new\n');
  });

  after(async () => {
    // Windows에서는 git이 잡고 있던 핸들이 늦게 풀려 첫 시도가 EBUSY로 실패할 수 있다.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('주 worktree와 연결 worktree를 모두 찾는다', async () => {
    const r = await collectWorktrees(main);
    assert.equal(r.available, true);
    assert.equal(r.reason, null);
    assert.equal(r.worktrees.length, 2);
    assert.equal(r.worktrees[0].isMain, true);
    assert.equal(r.worktrees[1].isMain, false);
    const branches = r.worktrees.map((w) => w.branch).sort();
    assert.deepEqual(branches, ['feature', 'master']);
    assert.equal(r.truncated, false);
  });

  test('연결 worktree에서 물어도 같은 목록을 준다', async () => {
    const r = await collectWorktrees(linked);
    assert.equal(r.available, true);
    assert.equal(r.worktrees.length, 2);
  });

  test('dirty/clean 상태와 변경 파일 수가 실제와 맞는다', async () => {
    const r = await collectWorktrees(main);
    const mainWt = r.worktrees.find((w) => w.branch === 'master');
    const featWt = r.worktrees.find((w) => w.branch === 'feature');
    assert.equal(mainWt.status.clean, false);
    assert.equal(mainWt.status.total, 2); // 수정 1 + 미추적 1
    assert.equal(mainWt.status.untracked, 1);
    assert.equal(mainWt.status.unstaged, 1);
    assert.equal(featWt.status.clean, true);
    assert.equal(featWt.status.total, 0);
  });

  test('worktree마다 자기 최근 커밋을 단다', async () => {
    const r = await collectWorktrees(main);
    const mainWt = r.worktrees.find((w) => w.branch === 'master');
    const featWt = r.worktrees.find((w) => w.branch === 'feature');
    assert.equal(mainWt.lastCommit.subject, 'base: 최초 커밋');
    assert.equal(featWt.lastCommit.subject, 'feat: 갈래 커밋');
    assert.notEqual(mainWt.lastCommit.sha, featWt.lastCommit.sha);
    assert.match(featWt.lastCommit.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('그래프가 두 머리의 커밋을 모두 담고 레인이 배정된다', async () => {
    const r = await collectWorktrees(main);
    const subjects = r.graph.rows.map((c) => c.subject);
    assert.ok(subjects.includes('base: 최초 커밋'));
    assert.ok(subjects.includes('feat: 갈래 커밋'));
    assert.equal(r.graph.rows.length, 2);
    assert.ok(r.graph.lanes >= 1);
    for (const row of r.graph.rows) {
      assert.equal(typeof row.lane, 'number');
      assert.ok(row.lane >= 0 && row.lane < r.graph.lanes);
    }
  });

  test('repo 안의 하위 디렉터리에서 물어도 최상위를 기준으로 답한다', async () => {
    const sub = path.join(main, 'nested', 'deep');
    await fs.mkdir(sub, { recursive: true });
    const r = await collectWorktrees(sub);
    assert.equal(r.available, true);
    assert.equal(r.worktrees.length, 2);
  });

  test('git repo가 아닌 디렉터리는 오류가 아니라 not-a-repo', async () => {
    const plain = path.join(root, 'plain dir');
    await fs.mkdir(plain, { recursive: true });
    const r = await collectWorktrees(plain);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'not-a-repo');
    assert.deepEqual(r.worktrees, []);
  });

  test('세션 배정이 실제 worktree 경로와 맞물린다', async () => {
    const r = await collectWorktrees(main);
    attachSessions(r.worktrees, {
      live: [{ key: 'live-1', cwd: path.join(linked, 'sub') }],
      past: [{ cwd: main, dirName: 'd', sessionId: 'past-1', title: 't', mtime: 1 }],
    });
    const featWt = r.worktrees.find((w) => w.branch === 'feature');
    const mainWt = r.worktrees.find((w) => w.branch === 'master');
    assert.deepEqual(featWt.sessions.live, [{ key: 'live-1', sessionId: null, cliName: null }]);
    assert.equal(mainWt.sessions.live.length, 0);
    assert.equal(mainWt.sessions.past[0].sessionId, 'past-1');
  });

  test('detached HEAD worktree도 브랜치 없이 온전히 실린다', async () => {
    // 브랜치 대신 커밋을 직접 체크아웃한 worktree — branch=null, detached=true여야 하고,
    // 그래도 상태·최근 커밋·그래프 참여는 전부 정상이어야 한다.
    const det = path.join(root, 'wt detached');
    const sha = (await git(['rev-parse', 'HEAD'], main)).trim();
    await git(['worktree', 'add', '--detach', det, sha], main);
    try {
      const r = await collectWorktrees(main);
      const wt = r.worktrees.find((w) => w.path.replace(/\\/g, '/').endsWith('wt detached'));
      assert.ok(wt, 'detached worktree가 목록에 있어야 한다');
      assert.equal(wt.detached, true);
      assert.equal(wt.branch, null);
      assert.equal(wt.status.clean, true);
      assert.equal(wt.lastCommit.subject, 'base: 최초 커밋');
      // 브랜치가 없어도 카드 제목으로 쓸 head sha는 있어야 한다.
      assert.match(wt.head, /^[0-9a-f]{7,}$/);
    } finally {
      await git(['worktree', 'remove', '--force', det], main);
    }
  });

  test('한 브랜치가 상한만큼 앞서 있어도 뒤진 worktree의 HEAD가 그래프에 남는다', async () => {
    // 총 상한 하나를 모든 갈래가 나눠 쓰면, 앞선 브랜치가 상한을 다 먹고 뒤진 브랜치의
    // HEAD가 목록에서 통째로 빠진다 — 그 worktree는 그래프에 나타나지도 못한다.
    const ahead = path.join(root, 'wt ahead');
    await git(['worktree', 'add', '-b', 'far-ahead', ahead], main);
    try {
      // --allow-empty로 쌓는다 — 검증 대상은 커밋 **개수**이지 내용이 아니라, 파일을
      // 쓰고 add하는 왕복을 없애면 같은 보장을 훨씬 빠르게 얻는다.
      for (let i = 0; i < MAX_GRAPH_COMMITS + 5; i += 1) {
        await git(['commit', '--allow-empty', '-m', `bulk ${i}`], ahead);
      }
      const r = await collectWorktrees(main);
      const shas = new Set(r.graph.rows.map((c) => c.sha));
      for (const wt of r.worktrees) {
        if (!wt.head) continue;
        assert.ok(
          shas.has(wt.head),
          `${wt.branch ?? wt.head}의 HEAD가 그래프에서 빠졌다`,
        );
      }
      // 그래도 유한하다 — 갈래 수 × 갈래별 최소 몫으로 묶인다.
      assert.ok(r.graph.rows.length <= r.worktrees.length * MAX_GRAPH_COMMITS);
      // 위상 순서도 지켜져야 한다(부모가 자식보다 뒤).
      const rowOf = new Map(r.graph.rows.map((c) => [c.sha, c.row]));
      for (const c of r.graph.rows) {
        for (const p of c.parents) {
          if (rowOf.has(p)) assert.ok(rowOf.get(p) > c.row, `${c.short}의 부모가 위에 있다`);
        }
      }
    } finally {
      await git(['worktree', 'remove', '--force', ahead], main);
      await git(['branch', '-D', 'far-ahead'], main);
    }
  });

  test('bare 저장소도 오류가 아니라 정상 목록으로 답한다', async () => {
    // bare에는 작업트리가 없어 --show-toplevel이 실패한다. 그것을 판정 기준으로 삼으면
    // bare 저장소에서 연 세션이 "저장소가 아님"으로 잘못 안내된다.
    const bare = path.join(root, 'demo bare.git');
    await git(['clone', '--bare', main, bare], root);
    const r = await collectWorktrees(bare);
    assert.equal(r.available, true, r.message ?? '');
    assert.equal(r.reason, null);
    assert.ok(r.root, 'bare에서도 표시할 최상위 경로가 있어야 한다');
    assert.equal(r.worktrees.length, 1);
    // 작업트리가 없으니 상태는 비지만, 커밋은 공용 자산이라 읽혀야 한다.
    assert.equal(r.worktrees[0].status, null);
    assert.equal(r.worktrees[0].unreadable, false);
    assert.ok(r.worktrees[0].lastCommit, 'bare에서도 최근 커밋이 나와야 한다');
    assert.ok(r.graph.rows.length > 0);
  });

  test('커밋이 하나도 없는 repo도 오류 없이 답한다', async () => {
    const empty = path.join(root, 'empty repo');
    await fs.mkdir(empty, { recursive: true });
    await git(['init'], empty);
    const r = await collectWorktrees(empty);
    assert.equal(r.available, true);
    assert.equal(r.worktrees.length, 1);
    assert.equal(r.worktrees[0].lastCommit, null);
    assert.deepEqual(r.graph.rows, []);
  });
});
