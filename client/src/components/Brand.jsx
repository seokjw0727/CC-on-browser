// 자기완결형 브랜드 SVG — 외부 폰트/이미지 의존 없음(로컬 앱 CSP 안전).
// Sparkle: Claude 스타일 선버스트 스파크. Mascot: CLAW'D 실루엣(단색 문맥용).
import { CLAWD_FRAMES } from '../lib/clawd.js';
import { FrameSvg } from './Clawd.jsx';

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

// CLAW'D 정지 실루엣 — 단일 소스는 lib/clawd.js의 base 프레임, 렌더러는
// Clawd.jsx의 FrameSvg를 공유한다(드리프트 방지). mono 클래스가 단색
// (currentColor, 눈은 구멍)으로 입힌다 — interact.css 참조.
export function Mascot({ scale = 4, className = '' }) {
  return <FrameSvg bits={CLAWD_FRAMES.base} scale={scale} className={`mono ${className}`.trim()} />;
}
