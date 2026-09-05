// 사용자 기본값(설정 → 새 세션 모달 초기값) 영속 유틸.
// 적용 범위는 "새 세션 모달을 열 때의 초기 선택값"뿐이다 — 실행 중 세션이나
// 사이드바 어디에도 소급 적용하지 않는다(설계도 §1).
//
// storage 인자는 테스트 주입용. 브라우저에서는 localStorage가 차단 컨텍스트
// (사파리 프라이빗 등)에서 접근만으로 throw할 수 있으므로 읽기·쓰기·삭제를
// 전부 try/catch로 감싼다 — 실패해도 조용히 기본값으로 동작한다.
import { MODES } from './permission-modes.js';

export const DEFAULT_MODEL_KEY = 'ccob-default-model';
export const DEFAULT_MODE_KEY = 'ccob-default-mode';
// 계정 공식 사용률 조회의 켬/끔. 다른 기본값들과 성격이 다르다 — 새 세션 모달의
// 초기 선택값이 아니라, 앱이 이 컴퓨터 밖으로 요청을 내보내도 되는지의 허락이다.
export const OFFICIAL_USAGE_KEY = 'ccob-official-usage';

// globalThis.localStorage 자체가 throw할 수 있어 getter도 try/catch.
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 저장값 읽기 — 없거나 실패하면 null. */
export function readPref(key, storage = defaultStorage()) {
  try {
    const v = storage?.getItem(key);
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 저장값 쓰기 — 빈 문자열/null은 키 삭제(= "지정 안 함").
 * 반환값은 "영속에 실제로 성공했는가"다. storage 자체가 없으면(차단 컨텍스트)
 * 아무것도 쓰이지 않았으므로 false — 호출측이 "저장했다"고 오보하지 않게 한다.
 */
export function writePref(key, value, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    if (value === null || value === undefined || value === '') storage.removeItem(key);
    else storage.setItem(key, String(value));
    return true;
  } catch {
    return false; // 저장 실패해도 세션 내 선택은 그대로 살아 있다
  }
}

/** 권한 모드 정규화 — MODES 밖의 값(손댄 localStorage·구버전)은 'default'로. */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : 'default';
}

/**
 * 저장된 기본 모델을 현재 CLI 카탈로그와 대조한다 — 스폰 인자로 쓰기 직전의 관문.
 * 카탈로그에 없으면 ''(= --model 생략, CLI 기본)으로 낙하 — 오래되거나 손댄
 * 값이 스폰 인자로 새어 나가 세션 시작을 깨뜨리는 것을 막는다.
 *
 * 카탈로그가 비어 있는(= 세션 init 전이라 검증 불가능한) 경우도 ''로 낙하한다.
 * "검증할 수 없으면 통과시키지 않는다" — 셀렉트를 비활성으로 두는 것만으로는
 * 이미 상태에 남아 있는 값이 스폰되는 경로를 막지 못하기 때문(codex 지적).
 * 검증 전의 원본 보존은 loadDefaults()/설정 UI의 몫이다.
 *
 * 대조는 카탈로그의 value(스폰 키)로만 한다 — resolvedModel 같은 해석 id는
 * --model 인자로 유효하지 않을 수 있어 일부러 받지 않는다.
 */
export function resolveDefaultModel(saved, models) {
  if (!saved) return '';
  if (!Array.isArray(models) || models.length === 0) return '';
  return models.some((m) => m && m.value === saved) ? saved : '';
}

/** 설정에 저장된 기본값 묶음 — 새 세션 모달의 useState 시드. */
export function loadDefaults(storage = defaultStorage()) {
  return {
    model: readPref(DEFAULT_MODEL_KEY, storage) ?? '',
    mode: normalizeMode(readPref(DEFAULT_MODE_KEY, storage)),
  };
}

/**
 * 계정 공식 사용률(5h/7d %)을 조회해도 되는가 — **기본값은 꺼짐**이다.
 *
 * 켜면 서버가 CLI의 구독 OAuth 토큰(~/.claude/.credentials.json)으로
 * api.anthropic.com의 사용량 메타데이터 endpoint 하나를 조회한다. 모델 호출이 아니라
 * 과금은 없지만, 서드파티 도구가 구독 자격증명을 쓰는 것 자체가 사용자가 직접 내려야
 * 할 판단이므로 기본값으로 켜 두지 않는다(SECURITY.md의 위협 모델 참조).
 *
 * 저장소가 막힌 컨텍스트에서는 읽기가 null이라 자동으로 꺼짐이 된다 — 판단할 수 없으면
 * 나가지 않는 쪽이 안전한 기본값이다.
 */
export function officialUsageEnabled(storage) {
  return readPref(OFFICIAL_USAGE_KEY, storage) === '1';
}

/**
 * 켬/끔 저장. 끄면 키를 지운다. 반환값은 "영속에 실제로 성공했는가"다 —
 * 저장이 막힌 채 스위치만 켜지면 다음 폴링이 다시 꺼짐으로 읽어 조회가 나가지 않으므로,
 * 호출측은 이 값이 false면 켜진 모습을 보여선 안 된다(한도 알림 토글과 같은 규약).
 */
export function setOfficialUsageEnabled(on, storage) {
  return writePref(OFFICIAL_USAGE_KEY, on ? '1' : '', storage);
}
