// 실행 중 작업 도크 — 입력창 **박스 밖**의 독립 카드. 지금 돌고 있는 셸·서브에이전트를
// 모아 보여 주고, 항목을 누르면 그 자리에서 상세(서브에이전트 미니 트랜스크립트·셸 명령
// 전문·백그라운드 메타)를 펼친다. 점프는 상세 안의 명시적 버튼으로만 한다 — 예전처럼
// 행 클릭이 곧 점프면, 연결 정보(uid)가 아직 없는 작업은 행 자체가 비활성이라
// "무엇이 돌고 있는지조차 눌러 볼 수 없는" 상태가 됐다.
//
// 표시 여부는 파생 목록이 비었는지로만 정한다. 예전 panelVisible(status, count)처럼
// "세션이 진행 중일 때만"으로 게이트하면 안 된다 — 백그라운드 작업은 결과가 즉시
// 돌아와 세션이 idle로 내려가므로, 정작 오래 도는 작업에서만 도크가 사라진다.
import { useRef, useState } from 'react';
import { openWork, workDetail } from '../lib/running-work.js';
import { activityLabel } from '../lib/subagents.js';
import { fmtAgo, fmtClock } from '../lib/format.js';
import Icon from './Icon.jsx';

// 상세는 렌더마다 재계산한다 — 캐시하면 서브에이전트가 한 걸음 나아가도 패널이 옛
// 화면에 멈춘다. 목록은 최대 8줄이라 아낄 계산도 없다.
function DockDetail({ panelId, session, item, onJump }) {
  const d = workDetail(session, item);
  if (!d) return null;
  const since = fmtAgo(d.startedAt);
  const clock = fmtClock(d.startedAt);
  // 미니 트랜스크립트를 그릴지는 kind가 아니라 **데이터**로 정한다. Task가 CLI의
  // background_tasks_changed로 승격되면 항목 kind는 'background'가 되지만 자식
  // 메시지는 그대로 들어오므로, kind로 걸러 내면 실제로 돌고 있는 에이전트가
  // 메타 한 줄뿐인 빈 패널이 된다.
  const showSteps = d.kind === 'subagent' || d.task?.type === 'local_agent' || d.stepsTotal > 0;
  return (
    <div className="dock-panel" id={panelId} role="region" aria-label={`${item.label} 상세`}>
      <div className="dock-panel-row">
        {d.subagentType && <span className="dock-subtype">{d.subagentType}</span>}
        {d.activity && <span className="dock-meta">{activityLabel(d.activity)}</span>}
        {/* at이 없는 메시지(구 프리로드·수기 시딩)는 since가 null — 행을 통째로 생략한다 */}
        {since && (
          <span className="dock-meta" data-tip={clock ? `시작 ${clock}` : undefined}>
            시작 {since}
          </span>
        )}
        {d.task?.label && <span className="dock-meta">{d.task.label}</span>}
        {d.task?.id && <span className="dock-meta mono">{d.task.id}</span>}
      </div>
      {d.description && <div className="dock-desc">{d.description}</div>}
      {d.command && <pre className="dock-cmd">{d.command}</pre>}
      {!d.description && d.prompt && <div className="dock-desc">{d.prompt}</div>}
      {showSteps &&
        (d.steps.length === 0 ? (
          <div className="dock-note">아직 보고된 활동이 없습니다</div>
        ) : (
          <>
            {d.stepsTotal > d.steps.length && (
              <div className="dock-note">이전 {d.stepsTotal - d.steps.length}단계 생략</div>
            )}
            <ul className="dock-steps">
              {d.steps.map((s, i) => (
                <li key={s.uid ?? `${s.kind}-${i}`} className={`dock-step${s.done ? ' done' : ''}`}>
                  <span className="dock-step-kind">{s.tool ?? s.kindLabel}</span>
                  <span className="dock-step-text">{s.text || '—'}</span>
                </li>
              ))}
            </ul>
          </>
        ))}
      <button
        type="button"
        className="dock-jump"
        disabled={!item.uid}
        onClick={() => item.uid && onJump?.(item.uid)}
        data-tip="대화에서 이 작업 보기"
      >
        <Icon name="external" size={12} /> 대화에서 보기
      </button>
      {!item.uid && (
        // disabled 버튼은 마우스 이벤트를 내지 않아 [data-tip] 툴팁이 아예 뜨지 않는다 —
        // 예전 도크는 비활성 사유를 그 뜨지 않는 툴팁에만 적어 뒀다. 보이는 글자로 남긴다.
        <span className="dock-note">CLI가 연결 정보를 보내지 않아 대화 위치를 찾지 못했습니다</span>
      )}
    </div>
  );
}

