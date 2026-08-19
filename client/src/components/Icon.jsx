// 앱 전체 아이콘의 단일 출처. 유니코드 이모지·픽토그램(☰ ✕ 🗑 ⚡ …)을 전부 걷어내고
// 직접 그린 SVG 29종으로 대체한다(설계도 2026-08-19-frontend-emoji-to-icon-set).
//
// 왜 이모지를 안 쓰는가: 같은 글자가 OS·폰트에 따라 컬러 이모지로도, 흑백 폰트 폴백으로도
// 그려지고 baseline·굵기가 제각각이라 크기를 맞출 방법이 없다. SVG는 픽셀 단위로 고정된다.
//
// 통일 규칙 — 개별 아이콘이 아니라 이 파일의 <svg> 속성이 강제한다:
//   viewBox 0 0 24 24 · stroke-width 1.8 · linecap/linejoin round · fill none · stroke currentColor
// 새 아이콘을 추가할 때도 path만 24 격자에 맞춰 그리면 나머지는 자동으로 통일된다.
//
// 스프라이트(<symbol>+<use>)를 쓰지 않는 이유: <use>는 같은 문서에 정의가 먼저 마운트돼
// 있어야 그려지는데, 조건부 렌더가 많은 이 앱에서는 정의가 없는 순간 빈 칸이 된다.
// path를 매번 인라인으로 그린다(29종 합계 ~3KB라 중복 비용은 무시할 수준).

import './icon.css';

/**
 * 이름 → SVG 자식 요소. 좌표는 전부 24x24 격자 기준.
 * fill이 필요한 조각(경고·안내의 점)만 개별적으로 fill을 지정한다.
 */
export const ICON_PATHS = {
  // ----- 내비게이션 · 공통 -----
  menu: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  'chevron-left': <path d="M14.5 6.5L9 12l5.5 5.5" />,
  'chevron-down': <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />,
  'chevron-up': <path d="M6.5 14.5L12 9l5.5 5.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,

  // ----- 동작 -----
  'arrow-up': <path d="M12 19.5V5M5.5 11.5L12 5l6.5 6.5" />,
  'arrow-down': <path d="M12 4.5V19M5.5 12.5L12 19l6.5-6.5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />,
  retry: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.7 3.9v3.5h-3.5" />,
  undo: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.3 3.9v3.5h3.5" />,
  edit: <path d="M4.9 15.6L15.9 4.6a2 2 0 0 1 2.8 2.8L7.7 18.4l-3.9 1.1zM14.2 6.3l2.8 2.8" />,
  external: <path d="M7 17L17 7M9.5 7H17v7.5" />,
  trash: (
    <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M10.2 11v5.5M13.8 11v5.5" />
  ),
  'folder-open': (
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6A2 2 0 0 1 18.45 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  ),

  // ----- 상태 · 알림 -----
  warning: (
    <>
      <path d="M12 4.5L21 19.5H3zM12 10.5v3.5" />
      <circle cx="12" cy="16.8" r="0.4" fill="currentColor" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 11.2V16" />
      <circle cx="12" cy="8.2" r="0.4" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.4 17.6L17.6 6.4" />
    </>
  ),
  compress: <path d="M9.5 4.5v5h-5M4.9 4.9l4.6 4.6M14.5 19.5v-5h5M19.1 19.1l-4.6-4.6" />,
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" />,
  bolt: <path d="M13.2 3.5L5.5 13.5h4.8L10.8 20.5l7.7-10h-4.8z" />,

  // ----- 사물 · 테마 -----
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  document: (
    <path d="M13.5 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5zM13.5 3.5V8.5h5M9.5 13h5M9.5 16h5" />
  ),
  phone: (
    <>
      <rect x="7.5" y="3.5" width="9" height="17" rx="2.2" />
      <path d="M11 17.5h2" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>
  ),
  broom: (
    <path d="M20 4l-8.6 8.6M11.8 12.2l-2.1-.7a2.6 2.6 0 0 0-2.7.7l-3.4 3.4a12.3 12.3 0 0 0 9.4 4.2l1.4-4.2a2.6 2.6 0 0 0-.6-2.7zM7.4 15.4l-1.6 2.6M10.6 16.9l-.9 2.7" />
  ),
  command: <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M18 6l-1.6 1.6M7.6 16.4L6 18" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />,
};

/** 아이콘 이름 목록 — 테스트가 세트의 완결성을 고정하는 데 쓴다. */
export const ICON_NAMES = Object.keys(ICON_PATHS);

/**
 * @param {string} name        ICON_PATHS의 키. 없는 이름이면 아무것도 그리지 않는다.
 * @param {number} [size=16]   px. 문맥별 크기는 설계도 §3-3 표를 따른다.
 * @param {string} [className] icon.css의 색·정렬 변형(.ico-danger 등)
 * @param {string} [title]     주면 "의미 있는 아이콘"이 되어 스크린리더가 읽는다.
 *                             주지 않으면 장식으로 취급해 숨긴다 — 대부분 이쪽이다
 *                             (버튼의 aria-label이나 옆 텍스트가 이미 이름을 준다).
 */
export default function Icon({ name, size = 16, className = '', title, ...rest }) {
  const shape = ICON_PATHS[name];
  if (!shape) return null;

  // 두 모드는 배타적이다. aria-hidden과 role="img"를 함께 붙이면 이름을 준 요소를
  // 도로 숨기는 자기모순이 된다.
  //
  // 그래서 접근성 속성은 이 컴포넌트만 정하고, 호출부가 반대쪽 속성을 실어 보내면
  // 여기서 떨어뜨린다. 스프레드 순서를 바꾸는 것으로는 못 막는다 — aria-hidden과
  // role/aria-label은 서로 다른 키라 나중 스프레드가 앞의 것을 덮어쓰지 않고,
  // 세 속성이 그대로 함께 붙어 버린다(codex 지적).
  const semantic = typeof title === 'string' && title.length > 0;
  const pass = { ...rest };
  delete pass.role;
  delete pass['aria-label'];
  delete pass['aria-hidden'];

  return (
    <svg
      className={`ico${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...pass}
      {...(semantic ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' })}
    >
      {shape}
    </svg>
  );
}
