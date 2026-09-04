// 세션 상태 → 사이드바 미니 마스코트의 상태 클래스 + 접근성 라벨.
//
// 화면에 남는 것은 마스코트의 포즈뿐이고 텍스트 배지는 없다(설계도
// 2026-08-09-sidebar-row-dot-status, 2026-09-04-sidebar-clawd-status-mark).
// 그래서 라벨은 "보이지 않지만 반드시 있어야 하는" 정보가 된다 — 스크린 리더의
// aria-label과 마우스 툴팁이 같은 문자열을 써야 두 경로가 어긋나지 않으므로,
// 라벨과 클래스를 한 함수가 함께 돌려준다.
//
// 2026-09-04에 색 점(.sess-dot)이 미니 CLAW'D로 바뀌면서 cls는 더 이상 색을 고르지
// 않는다 — 상태를 DOM에 남기는 표식(e2e·디버깅)으로 남았다. 함수 이름(statusDotOf)과
// 반환 계약 {label, cls}는 호출측·테스트가 그대로 쓰도록 유지한다.
//
// React 없는 순수 함수라 node --test로 검증한다(client/test/session-status.test.js).

// 권한 대기와 질문 대기는 "사용자 확인이 필요해 멈춰 있다"는 같은 상태라 클래스(st-attn)
// 를 공유하고 라벨만 갈린다 — 마스코트도 같은 포즈(집게 들고 홉)로 선다.
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
  // 모르는 상태는 상태 클래스 없이 기본 포즈 + 원문 라벨 — 조용히 '대기'로
  // 위장하지 않는다.
  return DOT[status] ?? { label: String(status ?? '알 수 없음'), cls: '' };
}
