# Session Tree Unification + Natural Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바를 "현재 세션 핀 고정" 통합 디렉토리 트리로 재구성하고, 무의존 순수 CSS로 절제된 모션(뷰 전환·트리 펼침·모달 개폐·등장)을 추가한다.

**Architecture:** 순수 함수 `sessionTree.js`가 라이브 세션 + 히스토리 프로젝트를 디렉토리(cwd) 노드로 병합(활성 세션 디렉토리를 pinned)한다. `Sidebar.jsx`가 그 트리를 렌더한다. 모션 레이어(CSS 토큰 + keyframes + 작은 `usePresence` 훅)가 뷰 전환·트리 펼침·모달·메시지/도구 등장에 fade/slide를 입히며, 모두 `transform`/`opacity` 우선 + `prefers-reduced-motion` 게이팅. 서버·프로토콜·store 리듀서 변경 없음.

**Tech Stack:** React 19, Vite 8, 순수 CSS(모션 라이브러리 없음), Node 내장 test runner(`node --test`).

## Global Constraints

Every task's requirements implicitly include this section.

- 새 npm 의존성 금지, CDN/외부 자산 금지 (CSP 안전·자체 완결). [스펙: 순수 CSS only]
- Anthropic SDK/API 금지. 테스트는 절대 실제 claude 실행 금지(fake-cli만).
- 서버 REST/WS·CLI 프로토콜·store 리듀서 스키마 변경 금지.
- 모션 톤: 120–220ms, `ease-out`, fade + 짧은 slide, 오버슈트/스프링 없음.
- `prefers-reduced-motion: reduce`에서 모션 전역 축소.
- `transform`/`opacity` 우선. 레이아웃 애니는 사이드바(`grid-template-columns`)·트리 펼침(`grid-template-rows`)만 허용.
- 코드/식별자/경로는 영문 유지, 주석·표시 문구는 기존 한국어 관례 따름.

---

## File Structure

- `client/src/lib/sessionTree.js` (신규) — 라이브+히스토리 병합·정렬·dedupe 순수 함수. React/DOM 의존 없음.
- `client/test/sessionTree.test.js` (신규) — sessionTree 단위 테스트(`node --test`).
- `client/src/lib/usePresence.js` (신규) — 마운트/exit 전환 훅(모달 닫힘 애니).
- `client/src/theme.css` (수정) — 모션 토큰, 공용 keyframes, reduced-motion.
- `client/src/components/Sidebar.jsx` (수정) — sessionTree 소비, 핀 트리 렌더, NewSessionModal에 usePresence.
- `client/src/components/interact.css` (수정) — 트리·핀 박스·펼침 애니·사이드바 접기·모달 개폐·버튼 press.
- `client/src/components/chat.css` (수정) — 뷰 전환·메시지·도구카드 등장.
- `client/src/App.jsx` (수정) — 사이드바 접기 트랜지션(클래스는 이미 있음, CSS만).
- `client/src/components/ChatView.jsx` (수정) — 뷰 전환 컨테이너 클래스 재적용 + 새 메시지 게이팅.
- `client/src/components/Message.jsx` (수정) — 등장 클래스(`isNew`).
- `client/src/components/ToolCard.jsx` (수정) — 등장 클래스 훅업(Message 경유).
- `client/src/components/PermissionDialog.jsx` (수정) — 열림 애니(enter-only).
- `package.json` (수정) — test 스크립트에 client 테스트 포함.

---

### Task 1: `sessionTree.js` — 병합·정렬·dedupe 순수 모듈 + 단위 테스트

**Files:**
- Create: `client/src/lib/sessionTree.js`
- Test: `client/test/sessionTree.test.js`
- Modify: `package.json` (test 스크립트)

**Interfaces:**
- Produces:
  - `shortDir(path: string) => string` — 마지막 2 세그먼트 축약(`…\b\c`).
  - `buildSessionTree({ liveSessions, projects, historyByDir, activeKey }) => { pinned: DirNode|null, others: DirNode[] }`
    - 입력: `liveSessions: [{ key, cwd, sessionId, status }]`, `projects: [{ dirName, cwd, sessionCount, lastModified }]`, `historyByDir: { [dirName]: [{ sessionId, title, mtime }] | 'loading' | undefined }`, `activeKey: string|null`
    - `DirNode = { key, cwd, dirName, label, mtime, count, hasLive, active, historyLoaded, live: LiveRow[], history: HistoryRow[] }`
    - `LiveRow = { key, sessionId, status, active }`; `HistoryRow = { sessionId, title, mtime }`

