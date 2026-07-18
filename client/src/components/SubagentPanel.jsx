// 실행 중 서브에이전트 세션 패널 — CLI의 Agents/Ultracode 실행 표시의 브라우저판.
// 목록·활동·표시 게이트는 전부 lib/subagents.js가 messages에서 파생한다(상태 필드 0).
// ActiveModes 배지 행(설정 상태)과 분리된 동적 작업 모니터로, Composer의 in-flow
// 블록에 렌더된다. 라이브 리전은 헤더의 개수 문구 하나만 — N이 바뀔 때만 발표되고
// 항목별 활동 라벨은 시각 전용이다(스크린리더 재낭독 소음 방지).
import { activityLabel, panelVisible } from '../lib/subagents.js';

export default function SubagentPanel({ list, status, conn }) {
  if (!panelVisible(status, list?.length ?? 0)) return null;
  // 연결이 끊겨도 숨기지 않는다 — 서버 쪽 프로세스는 계속 돌 수 있으므로
  // "마지막 확인 상태"로 남기고 pulse만 정지한다(재접속 리플레이가 갱신).
  const live = conn === 'open';
  return (
    <div className={`subagent-panel${live ? '' : ' stale'}`}>
      <div className="sub-head">
        <span aria-hidden="true">🤖</span>
        <span className="sub-count" role="status">서브에이전트 {list.length}개 실행 중</span>
        {!live && <span className="sub-stale-note">연결 끊김 — 마지막 확인 상태</span>}
      </div>
      <ul className="sub-list">
        {list.map((s) => (
          <li key={s.key} className={`sub-item${s.depth ? ' nested' : ''}`}>
            <span className={`pulse-dot${live ? ' on' : ''}`} aria-hidden="true" />
            {s.subagentType && <span className="sub-type">{s.subagentType}</span>}
            <span className="sub-label">{s.label}</span>
            <span className="sub-activity">{activityLabel(s.activity)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
