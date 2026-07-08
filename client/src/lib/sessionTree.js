// 라이브 세션 + 히스토리 프로젝트를 디렉토리(cwd) 단위 트리로 병합하는 순수 함수.
// React/DOM 의존 없음 → node --test 로 단위 테스트 가능.
// 식별 규칙: 라이브는 hub key로 식별(초기 sessionId=null 허용, 서로 절대 합치지 않음),
// 히스토리는 sessionId로 식별, 병합 시 non-null sessionId가 일치하는 히스토리만 숨김.

export function shortDir(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\\/]/).filter(Boolean);
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
