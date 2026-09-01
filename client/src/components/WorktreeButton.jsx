// WorktreeButton — 입력창 아래에 늘 떠 있는 브랜치 칩과, 그것이 여는 worktree 모달.
//
// 원래 이 패널은 사이드바 하단 네 버튼 중 두 번째였다. 거기서는 "통계·설정·정보와
// 나란한 부가 패널"이었는데, 지금 작업이 어느 브랜치에서 일어나고 있는지는 그런 종류의
// 정보가 아니다 — 프롬프트를 보내기 직전에 보여야 하는 값이라 입력창 옆으로 내려왔다.
// 모양이 VS Code 상태줄의 브랜치 표시를 닮은 것도 같은 이유다.
//
// 자리만 컴포저에 얹혀 있을 뿐 스토어에서 직접 읽는다(PermissionModeBar와 같은 규약) —
// Composer.jsx는 위치만 잡아 주고 props를 흘려보내지 않는다. 모달 역시 사이드바의
// FootModal을 빌려 쓰지 않고 같은 패턴을 자기 것으로 가진다: 사이드바에서 떼어낸다는
// 것은 화면 위치만 옮기는 일이 아니라 그쪽 표(FOOT_PANELS)에서 벗어난다는 뜻이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { fetchBranch } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { usePresence } from '../lib/usePresence.js';
import Icon from './Icon.jsx';
import WorktreePanel, { REASON_TEXT } from './WorktreePanel.jsx';
import './worktree.css';

// 브랜치가 갈라지는 모양 — worktree 패널이 보여 주는 것이 곧 이 모양이다.
// 사이드바에서 이 컴포넌트로 함께 옮겨 왔다(20 격자 직접 그림). className을 받는 이유:
// 칩 안(작게)과 모달 제목(강조색)에서 크기·색이 다르다.
function WorktreeIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 5.2v9.6" />
      <path d="M13.8 7.5h-3.3A4.5 4.5 0 0 0 6 12" />
      <circle cx="6" cy="3.6" r="1.6" />
      <circle cx="6" cy="16.4" r="1.6" />
      <circle cx="15.4" cy="7.5" r="1.6" />
    </svg>
  );
}

/**
 * 칩에 쓸 라벨과 툴팁. 라벨은 짧게 유지하고(칩이 좁다 — 넘치면 CSS가 잘라 낸다)
 * 사정은 툴팁이 설명한다. 조회 전(info=null)과 조회 실패를 같은 'worktree'로 두는 것은
 * 의도다 — 둘 다 "브랜치를 아직 말할 수 없다"이고, 그 차이는 칩이 아니라 패널을 열면
 * 드러난다.
 */
function chipText(info) {
  if (!info) return { label: 'worktree', tip: 'worktree 패널 열기', unknown: true };
  if (!info.available) {
    return {
      label: 'worktree',
      tip: REASON_TEXT[info.reason] ?? REASON_TEXT['git-failed'],
      unknown: true,
    };
  }
  if (info.branch) {
    return { label: info.branch, tip: `현재 브랜치: ${info.branch}`, unknown: false };
  }
  if (info.detached && info.head) {
    // 짧은 sha만 두면 브랜치 이름으로 오해된다 — 칩에서 상태를 함께 말한다.
    return {
      label: `${info.head} (detached)`,
      tip: `detached HEAD — 브랜치가 아니라 커밋 ${info.head}에 직접 올라와 있습니다`,
      unknown: false,
    };
  }
  // available이면 브랜치나 sha 둘 중 하나는 반드시 있다(서버 계약) — 여기 오는 것은
  // 계약이 어긋난 경우뿐이라, 없는 이름을 지어내지 않고 모른다고 말한다.
  return { label: 'worktree', tip: 'worktree 패널 열기', unknown: true };
}

