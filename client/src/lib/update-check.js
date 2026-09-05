// 업데이트 확인 결과 판정 — /api/update-check 응답 하나를 화면이 그릴 수 있는 상태로
// 바꾼다. 서버는 "무엇을 알아냈는가"만 말하고(latest/current/error), "업데이트가
// 있는가"는 여기서 판정한다.
//
// semver 전부를 다루지 않는다: 이 앱이 자기 자신을 배포하는 형식
// (major.minor.patch)만 수치로 비교하고, 프리릴리스/빌드 접미사는 **떼고** 비교한다.
// 그래서 1.9.5-beta.1과 1.9.5는 같다고 본다 — 프리릴리스 사용자에게 같은 번호로
// "업데이트하세요"를 띄우는 것이 더 나쁜 오답이기 때문이다.
//
// 이름이 parseSemver인 이유: model-catalog.js의 parseVersion은 "모델 id에서 세대
// 뽑기"라는 다른 뜻으로 이미 쓰이고 있어, 같은 이름이 두 뜻을 가지면 import 한 줄로 오독한다.

/** 새 버전을 받는 곳 — 배포 채널이 곧 여기다(tgz 자산이 릴리스마다 붙는다). */
export const RELEASES_URL = 'https://github.com/seokjw0727/CC-on-browser/releases';

/**
 * 실행 안내는 표시까지만 한다 — 서버가 설치를 대신 실행하지 않는다(설계도 §1).
 * 내려받은 tarball을 가리키는 이유는 그것이 README가 안내하는 실제 설치 경로이기
 * 때문이다. npm 이름으로 바로 까는 한 줄은 게시된 적이 없어 그대로 실패한다.
 * @param {string} latest 릴리스 태그에서 v를 뗀 버전
 */
export function updateCommand(latest) {
  return `npm install -g ./cc-on-browser-${latest}.tgz`;
}

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
 *          |{state:'outdated', current, latest, command: string, url: string}
 *          |{state:'unknown', current, latest,
 *            reason:'not-published'|'fetch-failed'|'missing'|'unparsable'}}
 */
export function updateStatus(payload) {
  const current = typeof payload?.current === 'string' ? payload.current : null;
  const latest = typeof payload?.latest === 'string' ? payload.latest : null;
  // 조회 자체가 실패한 경우가 먼저다 — latest가 없는 이유를 '모른다'로 뭉뚱그리면
  // 화면이 '다시 시도' 버튼을 내줄지 판단하지 못한다. 그 안에서 '게시된 릴리스 없음'을
  // 다시 갈라 내는 이유도 같다: 그쪽은 다시 눌러도 달라질 것이 없어, 재시도를 권하면
  // 있지도 않은 네트워크 고장을 의심하게 만든다.
  if (payload?.error) {
    const reason = payload.error === 'not published' ? 'not-published' : 'fetch-failed';
    return { state: 'unknown', current, latest, reason };
  }
  if (!current || !latest) return { state: 'unknown', current, latest, reason: 'missing' };
  const cmp = compareSemver(current, latest);
  if (cmp === null) return { state: 'unknown', current, latest, reason: 'unparsable' };
  if (cmp < 0) {
    return {
      state: 'outdated',
      current,
      latest,
      command: updateCommand(latest),
      url: RELEASES_URL,
    };
  }
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
  if (result.reason === 'not-published') {
    // 네트워크를 언급하지 않는다 — 여기서 사용자가 할 일은 재시도가 아니라 기다림이다.
    // 두 사정을 한 문장에 담는 이유: 익명 조회에는 "릴리스가 없다"와 "저장소가 비공개다"가
    // 똑같은 404로 와서, 우리도 둘 중 어느 쪽인지 알 수 없다(server.js 같은 자리 주석).
    return '배포된 릴리스를 찾지 못했습니다 — 아직 게시 전이거나 저장소가 비공개입니다.';
  }
  if (result.reason === 'fetch-failed') {
    return '업데이트를 확인하지 못했습니다 — 네트워크를 확인한 뒤 다시 시도해 주세요.';
  }
  if (result.reason === 'missing') return '버전을 알 수 없어 비교하지 못했습니다.';
  return '버전 형식을 알아보지 못해 비교하지 못했습니다.';
}
