// quota.js — 계정의 공식 사용률(5h/7d %) 조회.
// 사용자 승인 예외(2026-07-10): CLI의 구독 OAuth 토큰(~/.claude/.credentials.json)으로
// api.anthropic.com의 사용량 메타데이터 endpoint 하나만 GET한다 — 모델 호출이 아니며
// 과금이 없다(/usage 패널과 동일한 수치). 토큰은 이 모듈 밖으로 내보내지 않고,
// 응답에는 사용량 수치만 있다. 실패(파일 없음·만료·네트워크·비2xx)는 전부 null.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// 행 걸린 네트워크가 /api/usage 응답(로컬 집계 포함)을 인질로 잡지 않도록 상한을 둔다.
const QUOTA_TIMEOUT_MS = 4_000;

async function readAccessToken(credentialsPath) {
  let raw;
  try {
    raw = await fs.readFile(credentialsPath, 'utf8');
  } catch {
    return null;
  }
  let cred;
  try {
    cred = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = cred?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  // 만료 토큰은 쓰지 않는다 — 갱신은 CLI 자신의 몫(다음 CLI 사용 때 자동 갱신됨).
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
  return oauth.accessToken;
}

// 실측 응답(2026-07-10, 200 OK): { five_hour: {utilization: 46.0, resets_at: ISO, ...},
//                                  seven_day: {utilization: 28.0, resets_at: ISO, ...}, ... }
function windowInfo(w) {
  if (!w || typeof w !== 'object') return null;
  const utilization = Number(w.utilization);
  if (!Number.isFinite(utilization)) return null;
  const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
  return { utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

export async function fetchQuota({ credentialsPath = DEFAULT_CREDENTIALS_PATH, fetchFn = fetch } = {}) {
  const token = await readAccessToken(credentialsPath);
  if (!token) return null;
  let res;
  try {
    res = await fetchFn(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
      redirect: 'error', // 이 GET에 redirect 추종은 필요 없다 — 명시 차단
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const fiveHour = windowInfo(body.five_hour);
  const sevenDay = windowInfo(body.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, fetchedAt: Date.now() };
}
