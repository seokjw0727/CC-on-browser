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
// **CLI는 프로세스가 끝나면 자기 <pid>.json을 지운다**(실측 2026-08-28, v2.1.235 — 정상
// 종료·강제 종료 모두). 그래서 이 디렉터리는 "지금 살아 있는 세션"만 말해 주고, 끝난
// 세션의 이름은 아무 데도 남지 않는다(.jsonl에도 없다). 이름을 한 번이라도 본 우리가
// 적어 두지 않으면 지난 세션 목록의 cliName은 사실상 언제나 null이다 — 그래서 아래
// 영속 저장소가 있다. 살아 있는 파일이 언제나 우선이고, 저장소는 그 파일이 사라진
// 뒤를 메우는 폴백일 뿐이다.
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
// 저장소가 무한히 자라지 않게 하는 상한. 한 벌이 ~60바이트라 500개는 30KB 남짓이고,
// 실측 기준(트랜스크립트 243개) 도달하지 않는 수다. 넘으면 at이 오래된 것부터 버린다.
const MAX_STORE_ENTRIES = 500;
// rename이 Windows에서 바이러스 검사·탐색기 핸들과 겹쳐 EACCES/EPERM/EBUSY로 튀는
// 창을 넘기기 위한 짧은 재시도(codex 지적). 실패해도 치명적이지 않아 길게 끌지 않는다.
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 25;

/** @type {Map<string, {at: number, promise: Promise<Map<string,string>>}>} */
const cache = new Map();
// 저장소 경로별 쓰기 직렬화 큐 — 한 프로세스가 스스로와 경합하지 않게 한다.
// 크로스프로세스 lock은 두지 않는다: 이름은 "있으면 좋은" 부가 정보라 lock이 남아
// 굳는 실패가 그것이 막는 유실보다 나쁘다. 대신 발행 직전에 저장소를 다시 읽어
// 잃을 수 있는 창을 재읽기~rename 사이로 좁힌다(codex와 합의한 절충).
/** @type {Map<string, Promise<void>>} */
const writeQueues = new Map();

// 같은 sessionId를 가진 파일이 여럿일 수 있다(같은 세션을 재개하면 pid가 새로 생기고
// 옛 pid의 파일이 겹치는 순간이 있다). 최신 이름을 골라야 하므로 nameSince > startedAt
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

/**
 * 저장소 읽기 — {store: Map<sessionId, {name, at}>, readable}.
 *
 * readable을 함께 돌려주는 이유가 이 함수의 요점이다. "못 읽었다"와 "아직 없다"를
 * 같은 빈 맵으로 뭉개면, 일시적 읽기 실패(EACCES·EIO·잠긴 파일) 직후의 발행이 빈 맵
 * 위에 지금 살아 있는 이름만 얹어 **기억 전체를 덮어쓴다**(codex 지적). 조회는 빈 맵을
 * 그대로 써도 되지만(폴백만 없어질 뿐) 쓰기는 그 위에서 절대 진행하면 안 된다.
 *
 * 없음(ENOENT)과 깨진 JSON은 readable로 친다: 전자는 새로 만들면 되고, 후자는 우리만
 * 쓰는 캐시성 파일이라 어차피 살릴 것이 없다. 개별 항목 단위로는 검증해 걸러 낸다
 * (손으로 고친 항목 하나가 목록 전체를 날리지 않도록).
 */
