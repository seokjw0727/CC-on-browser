// quota.js — 공식 사용률 조회 테스트. 네트워크·실 토큰을 절대 쓰지 않는다
// (fetchFn 주입 + 임시 credentials 픽스처만 사용).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchQuota } from '../src/quota.js';

let root;
const credFile = (name) => path.join(root, name);

const writeCred = async (name, oauth) => {
  const p = credFile(name);
  await fs.writeFile(p, JSON.stringify({ claudeAiOauth: oauth }));
  return p;
};

// 실측(2026-07-10) 응답 형태의 최소 픽스처
const BODY = {
  five_hour: { utilization: 46.0, resets_at: '2026-07-09T19:19:59.874689+00:00' },
  seven_day: { utilization: 28.0, resets_at: '2026-07-15T05:59:59.874715+00:00' },
};

const okFetch = (body = BODY) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => body };
  };
  fn.calls = calls;
  return fn;
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccob-quota-'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('valid token + 200 → utilization/resetsAt(ms) mapped', async () => {
  const p = await writeCred('ok.json', {
    accessToken: 'tok_test',
    expiresAt: Date.now() + 60_000,
  });
  const fetchFn = okFetch();
  const q = await fetchQuota({ credentialsPath: p, fetchFn });
  assert.equal(q.fiveHour.utilization, 46);
  assert.equal(q.sevenDay.utilization, 28);
  assert.equal(q.fiveHour.resetsAt, Date.parse(BODY.five_hour.resets_at));
  // 요청이 Bearer 토큰과 beta 헤더를 실어 보냈는지
  assert.equal(fetchFn.calls.length, 1);
  assert.match(fetchFn.calls[0].opts.headers.Authorization, /^Bearer tok_test$/);
  assert.ok(fetchFn.calls[0].opts.headers['anthropic-beta']);
});

test('expired token → null without any fetch', async () => {
  const p = await writeCred('expired.json', {
    accessToken: 'tok_old',
    expiresAt: Date.now() - 1,
  });
  const fetchFn = okFetch();
  assert.equal(await fetchQuota({ credentialsPath: p, fetchFn }), null);
  assert.equal(fetchFn.calls.length, 0);
});

test('missing/malformed credentials → null without fetch', async () => {
  const fetchFn = okFetch();
  assert.equal(await fetchQuota({ credentialsPath: credFile('nope.json'), fetchFn }), null);
  const bad = credFile('bad.json');
  await fs.writeFile(bad, '{not json');
  assert.equal(await fetchQuota({ credentialsPath: bad, fetchFn }), null);
  assert.equal(fetchFn.calls.length, 0);
});

test('non-2xx / fetch throw / malformed body → null', async () => {
  const p = await writeCred('ok2.json', { accessToken: 't', expiresAt: Date.now() + 60_000 });
  assert.equal(
    await fetchQuota({ credentialsPath: p, fetchFn: async () => ({ ok: false, status: 401 }) }),
    null,
  );
  assert.equal(
    await fetchQuota({ credentialsPath: p, fetchFn: async () => { throw new Error('offline'); } }),
    null,
  );
  assert.equal(
    await fetchQuota({
      credentialsPath: p,
      fetchFn: async () => ({ ok: true, json: async () => ({ nothing: true }) }),
    }),
    null,
  );
  // 200인데 body가 JSON null인 경우도 계약대로 null (throw 금지)
  assert.equal(
    await fetchQuota({
      credentialsPath: p,
      fetchFn: async () => ({ ok: true, json: async () => null }),
    }),
    null,
  );
});

test('one window missing → the other still reported', async () => {
  const p = await writeCred('ok3.json', { accessToken: 't', expiresAt: Date.now() + 60_000 });
  const q = await fetchQuota({
    credentialsPath: p,
    fetchFn: okFetch({ five_hour: { utilization: 12.3, resets_at: 'not-a-date' } }),
  });
  assert.equal(Math.round(q.fiveHour.utilization * 10) / 10, 12.3);
  assert.equal(q.fiveHour.resetsAt, null);
  assert.equal(q.sevenDay, null);
});
