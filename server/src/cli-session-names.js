// cli-session-names.js — CLI가 세션마다 붙인 이름(~/.claude/sessions/<pid>.json의 name) 조회.
//
// 히스토리 제목(history.js의 extractTitle)과는 출처가 다르다: 저쪽은 트랜스크립트의 첫
// 사용자 발화를 요약한 것이고, 이쪽은 CLI 자신이 만들어 둔 이름이다. 트랜스크립트(.jsonl)
// 에는 이 이름이 없으므로 별도 디렉터리를 읽는다(실측 2026-08-23, CLI v2.1.235).
//
// 파일 한 벌의 실제 모양:
//   {"pid":13620,"sessionId":"d8dc…","cwd":"C:\\…","startedAt":1787390254498,
//    "version":"2.1.235","kind":"interactive","entrypoint":"sdk-cli",
//    "name":"cc-on-browser-ca","nameSource":"derived","nameSince":1787390254499}
//
// 밖으로 내보내는 것은 sessionId → name 뿐이다. pid·cwd·messagingSocketPath 등 나머지
// 필드는 브라우저가 알 이유가 없어 여기서 잘라낸다.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'sessions');
// 목록 endpoint가 연달아 불릴 때 같은 디렉터리를 반복해 훑지 않기 위한 짧은 캐시.
// 길게 잡으면 방금 이름이 바뀐 세션이 옛 이름으로 남는다 — 3초는 "연속 호출 1회분"만
// 아끼는 값이다.
const CACHE_TTL_MS = 3_000;
// 폭주 방어 — 정상적인 홈 디렉터리에서 도달할 수 없는 상한이다. 이 수를 넘을 때만
// mtime으로 정렬해 최신 것부터 읽는다(그냥 잘라내면 방금 만들어진 세션의 이름이 빠질
// 수 있다 — codex 지적). 상한 이하에서는 stat을 한 번도 부르지 않는다.
const MAX_FILES = 1_000;

/** @type {Map<string, {at: number, promise: Promise<Map<string,string>>}>} */
const cache = new Map();

// 같은 sessionId를 가진 파일이 여럿일 수 있다(같은 세션을 재개하면 pid가 새로 생기고
// 옛 pid의 파일은 그대로 남는다). 최신 이름을 골라야 하므로 nameSince > startedAt
// 순으로 점수를 매긴다. 둘 다 없으면 0 — 점수가 같으면 먼저 읽은 쪽을 유지한다.
function recencyOf(record) {
  if (Number.isFinite(record?.nameSince)) return record.nameSince;
  if (Number.isFinite(record?.startedAt)) return record.startedAt;
  return 0;
}

async function scan(sessionsRoot) {
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    // 디렉터리가 없는 CLI 버전·접근 불가 — 이름 없음으로 축약한다(호출측은 폴백 제목).
    return new Map();
  }
  // `<pid>.<hash>.key` 같은 이웃 파일이 같은 디렉터리에 산다 — 세션 기록만 고른다.
  let names_ = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  if (names_.length > MAX_FILES) {
    const stamped = [];
    for (const name of names_) {
      const stat = await fs.stat(path.join(sessionsRoot, name)).catch(() => null);
      stamped.push({ name, mtime: stat ? stat.mtimeMs : 0 });
    }
    stamped.sort((a, b) => b.mtime - a.mtime);
    names_ = stamped.slice(0, MAX_FILES).map((s) => s.name);
  }

  /** @type {Map<string, {name: string, score: number}>} */
  const best = new Map();
  for (const fileName of names_) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(sessionsRoot, fileName), 'utf8'));
    } catch {
      continue; // 쓰는 중이라 잘린 파일·깨진 JSON은 그 파일만 건너뛴다
    }
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    // nameSource('derived'|'user')로 거르지 않는다 — 자동 이름이든 CLI에서 직접 바꾼
    // 이름이든 사용자가 CLI에서 보던 그 이름을 그대로 보여 주는 것이 목적이다.
    if (!sessionId || !name) continue;
    const score = recencyOf(record);
    const prev = best.get(sessionId);
    if (!prev || score > prev.score) best.set(sessionId, { name, score });
  }
  const names = new Map();
  for (const [sessionId, { name }] of best) names.set(sessionId, name);
  return names;
}

// 캐시된 공유 맵 — 호출측에 그대로 넘기지 않는다(밖에서 고치면 다음 캐시 히트가
// 오염된다 — codex 지적). 만료된 항목은 여기서 함께 걷어내, 여러 root를 오가는
// 테스트에서 항목이 무한히 쌓이지 않게 한다.
function cachedNames(sessionsRoot) {
  const now = Date.now();
  for (const [root, hit] of cache) {
    if (now - hit.at >= CACHE_TTL_MS && root !== sessionsRoot) cache.delete(root);
  }
  const hit = cache.get(sessionsRoot);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise;
  // scan은 스스로 빈 맵으로 축약하므로 reject가 올라올 일은 없지만, 방어적으로 붙인다.
  const promise = scan(sessionsRoot).catch(() => new Map());
  cache.set(sessionsRoot, { at: now, promise });
  return promise;
}

/**
 * sessionId → CLI 세션 이름 맵(호출측 전용 사본). 실패는 전부 빈 맵으로 축약한다 —
 * 이 조회가 세션 목록 자체를 깨뜨리면 안 된다.
 */
export async function readCliSessionNames(sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  return new Map(await cachedNames(sessionsRoot));
}

/** 단일 세션 이름 — 라이브 세션이 자기 id를 확정한 직후 쓴다. 없으면 null. */
export async function lookupCliSessionName(sessionId, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  if (!sessionId) return null;
  const names = await cachedNames(sessionsRoot); // 읽기만 한다 — 사본을 뜰 이유가 없다
  return names.get(sessionId) ?? null;
}

/** 테스트용 — 캐시를 비운다(픽스처를 갈아 끼울 때 TTL을 기다리지 않기 위해). */
export function clearCliSessionNameCache() {
  cache.clear();
}
