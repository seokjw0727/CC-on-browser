// 노력 수준 정의 + spawn 매핑.
//
// 'ultracode'는 CC-on-browser 전용 최상위 "의사(pseudo) 티어"다 — 실제 claude CLI의
// --effort는 low|medium|high|xhigh|max만 받는다(claude --help v2.1.x 실측). 그래서
// ultracode는 UI/표시에서만 별도 모드로 구분하고, 서버/CLI로 나갈 때는 spawnEffort()가
// 실제 CLI 값(max)으로 매핑한다. 즉 ultracode = "최대 노력 + 강조 표시된 플래그십 모드"이며,
// 브라우저가 스폰하는 평범한 CLI 세션에는 별도 워크플로 채널이 없으므로 실효는 max 노력이다.
export const EFFORT_LEVELS = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '중간' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '매우 높음' },
  { value: 'max', label: '최대' },
  { value: 'ultracode', label: '울트라코드', ultra: true },
];

export const DEFAULT_EFFORT = 'high'; // CLI 기본값 (claude --help 실측: defaults to high)

// UI 전용 의사 티어(실제 CLI 플래그가 아님) — supportedEffortLevels 필터에서 제외되지
// 않도록, 모델별 지원 목록과 무관하게 항상 UI에 노출한다.
const UI_ONLY = new Set(['ultracode']);

// UI 의사 티어 → 실제 CLI --effort 값. 서버(EFFORT_LEVELS 검증)·spawn으로 나가는
// effort 값은 반드시 이 함수를 거친다. ultracode는 CLI 최고 노력인 max로 낮춰 보낸다.
export function spawnEffort(effort) {
  if (effort === 'ultracode') return 'max';
  return effort ?? null;
}

export function isUiEffort(effort) {
  return UI_ONLY.has(effort);
}

export function effortLabel(effort) {
  return EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? effort;
}
