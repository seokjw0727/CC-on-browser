// 라이브 세션 + 히스토리 프로젝트를 디렉토리(cwd) 단위 트리로 병합하는 순수 함수.
// React/DOM 의존 없음 → node --test 로 단위 테스트 가능.
// 식별 규칙: 라이브는 hub key로 식별(초기 sessionId=null 허용, 서로 절대 합치지 않음),
// 히스토리는 sessionId로 식별, 병합 시 non-null sessionId가 일치하는 히스토리만 숨김.

export function shortDir(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : `…\\${parts.slice(-2).join('\\')}`;
}

// 라이브 세션의 표시용 제목 — 첫 사용자 발화(user-text)를 히스토리 title과 같은 규칙으로
// 요약한다. 커맨드 래퍼(<…>)·빈 문자열은 건너뛴다. 없으면 '' (호출측이 폴백).
export function deriveSessionTitle(messages = [], maxLen = 60) {
  for (const m of messages) {
    if (!m || m.kind !== 'user-text' || typeof m.text !== 'string') continue;
    const t = m.text.trim().replace(/\s+/g, ' ');
    if (!t || t.startsWith('<')) continue;
    return t.slice(0, maxLen);
  }
  return '';
}

// 화면에 보일 세션 이름 — 모든 소비처(사이드바 라이브 행, 접힘 배지, 새 세션 모달의
// "지난 세션" 목록, 삭제 확인 모달)가 이 한 함수를 쓴다. 각자 폴백을 두면 이름 변경이
// 어떤 화면에서는 반영되고 어떤 화면에서는 안 되는 어긋남이 생긴다.
//
// 우선순위: 사용자가 지정한 이름 → CLI가 붙인 이름(cliName) →
//           서버 히스토리 제목(.jsonl에서 뽑은 title) → 라이브 메시지의 첫 발화 요약 →
//           sessionId 앞 8자 → '새 세션'
// customTitle이 맨 앞인 이유는 자명하다. cliName이 그다음인 이유는 그것이 사용자가
// 터미널에서 같은 세션을 부르던 이름이어서다 — 두 화면이 다른 이름을 쓰면 같은 세션인지
// 알아볼 수 없다. 히스토리 title이 메시지 요약보다 앞인 이유는 그쪽이 파일 전체를 보고
// 만든 제목이기 때문이다(지난 세션 행에는 messages가 없다).
export function sessionDisplayTitle({
  customTitle = '',
  cliName = '',
  title = '',
  messages = [],
  sessionId = null,
  fallback = '새 세션',
} = {}) {
  const custom = typeof customTitle === 'string' ? customTitle.trim() : '';
  if (custom) return custom;
  const cli = typeof cliName === 'string' ? cliName.trim() : '';
  if (cli) return cli;
  const serverTitle = typeof title === 'string' ? title.trim() : '';
  if (serverTitle) return serverTitle;
  const derived = deriveSessionTitle(messages);
  if (derived) return derived;
  return sessionId ? String(sessionId).slice(0, 8) : fallback;
}

function dirKeyOf(seed) {
  return (seed.cwd && String(seed.cwd).trim()) || seed.dirName || '';
}

// 새 세션 모달 "지난 세션" 목록 병합 — 서버 최근 목록(fetched)을 (dirName, sessionId)
// 키로 정리하고 라이브 세션을 숨긴 뒤 mtime 내림차순으로 정렬한다.
//
// closedLocal은 사이드바에 히스토리가 상시 노출되던 시절, 방금 닫힌 세션을 즉시
// 보여주기 위한 로컬 캡처였다(2026-07-21 모달 통합으로 소멸 — 모달은 열릴 때와
// 열린 세션 집합이 바뀔 때 서버에서 새로 받으므로 캡처가 필요 없다). 인자는 같은
// 키 규칙으로 후방호환을 위해 남겨 둔다: 주어지면 서버 항목이 우선(파일 기준
// 제목·mtime이 더 정확)이고, 병합 후 재절단은 하지 않는다.
export function mergeRecentSessions({ fetched = [], closedLocal = [], liveIds = new Set() } = {}) {
  const keyOf = (s) => `${s.dirName}\n${s.sessionId}`;
  const map = new Map();
  for (const s of closedLocal) {
    if (!s || !s.dirName || !s.sessionId) continue;
    map.set(keyOf(s), s);
  }
  for (const s of fetched) {
    if (!s || !s.dirName || !s.sessionId) continue;
    map.set(keyOf(s), s);
  }
  return [...map.values()]
    .filter((s) => !liveIds.has(s.sessionId))
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
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
          .map((h) => ({
            sessionId: h.sessionId,
            title: h.title,
            cliName: h.cliName ?? null,
            mtime: h.mtime,
          }))
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
