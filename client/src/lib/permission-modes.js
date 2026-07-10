// 권한 모드의 한국어 표기·색 클래스 — 컴포저 pill과 새 세션 모달이 공유한다.
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
