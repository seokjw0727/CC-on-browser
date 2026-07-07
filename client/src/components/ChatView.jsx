// 채팅 뷰 — 활성 세션의 message 목록 + 자동 스크롤(위로 스크롤 시 고정 해제).
// 메시지가 없으면(새 세션/세션 없음) 중앙 인사말(그리팅) 빈 상태를 보여준다.
import { useEffect, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import Message from './Message.jsx';
import { Sparkle } from './Brand.jsx';
import './chat.css';

const NEAR_BOTTOM_PX = 48;

/** account.email → 친근한 표시 이름. 없으면 null. */
function greetName(initInfo) {
  const email = initInfo?.account?.email;
  if (!email || typeof email !== 'string') return null;
  const local = email.split('@')[0] || '';
  const base = local.replace(/[._-].*$/, '').replace(/\d+$/, '') || local;
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function Greeting() {
  const { state } = useStore();
  const name = greetName(state.initInfo);
  return (
    <div className="greeting">
      <Sparkle size={30} />
      <h1 className="greeting-title">
        {name ? `${name}님, 무엇을 도와드릴까요?` : '무엇을 도와드릴까요?'}
      </h1>
      <p className="greeting-sub dim">
        아래에서 레포(작업 디렉터리)를 고르고 작업을 설명하면 시작합니다.
      </p>
    </div>
  );
}

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

  const empty = !session || session.messages.length === 0;
  const busy = session && (session.status === 'thinking' || session.status === 'tool');

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {empty ? (
          <Greeting />
        ) : (
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
        )}
      </div>
      {!pinned && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          ↓ 최신으로
        </button>
      )}
    </div>
  );
}
