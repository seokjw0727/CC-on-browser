// 세션 상태 → 사이드바 상태 점(dot)의 색 클래스 + 접근성 라벨.
//
// 화면에는 색만 남고 텍스트 배지는 없다(설계도 2026-08-09-sidebar-row-dot-status).
// 그래서 라벨은 "보이지 않지만 반드시 있어야 하는" 정보가 된다 — 스크린 리더의
// aria-label과 마우스 툴팁이 같은 문자열을 써야 두 경로가 어긋나지 않으므로,
// 라벨과 클래스를 한 함수가 함께 돌려준다.
//
// React 없는 순수 함수라 node --test로 검증한다(client/test/session-status.test.js).

// 권한 대기와 질문 대기는 "사용자 확인이 필요해 멈춰 있다"는 같은 상태라 색(st-attn)을
// 공유하고 라벨만 갈린다 — 색을 하나 더 늘리면 6색이 되어 오히려 구분이 어려워진다.
const DOT = {
  idle: { label: '대기', cls: 'st-idle' },
  thinking: { label: '생각 중', cls: 'st-think' },
  tool: { label: '도구', cls: 'st-tool' },
  'awaiting-permission': { label: '권한 대기', cls: 'st-attn' },
  exited: { label: '종료', cls: 'st-exited' },
};

/**
 * @param {string} status  store-reducer의 세션 status
 *   (idle | thinking | tool | awaiting-permission | exited)
 * @param {boolean} [isQuestion]  대기 중인 요청의 앞머리가 AskUserQuestion인가
 *   — awaiting-permission일 때만 의미가 있다(다이얼로그 분기와 같은 판별).
 * @returns {{label: string, cls: string}}
 */
export function statusDotOf(status, isQuestion = false) {
  if (status === 'awaiting-permission' && isQuestion) {
    return { label: '질문 대기', cls: 'st-attn' };
  }
  // 모르는 상태는 색 없이 기본 점 + 원문 라벨 — 조용히 '대기'로 위장하지 않는다.
  return DOT[status] ?? { label: String(status ?? '알 수 없음'), cls: '' };
}
