// quota.js — 계정의 공식 사용률(5h/7d %) 조회.
//
// **기본값은 꺼짐이다.** 이 모듈은 /api/usage가 `?quota=1` 옵트인을 받았을 때만 호출된다
// (server.js의 관문). 사용자가 설정에서 켜지 않으면 자격증명 파일을 읽지도, 바깥으로
// 나가지도 않는다. 켠 경우 CLI가 이미 저장해 둔 구독 OAuth 토큰으로 사용량 메타데이터
// endpoint 하나만 GET한다 — 모델 호출이 아니라 과금이 없고, 받는 것은 사용률 수치뿐이다.
// 토큰은 이 모듈 밖으로 나가지 않으며, 실패(파일 없음·만료·네트워크·비2xx)는 전부 null이다.
// 이 기능이 무엇을 하고 사용자가 무엇을 감수하는지는 SECURITY.md에 적어 두었다.
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

// 응답 형상: { five_hour: { utilization, resets_at, ... }, seven_day: { ... }, ... }
// utilization은 퍼센트 숫자, resets_at은 ISO 문자열이다. 둘 중 하나라도 기대한 형태가
// 아니면 그 창을 null로 접는다 — 그 판정을 아래 windowInfo 하나가 맡는다.
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