- [x] **Step 1: 실패 테스트 작성** — `client/test/sessionTree.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionTree, shortDir } from '../src/lib/sessionTree.js';

test('sessionId가 null인 두 라이브 세션은 절대 합쳐지지 않는다', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [
      { key: 'a', cwd: 'C:\\p', sessionId: null, status: 'idle' },
      { key: 'b', cwd: 'C:\\p', sessionId: null, status: 'idle' },
    ],
    projects: [],
    historyByDir: {},
    activeKey: 'a',
  });
  assert.equal(pinned.live.length, 2);
  assert.equal(others.length, 0);
});

test('재개된 라이브와 같은 non-null sessionId를 가진 히스토리 행은 숨겨진다', () => {
  const { pinned } = buildSessionTree({
    liveSessions: [{ key: 'a', cwd: 'C:\\p', sessionId: 's1', status: 'idle' }],
    projects: [{ dirName: 'C--p', cwd: 'C:\\p', sessionCount: 2, lastModified: 10 }],
    historyByDir: { 'C--p': [
      { sessionId: 's1', title: 'x', mtime: 5 },
      { sessionId: 's2', title: 'y', mtime: 4 },
    ] },
    activeKey: 'a',
  });
  assert.deepEqual(pinned.history.map((h) => h.sessionId), ['s2']);
});

test('활성 세션의 디렉토리가 pinned, 나머지는 others', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [{ key: 'a', cwd: 'C:\\p', sessionId: null, status: 'idle' }],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: 'a',
  });
  assert.equal(pinned.cwd, 'C:\\p');
  assert.equal(others.length, 1);
  assert.equal(others[0].cwd, 'C:\\q');
});

test('others 정렬: 라이브 있는 디렉토리 먼저, 그다음 mtime 내림차순', () => {
  const { others } = buildSessionTree({
    liveSessions: [
      { key: 'act', cwd: 'C:\\active', sessionId: null, status: 'idle' },
      { key: 'x', cwd: 'C:\\live', sessionId: null, status: 'idle' },
    ],
    projects: [
      { dirName: 'C--old', cwd: 'C:\\old', sessionCount: 1, lastModified: 1 },
      { dirName: 'C--new', cwd: 'C:\\new', sessionCount: 1, lastModified: 99 },
    ],
    historyByDir: {},
    activeKey: 'act',
  });
  assert.equal(others[0].cwd, 'C:\\live');
  assert.equal(others[1].cwd, 'C:\\new');
  assert.equal(others[2].cwd, 'C:\\old');
});

test('활성 세션이 없으면 pinned=null', () => {
  const { pinned, others } = buildSessionTree({
    liveSessions: [],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: null,
  });
  assert.equal(pinned, null);
  assert.equal(others.length, 1);
});

test('접힌(로드 안 된) 디렉토리는 historyLoaded=false, history=[]', () => {
  const { others } = buildSessionTree({
    liveSessions: [],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 3, lastModified: 10 }],
    historyByDir: {},
    activeKey: null,
  });
  assert.equal(others[0].historyLoaded, false);
  assert.equal(others[0].history.length, 0);
  assert.equal(others[0].count, 3);
});

test('접힌 디렉토리에 라이브 세션이 있으면 hasLive=true', () => {
  const { others } = buildSessionTree({
    liveSessions: [
      { key: 'act', cwd: 'C:\\active', sessionId: null, status: 'idle' },
      { key: 'x', cwd: 'C:\\q', sessionId: null, status: 'thinking' },
    ],
    projects: [{ dirName: 'C--q', cwd: 'C:\\q', sessionCount: 1, lastModified: 10 }],
    historyByDir: {},
    activeKey: 'act',
  });
  const q = others.find((n) => n.cwd === 'C:\\q');
  assert.equal(q.hasLive, true);
});

test('shortDir: 마지막 2 세그먼트로 축약', () => {
  assert.equal(shortDir('C:\\a\\b\\c'), '…\\b\\c');
  assert.equal(shortDir('C:\\a'), 'C:\\a');
  assert.equal(shortDir(''), '');
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/sessionTree.js'` (또는 export 없음). *(먼저 Step 4의 package.json 수정을 적용해야 client 테스트가 수집된다. 순서상 Step 2에서 실패를 보려면 Step 4를 먼저 해도 무방 — 실패 메시지만 확인.)*

- [x] **Step 3: 최소 구현** — `client/src/lib/sessionTree.js`

