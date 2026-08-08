// 사용자가 직접 지정한 세션 이름의 영속 유틸 — 사이드바 세션 우클릭 "이름 변경".
//
// 저장소는 localStorage 키 하나(ccob-session-titles)에 담긴 JSON 맵이다:
//   { "<sessionId>": { "title": "이름", "at": 1754600000000 }, ... }
// sessionId를 키로 쓰는 이유: hub key는 프로세스 수명 동안만 유효해 새로고침하면
// 사라지지만, sessionId는 CLI 트랜스크립트와 함께 디스크에 남아 재개 후에도
// 같은 대화를 가리킨다. 재개(fork)로 id가 새로 발급되면 store가 새 id로 옮겨 준다.
//
// 서버에는 저장하지 않는다(설계도 §1 "제외") — 이름은 이 브라우저 로컬 표시용이고,
// 히스토리 .jsonl은 CLI 소유라 우리가 쓰면 안 된다.
//
// preferences.js와 같은 방어 수칙: localStorage는 차단 컨텍스트(사파리 프라이빗 등)
// 에서 접근만으로 throw할 수 있으므로 읽기·쓰기·삭제를 전부 try/catch로 감싼다.
// 저장이 실패해도 in-memory 이름(store의 customTitle)은 그대로 살아 있다.

export const SESSION_TITLES_KEY = 'ccob-session-titles';

// 표시·저장 공통 상한. 사이드바 한 줄에 들어가지 않는 길이는 어차피 잘리므로
// 저장 단계에서 잘라 localStorage 용량이 이름 하나로 잠식되는 것을 막는다.
export const MAX_TITLE_LEN = 80;
// 보관 개수 — 초과하면 at(마지막 저장 시각)이 오래된 것부터 버린다.
export const MAX_TITLES = 200;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 이름 정규화 — 공백 정리 + 길이 제한. 빈 값이면 ''(= 이름 해제). */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LEN);
}

/**
 * 저장된 맵 전체를 읽는다 — 손상된 JSON·구조(문자열 값만 있던 초기 형태 포함)는
 * 조용히 버리거나 승격시켜 앱이 죽지 않게 한다.
 * @returns {Record<string, {title: string, at: number}>}
 */
export function readTitles(storage = defaultStorage()) {
  let raw;
  try {
    raw = storage?.getItem(SESSION_TITLES_KEY);
  } catch {
    return {};
  }
  if (typeof raw !== 'string' || raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // 손상된 값 — 빈 맵으로 수렴(다음 저장이 덮어쓴다)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [id, v] of Object.entries(parsed)) {
    if (!id) continue;
    // 값이 문자열이면 at 없는 옛 형태로 보고 승격(at=0 → 정리 시 먼저 버려진다).
    const title = normalizeTitle(typeof v === 'string' ? v : v?.title);
    if (!title) continue;
    const at = typeof v?.at === 'number' && Number.isFinite(v.at) ? v.at : 0;
    out[id] = { title, at };
  }
  return out;
}

/** sessionId의 커스텀 이름 — 없으면 ''. */
export function titleFor(sessionId, storage = defaultStorage()) {
  if (!sessionId) return '';
  return readTitles(storage)[sessionId]?.title ?? '';
}

/**
 * 이름 저장 — 빈 값/null이면 해당 항목 삭제(= 자동 제목으로 복귀).
 * 반환값은 "영속에 실제로 성공했는가". storage가 없으면(차단 컨텍스트) false다
 * — 호출측이 "저장했다"고 오보하지 않게(preferences.writePref와 같은 계약).
 */
export function saveTitle(sessionId, title, storage = defaultStorage(), now = Date.now()) {
  if (!sessionId || !storage) return false;
  const map = readTitles(storage);
  const normalized = normalizeTitle(title);
  if (!normalized) delete map[sessionId];
  else map[sessionId] = { title: normalized, at: now };

  // 정리 — at이 오래된 것부터 버려 MAX_TITLES를 넘지 않게 한다. 방금 쓴 항목은
  // at이 최신이라 살아남는다.
  const ids = Object.keys(map);
  if (ids.length > MAX_TITLES) {
    ids
      .sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0))
      .slice(0, ids.length - MAX_TITLES)
      .forEach((id) => delete map[id]);
  }

  try {
    if (Object.keys(map).length === 0) storage.removeItem(SESSION_TITLES_KEY);
    else storage.setItem(SESSION_TITLES_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false; // 용량 초과·차단 — 화면의 이름은 그대로 유지된다
  }
}

/**
 * 이름 이월 — 재개(fork)로 sessionId가 새로 발급됐을 때 원본의 이름을 새 id로 옮긴다.
 * 원본 항목은 남겨 둔다: 원본 트랜스크립트는 디스크에 그대로 있고 "지난 세션"
 * 목록에서 다시 재개될 수 있으므로, 그때도 같은 이름으로 보이는 편이 자연스럽다.
 * @returns {string} 이월된 이름('' = 원본에 이름이 없었음)
 */
export function carryTitle(fromSessionId, toSessionId, storage = defaultStorage(), now = Date.now()) {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return '';
  const title = titleFor(fromSessionId, storage);
  if (title) saveTitle(toSessionId, title, storage, now);
  return title;
}
