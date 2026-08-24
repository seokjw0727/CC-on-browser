// 노력 수준 정의 + CLI 매핑 + 슬라이더 순수 헬퍼.
//
// 'ultracode'는 UI 최상위 티어다 — 실제 claude CLI의 --effort는 low|medium|high|
// xhigh|max만 받는다(claude --help 실측). CLI 자신의 `/effort ultracode`는 이를
// **effortLevel 'xhigh' + ultracode 플래그**로 보내므로(v2.1.233 바이너리 실측),
// 우리도 같은 의미로 매핑한다: effortSettings()가 그 단일 출처다.
// ultracode는 워크플로 지원 계정·xhigh 지원 모델을 요구하므로, 미지원 환경에서는
// 실효가 '매우 높음'(xhigh)에 머문다.
// desc는 도트 hover 툴팁에서 `<라벨> — <desc>` 형태로 쓰이므로, 문구를 대시로 시작하지
// 않는다(대시가 겹쳐 보인다).
export const EFFORT_LEVELS = [
  { value: 'low', label: '낮음', desc: '가장 빠른 응답. 간단한 편집·질문에 적합합니다.' },
  { value: 'medium', label: '중간', desc: '속도와 정확도의 균형. 가벼운 작업에 적합합니다.' },
  { value: 'high', label: '높음', desc: 'CLI 기본값. 대부분의 코딩 작업에 권장됩니다.' },
  { value: 'xhigh', label: '매우 높음', desc: '더 깊게 추론합니다. 까다로운 버그·설계에 적합합니다.' },
  { value: 'max', label: '최대', desc: 'CLI가 지원하는 최고 노력. 가장 느리지만 가장 깊게 생각합니다.' },
  {
    value: 'ultracode',
    label: '울트라코드',
    ultra: true,
    desc: '매우 높음 + 멀티에이전트 워크플로(플래그십). 미지원 환경에서는 매우 높음과 같습니다.',
  },
];

export const DEFAULT_EFFORT = 'high'; // CLI 기본값 (claude --help 실측: defaults to high)

// 팝오버 (?) 아이콘의 전체 도움말 — 슬라이더 헤더와 같은 곳에서만 쓰지만 문구는
// 여기 정의를 단일 출처로 둔다(레벨별 desc와 짝).
export const EFFORT_HELP =
  '노력 수준은 모델이 답하기 전에 얼마나 깊게 생각할지를 정합니다. '
  + '높이면 더 정확하지만 느려지고 토큰도 더 씁니다. '
  + '변경은 실행 중인 세션에 즉시 적용됩니다(진행 중인 턴은 다음 턴부터).';

// UI 전용 최상위 티어 — 모델이 보고하는 supportedEffortLevels 목록에는 없으므로
// 그 필터에서 제외되지 않도록 항상 UI에 노출한다.
const UI_ONLY = new Set(['ultracode']);

/**
 * UI 티어 → 서버로 보내는 페이로드 {effort, ultracode}. start·setEffort로 나가는
 * 노력 수준은 반드시 이 함수를 거친다. ultracode는 CLI와 동일하게 xhigh + 플래그로
 * 분해된다(서버 검증은 low..max만 통과시키므로 'ultracode' 문자열은 나가지 않는다).
 */
export function effortPayload(effort) {
  if (effort === 'ultracode') return { effort: 'xhigh', ultracode: true };
  return { effort: effort ?? null, ultracode: false };
}

/** effortPayload의 역함수 — 서버 effortSet 방송을 UI 티어로 되돌린다. */
export function uiEffort({ effort = null, ultracode = false } = {}) {
  if (ultracode) return 'ultracode';
  return effort ?? null;
}

export function isUiEffort(effort) {
  return UI_ONLY.has(effort);
}

export function effortLabel(effort) {
  return EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? effort;
}

export function effortDesc(effort) {
  return EFFORT_LEVELS.find((l) => l.value === effort)?.desc ?? '';
}

// ----- 슬라이더 순수 헬퍼 (DOM 없이 단위 테스트되는 부분) -----

/**
 * 슬라이더에 **표시할** 수준 목록 — 모델이 보고한 지원 목록으로 거르되, 현재 값은
 * 지원 목록에 없더라도 남긴다.
 *
 * 남기는 이유: 빼면 호출측의 findIndex가 -1이 되고, 그걸 0으로 클램프하면 슬라이더가
 * '낮음'으로 뭉개진다 — 사용자는 모델을 바꿨을 뿐인데 노력 수준이 저 혼자 최하로
 * 내려간 것처럼 본다(모델마다 supportedEffortLevels가 다르다).
 *
 * 보존은 **표시**에 한정된다: 이 목록에 남았다고 미지원 값을 새로 보내게 되지는 않는다.
 * 커밋은 현재 값과 같으면 건너뛰고, 값이 실제로 바뀌면 이 목록이 그 즉시 다시 계산돼
 * 옛 값이 사라지기 때문이다.
 *
 * UI 티어(ultracode)는 모델의 지원 목록에 없다 — xhigh + 플래그로 나가므로 그 모델이
 * xhigh를 지원할 때만 노출한다(지원하지 않는 수준을 보내지 않기 위해). 지원 목록 자체를
 * 보고하지 않는 모델은 판단 근거가 없으니 전부 노출한다(기존 동작).
 *
 * @param {string[]|null|undefined} reported 모델이 보고한 supportedEffortLevels
 * @param {string|null} current 현재 노력 수준(UI 티어)
 * @returns {Array<object>} EFFORT_LEVELS의 부분집합 — 전역 순서를 유지한다
 */
export function visibleEffortLevels(reported, current) {
  const list = Array.isArray(reported) ? reported : null;
  if (!list?.length) return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter((l) => (
    l.value === current
    || (isUiEffort(l.value) ? list.includes('xhigh') : list.includes(l.value))
  ));
}

/** 트랙 위 비율(0~1) → 가장 가까운 레벨 인덱스. 범위를 벗어난 값도 양끝으로 붙인다. */
export function effortIndexFromRatio(ratio, count) {
  if (!Number.isFinite(ratio) || !Number.isFinite(count) || count <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.min(count - 1, Math.max(0, Math.round(clamped * (count - 1))));
}

/** 레벨 인덱스 → 트랙 위 비율(0~1). 도트·핸들·채움의 공통 좌표. */
export function effortRatioFromIndex(index, count) {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 1) return 0;
  const clamped = Math.min(count - 1, Math.max(0, index));
  return clamped / (count - 1);
}

/**
 * ARIA slider 키보드 규약 → 다음 인덱스. 처리하지 않는 키는 null을 돌려주므로
 * 호출측이 기본 동작을 막을지(preventDefault) 판단할 수 있다.
 * 오름차순 트랙이라 ArrowUp/Right가 증가, ArrowDown/Left가 감소한다.
 */
export function nextEffortIndex(key, index, count) {
  if (!Number.isFinite(count) || count <= 0) return null;
  const cur = Math.min(count - 1, Math.max(0, Number.isFinite(index) ? index : 0));
  const clamp = (i) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(cur + 1);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(cur - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageUp':
      return clamp(cur + 2);
    case 'PageDown':
      return clamp(cur - 2);
    default:
      return null;
  }
}