```js
// 라이브 세션 + 히스토리 프로젝트를 디렉토리(cwd) 단위 트리로 병합하는 순수 함수.
// React/DOM 의존 없음 → node --test 로 단위 테스트 가능.
// 식별 규칙: 라이브는 hub key로 식별(초기 sessionId=null 허용, 서로 절대 합치지 않음),
// 히스토리는 sessionId로 식별, 병합 시 non-null sessionId가 일치하는 히스토리만 숨김.

export function shortDir(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : `…\\${parts.slice(-2).join('\\')}`;
}

function dirKeyOf(seed) {
  return (seed.cwd && String(seed.cwd).trim()) || seed.dirName || '';
}

export function buildSessionTree({
  liveSessions = [],
  projects = [],
  historyByDir = {},
  activeKey = null,
} = {}) {
  const dirs = new Map(); // dirKey -> DirNode(부분)

  const ensure = (seed) => {
    const key = dirKeyOf(seed);
    let node = dirs.get(key);
    if (!node) {
      node = {
        key,
        cwd: seed.cwd ?? null,
        dirName: seed.dirName ?? null,
        mtime: seed.mtime ?? 0,
        count: seed.count ?? 0,
        live: [],
        history: [],
      };
      dirs.set(key, node);
    } else {
      if (!node.cwd && seed.cwd) node.cwd = seed.cwd;
      if (!node.dirName && seed.dirName) node.dirName = seed.dirName;
      if (seed.mtime && seed.mtime > node.mtime) node.mtime = seed.mtime;
      if (seed.count) node.count = seed.count;
    }
    return node;
  };

  // 1) 프로젝트(히스토리) — dirName/cwd/mtime/count 확보.
  for (const p of projects) {
    ensure({
      cwd: p.cwd,
      dirName: p.dirName,
      mtime: p.lastModified ?? p.mtime ?? 0,
      count: p.sessionCount ?? 0,
    });
  }

  // 2) 라이브 세션 — cwd로 그룹, key로 개별 행.
  const activeCwd =
    liveSessions.find((s) => s.key === activeKey)?.cwd ?? null;
  for (const s of liveSessions) {
    const node = ensure({ cwd: s.cwd });
    node.live.push({
      key: s.key,
      sessionId: s.sessionId ?? null,
      status: s.status,
      active: s.key === activeKey,
    });
  }

  // 3) 히스토리 행 dedupe + 파생 필드.
  for (const node of dirs.values()) {
    const liveIds = new Set(
      node.live.map((l) => l.sessionId).filter((id) => id != null),
    );
    const hist = node.dirName ? historyByDir[node.dirName] : undefined;
    node.historyLoaded = Array.isArray(hist);
    node.history = node.historyLoaded
      ? hist
          .filter((h) => !(h.sessionId != null && liveIds.has(h.sessionId)))
          .map((h) => ({ sessionId: h.sessionId, title: h.title, mtime: h.mtime }))
      : [];
    node.hasLive = node.live.length > 0;
    node.active = node.cwd != null && node.cwd === activeCwd;
    node.label = shortDir(node.cwd) || node.dirName || node.key;
  }

  const all = [...dirs.values()];
  const pinned = all.find((n) => n.active) ?? null;
  const others = all
    .filter((n) => n !== pinned)
    .sort((a, b) => Number(b.hasLive) - Number(a.hasLive) || b.mtime - a.mtime);

  return { pinned, others };
}
```

- [x] **Step 4: 테스트 스크립트에 client 테스트 포함** — `package.json`

`"test"` 스크립트를 다음으로 교체:

```json
"test": "node --test \"server/test/*.test.js\" \"client/test/*.test.js\"",
```

- [x] **Step 5: 테스트 통과 확인**

Run: `npm test`
Expected: PASS — 기존 38 + 신규 8 = **46 tests, 0 fail**. (신규 8개가 카운트에 나타나는지 확인 — 안 나타나면 node가 client 글롭을 수집 못 한 것이니 node 버전/글롭 확인.)

- [x] **Step 6: 커밋**

```bash
git add client/src/lib/sessionTree.js client/test/sessionTree.test.js package.json
git commit -m "feat(client): add sessionTree pure merge/dedupe module + tests"
```

---

### Task 2: 모션 기반 — 토큰 · 공용 keyframes · reduced-motion (`theme.css`)

**Files:**
- Modify: `client/src/theme.css`

**Interfaces:**
- Produces (CSS): 변수 `--ease-out`, `--dur-micro/fast/base/slow`; keyframes `enter-rise`, `overlay-in`, `dialog-in`; 전역 `prefers-reduced-motion` 축소.

- [x] **Step 1: 모션 토큰 추가** — `:root` 블록 끝(`--composer-max: 760px;` 다음 줄, 닫는 `}` 앞)에 삽입:

```css
  /* Motion — refined/fast (tone A) */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --dur-micro: 90ms;
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --dur-slow: 220ms;
```

- [x] **Step 2: 공용 keyframes + reduced-motion 추가** — 파일 맨 끝에 추가:

