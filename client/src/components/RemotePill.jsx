// 원격 제어 pill + 팝오버 — `claude remote-control`을 브라우저에서 켜고 끈다.
// 상태의 출처는 서버가 보내는 스냅샷 하나뿐이다(store.remoteControls). 낙관적 갱신을
// 하지 않는다: 실제로 켜졌는지는 CLI 출력을 파싱해야 알 수 있고, 그 판정은 서버 몫이다.
//
// 조회 키가 cwd가 아니라 세션 key인 이유는 store-reducer의 remoteControlFor 주석 참조.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { remoteControlFor } from '../lib/store-reducer.js';

const LABEL = {
  starting: '원격 연결 중…',
  ready: '원격 ON',
  stopping: '원격 중지 중…',
  error: '원격 실패',
};

/** pill에 띄울 한 줄 요약 — 툴팁으로도 쓰인다. */
function summarize(rc) {
  if (!rc) return '이 레포를 claude.ai·모바일 앱에서 조종할 수 있게 켭니다';
  if (rc.state === 'error') return rc.error || '원격 제어를 시작하지 못했습니다';
  if (rc.state === 'ready') {
    const cap = rc.capacity ? ` · 세션 ${rc.capacity.used}/${rc.capacity.max}` : '';
    return `claude.ai·모바일 앱에서 이 레포를 조종할 수 있습니다${cap}`;
  }
  if (rc.state === 'stopping') return '원격 제어를 끄는 중입니다';
  return '원격 제어 연결을 준비하고 있습니다';
}

export default function RemotePill({ session }) {
  const { state, setRemoteControl, notify } = useStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const byKey = remoteControlFor(state, session?.key ?? null);
  // 세션이 먼저 끝나면 서버의 keys에서 빠지지만 원격 제어는 계속 돌 수 있다. 그때도
  // 끌 수 있어야 하므로, key로 못 찾으면 이 세션의 cwd와 정확히 같은 항목을 폴백으로
  // 쓴다(표시·중지 전용). 중지는 그 항목의 cwd를 그대로 되돌려 보낸다 — 서버는 자기가
  // 이미 알려 준 항목만 받아들이므로 임의 경로를 여는 권한이 되지 않는다.
  // 매칭 근거는 서버가 realpath로 묶어 내려준 cwds 목록이다. 여기서 raw session.cwd를
  // r.cwd와 직접 비교하면 심링크·junction·대소문자·끝 구분자에서 어긋난다(codex 지적).
  const byCwd = byKey
    ? null
    : (state.remoteControls ?? []).find(
      (r) => session?.cwd && (r.cwds ?? []).includes(session.cwd),
    ) ?? null;
  const rc = byKey ?? byCwd;
  // stopped는 "꺼짐"과 같다 — 껐다는 사실을 pill에 남길 이유가 없다.
  const active = !!rc && rc.state !== 'stopped';
  const disabled = state.conn !== 'open' || !session;
  const popOpen = open && active;

  useEffect(() => {
    if (!popOpen) return undefined;
    // 버블 단계로 듣고 전파를 막지 않는다. capture + stopPropagation이면 나중에 뜬
    // 권한·질문 다이얼로그의 Escape 계약을 이 팝오버가 가로챈다(codex 지적).
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [popOpen]);

  // 세션이 바뀌면 팝오버를 닫는다 — 다른 레포의 상태를 열어 둔 채 보여 주지 않기 위해.
  useEffect(() => {
    setOpen(false);
  }, [session?.key]);

  if (!session) return null;

  const failed = () => notify('WebSocket이 연결되어 있지 않습니다.', 'error');

  const start = () => {
    if (disabled) return;
    // 전송 실패를 삼키지 않는다 — 삼키면 클릭이 아무 흔적 없이 사라진다(codex 지적).
    if (setRemoteControl(session.key, 'start')) setOpen(true);
    else failed();
  };
  const stop = () => {
    const sent = byKey
      ? setRemoteControl(session.key, 'stop')
      : setRemoteControl(null, 'stop', { cwd: rc?.cwd });
    if (sent) setOpen(false);
    else failed();
  };
  const copy = async () => {
    if (!rc?.url) return;
    try {
      await navigator.clipboard.writeText(rc.url);
      notify('원격 제어 주소를 복사했습니다');
    } catch {
      notify('클립보드에 복사하지 못했습니다', 'error');
    }
  };

  return (
    <span className="remote-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`pill remote-pill${active ? ` on ${rc.state}` : ''}`}
        disabled={disabled}
        // 실제로 렌더되는지(popOpen)와 어긋나지 않게 — 다른 탭에서 꺼지면 active가
        // 떨어지면서 팝오버는 사라지는데 open은 true로 남는다(codex 지적).
        aria-expanded={popOpen}
        aria-haspopup="dialog"
        data-tip={summarize(rc)}
        onClick={() => (active ? setOpen((v) => !v) : start())}
      >
        <span className="pill-ico" aria-hidden="true">📱</span>
        <span className="truncate">{active ? LABEL[rc.state] ?? '원격' : '원격 제어'}</span>
      </button>

      {popOpen && (
        <div className="remote-pop" role="dialog" aria-label="원격 제어">
          <div className="rp-head">
            <span className={`pulse-dot${rc.state === 'ready' ? ' on' : ''}`} aria-hidden="true" />
            <span className="rp-title">{LABEL[rc.state] ?? '원격 제어'}</span>
            {rc.capacity && (
              <span className="rp-cap dim">세션 {rc.capacity.used}/{rc.capacity.max}</span>
            )}
          </div>

          {rc.error && <div className="rp-error">{rc.error}</div>}

          {rc.url ? (
            <>
              <a className="rp-link" href={rc.url} target="_blank" rel="noreferrer noopener">
                claude.ai/code 에서 열기 ↗
              </a>
              <div className="rp-url dim" title={rc.url}>{rc.url}</div>
            </>
          ) : (
            !rc.error && <div className="rp-wait dim">연결 주소를 기다리는 중…</div>
          )}

          {/* 사용자가 반드시 알아야 하는 두 가지: 노출 범위와, 끄지 않으면 계속 돈다는 것 */}
          <p className="rp-note">
            켜져 있는 동안 내 Claude 계정으로 로그인한 기기가 이 레포에서 작업할 수 있습니다.
            <br />
            <strong>브라우저를 닫아도 계속 동작합니다</strong> — 다 쓰면 꺼 주세요.
          </p>

          <div className="rp-actions">
            {rc.url && (
              <button type="button" className="ir-btn" onClick={copy}>
                주소 복사
              </button>
            )}
            {/* 실패 상태에서 재시도 경로를 여기서 준다 — 이게 없으면 '끄기'밖에 없어
                실패한 항목에서 빠져나갈 방법이 UI에 존재하지 않는다(codex 지적). */}
            {rc.state === 'error' && (
              <button type="button" className="ir-btn" onClick={start} disabled={disabled}>
                다시 시도
              </button>
            )}
            <button
              type="button"
              className="ir-btn primary"
              onClick={stop}
              disabled={rc.state === 'stopping' || state.conn !== 'open'}
            >
              원격 제어 끄기
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
