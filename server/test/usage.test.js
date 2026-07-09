// usage.js — 트랜스크립트 5h/7d 로컬 집계 테스트 (fake 픽스처만 사용, 실 CLI 미실행).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateUsage, FIVE_HOURS_MS, SEVEN_DAYS_MS } from '../src/usage.js';

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