```css
/* ============================================================
   Motion — shared keyframes + reduced-motion (tone A: fade+slide)
   ============================================================ */
@keyframes enter-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes enter-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes overlay-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes dialog-in {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* 뷰 전환용 — 컨테이너에 클래스 재적용해 재생 */
.view-enter { animation: enter-rise var(--dur-base) var(--ease-out) both; }

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [x] **Step 3: 빌드 확인**

Run: `npm run build --prefix client`
Expected: PASS — `✓ built`. (CSS만 추가했으므로 컴파일 성공.)

- [x] **Step 4: 커밋**

```bash
git add client/src/theme.css
git commit -m "feat(client): add motion tokens, shared keyframes, reduced-motion"
```

---

### Task 3: 사이드바 핀 트리 재구성 + 펼침 애니 (`Sidebar.jsx`, `interact.css`)

**Files:**
- Modify: `client/src/components/Sidebar.jsx`
- Modify: `client/src/components/interact.css`

**Interfaces:**
- Consumes: `buildSessionTree`, `shortDir` (Task 1); `--ease-out`, `--dur-*` (Task 2).

- [x] **Step 1: import 추가** — `Sidebar.jsx` 상단, `Brand.jsx` import 아래에:

```js
import { buildSessionTree } from '../lib/sessionTree.js';
```

(기존 로컬 `shortPath`는 유지하거나 `shortDir`로 대체 가능. 본 Task는 트리 렌더에 `sessionTree`의 label을 쓰므로 로컬 `shortPath`는 그대로 두어도 무방.)

- [x] **Step 2: 트리 파생 + 하위 컴포넌트 추가** — `Sidebar` 함수 본문, `const openSessions = [...state.sessions.values()];` 다음에 삽입:

```js
  const tree = buildSessionTree({
    liveSessions: openSessions,
    projects: state.projects,
    historyByDir: expanded,
    activeKey: state.activeKey,
  });

  // 라이브 세션 행
  const LiveRow = ({ row, node }) => {
    const badge = STATUS_BADGE[row.status] ?? { label: row.status, cls: '' };
    const label = row.sessionId ? row.sessionId.slice(0, 8) : '새 세션';
    return (
      <div className={`sess-row live${row.active ? ' active' : ''}`}>
        <button
          type="button"
          className="sess-main"
          onClick={() => dispatch({ type: 'set-active', key: row.key })}
          title={node.cwd || node.label}
        >
          <span className="sess-dot live" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </button>
        {row.status !== 'exited' && (
          <button
            type="button"
            className="session-stop"
            aria-label="세션 종료"
            title="세션 종료 (CLI 프로세스 정지)"
            onClick={() => stopSession(row.key)}
          >
            ✕
          </button>
        )}
      </div>
    );
  };

  // 재개 가능 히스토리 행
  const HistoryRow = ({ h, node }) => (
    <button
      type="button"
      className="sess-row history"
      disabled={!node.cwd}
      title={node.cwd ? `재개: ${h.sessionId}` : 'cwd를 알 수 없어 재개할 수 없습니다'}
      onClick={() =>
        node.cwd &&
        resumeSession({ dirName: node.dirName, cwd: node.cwd }, { sessionId: h.sessionId })
      }
    >
      <span className="sess-dot" aria-hidden="true" />
      <span className="truncate">{h.title || '(제목 없음)'}</span>
      <span className="rs-meta dim">{fmtTime(h.mtime)}</span>
    </button>
  );

  // 디렉토리 그룹(헤더 + 펼침 영역)
  const DirGroup = ({ node, pinned = false }) => {
    const open = pinned || !!expanded[node.dirName];
    return (
      <div className={`dir-group${node.active ? ' active-dir' : ''}`}>
        <button
          type="button"
          className="dir-head"
          onClick={() => node.dirName && toggleProject(node.dirName)}
          disabled={!node.dirName}
          title={node.cwd || node.label}
        >
          {!pinned && (
            <span className="dir-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          )}
          <span className="dir-ico" aria-hidden="true">📁</span>
          <span className="truncate">{node.label}</span>
          {!open && node.hasLive && (
            <span className="live-dot" title="열린 세션 있음" aria-hidden="true" />
          )}
          <span className="badge">{node.count || node.live.length}</span>
        </button>
        <div className="dir-rows" data-open={open ? 'true' : 'false'}>
          <div className="dir-rows-inner">
            {node.live.map((row) => (
              <LiveRow key={row.key} row={row} node={node} />
            ))}
            {expanded[node.dirName] === 'loading' && (
              <div className="dim dir-loading">불러오는 중…</div>
            )}
            {node.history.map((h) => (
              <HistoryRow key={h.sessionId} h={h} node={node} />
            ))}
            {open &&
              node.live.length === 0 &&
              node.historyLoaded &&
              node.history.length === 0 && (
                <div className="dim dir-empty">세션 없음</div>
              )}
          </div>
        </div>
      </div>
    );
  };
```

*주의:* 기존 `resumeSession(project, meta)`는 `project.dirName`, `project.cwd`, `meta.sessionId`를 사용하므로 위 `HistoryRow`가 넘기는 `{ dirName, cwd }` / `{ sessionId }` 형태와 호환된다. 확인만 하고 시그니처는 바꾸지 않는다.

- [x] **Step 3: `.sidebar-inner` 렌더를 트리로 교체** — `Sidebar.jsx`에서 기존 "열린 세션" 블록과 "최근 세션" 블록(즉 `{openSessions.length > 0 && ( ... )}` 부터 `state.projects.map(...)` 렌더 끝까지)을 다음으로 교체:

```jsx
        {tree.pinned && (
          <div className="pin-box">
            <div className="sidebar-h">현재 세션</div>
            <DirGroup node={tree.pinned} pinned />
          </div>
        )}

        <div className="sidebar-h">
          다른 프로젝트
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={refreshProjects}
            aria-label="최근 세션 새로고침"
            title="새로고침"
          >
            ↻
          </button>
        </div>

        {tree.others.length === 0 && (
          <div className="dim" style={{ fontSize: 12.5 }}>
            다른 프로젝트가 없습니다.
          </div>
        )}
        {tree.others.map((node) => (
          <DirGroup key={node.key} node={node} />
        ))}
```

기존 하단 `{error && ...}` 와 `{openSessions.length === 0 && (빈 상태)}` 블록은 그대로 둔다. (빈 상태 조건 `isEmpty`도 유지.)

- [x] **Step 4: 트리·핀 박스·펼침 애니 스타일 추가** — `interact.css` 끝에 추가:

```css
/* ===== 통합 세션 트리 ===== */
.pin-box {
  margin: 4px 0 10px;
  padding: 6px;
  border: 1px solid var(--accent-line);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  animation: enter-fade var(--dur-base) var(--ease-out) both;
}
.pin-box .sidebar-h { margin-top: 2px; color: var(--accent); }

.dir-group { margin: 1px 0; }
.dir-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  color: var(--text-dim);
  text-align: left;
}
.dir-head:hover { background: var(--surface-2); color: var(--text); }
.dir-head:disabled { opacity: 1; cursor: default; }
.dir-caret { width: 12px; flex: none; font-size: 10px; transition: transform var(--dur-fast) var(--ease-out); }
.dir-ico { flex: none; }
.dir-head .badge { margin-left: auto; }
.active-dir > .dir-head { color: var(--text); }
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent); flex: none;
}

