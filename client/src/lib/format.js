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

// 경로 꼬리 2단 축약 — 세션 이름 표기 관례 (레포 pill·사이드바·접힘 배지 공통)
export function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}
