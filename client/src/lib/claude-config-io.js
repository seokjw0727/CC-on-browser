// 설정 파일 API의 응답·실패를 화면이 쓸 형상으로 정리하는 순수 함수들.
//
// 이것들이 claude-config-draft.js(훅)와 **다른 파일**에 있는 이유는 하나다: 훅은
// api.js를 import하고, api.js는 store.jsx를 import한다. node --test는 .jsx를 로드하지
// 못하므로 훅 파일에 두면 이 규칙들을 단위 테스트로 고정할 수 없다. 여기는 import가
// 하나도 없어 그대로 테스트된다.

/** 저장 성공 토스트 문구 — e2e가 이 문자열로 저장 완료를 기다린다. */
export const SAVED_NOTICE = 'Claude Code 설정을 저장했습니다. 이후 시작되는 세션부터 적용됩니다.';

/**
 * /api/claude-config 응답 → 화면 상태. content에 `??`만 쓰는 이유: 빈 문자열은
 * "빈 파일"이라는 사실이므로 폼이 '{}'로 조용히 지어내면 안 된다.
 */
export function normalizeConfigResponse(res) {
  return { path: res?.path || '', text: res?.content ?? '{}', mtimeMs: res?.mtimeMs ?? null };
}

/** 설치 목록 조회 실패는 켬/끔 편집을 막지 않는다 — 배열이 아니면 빈 목록으로 간다. */
export function normalizePluginList(res) {
  return Array.isArray(res?.plugins) ? res.plugins : [];
}

/**
 * 저장 전 클라이언트 검증. 최상위가 객체인지는 **일부러 보지 않는다** — 저장은
 * 폼(formReady)보다 느슨한 기준을 쓰고, 서버가 다시 검증한다.
 * @returns {string|null} 문제가 없으면 null
 */
export function jsonSyntaxIssue(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return `JSON 문법 오류: ${err.message}`;
  }
}

/** 저장 실패를 화면 문구로. 409만 "덮어쓰지 않았다"는 사실을 따로 알린다. */
export function saveFailure(err) {
  return err?.status === 409
    ? {
        conflict: true,
        message: '다른 곳에서 파일이 바뀌었습니다. 덮어쓰지 않았습니다 — 다시 불러온 뒤 편집하세요.',
      }
    : { conflict: false, message: String(err?.message ?? err) };
}
