// 공용 표시 포매터 — Composer(상태줄)·Message(usage 꼬리표)·App/Sidebar(경로)에서
// 같은 표기를 쓰도록 단일화한다 (사본 발산 방지).

// 토큰 수 축약(1234 → 1.2k) — CLI 상태줄 표기 관례
export function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// 세션 컨텍스트 창 크기 — CLI는 1M 컨텍스트 모델을 '[1m]' 접미사로 표기하지만,
// 접미사가 실리는 필드는 일정하지 않다(v2.1.205 initialize 캡처: value 'default'→
// resolvedModel 'claude-opus-4-8[1m]', 반대로 value 'claude-fable-5[1m]'→
// resolvedModel 'claude-fable-5'). 그래서 모델 문자열 자체와, 카탈로그(models)에서
// 그 문자열이 별칭(value)이든 해석 id(resolvedModel)든 매칭된 항목의 양쪽 필드를
// 모두 보고 어느 하나라도 '[1m]'이면 1M로 판별한다. 카탈로그 없이도 동작(문자열만).
export const CONTEXT_WINDOW = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;
export function contextWindowFor(model, models = []) {
  const s = String(model ?? '');
  const list = Array.isArray(models) ? models : [];
  // 별칭 일치 우선 — 해석 id는 [1m]·비[1m] 변형이 공유할 수 있어 뒤로 미룬다
  const entry =
    list.find((m) => m?.value === s) ?? list.find((m) => m?.resolvedModel === s) ?? null;
  const fields = entry ? [s, entry.value, entry.resolvedModel] : [s];
  return fields.some((f) => String(f ?? '').includes('[1m]'))
    ? CONTEXT_WINDOW_1M
    : CONTEXT_WINDOW;
}

// 경로 꼬리 2단 축약 — 세션 이름 표기 관례 (레포 pill·사이드바·접힘 배지 공통)
export function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}