/* 펼침 — grid-rows 0fr→1fr (순수 CSS, JS 높이 계산 불필요) */
.dir-rows {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.dir-rows[data-open='true'] { grid-template-rows: 1fr; }
.dir-rows-inner { overflow: hidden; min-height: 0; }

.sess-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px 5px 22px;
  border-radius: var(--r-sm);
  color: var(--text-dim);
  text-align: left;
}
.sess-row.history:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.sess-row.live { padding-right: 4px; }
.sess-row .sess-main {
  display: flex; align-items: center; gap: 7px;
  flex: 1; min-width: 0; padding: 0; border: none; background: none;
  color: inherit; text-align: left;
}
.sess-row.live.active { background: var(--accent-soft); color: var(--text); }
.sess-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex: none; }
.sess-dot.live { background: var(--accent); }
.sess-row .rs-meta { margin-left: auto; font-size: 11px; }
.dir-loading, .dir-empty { padding: 4px 8px 4px 22px; font-size: 12px; }
```

기존 `.session-tab`/`.session-tab-row`/`.proj-*`/`.recent-session` 규칙은 더 이상 참조되지 않으면 삭제해도 되나, 이번 Task 범위에서는 남겨도 무해하므로 **삭제하지 않는다**(회귀 위험 최소).

- [x] **Step 5: 빌드 + 브라우저 실측**

Run: `npm run build --prefix client`
Expected: PASS.

그다음 fake-cli로 실측:
```bash
node scripts/dev-fake.mjs --port 8790 --scenario echo
```
Brave에서 출력된 `http://127.0.0.1:8790/#token=...` 접속(원격 디버깅으로 구동 중이면 chrome-devtools MCP 사용). 확인:
- 세션 시작 전: "다른 프로젝트"에 디렉토리들이 접힌 상태로 보임. 디렉토리 클릭 시 아래로 **부드럽게 펼쳐지며**(grid-rows) 히스토리 행 표시.
- 세션 시작 후: 상단에 "현재 세션" 핀 박스가 나타나고 활성 세션(●)이 강조됨. 다른 디렉토리는 접힌 채 라이브가 있으면 `live-dot` 표시.
- 콘솔 에러 없음.

정리:
```bash
# dev-fake 서버 종료(포트 8790 리스너 kill)
```

- [x] **Step 6: 커밋**

```bash
git add client/src/components/Sidebar.jsx client/src/components/interact.css
git commit -m "feat(client): unify sidebar into current-session-pinned directory tree"
```

---

### Task 4: `usePresence` 훅 + 모달 개폐 애니 (`usePresence.js`, `Sidebar.jsx`, `PermissionDialog.jsx`, `interact.css`)

**Files:**
- Create: `client/src/lib/usePresence.js`
- Modify: `client/src/components/Sidebar.jsx` (NewSessionModal leave)
- Modify: `client/src/components/PermissionDialog.jsx` (enter 애니만)
- Modify: `client/src/components/interact.css` (overlay/dialog 애니)

**Interfaces:**
- Produces: `usePresence(isOpen: boolean, duration = 140) => { mounted: boolean, status: 'open' | 'closing' }`

- [x] **Step 1: `usePresence` 훅 작성** — `client/src/lib/usePresence.js`

