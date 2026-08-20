// 업데이트 확인 결과 판정 — /api/update-check 응답 하나를 화면이 그릴 수 있는 상태로
// 바꾼다. 서버는 "무엇을 알아냈는가"만 말하고(latest/current/error), "업데이트가
// 있는가"는 여기서 판정한다.
//
// semver 전부를 다루지 않는다: 이 앱이 자기 자신을 npm에 배포하는 형식
// (major.minor.patch)만 수치로 비교하고, 프리릴리스/빌드 접미사는 **떼고** 비교한다.
// 그래서 1.9.5-beta.1과 1.9.5는 같다고 본다 — 프리릴리스 사용자에게 같은 번호로
// "업데이트하세요"를 띄우는 것이 더 나쁜 오답이기 때문이다.
//
// 이름이 parseSemver인 이유: model-catalog.js의 parseVersion은 "모델 id에서 세대
// 뽑기"라는 다른 뜻으로 이미 쓰이고 있어, 같은 이름이 두 뜻을 가지면 import 한 줄로 오독한다.

/** 실행 안내는 표시까지만 한다 — 서버가 npm install을 대신 실행하지 않는다(설계도 §1). */
export const UPDATE_COMMAND = 'npm i -g cc-on-browser@latest';

/**
 * '1.9.5' | 'v1.9.5' | '1.10.0-beta.2' | '2.0.0+build.5' → {major, minor, patch}
 * 세 자리가 모두 숫자여야 한다 — '1.9'·'latest'·''·null은 전부 null(비교 포기).
 * @param {unknown} raw
 * @returns {{major: number, minor: number, patch: number} | null}
 */
export function parseSemver(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * a가 b보다 낮으면 -1, 같으면 0, 높으면 1. 한쪽이라도 파싱 불가면 null.
 * 문자열 비교로 하면 '1.10.0' < '1.9.9'가 되므로 자리마다 수치로 견준다.
 * @returns {-1 | 0 | 1 | null}
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

/**
 * /api/update-check 응답을 그대로 받아 화면 상태로 환원한다.
 * @param {{current: string|null, latest: string|null, error?: string}} payload
 * @returns {{state:'current', current, latest, ahead: boolean}
 *          |{state:'outdated', current, latest, command: string}
 *          |{state:'unknown', current, latest, reason:'fetch-failed'|'missing'|'unparsable'}}
 */
export function updateStatus(payload) {
  const current = typeof payload?.current === 'string' ? payload.current : null;
  const latest = typeof payload?.latest === 'string' ? payload.latest : null;
  // 조회 자체가 실패한 경우가 먼저다 — latest가 없는 이유를 '모른다'로 뭉뚱그리면
  // 화면이 '다시 시도' 버튼을 내줄지 판단하지 못한다.
  if (payload?.error) return { state: 'unknown', current, latest, reason: 'fetch-failed' };
  if (!current || !latest) return { state: 'unknown', current, latest, reason: 'missing' };
  const cmp = compareSemver(current, latest);
  if (cmp === null) return { state: 'unknown', current, latest, reason: 'unparsable' };
  if (cmp < 0) return { state: 'outdated', current, latest, command: UPDATE_COMMAND };
  // cmp > 0은 로컬에서 빌드한 개발 버전이다 — '업데이트 있음'으로 보이면 안 되므로
  // 최신과 같은 칸에 넣되, 문구가 달라질 수 있게 ahead로 표시만 남긴다.
  return { state: 'current', current, latest, ahead: cmp > 0 };
}

/**
 * 결과 문구 — 텍스트를 JSX 밖에 두어 node --test로 고정한다.
 * @param {ReturnType<typeof updateStatus>} result
 * @returns {string}
 */
export function updateMessage(result) {
  if (result.state === 'outdated') {
    return `새 버전 v${result.latest}이 있습니다 (현재 v${result.current}).`;
  }
  if (result.state === 'current') {
    return result.ahead
      ? `배포된 최신 버전(v${result.latest})보다 앞선 버전을 쓰고 있습니다 (현재 v${result.current}).`
      : `최신 버전입니다 (v${result.current}).`;
  }
  if (result.reason === 'fetch-failed') {
    return '업데이트를 확인하지 못했습니다 — 네트워크를 확인한 뒤 다시 시도해 주세요.';
  }
  if (result.reason === 'missing') return '버전을 알 수 없어 비교하지 못했습니다.';
  return '버전 형식을 알아보지 못해 비교하지 못했습니다.';
}
