// usage.js — 트랜스크립트 5h/7d·일별 로컬 집계 테스트 (fake 픽스처만 사용, 실 CLI 미실행).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateDailyUsage,
  aggregateUsage,
  FIVE_HOURS_MS,
  MAX_DAILY_DAYS,
  SEVEN_DAYS_MS,
} from '../src/usage.js';

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // 고정 기준 시각 — 경계를 결정적으로 검증
let root;

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const entry = (msAgo, usage, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(msAgo),
    message: { id: extra.msgId ?? null, role: 'assistant', content: [], usage },
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
  });

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-usage-'));
  const proj = path.join(root, 'C--proj-a');
  await fs.mkdir(proj, { recursive: true });
  const lines = [
    // 1시간 전 — 5h·7d 모두 포함 (총 135 tok)
    entry(60 * 60 * 1000, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    }),
    // 정확히 5h 경계 — 포함 (총 2 tok)
    entry(FIVE_HOURS_MS, { input_tokens: 1, output_tokens: 1 }),
    // 6시간 전 — 7d에만 포함 (총 1000 tok)
    entry(6 * 60 * 60 * 1000, { input_tokens: 1000, output_tokens: 0 }),
    // 8일 전 — 타임스탬프 기준 제외
    entry(8 * 24 * 60 * 60 * 1000, { input_tokens: 999999, output_tokens: 999999 }),
    // assistant가 아닌 엔트리 — 제외
    JSON.stringify({ type: 'user', timestamp: iso(1000), message: { usage: { input_tokens: 777 } } }),
    // 미래 타임스탬프 — 제외
    entry(-60_000, { input_tokens: 5 }),
    // usage 없는 assistant — 제외
    JSON.stringify({ type: 'assistant', timestamp: iso(1000), message: { role: 'assistant', content: [] } }),
    // 파손 라인 — 무시
    '{broken json "usage"',
  ];
  await fs.writeFile(path.join(proj, 's1.jsonl'), lines.join('\n') + '\n');

  const proj2 = path.join(root, 'C--proj-b');
  await fs.mkdir(proj2, { recursive: true });
  // resume 복제 시나리오: 같은 requestId+message.id가 두 파일에 등장 → 1회만 집계 (총 42 tok)
  const dup = entry(30 * 60 * 1000, { input_tokens: 40, output_tokens: 2 }, { requestId: 'req_dup', msgId: 'msg_dup' });
  await fs.writeFile(path.join(proj2, 's2.jsonl'), dup + '\n');
  await fs.writeFile(path.join(proj2, 's3.jsonl'), dup + '\n');
  // id가 없는 동일 내용 엔트리 2건 — 각각 집계 (총 6 tok)
  const anon = entry(30 * 60 * 1000, { input_tokens: 3, output_tokens: 0 });
  await fs.writeFile(path.join(proj2, 's4.jsonl'), anon + '\n' + anon + '\n');

  // mtime이 7일보다 오래된 파일은 열지 않고 건너뛴다(내용은 창 안이어도 무시).
  const oldFile = path.join(proj2, 's5-old.jsonl');
  await fs.writeFile(oldFile, entry(60_000, { input_tokens: 12345 }) + '\n');
  const oldSec = (NOW - 8 * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(oldFile, oldSec, oldSec);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('windows, boundaries, dedupe, and filters', async () => {
  const { fiveHour, sevenDay } = await aggregateUsage(root, NOW);
  // 5h: 135(1h) + 2(5h 경계) + 42(dup 1회) + 6(anon 2회) = 185
  assert.equal(fiveHour.totalTokens, 185);
  assert.equal(fiveHour.entries, 5);
  assert.equal(fiveHour.cacheReadTokens, 100);
  assert.equal(fiveHour.cacheCreationTokens, 20);
  // 7d: 185 + 1000(6h)
  assert.equal(sevenDay.totalTokens, 1185);
  assert.equal(sevenDay.entries, 6);
  assert.equal(sevenDay.inputTokens, 10 + 1 + 1000 + 40 + 3 + 3);
  assert.equal(sevenDay.outputTokens, 5 + 1 + 0 + 2 + 0 + 0);
});

test('missing projects root returns zeroed buckets', async () => {
  const res = await aggregateUsage(path.join(root, 'no-such-dir'), NOW);
  assert.equal(res.fiveHour.totalTokens, 0);
  assert.equal(res.fiveHour.entries, 0);
  assert.equal(res.sevenDay.totalTokens, 0);
});

// ----- 일별 집계 (돌아보기 잔디용) -----
// NOW는 UTC 고정이지만 일별 버킷은 러너의 로컬 캘린더 기준이다 — 기대 날짜 키를
// 테스트 안에서 같은 로컬 규칙으로 계산해 타임존 독립적으로 검증한다.
const entryAt = (ts, usage, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: { id: extra.msgId ?? null, role: 'assistant', content: [], usage },
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
  });
