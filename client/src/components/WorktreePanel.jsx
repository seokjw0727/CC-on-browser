// WorktreePanel — git worktree 전경(하단 고정 패널의 네 번째 칸). **조회 전용**이다:
// 생성·삭제·정리·전환 버튼은 없고, 앞으로 넣더라도 이 컴포넌트의 계약이 아니다.
//
// 화면은 위아래 두 층이다. 위는 커밋 그래프(SVG) — 브랜치들이 어디서 갈라져 어디서
// 만나는지를 보여 준다. 아래는 worktree 카드 — 각각의 브랜치·상태·최근 커밋과, 그
// 디렉터리에서 열렸던 세션 이름을 담는다.
//
// 세션 이름을 서버가 정하지 않는 이유: 사용자가 사이드바에서 바꾼 이름(customTitle)은
// localStorage에만 있어 서버가 모른다. 그래서 서버는 "이 worktree에 이 세션들이 있다"는
// 판정(key·sessionId)만 내려보내고, 표시할 이름은 여기서 sessionDisplayTitle로 정한다 —
// 사이드바 행과 이 카드가 같은 세션을 다른 이름으로 부르지 않게 하는 유일한 방법이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWorktrees } from '../lib/api.js';
import { sessionDisplayTitle } from '../lib/sessionTree.js';
import { titleFor } from '../lib/session-titles.js';
import { fmtAgo } from '../lib/format.js';
import './worktree.css';

// 그래프 격자(px). 행 높이는 카드 글줄과 눈으로 맞춘 값이고, 레인 폭은 노드 지름의
// 두 배쯤이라 선이 겹쳐 보이지 않는다.
const ROW_H = 26;
const LANE_W = 18;
const PAD_X = 14;
const PAD_Y = 14;
const NODE_R = 4;
/** 레인 색은 6종을 돌려 쓴다 — worktree.css가 --wt-lane-0..5로 정의한다. */
const LANE_COLORS = 6;

const REASON_TEXT = {
  'no-session': '실행 중인 세션이 없습니다. 세션을 시작하면 그 프로젝트의 worktree를 보여 줍니다.',
  'no-cwd': '세션의 작업 디렉터리를 확인할 수 없습니다.',
  'git-missing': 'git을 찾지 못했습니다. git이 설치되어 있고 PATH에 있는지 확인해 주세요.',
  'not-a-repo': '이 세션의 작업 디렉터리는 git 저장소가 아닙니다.',
  'unsafe-repo': 'git이 이 저장소를 신뢰하지 않습니다(소유자 불일치). 터미널에서 git status를 한 번 실행하면 해결 방법을 안내해 줍니다.',
  'git-failed': 'git 조회에 실패했습니다.',
};

