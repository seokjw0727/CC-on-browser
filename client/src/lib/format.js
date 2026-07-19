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
// 접미사가 실리는 자리는 보고 경로마다 다르다(실측 2026-07-11, opus[1m] 캡처):
//   카탈로그: value 'default'→resolvedModel 'claude-opus-4-8[1m]',
//             반대로 value 'claude-fable-5[1m]'→resolvedModel 'claude-fable-5'
//   system/init.model = 'claude-opus-4-8[1m]' (접미사 유지)
//   assistant message.model = 'claude-opus-4-8' (접미사 탈락 bare id)
// 판별: ① 정확 일치(별칭 value 우선 → 해석 id) 항목의 양쪽 필드에 [1m]이 있으면 1M
//       ② bare id는 접미사를 벗긴 base로 후보를 모아, 전부 [1m]이면 1M —
//          비[1m] 변형과 혼재하면 어느 쪽인지 알 수 없으므로 보수적으로 200k
//       ③ 카탈로그 불일치는 문자열 자체의 [1m]로만 판별.
// 모델 미지정(null/'')은 CLI 기본 = 카탈로그의 'default' 항목으로 해석한다.
export const CONTEXT_WINDOW = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;
export function contextWindowFor(model, models = []) {
  const s = String(model ?? '') || 'default';
  const list = Array.isArray(models) ? models : [];
  const has1m = (v) => String(v ?? '').includes('[1m]');
  // 별칭(value)은 카탈로그의 고유 키 — 단일 일치로 충분
  const valueHit = list.find((m) => m?.value === s);
  if (valueHit) {
    return [s, valueHit.value, valueHit.resolvedModel].some(has1m)
      ? CONTEXT_WINDOW_1M
      : CONTEXT_WINDOW;
  }
  // 해석 id는 [1m]·비[1m] 변형이 공유할 수 있다 — 전 일치 항목을 모아
  // base 분기와 같은 규칙(전부 [1m]일 때만 1M, 혼재 시 보수적 200k)을 적용
  const resolvedHits = list.filter((m) => m?.resolvedModel === s);
  if (resolvedHits.length > 0) {
    return has1m(s) || resolvedHits.every((m) => has1m(m?.value) || has1m(m?.resolvedModel))
      ? CONTEXT_WINDOW_1M
      : CONTEXT_WINDOW;
  }
  const strip = (v) => String(v ?? '').replace(/\[1m\]$/, '');
  const cands = list.filter((m) => strip(m?.value) === s || strip(m?.resolvedModel) === s);
  if (cands.length > 0) {
    return cands.every((m) => has1m(m?.value) || has1m(m?.resolvedModel))
      ? CONTEXT_WINDOW_1M
      : CONTEXT_WINDOW;
  }
  return has1m(s) ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW;
}

// 쿼터 리셋 시각 표기 — 당일이면 시각만, 하루를 넘기면 날짜까지.
// Composer 상태줄 툴팁·사이드바 통계 섹션이 같은 표기를 쓴다.
export function fmtReset(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString()
      : d.toLocaleString();
  } catch {
    return null;
  }
}

// 파일 크기 축약(1024 기준) — 사이드바 "지난 세션" 대화 크기 표기.
// 유한 아님·음수는 null(호출측 미표시), 0은 "0 B".
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${Math.floor(n)} B`;
  // toFixed(1)이 "1024.0 KB"를 만들지 않게 반올림 임계(1023.95)에서 상위 단위로 승급
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1023.95 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// 상대 시각 — "방금"/"n분 전"/"n시간 전"/"n일 전", 7일 이상은 로케일 날짜.
// 미래 timestamp(시계 왜곡)는 "방금"으로 clamp, invalid/0 이하는 null.
// 리렌더 시점 기준이라 방치 시 다소 뒤처질 수 있다(허용 정책 — 설계도 §4).
export function fmtAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const diff = now - ms; // 미래(음수)는 첫 분기("방금")로 흡수
  if (diff < 60_000) return '방금';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return null;
  }
}

// 경로 꼬리 2단 축약 — 세션 이름 표기 관례 (레포 pill·사이드바·접힘 배지 공통)
export function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}