async function readStore(storeFile) {
  /** @type {Map<string, {name: string, at: number}>} */
  const store = new Map();
  let raw;
  try {
    raw = await fs.readFile(storeFile, 'utf8');
  } catch (err) {
    // 파일이 없는 것은 정상 상태(첫 실행) — 그 위에 새로 쓰는 것이 맞다.
    return { store, readable: err?.code === 'ENOENT' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { store, readable: true }; // 깨졌다 — 우리 형식이라 다시 지어도 잃을 것이 없다
  }
  const names = parsed?.names;
  if (!names || typeof names !== 'object') return { store, readable: true };
  for (const [sessionId, entry] of Object.entries(names)) {
    if (!sessionId) continue;
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    store.set(sessionId, { name, at: Number.isFinite(entry?.at) ? entry.at : 0 });
  }
  return { store, readable: true };
}

/**
 * 저장소 발행 — 같은 디렉터리의 tmp에 쓴 뒤 rename으로 바꿔치기한다(instance-file.js와
 * 같은 규약). 목적지를 미리 지우지 않는 이유는 그 사이에 "파일 없음" 창이 생겨,
 * rename이 끝내 실패하면 마지막 정상 저장소마저 잃기 때문이다.
 */
async function writeStore(storeFile, store) {
  const dir = path.dirname(storeFile);
  const names = {};
  for (const [sessionId, { name, at }] of store) names[sessionId] = { name, at };
  const body = JSON.stringify({ version: 1, names });
  // 여러 sessionsRoot를 훑는 스캔이 같은 저장소를 공유할 수 있어 pid만으로는 모자란다.
  const tmp = `${storeFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // writeFile은 핸들을 닫고 반환한다 — 열린 핸들이 남은 채로 rename하지 않는다.
    await fs.writeFile(tmp, body, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, storeFile);
        return;
      } catch (err) {
        const code = err?.code;
        const retryable = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
        if (!retryable || attempt >= RENAME_RETRIES) throw err;
        await new Promise((r) => { setTimeout(r, RENAME_BACKOFF_MS * (attempt + 1)); });
      }
    }
  } finally {
    // 성공하면 tmp는 이미 사라졌고(rename), 실패하면 여기서 치운다.
    await fs.unlink(tmp).catch(() => {});
  }
}

// 저장소 경로별로 read-merge-write를 한 줄로 세운다. 앞선 작업이 실패해도 뒤가 멈추지
// 않도록 사슬은 언제나 resolve된 상태로 이어 붙인다.
function enqueueStoreWrite(storeFile, job) {
  const prev = writeQueues.get(storeFile) ?? Promise.resolve();
  const next = prev.then(job).catch(() => {});
  writeQueues.set(storeFile, next);
  next.then(() => {
    if (writeQueues.get(storeFile) === next) writeQueues.delete(storeFile);
  });
  return next;
}

/**
 * 살아 있는 파일에서 **실제로 관찰한** 이름만 저장소에 적는다.
 *
 * 병합 결과(폴백 포함)를 적지 않는 것이 중요하다: 그러면 평범한 조회가 옛 항목의 at을
 * 계속 갱신해 상한 정리가 "가장 오래 안 쓴 것"이 아니라 "가장 오래 조회 안 한 것"이
 * 되고, 어느 이름이 실제로 관찰된 것인지도 알 수 없게 된다(codex 지적).
 *
 * 바뀐 것이 없으면 파일을 건드리지 않는다 — 목록 endpoint를 누를 때마다 쓰지 않기 위해.
 */
function persistNames(storeFile, liveNames) {
  if (liveNames.size === 0) return Promise.resolve(); // 관찰한 것이 없으면 파일도 만들지 않는다
  return enqueueStoreWrite(storeFile, async () => {
    // 발행 직전 재읽기 — 남의 갱신 위에 병합한다.
    const { store, readable } = await readStore(storeFile);
    // 읽지 못한 저장소 위에는 쓰지 않는다 — 빈 맵으로 오해하고 덮으면 기억이 날아간다.
    if (!readable) return;
    const now = Date.now();
    let changed = false;
    for (const [sessionId, name] of liveNames) {
      const prev = store.get(sessionId);
      if (prev && prev.name === name) continue;
      store.set(sessionId, { name, at: now });
      changed = true;
    }
    if (!changed && store.size <= MAX_STORE_ENTRIES) return;
    if (store.size > MAX_STORE_ENTRIES) {
      // 지금 살아 있는 세션이 먼저다. 이름이 그대로면 at을 갱신하지 않으므로(바로 위)
      // 오래 살아 있던 세션일수록 at이 낡는데, 그 상태에서 at만 보고 자르면 **아직 살아
      // 있는** 세션이 밀려나고 그 CLI가 끝나는 순간 폴백이 통째로 없어진다(codex 지적).
      // 그다음이 at 내림차순, 같으면 sessionId 오름차순 — 상한에 걸렸을 때 결과가
      // 흔들리지 않게.
      const kept = [...store.entries()]
        .sort((a, b) => (
          (liveNames.has(b[0]) ? 1 : 0) - (liveNames.has(a[0]) ? 1 : 0)
          || b[1].at - a[1].at
          || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        ))
        .slice(0, MAX_STORE_ENTRIES);
      store.clear();
      for (const [sessionId, entry] of kept) store.set(sessionId, entry);
    }
    await writeStore(storeFile, store);
  });
}

// 살아 있는 이름 + 저장된 이름의 병합본. 살아 있는 쪽이 언제나 이긴다 — 저장소는
// 그 파일이 사라진 뒤를 메우는 폴백이고, CLI에서 이름을 바꾸면 그 즉시 새 이름이
// 보여야 한다.
async function loadMerged(sessionsRoot, storeFile) {
  const live = await scan(sessionsRoot);
  const merged = new Map();
  if (storeFile) {
    // 조회는 못 읽은 저장소를 빈 맵으로 써도 된다 — 폴백이 없어질 뿐 목록은 살아 있다.
    const { store } = await readStore(storeFile);
    for (const [sessionId, { name }] of store) merged.set(sessionId, name);
  }
  for (const [sessionId, name] of live) merged.set(sessionId, name);
  // 저장 실패는 조회를 깨뜨리지 않는다. 다만 **기다린다** — 끝난 뒤에 저장소를 보는
  // 호출자(테스트·다음 조회)가 방금 관찰한 이름을 확실히 보게 하기 위해서다.
  if (storeFile) await persistNames(storeFile, live).catch(() => {});
  return merged;
}

// 캐시된 공유 맵 — 호출측에 그대로 넘기지 않는다(밖에서 고치면 다음 캐시 히트가
// 오염된다 — codex 지적). 만료된 항목은 여기서 함께 걷어내, 여러 root를 오가는
// 테스트에서 항목이 무한히 쌓이지 않게 한다.
//
// 키가 (sessionsRoot, storeFile) 쌍인 이유: 저장소가 다르면 폴백이 달라 같은 root라도
// 결과가 다르고, root가 다르면 살아 있는 이름이 달라 같은 저장소라도 결과가 다르다.
// 어느 한쪽만으로 키를 잡으면 서로 다른 설정의 결과가 섞인다(codex 지적).
function cacheKeyOf(sessionsRoot, storeFile) {
  return `${sessionsRoot}\u0000${storeFile ?? ''}`;
}

function cachedNames(sessionsRoot, storeFile) {
  const now = Date.now();
  const key = cacheKeyOf(sessionsRoot, storeFile);
  for (const [cached, hit] of cache) {
    if (now - hit.at >= CACHE_TTL_MS && cached !== key) cache.delete(cached);
  }
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise;
  // loadMerged는 스스로 빈 맵으로 축약하므로 reject가 올라올 일은 없지만, 방어적으로 붙인다.
  const promise = loadMerged(sessionsRoot, storeFile).catch(() => new Map());
  cache.set(key, { at: now, promise });
  return promise;
}

/**
 * 이름 저장소의 표준 경로 — 앱 소유 디렉터리다(instance-file.js의 신원 파일과 같은
 * '.cc-on-browser'). ~/.claude 아래에 쓰지 않는 이유는 그쪽이 CLI의 영역이어서다.
 *
 * **이 값이 기본 인자로 쓰이지 않는 것이 핵심이다.** 저장소는 부수효과를 갖는 기능이라
 * 앱 진입점(bin/cc-on-browser.mjs)만 옵트인한다 — server.js의 pasteCleanup과 같은 선택이다.
 * 기본으로 켜면 startServer를 띄우는 것만으로 개발자의 실제 홈에 파일이 생기고(테스트
 * 40여 곳이 그렇게 부른다), 남은 파일이 다음 테스트의 폴백으로 새어들어 순서 의존을 만든다.
 * instance-file.js가 homeDir를 필수 인자로 두는 것과 같은 이유다.
 */
export function defaultNameStoreFile(homeDir = os.homedir()) {
  return path.join(homeDir, '.cc-on-browser', 'session-names.json');
}

/**
 * sessionId → CLI 세션 이름 맵(호출측 전용 사본). 실패는 전부 빈 맵으로 축약한다 —
 * 이 조회가 세션 목록 자체를 깨뜨리면 안 된다.
 *
 * storeFile을 주지 않으면 영속 저장소를 쓰지 않는다(읽기도 쓰기도) — 살아 있는 파일만
 * 본다. 즉 이 모듈의 기본값은 "부수효과 없음"이다.
 */
export async function readCliSessionNames(
  sessionsRoot = DEFAULT_SESSIONS_ROOT,
  { storeFile = null } = {},
) {
  return new Map(await cachedNames(sessionsRoot, storeFile));
}

/** 단일 세션 이름 — 라이브 세션이 자기 id를 확정한 직후 쓴다. 없으면 null. */
export async function lookupCliSessionName(
  sessionId,
  sessionsRoot = DEFAULT_SESSIONS_ROOT,
  { storeFile = null } = {},
) {
  if (!sessionId) return null;
  // 읽기만 한다 — 사본을 뜰 이유가 없다
  const names = await cachedNames(sessionsRoot, storeFile);
  return names.get(sessionId) ?? null;
}

/**
 * 테스트용 — 조회 캐시를 비운다(픽스처를 갈아 끼울 때 TTL을 기다리지 않기 위해).
 * 영속 저장소는 건드리지 않는다: 캐시는 "방금 읽은 것"이고 저장소는 "기억한 것"이라,
 * 캐시를 비웠다고 기억까지 지우면 폴백을 검증할 수 없다.
 */
export function clearCliSessionNameCache() {
  cache.clear();
}
