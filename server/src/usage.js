// usage.js — ~/.claude/projects 트랜스크립트 로컬 집계.
// Anthropic 공식 쿼터 수치가 아니라 로컬 세션 기록(assistant 엔트리의 message.usage)
// 합산이다. resume 시 이전 대화가 새 세션 파일에 복제될 수 있으므로
// requestId+message.id 쌍으로 중복을 제거한다(두 id가 모두 있을 때만 — id 없는
// 항목의 중복 가능성은 허용 오차).
//
// 스캔은 파일 통읽기 대신 라인 스트리밍(readline)이다 — 일별 집계(최대 365일 창)가
// 추가되면서 한 번에 여는 파일 양이 커질 수 있어, 메모리 상한을 파일 크기와
// 무관하게 유지한다. 5h/7d 집계도 같은 스캐너를 공유한다(사본 발산 방지).
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** 일별 집계 창의 상한(일) — /api/usage-daily의 days clamp와 공유 */
export const MAX_DAILY_DAYS = 365;

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    entries: 0,
  };
}

function addUsage(bucket, usage) {
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  bucket.inputTokens += inTok;
  bucket.outputTokens += outTok;
  bucket.cacheReadTokens += cacheRead;
  bucket.cacheCreationTokens += cacheCreate;
  bucket.totalTokens += inTok + outTok + cacheRead + cacheCreate;
  bucket.entries += 1;
}

// 공용 스캐너 — [since, now] 창에 드는 dedup된 assistant usage 엔트리마다
// onEntry(usage, ts)를 호출한다. mtime이 since보다 오래된 파일은 열지 않는다
// (엔트리 ts ≤ 파일 mtime이므로 창 안 엔트리를 놓치지 않는다 — 동기화·복원으로
// mtime이 뒤틀린 파일의 극단 케이스는 기존 7일 필터와 같은 허용 오차).
async function scanUsageEntries(projectsRoot, { now, since }, onEntry) {
  const seen = new Set();

  let projectDirs;
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, dirEntry.name);
    let files;
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue; // 접근 불가 디렉터리는 집계에서 제외
    }
    for (const fileEntry of files) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, fileEntry.name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since) continue; // 창 밖 파일은 열지 않는다
      // 파일 단위 all-or-nothing: 스트림이 중간에 실패하면 그 파일 전체를 버린다
      // (기존 readFile 방식과 동일 의미). dedup 키 등록도 커밋 시점에 해야
      // 실패 파일이 다른 파일의 사본 집계를 막지 않는다.
      const pending = []; // [{key|null, usage, ts}]
      try {
        const rl = readline.createInterface({
          input: createReadStream(filePath),
          crlfDelay: Infinity,
        });
        for await (const rawLine of rl) {
          if (!rawLine || !rawLine.includes('"usage"')) continue; // 파싱 전 사전 필터
          let obj;
          try {
            obj = JSON.parse(rawLine);
          } catch {
            continue;
          }
          if (obj?.type !== 'assistant') continue;
          const usage = obj.message?.usage;
          if (!usage || typeof usage !== 'object') continue;
          const ts = Date.parse(obj.timestamp ?? '');
          if (!Number.isFinite(ts) || ts > now || ts < since) continue;
          const key =
            obj.requestId && obj.message?.id ? `${obj.requestId}|${obj.message.id}` : null;
          pending.push({ key, usage, ts });
        }
      } catch {
        continue; // 읽기 실패 파일은 집계에서 제외
      }
      for (const { key, usage, ts } of pending) {
        if (key) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        onEntry(usage, ts);
      }
    }
  }
}

/** 최근 5시간/7일 창 집계 — /api/usage 상태줄용 */
export async function aggregateUsage(projectsRoot = DEFAULT_PROJECTS_ROOT, now = Date.now()) {
  const fiveHour = emptyBucket();
  const sevenDay = emptyBucket();
  await scanUsageEntries(projectsRoot, { now, since: now - SEVEN_DAYS_MS }, (usage, ts) => {
    addUsage(sevenDay, usage);
    if (now - ts <= FIVE_HOURS_MS) addUsage(fiveHour, usage);
  });
  return { now, fiveHour, sevenDay };
}

// 로컬 캘린더 날짜 키(YYYY-MM-DD) — 서버 로컬 = 사용자 로컬(로컬 전용 앱).
// 클라이언트는 이 키를 new Date(y, m-1, d)로만 해석해야 한다(UTC 해석 금지).
function localDateKey(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 일별 집계 — 사이드바 "돌아보기" 잔디용. 오늘을 포함한 최근 days일(1..365 clamp)을
 * 로컬 캘린더 일 기준으로 나누고, 기록이 없는 날도 0 버킷으로 채운 전체 시계열을
 * 오래된 날 → 오늘 순서로 반환한다(클라이언트 그리드가 빈 날짜 보간을 안 해도 되게).
 * @returns {Promise<{now: number, days: [{date: string, ...bucket}]}>}
 */
export async function aggregateDailyUsage(
  projectsRoot = DEFAULT_PROJECTS_ROOT,
  now = Date.now(),
  days = MAX_DAILY_DAYS,
) {
  // NaN/Infinity 방어 — 비정상 입력은 기본 창으로 (호출부 검증과 별개의 심층 방어)
  const n = Number.isFinite(days)
    ? Math.max(1, Math.min(MAX_DAILY_DAYS, Math.trunc(days)))
    : MAX_DAILY_DAYS;
  // 창 시작 = (오늘 − (n−1))일의 로컬 자정
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1));
  const since = start.getTime();

  const buckets = new Map(); // date key -> bucket (series와 같은 객체 공유)
  const series = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const bucket = { date: localDateKey(d.getTime()), ...emptyBucket() };
    buckets.set(bucket.date, bucket);
    series.push(bucket);
  }

  await scanUsageEntries(projectsRoot, { now, since }, (usage, ts) => {
    const bucket = buckets.get(localDateKey(ts));
    if (bucket) addUsage(bucket, usage);
  });
  return { now, days: series };
}
