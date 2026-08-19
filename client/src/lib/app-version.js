/* global __APP_VERSION__ */
// 이 번들이 어느 버전에서 빌드됐는지 — vite define이 빌드·개발 서버 모두에서
// package.json의 값을 문자열 리터럴로 박아 넣는다(client/vite.config.js).
//
// 왜 필요한가: 데몬은 브라우저를 닫아도 살아남고 재실행은 그 데몬을 재사용하므로,
// 업그레이드 직후 "새 클라이언트 번들 + 구 서버"가 만날 수 있다. 그러면 새로 생긴
// WS 메시지가 `unknown message type: …`으로 튕긴다(v1.9.3 데몬 실측). 사용자가 그
// 상황을 알아볼 수 있도록 서버 버전(/api/bootstrap)과 견주는 데 쓴다.
//
// define이 없는 환경(node --test로 이 모듈만 부르는 경우)에서는 null이다 —
// typeof는 선언되지 않은 식별자에도 던지지 않으므로 그대로 안전하다.
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;

/**
 * 클라이언트·서버 버전이 어긋났는가. 어느 한쪽을 모르면(구버전 서버는 bootstrap에
 * version을 싣지 않는다) 판정하지 않는다 — 다만 그 경우도 스큐의 증거이므로,
 * 호출측이 serverVersion === undefined를 "구버전 서버"로 따로 다룰 수 있게
 * 값이 아니라 이유를 돌려준다.
 * @returns {null | {client: string, server: string|null}} null이면 정상
 */
export function versionSkew(serverVersion) {
  if (!APP_VERSION) return null; // 번들 버전을 모르면 비교 자체를 하지 않는다
  if (serverVersion === APP_VERSION) return null;
  return { client: APP_VERSION, server: typeof serverVersion === 'string' ? serverVersion : null };
}
