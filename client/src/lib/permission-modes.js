// 권한 모드의 한국어 표기·색 클래스 — 입력 상자 안쪽 우측 상단의 셀렉트
// (PermissionModeBar)와 새 세션 모달이 공유한다.
// 색 규약(사용자 지정): 기본모드 무색, 자동모드 파랑, 플랜모드 초록, 신뢰모드 빨강
// (select.mode-* 규칙은 interact.css).
export const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const MODE_LABEL = {
  default: '기본모드',
  acceptEdits: '자동모드',
  plan: '플랜모드',
  bypassPermissions: '신뢰모드',
};

export const MODE_CLASS = {
  default: '',
  acceptEdits: 'mode-auto',
  plan: 'mode-plan',
  bypassPermissions: 'mode-trust',
};

// 셀렉트용 한 줄 설명 — pill(공간이 좁다)은 MODE_LABEL만 쓰고, 목록에서 고르는
// 자리(새 세션 모달·설정 기본값·Config 편집기)는 이 설명까지 붙인 라벨을 쓴다.
export const MODE_DESC = {
  default: '매번 확인',
  acceptEdits: '파일 편집 자동 허용',
  plan: '계획만, 실행 안 함',
  bypassPermissions: '확인 없이 전부 실행',
};

export const PERMISSION_MODES = MODES.map((value) => ({
  value,
  label: `${MODE_LABEL[value]} — ${MODE_DESC[value]}`,
}));