```js
// 모달 leave 애니메이션용 존재(presence) 훅.
// isOpen이 false로 바뀌면 duration 동안 mounted를 유지하며 status='closing' →
// 소비 측이 .closing 클래스로 페이드아웃 후 언마운트.
import { useEffect, useRef, useState } from 'react';

export function usePresence(isOpen, duration = 140) {
  const [state, setState] = useState(() => ({
    mounted: isOpen,
    status: isOpen ? 'open' : 'closed',
  }));
  const timerRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setState({ mounted: true, status: 'open' });
      return undefined;
    }
    // 닫힘 시작
    setState((s) => (s.mounted ? { mounted: true, status: 'closing' } : s));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState({ mounted: false, status: 'closed' });
    }, duration);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isOpen, duration]);

  return { mounted: state.mounted, status: state.status };
}
```

- [x] **Step 2: NewSessionModal에 usePresence 연결** — `Sidebar.jsx`

import에 추가:
```js
import { usePresence } from '../lib/usePresence.js';
```

`Sidebar` 본문에서 모달 렌더를 교체. 기존:
```jsx
      {modalOpen && (
        <NewSessionModal ... />
      )}
```
를 다음으로:
```jsx
      <NewSessionPresence
        open={modalOpen}
        initInfo={state.initInfo}
        projects={state.projects}
        defaultCwd={defaultCwd}
        onClose={closeModal}
        onStart={(opts) => {
          closeModal();
          startSession(opts);
        }}
      />
```

그리고 파일 하단(다른 최상위 함수 옆)에 래퍼 추가:
```jsx
function NewSessionPresence({ open, ...rest }) {
  const { mounted, status } = usePresence(open, 140);
  if (!mounted) return null;
  return <NewSessionModal {...rest} presenceStatus={status} />;
}
```

`NewSessionModal`의 최상위 오버레이 div에 `closing` 클래스를 전달 — `className="modal-overlay"` 를:
```jsx
    <div className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`} ...>
```
로 바꾸고, `NewSessionModal({ ... })` 시그니처에 `presenceStatus` 파라미터를 추가한다.

- [x] **Step 3: PermissionDialog 열림 애니(enter-only)** — 별도 코드 변경 없이 CSS로 처리(Step 4). PermissionDialog는 leave 애니 미적용(스펙 §2.3) — 구조 변경 없음. (`usePresence` 사용하지 않음.)

- [x] **Step 4: overlay/dialog 애니 CSS** — `interact.css`의 기존 `.modal-overlay`/`.modal` 규칙에 애니 추가(규칙을 찾아 `animation` 선언을 더한다):

```css
.modal-overlay {
  /* ...기존 선언 유지... */
  animation: overlay-in var(--dur-fast) var(--ease-out) both;
}
.modal-overlay.closing { animation: overlay-in var(--dur-fast) var(--ease-out) reverse both; }

.modal,
.perm-dialog {
  /* ...기존 선언 유지... */
  animation: dialog-in var(--dur-base) var(--ease-out) both;
}
.modal-overlay.closing .modal { animation: dialog-in var(--dur-fast) var(--ease-out) reverse both; }
```

(주: `.modal-overlay`·`.modal`·`.perm-dialog` 선택자는 이미 interact.css에 존재. 기존 블록에 `animation` 한 줄씩 추가하는 방식.)

- [x] **Step 5: 빌드 + 브라우저 실측**

Run: `npm run build --prefix client`
Expected: PASS.

fake-cli(권한 시나리오)로 실측:
```bash
node scripts/dev-fake.mjs --port 8790 --scenario permission
```
확인:
- "새 세션" 클릭 → 오버레이 페이드 + 다이얼로그가 살짝 위로+scale 들어옴. "취소/Esc" → **페이드아웃 후** 닫힘(스냅 아님).
- 세션 시작 후 메시지 전송 → 권한 다이얼로그가 열림 애니로 등장(닫힘은 즉시 — 의도됨).
- 직전에 고친 포커스 트랩/복원 정상(모달 내 Tab 순환, 닫힘 시 트리거로 포커스 복원).

- [x] **Step 6: 커밋**

```bash
git add client/src/lib/usePresence.js client/src/components/Sidebar.jsx client/src/components/interact.css
git commit -m "feat(client): animate modal open/close via usePresence (new-session leave)"
```

---

### Task 5: 세션 전환 뷰 트랜지션 + 메시지 등장 게이팅 (`ChatView.jsx`, `Message.jsx`, `chat.css`)

**Files:**
- Modify: `client/src/components/ChatView.jsx`
- Modify: `client/src/components/Message.jsx`
- Modify: `client/src/components/chat.css`

**Interfaces:**
- Consumes: `enter-rise`, `--dur-*`, `--ease-out` (Task 2), `.view-enter` (Task 2).
- Message는 새 prop `isNew?: boolean`을 받아 등장 클래스를 붙인다.

- [x] **Step 1: ChatView에 뷰 전환 재적용 + 새 메시지 게이팅** — `ChatView.jsx`

`ChatView` 본문 상단(refs 근처)에 추가:
```js
  const viewRef = useRef(null);
  const seenRef = useRef(new Set());
