// 컴포저 — 자동 높이 textarea, Enter 전송/Shift+Enter 개행,
// `/` 커맨드 드롭다운(initInfo.commands), Esc/버튼으로 interrupt.
// 스트리밍 중에는 큐잉 없이 전송만 비활성(+안내), 입력 자체는 가능.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import './interact.css';

const MAX_HEIGHT_PX = 200;

export default function Composer() {
  const { state, dispatch, send } = useStore();
  const session = useActiveSession();
  const [text, setText] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const taRef = useRef(null);

  const busy =
    !!session && session.status !== 'idle' && session.status !== 'exited';
  const exited = session?.status === 'exited';
  const canSend =
    !!session && session.status === 'idle' && state.conn === 'open' && text.trim() !== '';

  // ----- `/` 커맨드 드롭다운 -----
  const commands = useMemo(() => {
    const list = state.initInfo?.commands;
    if (!Array.isArray(list)) return [];
    return list
      .map((c) => (typeof c === 'string' ? { name: c, description: '' } : c))
      .filter((c) => c && typeof c.name === 'string')
      // CLI가 이름을 "/name" 형태로 줄 수도 있으므로 선행 슬래시 제거
      .map((c) => ({ ...c, name: c.name.replace(/^\//, '') }));
  }, [state.initInfo]);

  const cmdMatch = /^\/([\w:.-]*)$/.exec(text);
  const filtered = cmdMatch
    ? commands.filter((c) =>
        c.name.toLowerCase().startsWith(cmdMatch[1].toLowerCase()),
      )
    : [];
  const dropdownOpen = !cmdDismissed && !!cmdMatch && filtered.length > 0;

  useEffect(() => {
    setCmdDismissed(false);
    setSelIdx(0);
  }, [text]);

  // ----- textarea 자동 높이 -----
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const pickCommand = (cmd) => {
    if (!cmd) return;
    setText(`/${cmd.name} `); // 선택 후 일반 텍스트로 이어서 작성/전송
    taRef.current?.focus();
  };

  const doSend = () => {
    if (!canSend) return;
    const t = text;
    const ok = send({ type: 'send', key: session.key, text: t });
    if (!ok) return;
    // CLI는 사용자 텍스트를 되돌려주지 않으므로 로컬에서 즉시 반영
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({
        ...reduceCliEvent(s, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        }),
        status: s.status === 'idle' ? 'thinking' : s.status,
      }),
    });
    setText('');
  };

  const doInterrupt = () => {
    if (session && session.status !== 'idle' && session.status !== 'exited') {
      send({ type: 'interrupt', key: session.key });
    }
  };

  const onKeyDown = (e) => {
    if (dropdownOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickCommand(filtered[Math.min(selIdx, filtered.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      doInterrupt();
    }
  };

  const placeholder = !session
    ? '사이드바에서 새 세션을 시작하세요'
    : exited
      ? '세션이 종료되었습니다'
      : '메시지 입력 — Enter 전송, Shift+Enter 개행, / 커맨드';

  return (
    <div className="composer-area">
      <div className="composer">
        {dropdownOpen && (
          <div className="cmd-dropdown" role="listbox">
            {filtered.map((c, i) => (
              <div
                key={c.name}
                role="option"
                aria-selected={i === selIdx}
                className={`cmd-item${i === selIdx ? ' sel' : ''}`}
                onMouseEnter={() => setSelIdx(i)}
                // onMouseDown: textarea blur 전에 선택 처리
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c);
                }}
              >
                <span className="cmd-name">/{c.name}</span>
                {c.description && <span className="cmd-desc">{c.description}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="composer-row">
          <textarea
            ref={taRef}
            rows={2}
            value={text}
            placeholder={placeholder}
            disabled={!session || exited}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button
              type="button"
              className="btn-danger"
              onClick={doInterrupt}
              title="현재 턴 중단 (Esc)"
            >
              ■ 중단
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={!canSend}
              onClick={doSend}
              title="전송 (Enter)"
            >
              전송
            </button>
          )}
        </div>

        <div className="composer-hint dim">
          {busy && (
            <span>
              응답 생성 중 — 완료 후 전송할 수 있습니다. Esc 또는 [중단]으로 멈출 수
              있습니다.
            </span>
          )}
          {session && state.conn !== 'open' && (
            <span style={{ color: 'var(--danger)' }}>
              서버 연결이 끊겼습니다 — 재접속 중…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
