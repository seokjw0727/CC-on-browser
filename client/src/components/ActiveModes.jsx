// 구동 중인 세션 목표를 짧은 배지로 표시.
// - GOAL: /goal <텍스트>로 설정된 활성 목표(reduce-cli-event가 추적). 화면에는 'GOAL'
//   한 단어만 두고 목표 전문은 hover/포커스 툴팁으로 보여준다 — 목표 문자열이 입력창
//   위 공간을 길게 차지하지 않게 하기 위함(사용자 요청, 2026-07-30).
// 울트라코드(⚡)·권한 상승(🔓) 배지는 같은 요청으로 제거했다: 노력 수준 피커와 권한
// 모드 셀렉트가 이미 현재 상태를 보여주므로 배지는 중복 안내였다(선택지 자체는 유지).
// 목표가 없으면 렌더하지 않아 공간을 차지하지 않는다.

export default function ActiveModes({ session }) {
  if (!session) return null;
  const goal =
    typeof session.goal === 'string' && session.goal.trim() ? session.goal.trim() : null;
  if (!goal) return null;

  return (
    <div className="active-modes" role="group" aria-label="구동 중인 기능">
      {/* 화면 텍스트가 'GOAL'뿐이라 의미(=무슨 목표인가)는 툴팁에만 있다. 마우스가 없는
          사용자도 읽을 수 있도록 tabIndex로 포커스를 받게 해 TooltipLayer의
          :focus-visible 경로를 열어 주고, 접근성 이름에 목표 전문을 싣는다. */}
      <span
        className="mode-badge goal"
        tabIndex={0}
        role="note"
        data-tip={`활성 목표: ${goal}`}
        aria-label={`활성 목표: ${goal}`}
      >
        GOAL
      </span>
    </div>
  );
}