```

세션 전환 effect(`[session?.key]`)에 뷰 전환 클래스 재적용 + seen 리셋을 추가. 기존:
```js
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.key]);
```
를 다음으로 교체:
```js
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // 전환된 세션의 기존 메시지는 등장 애니 제외(재생 방지) — seen을 현재 uid로 채움
    seenRef.current = new Set(
      session ? session.messages.map((m, i) => m.uid ?? `i${i}`) : [],
    );
    // 패널만 페이드+상승 재생(자식 remount 아님): 클래스 제거→reflow→추가
    const vc = viewRef.current;
    if (vc) {
      vc.classList.remove('view-enter');
      // 강제 reflow로 애니 재시작
      void vc.offsetWidth;
      vc.classList.add('view-enter');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.key]);
```

렌더에서 `.chat-scroll`(또는 그 내부 리스트 컨테이너)에 `ref={viewRef}` 부여. 기존:
```jsx
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
```
는 스크롤 컨테이너이므로 애니는 그 **안쪽 래퍼**에 건다. `.chat-scroll` 바로 안에 래퍼를 추가:
```jsx
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="chat-view-inner" ref={viewRef}>
          {empty ? (
            <Greeting />
          ) : (
            <div className="msg-list">
              {session.messages.map((m, i) => {
                const key = m.uid ?? `i${i}`;
                const isNew = !seenRef.current.has(key);
                return <Message key={key} item={m} isNew={isNew} />;
              })}
              {/* busy / exited status-line 블록은 그대로 유지 */}
            </div>
          )}
        </div>
      </div>
```
(즉 기존 `{empty ? ... : ...}` 전체를 `.chat-view-inner`로 감싼다. busy/exited status-line 블록은 `.msg-list` 안 원위치 유지.)

새 메시지를 seen에 등록(매 커밋 후):
```js
  useEffect(() => {
    if (!session) return;
    for (const [i, m] of session.messages.entries()) {
      seenRef.current.add(m.uid ?? `i${i}`);
    }
  });
