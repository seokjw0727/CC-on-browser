// 실행 중 작업 도크 — 입력창 아래에 "지금 돌고 있는 것"을 모아 보여 주고,
// 클릭하면 대화 속 해당 카드로 이동한다. SubagentPanel.jsx의 후신.
//
// 표시 여부는 파생 목록이 비었는지로만 정한다. 예전 panelVisible(status, count)처럼
// "세션이 진행 중일 때만"으로 게이트하면 안 된다 — 백그라운드 작업은 결과가 즉시
// 돌아와 세션이 idle로 내려가므로, 정작 오래 도는 작업에서만 도크가 사라진다.
import { openWork } from '../lib/running-work.js';

export default function RunningWork({ session, conn, onJump }) {
  const list = openWork(session);
  if (list.length === 0) return null;

  // 연결이 끊겨도 숨기지 않는다 — 서버 쪽 프로세스는 계속 돌 수 있으므로
  // "마지막 확인 상태"로 남기고 pulse만 정지한다(재접속 스냅샷이 갱신).
  const live = conn === 'open';

  return (
    <div className={`running-dock${live ? '' : ' stale'}`}>
      <div className="dock-head">
        <span className="dock-count" role="status">실행 중 {list.length}개</span>
        {!live && <span className="dock-stale-note">연결 끊김 — 마지막 확인 상태</span>}
      </div>
      <ul className="dock-list">
        {list.map((w) => (
          <li key={w.key}>
            <button
              type="button"
              className="dock-item"
              // uid가 없으면 대화에 대응하는 카드가 없다(연결 정보 미도착) — 이동 불가.
              disabled={!w.uid}
              onClick={() => w.uid && onJump?.(w.uid)}
              data-tip={w.uid ? '대화에서 이 작업 보기' : '대화에서 위치를 찾지 못했습니다'}
            >
              <span className={`pulse-dot${live ? ' on' : ''}`} aria-hidden="true" />
              <span className="dock-ico" aria-hidden="true">{w.icon}</span>
              <span className="dock-label">{w.label}</span>
              <span className="dock-detail">{w.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
