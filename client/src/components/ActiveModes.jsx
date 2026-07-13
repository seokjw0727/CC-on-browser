// 구동 중인 세션 기능을 강조 배지로 표시(Task: "ultracode, goal 등 구동 중 기능 명확히 표시").
// - ⚡ 울트라코드: effort가 UI 의사 티어(ultracode)일 때 — 최대 노력 플래그십 모드.
// - 🎯 목표: /goal <텍스트>로 설정된 활성 목표(reduce-cli-event가 추적).
// - 🔓 권한 상승: bypassPermissions/acceptEdits 같은 비기본 권한 모드(안전상 눈에 띄게).
// 활성 기능이 하나도 없으면 렌더하지 않아 공간을 차지하지 않는다.
import { isUiEffort } from '../lib/effort.js';
import { MODE_LABEL } from '../lib/permission-modes.js';

// 배지로 부각할 "상승된" 권한 모드 — default/plan은 일상 모드라 제외.
const ELEVATED_MODES = new Set(['bypassPermissions', 'acceptEdits']);

export default function ActiveModes({ session }) {
  if (!session) return null;
  const ultra = isUiEffort(session.effort);
  const goal =
    typeof session.goal === 'string' && session.goal.trim() ? session.goal.trim() : null;
  const mode = ELEVATED_MODES.has(session.permissionMode) ? session.permissionMode : null;
  if (!ultra && !goal && !mode) return null;

  return (
    <div className="active-modes" role="group" aria-label="구동 중인 기능">
      {ultra && (
        <span className="mode-badge ultra" title="울트라코드 — 최대 노력 플래그십 모드">
          <span aria-hidden="true">⚡</span> 울트라코드
        </span>
      )}
      {goal && (
        // 의미(=활성 목표)는 aria-hidden 🎯에만 실리면 스크린리더가 목표 문자열만 읽어
        // 일반 텍스트와 구분 못 한다 — 배지에 접근성 이름을 명시한다.
        <span className="mode-badge goal" title={`활성 목표: ${goal}`} aria-label={`활성 목표: ${goal}`}>
          <span aria-hidden="true">🎯</span>
          <span className="mode-badge-text">{goal}</span>
        </span>
      )}
      {mode && (
        <span className="mode-badge perm" title={`권한 모드: ${MODE_LABEL[mode] ?? mode}`}>
          <span className="badge-ico" aria-hidden="true">🔓</span> {MODE_LABEL[mode] ?? mode}
        </span>
      )}
    </div>
  );
}
