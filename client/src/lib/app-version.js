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
 * 클라이언트·서버 버전이 어긋났는가. 두 쪽을 다르게 다룬다:
 *  · **번들 버전**을 모르면(define이 없는 환경) 비교 자체를 포기하고 null — 근거가
 *    없는데 경고를 띄우면 거짓 경보가 된다.
 *  · **서버 버전**을 모르면(구버전 서버는 bootstrap에 version을 싣지 않는다) 그
 *    자체가 스큐의 증거이므로 스큐로 **보고하되** server: null로 이유를 알린다.
 * @returns {null | {client: string, server: string|null}} null이면 정상
 */
export function versionSkew(serverVersion) {
  if (!APP_VERSION) return null; // 번들 버전을 모르면 비교 자체를 하지 않는다
  if (serverVersion === APP_VERSION) return null;
  return { client: APP_VERSION, server: typeof serverVersion === 'string' ? serverVersion : null };
}

/** 값을 모를 때 정보 모달이 쓰는 라벨. 빈 칸은 "버그"로 읽히지만 이 문구는 상태로 읽힌다. */
export const UNKNOWN_LABEL = '알 수 없음';

/**
 * 정보 모달 한 행의 표시 문자열.
 *
 * "모른다"가 세 가지 모양으로 온다: ① 구버전 데몬은 bootstrap에 키 자체를 빼먹어
 * undefined ② `claude --version`이 타임아웃되면 서버가 null ③ 그 전에 죽으면 빈
 * 문자열. 셋을 한 라벨로 접지 않으면 화면에 undefined가 그대로 찍힌다.
 * port는 숫자로 오므로 함께 받는다 — 0은 진짜 값이라 '알 수 없음'으로 접으면 안 된다.
 */
export function infoValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : UNKNOWN_LABEL;
  if (typeof v !== 'string') return UNKNOWN_LABEL;
  const t = v.trim();
  return t === '' ? UNKNOWN_LABEL : t;
}
