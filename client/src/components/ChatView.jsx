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
  const viewRef = useRef(null);
  const seenRef = useRef(new Set());
  // 직전에 관측한 스크롤포트 높이 — handleScroll에서 "사용자 스크롤"과
  // "컴포저 확장/축소로 인한 레이아웃 스크롤"을 구분하는 기준.
  const lastClientHRef = useRef(0);

  // seen 리셋은 effect가 아니라 렌더 단계에서 동기적으로 처리한다.
  // 이유: activeKey가 바뀌면 스토어의 세션 Map은 이미 그 세션의 전체 messages를
  // 들고 있으므로(비활성 세션도 계속 이벤트를 누적함) 전환 직후 첫 렌더에서 바로
  // session.messages가 "새 세션의 기존 메시지들"로 채워진다. 이 시점의 seenRef는
  // 아직 이전 세션 기준이라 전부 isNew=true로 계산되고, uid가 전부 달라 해당
  // 메시지 DOM은 실제로 새로 mount되어 애니가 그대로 재생돼 버린다.
  // 이후 [session?.key] effect가 seenRef를 리셋해도 pinned가 이미 true였다면
  // setPinned(true)는 동일 값이라 React가 리렌더를 bail-out하므로 보정 렌더가
  // 아예 없다 — 즉 이미 재생된 애니를 되돌릴 기회가 없다(React 공식 문서가
  // "prop 변화에 따른 state 조정"에서 effect 대신 렌더 중 조정을 권하는 바로 그 사례).
  // 그래서 이전 key를 state로 추적하다가 바뀐 걸 감지하면 그 자리에서 즉시
  // seenRef를 리셋해, 전환된 세션의 첫 렌더부터 기존 메시지가 isNew=false로
  // 계산되게 한다.
  const [seenSessionKey, setSeenSessionKey] = useState(session?.key);
  if (seenSessionKey !== session?.key) {
    setSeenSessionKey(session?.key);
    seenRef.current = new Set(
      session ? session.messages.map((m, i) => m.uid ?? `i${i}`) : [],
    );
  }

  // 매 렌더 후: 하단 고정 상태면 스크롤을 최하단으로 유지 (스트리밍 추적)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  // 렌더 없이 높이만 변하는 경우의 하단 고정 — 두 가지를 관찰한다:
  //  1) 내부 콘텐츠(inner): AssistantText의 rAF 페이서는 자기 로컬 state만 갱신해
  //     ChatView는 리렌더되지 않는다(details 펼침 등 다른 높이 변화도 함께 커버).
  //  2) 스크롤포트(el) 자체: 컴포저 textarea 자동 확장/축소가 chat-scroll 높이를
  //     바꾼다 — 고정 상태면 재고정하고, lastClientH도 갱신해 handleScroll의
  //     레이아웃 가드(아래)와 어긋나지 않게 한다.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = viewRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return undefined;
    lastClientHRef.current = el.clientHeight;
    const ro = new ResizeObserver(() => {
      lastClientHRef.current = el.clientHeight;
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 세션 전환 시 고정 복원 + 최하단으로 + 뷰 전환 애니 재생
  // (seen 리셋은 위 렌더 단계에서 이미 끝났으므로 여기서는 건드리지 않는다 —
  // 여기서 다시 하면 한 프레임 늦어 위에서 설명한 플리커가 재발한다.)
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // 패널만 페이드+상승 재생(자식 remount 아님): 클래스 제거→reflow→추가
    const vc = viewRef.current;
    if (vc) {
      vc.classList.remove('view-enter');
      // 강제 reflow로 애니 재시작
      void vc.offsetWidth;
      vc.classList.add('view-enter');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.key]);

  // 새 메시지를 seen에 등록(매 커밋 후) — 다음 렌더부터는 재애니 대상에서 제외
  useEffect(() => {
    if (!session) return;
    for (const [i, m] of session.messages.entries()) {
      seenRef.current.add(m.uid ?? `i${i}`);
    }
  });

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 레이아웃 가드: 스크롤포트 높이가 직전과 다르면 사용자 스크롤이 아니라
    // 컴포저 확장/축소(전송 직후 textarea 비움 등)로 브라우저가 scrollTop을
    // 클램프한 이벤트다 — 핀을 풀지 않고, 고정 상태면 하단으로 재고정만 한다.
    // (전송 직후 이 클램프가 "위로 스크롤"로 오인돼 채팅이 따라오지 않는 버그 실측.)
    if (el.clientHeight !== lastClientHRef.current) {
      lastClientHRef.current = el.clientHeight;
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
      return;
    }
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
        <div className="chat-view-inner" ref={viewRef}>
          {empty ? (
            <Greeting />
          ) : (
            <div className="msg-list">
              {session.messages.map((m, i) => {
                const key = m.uid ?? `i${i}`;
                const isNew = !seenRef.current.has(key);
                return <Message key={key} item={m} isNew={isNew} />;
              })}
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
                <div className="status-line dim">
                  세션이 종료되었습니다 — 잠시 후 목록에서 사라집니다.
                </div>
              )}
            </div>
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