const localKey = (ms) => {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};
// NOW의 로컬 자정에서 n일 전 자정 ms
const midnightAgo = (n) => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
};

test('daily: calendar buckets, zero fill, midnight boundaries, dedupe', async () => {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-daily-'));
  try {
    const proj = path.join(r, 'C--daily');
    await fs.mkdir(proj, { recursive: true });
    const HOUR = 60 * 60 * 1000;
    const lines = [
      // 오늘 자정 직후(00:30) — 오늘 버킷
      entryAt(midnightAgo(0) + HOUR / 2, { input_tokens: 10, output_tokens: 0 }),
      // 어제 자정 직전(23:30) — 어제 버킷
      entryAt(midnightAgo(0) - HOUR / 2, { input_tokens: 5, output_tokens: 0 }),
      // 창 시작 정각(2일 전 로컬 자정) — 포함
      entryAt(midnightAgo(2), { input_tokens: 7, output_tokens: 0 }),
      // 창 시작 직전 — 제외
      entryAt(midnightAgo(2) - 1, { input_tokens: 999_999, output_tokens: 0 }),
      // 미래 — 제외
      entryAt(NOW + 60_000, { input_tokens: 888_888, output_tokens: 0 }),
    ];
    await fs.writeFile(path.join(proj, 's1.jsonl'), lines.join('\n') + '\n');
    // resume 복제: 같은 requestId+msgId가 두 파일에 — 오늘 버킷에 1회만
    const dup = entryAt(midnightAgo(0) + HOUR, { input_tokens: 40, output_tokens: 2 }, { requestId: 'req_d', msgId: 'msg_d' });
    await fs.writeFile(path.join(proj, 's2.jsonl'), dup + '\n');
    await fs.writeFile(path.join(proj, 's3.jsonl'), dup + '\n');

    const { days } = await aggregateDailyUsage(r, NOW, 3);
    assert.equal(days.length, 3);
    // 시계열은 오래된 날 → 오늘, 로컬 캘린더 키
    assert.deepEqual(days.map((d) => d.date), [localKey(midnightAgo(2)), localKey(midnightAgo(1)), localKey(midnightAgo(0))]);
    assert.equal(days[2].totalTokens, 10 + 42); // 오늘 = 00:30 + dup 1회
    assert.equal(days[2].entries, 2);
    assert.equal(days[1].totalTokens, 5); // 어제 = 23:30
    assert.equal(days[0].totalTokens, 7); // 창 시작 정각 — 0 버킷이 아니라 포함
  } finally {
    await fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('daily: days clamp and full zero-fill series', async () => {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-daily2-'));
  try {
    const one = await aggregateDailyUsage(r, NOW, 0); // 하한 clamp → 오늘 하루
    assert.equal(one.days.length, 1);
    assert.equal(one.days[0].date, localKey(midnightAgo(0)));
    const big = await aggregateDailyUsage(r, NOW, 9999); // 상한 clamp
    assert.equal(big.days.length, MAX_DAILY_DAYS);
    // 기록이 전혀 없어도 전 구간 0 버킷으로 채워진다
    assert.ok(big.days.every((d) => d.totalTokens === 0 && d.entries === 0));
  } finally {
    await fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('daily: files with mtime older than window are skipped', async () => {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-daily3-'));
  try {
    const proj = path.join(r, 'C--daily');
    await fs.mkdir(proj, { recursive: true });
    const f = path.join(proj, 'old.jsonl');
    // 내용은 오늘(창 안)이지만 mtime을 10일 전으로 — 3일 창에서는 열리지 않는다
    await fs.writeFile(f, entryAt(NOW - 1000, { input_tokens: 123 }) + '\n');
    const oldSec = (NOW - 10 * 24 * 60 * 60 * 1000) / 1000;
    await fs.utimes(f, oldSec, oldSec);
    const { days } = await aggregateDailyUsage(r, NOW, 3);
    assert.ok(days.every((d) => d.totalTokens === 0));
  } finally {
    await fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('usage fields default to 0 when absent', async () => {
  const r2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-usage2-'));
  try {
    const proj = path.join(r2, 'C--x');
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(
      path.join(proj, 's.jsonl'),
      entry(1000, { output_tokens: 5 }) + '\n',
    );
    const { fiveHour } = await aggregateUsage(r2, NOW);
    assert.equal(fiveHour.totalTokens, 5);
    assert.equal(fiveHour.inputTokens, 0);
    assert.equal(fiveHour.entries, 1);
  } finally {
    await fs.rm(r2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