/** 커밋 그래프 SVG. rows/lanes는 서버가 배치까지 끝내 내려준 좌표다. */
function CommitGraph({ graph, headMap, failed }) {
  const rows = graph?.rows ?? [];
  if (!rows.length) {
    // "커밋이 없다"와 "커밋을 못 읽었다"는 사용자가 할 일이 다르다 — 뭉뚱그리지 않는다.
    return (
      <p className="wt-empty">
        {failed ? '커밋 이력을 읽지 못했습니다.' : '표시할 커밋이 없습니다.'}
      </p>
    );
  }
  const rowOf = new Map(rows.map((c) => [c.sha, c.row]));
  const width = PAD_X * 2 + Math.max(1, graph.lanes) * LANE_W;
  const height = PAD_Y * 2 + (rows.length - 1) * ROW_H;
  const x = (lane) => PAD_X + lane * LANE_W;
  const y = (row) => PAD_Y + row * ROW_H;
  const laneClass = (lane) => `wt-lane-${lane % LANE_COLORS}`;

  const edges = [];
  for (const c of rows) {
    for (const e of c.edges ?? []) {
      const x1 = x(c.lane);
      const y1 = y(c.row);
      const target = rowOf.get(e.sha);
      if (target == null) {
        // 부모가 이 창(최대 60커밋) 밖이다 — 이력이 이어진다는 표시만 남긴다.
        edges.push({
          key: `${c.sha}-${e.sha}-out`,
          d: `M${x1} ${y1}V${y1 + ROW_H * 0.7}`,
          lane: e.lane,
          faded: true,
        });
        continue;
      }
      const x2 = x(e.lane);
      const y2 = y(target);
      // 같은 레인이면 직선, 레인을 옮기면 한 행 아래에서 부드럽게 꺾는다.
      const d = x1 === x2
        ? `M${x1} ${y1}V${y2}`
        : `M${x1} ${y1}V${y2 - ROW_H * 0.6}C${x1} ${y2 - ROW_H * 0.2} ${x2} ${y2 - ROW_H * 0.4} ${x2} ${y2}`;
      edges.push({ key: `${c.sha}-${e.sha}`, d, lane: e.lane, faded: false });
    }
  }

  return (
    <div className="wt-graph-wrap">
      <svg
        className="wt-graph"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        {edges.map((e) => (
          <path
            key={e.key}
            className={`wt-edge ${laneClass(e.lane)}${e.faded ? ' faded' : ''}`}
            d={e.d}
          />
        ))}
        {rows.map((c) => (
          <circle
            key={c.sha}
            className={`wt-node ${laneClass(c.lane)}${headMap.has(c.sha) ? ' head' : ''}`}
            cx={x(c.lane)}
            cy={y(c.row)}
            r={headMap.has(c.sha) ? NODE_R + 1.5 : NODE_R}
          />
        ))}
      </svg>
      {/* 그래프는 장식이고, 읽을 수 있는 이력은 이 목록이다 — 스크린리더도 여기를 읽는다. */}
      <ol className="wt-commits">
        {rows.map((c) => (
          <li key={c.sha} className="wt-commit">
            <code className={`wt-sha ${laneClass(c.lane)}`}>{c.short}</code>
            <span className="wt-subject" title={c.subject}>{c.subject || '(제목 없음)'}</span>
            {headMap.has(c.sha) && (
              <span className="wt-head-tags">
                {/* key는 worktree 경로다 — 라벨은 고유하지 않다. 같은 sha를 가리키는
                    detached worktree 둘이나 같은 브랜치를 강제로 연 둘은 라벨이 겹쳐,
                    라벨을 key로 쓰면 React가 중복 key로 항목을 잃는다(codex 지적). */}
                {headMap.get(c.sha).map(({ label, path: wtPath }) => (
                  <span key={wtPath} className="wt-tag">{label}</span>
                ))}
              </span>
            )}
            <span className="wt-when dim">{c.at ? fmtAgo(Date.parse(c.at)) : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** worktree 카드 하나. */
function WorktreeCard({ wt, nameOfLive, nameOfPast }) {
  const st = wt.status;
  const live = wt.sessions?.live ?? [];
  const past = wt.sessions?.past ?? [];
  const badges = [];
  if (wt.isMain) badges.push({ key: 'main', text: '주 worktree', cls: 'main' });
  if (wt.detached) badges.push({ key: 'detached', text: 'detached HEAD', cls: 'warn' });
  if (wt.bare) badges.push({ key: 'bare', text: 'bare', cls: '' });
  if (wt.locked) badges.push({ key: 'locked', text: '잠김', cls: 'warn' });
  if (wt.prunable) badges.push({ key: 'prunable', text: '정리 대상', cls: 'warn' });

  return (
    <li className={`wt-card${live.length ? ' has-live' : ''}`}>
      <div className="wt-card-head">
        <span className="wt-branch" title={wt.branch ?? wt.head ?? ''}>
          {wt.branch ?? (wt.head ? `${wt.head.slice(0, 7)} (detached)` : '브랜치 없음')}
        </span>
        {/* 상태는 색만으로 말하지 않는다 — 점 옆에 반드시 글자가 함께 선다. */}
        {st && (
          <span className={`wt-state${st.clean ? ' clean' : ' dirty'}`}>
            <span className="wt-state-dot" aria-hidden="true" />
            {st.clean ? '깨끗함' : `변경 ${st.capped ? `${st.total}+` : st.total}`}
          </span>
        )}
        {wt.unreadable && <span className="wt-state unknown">상태 확인 불가</span>}
      </div>

      <div className="wt-path" title={wt.path}>{wt.path}</div>

      {badges.length > 0 && (
        <div className="wt-badges">
          {badges.map((b) => (
            <span key={b.key} className={`wt-badge ${b.cls}`}>{b.text}</span>
          ))}
        </div>
      )}

      {st && !st.clean && (
        <div className="wt-counts dim">
          {st.staged > 0 && <span>스테이지 {st.staged}</span>}
          {st.unstaged > 0 && <span>수정 {st.unstaged}</span>}
          {st.untracked > 0 && <span>미추적 {st.untracked}</span>}
        </div>
      )}

      {wt.lastCommit ? (
        <div className="wt-last">
          <code className="wt-sha">{wt.lastCommit.short}</code>
          <span className="wt-subject" title={wt.lastCommit.subject}>
            {wt.lastCommit.subject || '(제목 없음)'}
          </span>
          <span className="wt-when dim">
            {wt.lastCommit.at ? fmtAgo(Date.parse(wt.lastCommit.at)) : ''}
          </span>
        </div>
      ) : (
        <div className="wt-last dim">커밋 없음</div>
      )}

      {(live.length > 0 || past.length > 0) && (
        <div className="wt-sessions">
          {live.map((s) => (
            // 점의 색만으로 실행 중을 말하지 않는다 — 이름 뒤 라벨과 title이 함께 선다.
            <span key={`l-${s.key}`} className="wt-session live" title="실행 중인 세션">
              <span className="wt-session-dot" aria-hidden="true" />
              {nameOfLive(s)}
              <span className="wt-session-tag">실행 중</span>
            </span>
          ))}
          {past.map((s) => (
            <span key={`p-${s.sessionId}`} className="wt-session">
              {nameOfPast(s)}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export default function WorktreePanel({ state }) {
  const activeKey = state?.activeKey ?? null;
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ok | error
  const [error, setError] = useState('');
  // 요청마다 번호를 매겨 늦게 도착한 옛 응답이 새 결과를 덮지 못하게 한다 — 세션을
  // 바꾸거나 새로고침을 누르면 이전 조회가 아직 git을 기다리고 있을 수 있다.
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const seq = reqRef.current + 1;
    reqRef.current = seq;
    setStatus('loading');
    setError('');
    fetchWorktrees(activeKey).then(
      (res) => {
        if (reqRef.current !== seq) return;
        setData(res);
        setStatus('ok');
      },
      (err) => {
        if (reqRef.current !== seq) return;
        setError(String(err?.message ?? err));
        setStatus('error');
      },
    );
  }, [activeKey]);

  useEffect(() => {
    load();
    // 언마운트 후 도착한 응답이 setState를 부르지 않도록 번호를 무효화한다.
    return () => { reqRef.current += 1; };
  }, [load]);

  // 라이브 세션 이름은 스토어에서, 지난 세션 이름은 서버가 준 재료에서 —
  // 양쪽 다 사이드바와 같은 함수(sessionDisplayTitle)를 통과시킨다.
  // live 항목은 {key, sessionId, cliName}이다. 스토어에 그 key가 없을 수 있다 — 다른
  // 탭에서 연 세션이거나 아직 동기화되지 않은 세션이다. 그때는 서버가 함께 준 재료로
  // 같은 우선순위를 따라 내려가므로, 이름 없는 '세션'으로 뭉개지지 않는다.
  // 스토어를 먼저 보는 이유: 로컬에서 바꾼 이름과 방금 온 메시지는 거기에만 있다.
  const nameOfLive = useCallback((s) => {
    const known = state?.sessions?.get?.(s.key);
    const sessionId = known?.sessionId ?? s.sessionId ?? null;
    return sessionDisplayTitle({
      customTitle: known?.customTitle || titleFor(sessionId),
      cliName: known?.cliName || s.cliName,
      messages: known?.messages,
      sessionId,
      fallback: '이름 없는 세션',
    });
  }, [state]);

  const nameOfPast = useCallback((s) => sessionDisplayTitle({
    customTitle: titleFor(s.sessionId),
    cliName: s.cliName,
    title: s.title,
    sessionId: s.sessionId,
  }), []);

  if (status === 'loading' && !data) {
    return <p className="wt-note dim">worktree를 읽는 중…</p>;
  }
  if (status === 'error') {
    return (
      <div className="wt-note">
        <p className="wt-error">조회에 실패했습니다 — {error}</p>
        <button type="button" className="wt-retry" onClick={load}>다시 시도</button>
      </div>
    );
  }
  if (!data?.available) {
    const reason = data?.reason ?? 'git-failed';
    return (
      <div className="wt-note">
        <p className="dim">{REASON_TEXT[reason] ?? REASON_TEXT['git-failed']}</p>
        {data?.message && <p className="wt-detail dim">{data.message}</p>}
        <button type="button" className="wt-retry" onClick={load}>다시 확인</button>
      </div>
    );
  }

  const worktrees = data.worktrees ?? [];
  // 커밋 sha -> 그 커밋을 HEAD로 둔 worktree들의 표시명. 그래프에서 "지금 여기"를 찍는다.
  const headMap = new Map();
  for (const wt of worktrees) {
    if (!wt.head) continue;
    const label = wt.branch ?? wt.head.slice(0, 7);
    headMap.set(wt.head, [...(headMap.get(wt.head) ?? []), { label, path: wt.path }]);
  }

  return (
    <div className="wt-panel">
      <div className="wt-head">
        <span className="wt-root dim" title={data.root ?? ''}>{data.root}</span>
        <button
          type="button"
          className="wt-retry"
          onClick={load}
          disabled={status === 'loading'}
        >
          {status === 'loading' ? '읽는 중…' : '새로 고침'}
        </button>
      </div>

      <section className="wt-section">
        <h3 className="wt-h">커밋 그래프</h3>
        <CommitGraph graph={data.graph} headMap={headMap} failed={!!data.graphFailed} />
      </section>

      <section className="wt-section">
        <h3 className="wt-h">
          worktree
          <span className="wt-count dim">{worktrees.length}</span>
        </h3>
        {worktrees.length === 0 ? (
          <p className="wt-empty">worktree가 없습니다.</p>
        ) : (
          <ul className="wt-cards">
            {worktrees.map((wt) => (
              <WorktreeCard
                key={wt.path}
                wt={wt}
                nameOfLive={nameOfLive}
                nameOfPast={nameOfPast}
              />
            ))}
          </ul>
        )}
        {data.truncated && (
          <p className="wt-detail dim">worktree가 너무 많아 일부만 표시했습니다.</p>
        )}
        {data.sessionsUnavailable && (
          <p className="wt-detail dim">세션 기록을 읽지 못해 세션 표시를 생략했습니다.</p>
        )}
      </section>
    </div>
  );
}