export default function RunningWork({ session, conn, onJump }) {
  const list = openWork(session);
  const [openKey, setOpenKey] = useState(null);
  const rowRefs = useRef(new Map());
  // 훅은 조기 반환보다 **위**에 있어야 한다 — 목록이 비는 순간 훅 개수가 달라지면
  // React가 훅 순서 위반으로 터진다(훅이 없던 예전 코드는 여기서 바로 반환해도 됐다).
  // 펼친 항목이 목록에서 사라지면(작업 종료) 렌더 시점에 무효화돼 이펙트 없이 접힌다.
  const expandedKey = list.some((w) => w.key === openKey) ? openKey : null;
  if (list.length === 0) return null;

  // 연결이 끊겨도 숨기지 않는다 — 서버 쪽 프로세스는 계속 돌 수 있으므로
  // "마지막 확인 상태"로 남기고 pulse만 정지한다(재접속 스냅샷이 갱신).
  const live = conn === 'open';

  // Esc는 도크 서브트리에서만 받는다. document 리스너로 두면 입력창의 Esc(=턴 중단)와
  // 같이 발화해, 사용자가 읽던 패널이 중단과 함께 조용히 닫힌다.
  const onDockKeyDown = (e) => {
    if (e.key !== 'Escape' || expandedKey == null) return;
    setOpenKey(null);
    // 패널 안에 있던 포커스를 열었던 행으로 되돌린다(문서 처음으로 튕기지 않게).
    rowRefs.current.get(expandedKey)?.focus();
  };

  return (
    <div className={`running-dock${live ? '' : ' stale'}`} onKeyDown={onDockKeyDown}>
      <div className="dock-head">
        <span className="dock-count" role="status">실행 중 {list.length}개</span>
        {!live && <span className="dock-stale-note">연결 끊김 — 마지막 확인 상태</span>}
      </div>
      <ul className="dock-list">
        {list.map((w, i) => {
          const expanded = w.key === expandedKey;
          // 패널 id는 인덱스로 만든다 — w.key엔 CLI가 준 task_id가 그대로 섞여 있어
          // 공백·따옴표가 들어오면 aria-controls(IDREF)가 통째로 깨진다.
          const panelId = `dock-panel-${i}`;
          return (
            <li key={w.key}>
              <button
                type="button"
                className={`dock-item${expanded ? ' open' : ''}`}
                ref={(el) => {
                  if (el) rowRefs.current.set(w.key, el);
                  else rowRefs.current.delete(w.key);
                }}
                aria-expanded={expanded}
                aria-controls={expanded ? panelId : undefined}
                onClick={() => setOpenKey(expanded ? null : w.key)}
                data-tip={expanded ? '접기' : '자세히 보기'}
              >
                <span className={`pulse-dot${live ? ' on' : ''}`} aria-hidden="true" />
                <Icon name={w.icon} size={14} className="dock-ico" />
                <span className="dock-label">{w.label}</span>
                {w.activity && <span className="dock-activity">{activityLabel(w.activity)}</span>}
                <span className="dock-detail">{w.detail}</span>
                <Icon name="chevron-down" size={12} className="dock-caret" />
              </button>
              {expanded && (
                <DockDetail panelId={panelId} session={session} item={w} onJump={onJump} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
