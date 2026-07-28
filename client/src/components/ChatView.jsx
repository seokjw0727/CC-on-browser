// 채팅 뷰 — 활성 세션의 message 목록 + 자동 스크롤(위로 스크롤 시 고정 해제).
// 메시지가 없으면(새 세션/세션 없음) 중앙 인사말(그리팅) 빈 상태를 보여준다.
//
// 목록은 **윈도잉**해서 그린다(lib/chat-window.js): 대화 전체를 DOM에 두면 힙의 72%가
// DOM이 되고 그 임계를 넘으면 GC 스래싱으로 스트리밍 중 메인스레드가 초 단위로 멈춘다
// (실측 2026-07-27: 메시지 1920개·도구 결과 20KB에서 총 블로킹 3851ms → 윈도잉 후 0ms).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import Message, { debugEnabled } from './Message.jsx';
import { expandStart, windowStartFor } from '../lib/chat-window.js';
import { Sparkle } from './Brand.jsx';
import './chat.css';

const NEAR_BOTTOM_PX = 48;
const EMPTY = []; // 세션이 없을 때의 안정된 빈 배열(렌더마다 새 배열을 만들지 않게)

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
  const { state } = useStore();
  const session = useActiveSession();
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const viewRef = useRef(null);
  // 등장 애니 판정 워터마크 — "이 인덱스 이상은 아직 화면에 안 나온 새 메시지".
  // uid Set이었던 것을 숫자 하나로 바꿨다: messages는 append-only(리듀서가 기존
  // 항목을 제자리 교체만 한다)라 인덱스로 충분하고, 커밋마다 전량 순회하던 O(N)과
  // 대화 길이만큼 무한히 커지던 Set이 사라진다.
  const seenCountRef = useRef(0);
  // 위 워터마크가 어느 세션에서 잰 값인지. 렌더 중에 "이 값이 지금 세션 것인가"를
  // 판별하는 용도이고, 워터마크와 함께 커밋 후 effect에서만 쓴다.
  const seenKeyRef = useRef(session?.key);
  // 사용자가 "더 보기"/"모두 불러오기"로 고른 시작점. null이면 자동(기본 창).
  const [expand, setExpand] = useState(null);
  // 위로 읽는 중 얼려 둔 상단 시작점. null이면 "꼬리를 따라간다"(기본 창).
  // 하단 고정이 풀리는 **전이 시점에만** 잡는다 — 델타마다 갱신되지 않으므로
  // 스트리밍 중 추가 렌더를 유발하지 않는다.
  const [readStart, setReadStart] = useState(null);
  // 마지막으로 커밋된 창 시작점. 위 전이에서 얼릴 값의 출처(렌더 중이 아니라
  // 커밋 후에만 쓴다 — 중단된 concurrent 렌더의 값이 새지 않게).
  const winStartRef = useRef(0);
  const moreBtnRef = useRef(null);
  const allLoadedRef = useRef(null);
  // 확장 클릭이 예약한 스크롤 보정 — {node, offsetTop, scrollTop}. useLayoutEffect가 소비한다.
  const anchorRef = useRef(null);
  const focusDoneRef = useRef(false);
  // 직전에 관측한 스크롤포트 높이 — handleScroll에서 "사용자 스크롤"과
  // "컴포저 확장/축소로 인한 레이아웃 스크롤"을 구분하는 기준.
  const lastClientHRef = useRef(0);
  // 우리가 마지막으로 직접 맞춘 scrollTop. 사용자가 실제로 굴렸는지 판별하는 기준이다
  // (아래 pinBottom이 갱신한다).
  const lastScrollTopRef = useRef(0);

  // 세션 전환 시 창(expand/readStart) 리셋은 effect가 아니라 렌더 단계에서 한다.
  // 이유: activeKey가 바뀌면 스토어의 세션 Map은 이미 그 세션의 전체 messages를
  // 들고 있으므로(비활성 세션도 계속 이벤트를 누적함) 전환 직후 첫 렌더에서 바로
  // session.messages가 "새 세션의 기존 메시지들"로 채워진다. 이때 이전 세션 기준의
  // 값으로 계산하면 그 메시지 DOM이 새로 mount되면서 애니가 그대로 재생돼 버리는데,
  // [session?.key] effect로 뒤늦게 고치려 해도 pinned가 이미 true면 setPinned(true)는
  // 동일 값이라 React가 리렌더를 bail-out해 보정 렌더 자체가 없다 — 즉 이미 재생된
  // 애니를 되돌릴 기회가 없다(React 공식 문서가 "prop 변화에 따른 state 조정"에서
  // effect 대신 렌더 중 조정을 권하는 바로 그 사례).
  // expand/readStart는 state라 여기서 리셋하면 갱신값이 다시 도는 렌더로 넘어간다.
  // 반면 등장 워터마크는 ref라 이 방식이 통하지 않는다 — 아래 seenCount 주석 참고.
  const [seenSessionKey, setSeenSessionKey] = useState(session?.key);
  const sessionChanged = seenSessionKey !== session?.key;
  if (sessionChanged) {
    setSeenSessionKey(session?.key);
    setExpand(null);
    setReadStart(null);
  }

  // ----- 렌더할 창 -----
  // 세션이 막 바뀐 렌더에서는 위 setState가 아직 반영되지 않았으므로 **폐기될 그
  // 렌더에서만** 초기값을 강제한다. 이전 세션의 확장/동결 시작점으로 새 세션의 창을
  // 계산해 수천 개를 헛되이 훑는 것을 막는 용도다(커밋되는 다음 렌더에서는 위
  // setState가 이미 반영돼 있다).
  const allMsgs = session ? session.messages : EMPTY;
  const total = allMsgs.length;
  // 워터마크는 sessionChanged로 덮을 수 없다. 렌더 중 setState는 그 렌더의 JSX를
  // 폐기하고 곧바로 다시 렌더하는데, 그 두 번째(=실제로 커밋되는) 렌더에서는
  // sessionChanged가 이미 false라 이전 세션의 워터마크가 그대로 쓰인다.
  // expand/readStart는 state라 갱신값이 두 번째 렌더로 넘어가지만 이 지역변수는
  // 넘어가지 않는다. 그래서 ref가 "어느 세션에서 잰 값인지"를 같이 들고 다니게 해,
  // 아직 이 세션에서 재지 않았으면(=전환 직후) total로 본다 — 기존 메시지는
  // isNew=false가 되고, 렌더 중 ref를 쓰지 않으므로 중단된 concurrent 렌더의 값도
  // 새지 않는다.
  const seenCount = seenKeyRef.current === session?.key ? seenCountRef.current : total;
  const curExpand = sessionChanged ? null : expand;
  const curRead = sessionChanged ? null : readStart;
  const sticky = curExpand != null;
  const winStart = windowStartFor({
    total,
    start: sticky ? curExpand : (curRead ?? 0),
    sticky,
    // 확장도 동결도 아니면 꼬리를 따라간다(= 기본 창, 성능·RAM 이득이 나오는 상태).
    pinned: sticky || curRead == null,
  });
  const shown = winStart > 0 ? allMsgs.slice(winStart) : allMsgs;
  // raw 이벤트 표시 여부는 여기서 확정해 prop으로 내린다 — Message가 memo라
  // 안에서 debugEnabled()를 읽으면 토글해도 기존 메시지가 다시 렌더되지 않는다.
  const debug = state.debugRaw || debugEnabled();

  // 하단으로 붙이고 "우리가 맞춘 값"을 기록한다. handleScroll이 사용자 스크롤과
  // 콘텐츠 증가로 인한 스크롤 이벤트를 구분하려면 이 기준값이 필요하다.
  const pinBottom = (el) => {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  };

  // 매 렌더 후: 하단 고정 상태면 스크롤을 최하단으로 유지 (스트리밍 추적)
  useEffect(() => {
    if (pinnedRef.current) pinBottom(scrollRef.current);
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
      if (pinnedRef.current) pinBottom(el);
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 세션 전환 시 고정 복원 + 최하단으로 + 뷰 전환 애니 재생
  // (워터마크·창은 렌더 단계에서 이미 정리됐으므로 여기서는 건드리지 않는다 —
  // 여기서 다시 하면 한 프레임 늦어 위에서 설명한 플리커가 재발한다.)
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    pinBottom(scrollRef.current);
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

  // 커밋된 값 반영(매 커밋 후):
  //  - 워터마크: 다음 렌더부터 재애니 대상에서 제외. "더 보기"로 들어오는 과거
  //    메시지는 인덱스가 이 아래라 애니를 타지 않는다.
  //  - 창 시작점: 하단 고정이 풀리는 전이에서 얼릴 값의 출처.
  useEffect(() => {
    if (session) {
      seenCountRef.current = session.messages.length;
      seenKeyRef.current = session.key;
    }
    winStartRef.current = winStart;
  });

  // 확장(더 보기/모두 불러오기) 직후 스크롤 보정 — 위에 붙은 메시지 높이만큼
  // 읽던 위치가 밀리는 것을 앵커 노드의 뷰포트 좌표 차이로 되돌린다. 커밋 직후
  // 페인트 전에 끝내야 하므로 layout effect다(자동 하단 고정은 passive effect라
  // 뒤에 돌지만 pinned=false여서 개입하지 않는다).
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (a) {
      anchorRef.current = null;
      const el = scrollRef.current;
      if (el && a.node.isConnected) {
        // 레이아웃 좌표(offsetTop) 차이로 보정한다. 뷰포트 좌표(getBoundingClientRect)를
        // 쓰면 브라우저의 스크롤 앵커링이 측정과 쓰기 사이에 scrollTop을 건드려 정확히
        // 그만큼 어긋난다(실측: 199px). offsetTop은 스크롤과 무관해 그 경합이 없고,
        // 절대 대입이라 앵커링이 먼저 손댔더라도 결과가 같다.
        el.scrollTop = a.scrollTop + (a.node.offsetTop - a.offsetTop);
        lastScrollTopRef.current = el.scrollTop;
        lastClientHRef.current = el.clientHeight;
      }
    }
    // 전부 불러와 버튼이 사라졌으면 포커스가 증발한다 — 대체 상태줄로 옮긴다.
    // 앵커 보정과 독립이다: 앵커 노드를 못 잡은 경우(창 전체가 숨김 항목이라
    // nextElementSibling이 없는 등)에도 포커스는 옮겨야 한다(codex 지적).
    // preventScroll: 방금 맞춘 스크롤을 브라우저가 다시 헝클지 않게.
    if (focusDoneRef.current) {
      focusDoneRef.current = false;
      allLoadedRef.current?.focus({ preventScroll: true });
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
      if (pinnedRef.current) pinBottom(el);
      return;
    }
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    // 콘텐츠 증가 가드: 고정 중인데 하단에서 멀어진 이벤트가 왔고 **scrollTop은 우리가
    // 맞춰 둔 값 그대로**라면, 사용자가 굴린 게 아니라 목록이 길어져 하단이 멀어진 것이다.
    // 이걸 사용자 스크롤로 오인하면 자동 추적이 끊기고(윈도잉에서는 창까지 그 자리에
    // 얼어붙어 대화 전체가 렌더된다), 재개/대량 이벤트 유입에서 실제로 재현됐다.
    if (!atBottom && pinnedRef.current && el.scrollTop === lastScrollTopRef.current) {
      pinBottom(el);
      return;
    }
    if (atBottom !== pinnedRef.current) {
      pinnedRef.current = atBottom;
      setPinned(atBottom);
      // 위로 읽기 시작하는 **이 전이에서만** 상단을 얼린다 — 그래야 읽는 동안
      // 새 메시지가 와도 위치가 밀리지 않는다. 하단으로 돌아오면 놓아준다(창 수축).
      setReadStart(atBottom ? null : winStartRef.current);
    }
    if (atBottom) lastScrollTopRef.current = el.scrollTop;
  };

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setPinned(true);
    // 사용자가 명시적으로 최신으로 돌아왔다 = 펼쳐 둔 과거를 놓아준다(창 수축).
    // 이 버튼과 세션 전환이 확장을 해제하는 유일한 경로다(설계도 §3-1).
    setExpand(null);
    setReadStart(null);
    pinBottom(scrollRef.current);
  };

  // "이전 메시지 더 보기" / "모두 불러오기". 클릭 즉시 고정을 풀고(자동 하단
  // 스크롤과 경합하지 않게) 앵커를 잡아 두면 layout effect가 위치를 되돌린다.
  const expandWindow = (next) => {
    pinnedRef.current = false;
    setPinned(false);
    const el = scrollRef.current;
    const node = moreBtnRef.current?.nextElementSibling ?? null;
    anchorRef.current =
      node && el ? { node, offsetTop: node.offsetTop, scrollTop: el.scrollTop } : null;
    focusDoneRef.current = next === 0;
    setExpand(next);
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
              {winStart > 0 ? (
                <div className="load-earlier" ref={moreBtnRef}>
                  <button
                    type="button"
                    className="load-earlier-btn"
                    onClick={() => expandWindow(expandStart(winStart))}
                  >
                    ↑ 이전 메시지 {winStart.toLocaleString()}개 더 보기
                  </button>
                  <button
                    type="button"
                    className="load-earlier-btn subtle"
                    onClick={() => expandWindow(0)}
                  >
                    모두 불러오기
                  </button>
                </div>
              ) : (
                sticky && (
                  <div className="load-earlier done dim" ref={allLoadedRef} tabIndex={-1} role="status">
                    이전 메시지를 모두 불러왔습니다
                  </div>
                )
              )}
              {shown.map((m, i) => {
                const idx = winStart + i;
                const key = m.uid ?? `i${idx}`;
                const isNew = idx >= seenCount;
                return <Message key={key} item={m} isNew={isNew} debug={debug} />;
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