// worktree 모달 — 사이드바 FootModal과 같은 오버레이/포커스 트랩/페이드 규약.
// 본문은 예전과 완전히 같은 WorktreePanel이다(조회·새로고침·오류 처리는 전부 그쪽 몫).
function WorktreeModal({ presenceStatus, onClose }) {
  const { state } = useStore();
  const dialogRef = useFocusTrap(true);
  return (
    <div
      className={`modal-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        // 컴포저의 Esc(턴 중단)까지 올라가지 않게 여기서 끊는다 — 모달을 닫으려던
        // 키가 진행 중인 응답을 함께 중단시키면 안 된다.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal worktree-modal"
        role="dialog"
        aria-modal="true"
        id="worktree-modal"
        aria-labelledby="worktree-modal-title"
      >
        <div className="modal-title">
          <WorktreeIcon className="wt-modal-icon" />
          <span id="worktree-modal-title">worktree</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body wt-modal-body">
          <WorktreePanel state={state} />
        </div>
      </div>
    </div>
  );
}

// 닫힘 페이드아웃(140ms) 동안 마운트를 유지 — 사이드바 FootModalPresence와 같은 값.
function WorktreeModalPresence({ open, onClose }) {
  const { mounted, status } = usePresence(open, 140);
  if (!mounted) return null;
  return <WorktreeModal presenceStatus={status} onClose={onClose} />;
}

export default function WorktreeButton() {
  const { state } = useStore();
  const session = useActiveSession();
  const activeKey = state.activeKey ?? null;
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  // 요청마다 번호를 매겨 늦게 도착한 옛 응답이 새 결과를 덮지 못하게 한다 — 세션을
  // 옮기면 이전 세션을 향한 조회가 아직 git을 기다리고 있을 수 있고, 그게 뒤늦게
  // 도착하면 칩이 남의 브랜치를 가리킨다(WorktreePanel과 같은 처방).
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    fetchBranch(activeKey).then(
      (res) => { if (seqRef.current === seq) setInfo(res); },
      // 로컬 서버에 닿지 못한 경우다(git 실패는 200 + available:false로 온다).
      // 칩은 '알 수 없음'으로 물러서고, 사정은 패널을 열면 그쪽이 다시 말해 준다.
      () => { if (seqRef.current === seq) setInfo(null); },
    );
  }, [activeKey]);

  // 세션이 바뀌면 옛 브랜치를 **즉시** 지운다. 새 응답이 올 때까지 두면 그 사이 칩이
  // 다른 세션의 브랜치를 자기 것인 양 보여 준다.
  useEffect(() => {
    setInfo(null);
    load();
    return () => { seqRef.current += 1; };
  }, [load]);

  // 턴이 끝나는 순간 다시 읽는다. 이 칩은 늘 떠 있으므로 "열 때 한 번"으로는 부족하다 —
  // Claude가 방금 브랜치를 갈아탔다면 사용자가 패널을 열기 전부터 라벨이 틀려 있다.
  const status = session?.status ?? null;
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status === 'idle' && was && was !== 'idle') load();
  }, [status, load]);

  // 터미널에서 직접 checkout하고 브라우저로 돌아오는 흐름도 같은 이유로 받아 준다.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const closeModal = useCallback(() => {
    setOpen(false);
    // 패널을 보고 닫은 시점의 브랜치가 칩에도 반영되게 한다.
    load();
  }, [load]);

  const { label, tip, unknown } = chipText(info);

  return (
    <>
      <div className="wt-chip-row">
        <button
          type="button"
          className={`wt-chip${unknown ? ' unknown' : ''}${open ? ' open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? 'worktree-modal' : undefined}
          // 보이는 라벨은 브랜치명이라 매번 달라진다 — 접근성 이름 앞머리는 고정해
          // 스크린리더와 테스트가 항상 같은 이름으로 이 버튼을 찾을 수 있게 한다.
          aria-label={`worktree — ${label}`}
          data-tip={tip}
        >
          <WorktreeIcon className="wt-chip-ico" />
          <span className="wt-chip-label">{label}</span>
        </button>
      </div>

      <WorktreeModalPresence open={open} onClose={closeModal} />
    </>
  );
}
