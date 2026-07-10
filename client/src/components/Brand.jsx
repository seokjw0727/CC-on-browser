// 자기완결형 브랜드 SVG — 외부 폰트/이미지 의존 없음(로컬 앱 CSP 안전).
// Sparkle: Claude 스타일 선버스트 스파크. Mascot: 오렌지 픽셀아트.
import { CLAWD_FRAMES } from '../lib/clawd.js';

// 10방향 선버스트 스파크(오목한 변의 별) — currentColor로 채움.
export function Sparkle({ size = 22, className = '' }) {
  // 중심에서 뻗는 스파이크를 회전 배치. 긴 4개 + 짧은 4개 사이각.
  const spikes = [];
  const cx = 12;
  const cy = 12;
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    const len = long ? 11 : 6.5;
    const w = long ? 2.1 : 1.5;
    const ang = (i * Math.PI) / 4;
    // 오목한 다이아몬드형 스파이크(끝 뾰족, 중앙 잘록)
    const tipX = cx + Math.cos(ang) * len;
    const tipY = cy + Math.sin(ang) * len;
    const px = Math.cos(ang + Math.PI / 2);
    const py = Math.sin(ang + Math.PI / 2);
    const midX = cx + Math.cos(ang) * len * 0.42;
    const midY = cy + Math.sin(ang) * len * 0.42;
    const d = `M${cx} ${cy} Q${midX - px * w} ${midY - py * w} ${tipX} ${tipY} Q${midX + px * w} ${midY + py * w} ${cx} ${cy} Z`;
    spikes.push(<path key={i} d={d} />);
  }
  return (
    <svg
      className={`sparkle ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {spikes}
    </svg>
  );
}

// 11x8 픽셀 인베이더 — 단일 소스는 lib/clawd.js의 base 프레임(드리프트 방지).
const MASCOT_BITS = CLAWD_FRAMES.base;

export function Mascot({ scale = 4, className = '' }) {
  const cols = MASCOT_BITS[0].length;
  const rows = MASCOT_BITS.length;
  const rects = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (MASCOT_BITS[y][x] === '1') {
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />);
      }
    }
  }
  return (
    <svg
      className={`mascot ${className}`.trim()}
      width={cols * scale}
      height={rows * scale}
      viewBox={`0 0 ${cols} ${rows}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects}
    </svg>
  );
}
