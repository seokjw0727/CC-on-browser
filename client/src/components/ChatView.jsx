// 채팅 뷰 — 활성 세션의 message 목록 + 자동 스크롤(위로 스크롤 시 고정 해제).
import { useEffect, useRef, useState } from 'react';
import { useActiveSession } from '../lib/store.jsx';
import Message from './Message.jsx';
import './chat.css';

const NEAR_BOTTOM_PX = 48;

export default function ChatView() {
  const session = useActiveSession();
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  // 매 렌더 후: 하단 고정 상태면 스크롤을 최하단으로 유지 (스트리밍 추적)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  // 세션 전환 시 고정 복원 + 최하단으로
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.key]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom !== pinnedRef.current) {
      pinnedRef.current = atBottom;
      setPinned(atBottom);
    }
  };

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  if (!session) {
    return (
      <div className="chat-view">
        <div className="placeholder">
          세션이 없습니다. 사이드바에서 새 세션을 시작하세요.
        </div>
      </div>
    );
  }

  const busy = session.status === 'thinking' || session.status === 'tool';

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="msg-list">
          {session.messages.map((m, i) => (
            <Message key={m.uid ?? `i${i}`} item={m} />
          ))}
          {busy && (
            <div className="status-line dim">
              <span className="pulse-dot on" />{' '}
              {session.status === 'tool' ? '도구 실행 중…' : '생각 중…'}
              {session.thinkingTokens
                ? ` (~${session.thinkingTokens} tokens)`
                : ''}
            </div>
          )}
          {session.status === 'exited' && (
            <div className="status-line dim">세션이 종료되었습니다.</div>
          )}
        </div>
      </div>
      {!pinned && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          ↓ 최신으로
        </button>
      )}
    </div>
  );
}