```

- [x] **Step 2: Message에 등장 클래스** — `Message.jsx`

시그니처를 `export default function Message({ item, isNew })` 로 바꾸고, 각 `.msg`/카드 루트에 `isNew`일 때 `enter-rise` 애니 클래스를 붙인다. 반복을 줄이기 위해 상단에 헬퍼:
```js
export default function Message({ item, isNew }) {
  const enter = isNew ? ' msg-enter' : '';
  switch (item.kind) {
    case 'user-text':
      return (
        <div className={`msg msg-user${enter}`}>
          <pre className="user-text">{item.text}</pre>
        </div>
      );
    case 'assistant-text':
      return (
        <div className={`msg msg-assistant${enter}`}>
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: render(item.text) }} />
          {item.streaming && <span className="stream-cursor" />}
        </div>
      );
    case 'thinking':
      return <div className={enter ? 'msg-enter' : undefined}><ThinkingBlock item={item} /></div>;
    case 'tool_use':
      return <div className={enter ? 'msg-enter' : undefined}><ToolCard item={item} /></div>;
    case 'notice':
      return <div className={`msg msg-notice dim${enter}`}>{item.text}</div>;
    case 'error':
      return <div className={`msg msg-error${enter}`}>{item.text}</div>;
    case 'raw':
      return (
        <details className={`msg-raw${enter}`}>
          <summary className="dim">{rawSummary(item.payload)}</summary>
          <pre>{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
      );
    default:
      return null;
  }
}
```
(thinking/tool_use는 자체 루트가 있으므로 얇은 래퍼 div에 `msg-enter`를 얹는다. 래퍼가 레이아웃에 영향 없도록 CSS에서 `display: contents` 대신 기본 block 유지 — Task 6에서 tool 카드 자체에 직접 적용하도록 개선 가능하나 본 Task는 래퍼로 충분.)

- [x] **Step 3: 등장 애니 CSS** — `chat.css` 끝에 추가:

```css
.msg-enter { animation: enter-rise var(--dur-base) var(--ease-out) both; }
.chat-view-inner { will-change: auto; }
.view-enter { animation: enter-rise var(--dur-base) var(--ease-out) both; }
```
(`.view-enter`는 theme.css에도 있으나 chat 스코프에서 확실히 적용되도록 중복 무해. 원치 않으면 생략 가능.)

- [x] **Step 4: 빌드 + 브라우저 실측**

Run: `npm run build --prefix client`
Expected: PASS.

fake-cli(echo)로 실측:
```bash
node scripts/dev-fake.mjs --port 8790 --scenario echo
```
확인:
- 세션 두 개 시작 후 사이드바에서 서로 전환 → 채팅 패널이 **페이드+상승**으로 바뀌고, 기존 메시지는 개별 재애니 없이 한 번에 표시(스크롤 최하단 유지).
- 메시지 전송 → **새 메시지만** 아래에서 살짝 떠오르며 등장. 기존 메시지는 가만히.
- reduced-motion 에뮬레이션(chrome-devtools `emulate` 또는 OS 설정) 시 즉시 표시.

- [x] **Step 5: 커밋**

```bash
git add client/src/components/ChatView.jsx client/src/components/Message.jsx client/src/components/chat.css
git commit -m "feat(client): session-switch view transition + gated message entrance"
```

---

### Task 6: 마이크로 인터랙션 + 사이드바 접기 애니 마무리 (`interact.css`, `chat.css`, `App.jsx` 확인)

**Files:**
- Modify: `client/src/components/interact.css`
- Modify: `client/src/components/chat.css`
- Modify: `client/src/App.jsx` (사이드바 폭 트랜지션 — CSS만, JSX는 이미 클래스 토글)

**Interfaces:**
- Consumes: `--dur-*`, `--ease-out` (Task 2).

- [x] **Step 1: 사이드바 접기 폭 트랜지션** — `theme.css`의 `.app` 규칙에 transition 추가. `.app { display: grid; height: 100%; grid-template-columns: var(--sidebar-width) 1fr; }` 를:
```css
.app {
  display: grid;
  height: 100%;
  grid-template-columns: var(--sidebar-width) 1fr;
  transition: grid-template-columns var(--dur-slow) var(--ease-out);
}
```
로 바꾼다. (`.app.sidebar-collapsed`는 이미 `0 1fr` — 이제 폭이 부드럽게 전환.) sidebar 내용이 폭 0에서 잘리도록 `.sidebar { overflow: hidden; }`가 필요하면 `interact.css`의 `.sidebar` 규칙에 `overflow: hidden;`을 확인/추가.

- [x] **Step 2: 버튼/pill press 마이크로** — `theme.css` 하단(또는 interact.css)에 추가:
```css
@media (prefers-reduced-motion: no-preference) {
  .btn-primary:active:not(:disabled),
  .pill:active,
  .send-btn:active:not(:disabled),
  .new-session-btn:active,
  .dir-head:active,
  .sess-row:active {
    transform: scale(0.97);
  }
}
.btn-primary, .pill, .send-btn, .new-session-btn, .dir-head, .sess-row {
  transition: transform var(--dur-micro) var(--ease-out),
              background var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out);
}
```
(기존 `button`의 0.13s transition과 충돌하지 않도록 이 선택자들은 명시적으로 재선언. reduced-motion에서는 Task 2의 전역 규칙이 transform을 즉시화.)

- [x] **Step 3: reopen 버튼 페이드** — `interact.css` 또는 theme.css의 `.sidebar-reopen`에 등장 애니:
```css
.sidebar-reopen { animation: enter-fade var(--dur-base) var(--ease-out) both; }
```

- [x] **Step 4: 빌드 + 브라우저 실측**

Run: `npm run build --prefix client`
Expected: PASS.

fake-cli(echo)로 실측:
- 사이드바 접기(⟨)/열기(☰) → 폭이 **부드럽게** 줄고/늘고, reopen 버튼 페이드 인.
- 버튼·pill·디렉토리 헤더 클릭 시 살짝 눌리는 press 피드백.
- reduced-motion 시 즉시(축소).

- [x] **Step 5: 전체 검증(회귀 포함)**

Run: `npm test`
Expected: PASS — **46 tests, 0 fail**(Task 1 이후 유지).

Run: `npm run build --prefix client`
Expected: PASS.

브라우저 통합 실측(권한 시나리오 1회, echo 시나리오 1회)으로 6개 표면(트리·전환·펼침·모달·등장·접기) + reduced-motion 최종 확인.

- [x] **Step 6: 커밋**

```bash
git add client/src/theme.css client/src/components/interact.css client/src/components/chat.css
git commit -m "feat(client): sidebar-collapse transition + press micro-interactions"
```

---

## Self-Review (작성자 체크 결과)

**Spec coverage:**
- §1 세션 트리(핀 고정·병합·dedupe·정렬·빈 상태) → Task 1(로직)+Task 3(UI). ✓
- §2 모션 토큰·카탈로그(8표면)·leave·reduced-motion·성능 → Task 2(토큰/reduced-motion)+Task 3(트리 펼침)+Task 4(모달)+Task 5(전환·메시지)+Task 6(접기·press). ✓
- §3 뷰 전환(remount 아님)·usePresence·트리 펼침(grid-rows)·엣지케이스·검증 → Task 5·4·3, 검증은 각 Task Step. ✓
- sessionTree 단위 테스트 → Task 1. ✓

**Placeholder scan:** 코드 스텝은 모두 실제 코드 포함. "TODO/TBD/적절히 처리" 없음. ✓

**Type consistency:** `buildSessionTree` 반환 필드(`pinned/others`, `DirNode.live/history/label/hasLive/active/count/dirName/cwd`)를 Task 3에서 동일하게 소비. `usePresence` 반환 `{mounted,status}`를 Task 4에서 동일 사용. `Message`의 `isNew` prop을 Task 5에서 정의·소비 일치. ✓

**Known follow-ups(범위 밖):** 미참조로 남는 기존 CSS(`.session-tab*`, `.proj-*`, `.recent-session`)는 별도 정리 커밋 대상(이번 계획은 회귀 위험 회피 위해 삭제 안 함).
