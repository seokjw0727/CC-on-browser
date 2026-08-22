// 모서리 스타일 — 색 테마(라이트/다크)와 독립된 두 번째 축.
// 'pill'은 지금까지의 둥근 모양(기본값), 'square'는 각진 모양이다.
// 실제 적용은 :root[data-shape='square']가 theme.css의 radius 토큰을 덮어쓰는 것으로만
// 이뤄진다 — 컴포넌트는 이 값을 읽지 않는다.
export const SHAPES = ['pill', 'square'];

export const SHAPE_LABEL = {
  pill: '둥근',
  square: '각진',
};

export const DEFAULT_SHAPE = 'pill';

/**
 * 저장값을 신뢰하지 않고 걸러 낸다 — 손으로 고친 localStorage나 옛 버전이 남긴 값이
 * 그대로 data-shape에 실리면 어느 토큰 블록에도 걸리지 않아 조용히 깨진다.
 */
export function normalizeShape(value) {
  return SHAPES.includes(value) ? value : DEFAULT_SHAPE;
}
