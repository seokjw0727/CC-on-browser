// WebSocket connection with auto-reconnect (1s -> 5s backoff), 실제 탭 닫힘 신호(bye),
// 절전 복귀 헬스체크(ping/pong probe). Re-sending `attach` per session after reconnect
// is the store's job (store listens for onStatus('open')).
//
// 왜 bye/probe가 필요한가: 서버 데몬은 "의도적 탭 닫힘"(pagehide → bye)과
// "연결 유실"(절전·리드 닫힘·freeze)을 구분해 수명을 결정한다(server/src/lifecycle.js).
// 또 절전 복귀 후 소켓이 half-open(OPEN으로 보이지만 죽음)으로 남을 수 있어,
// 주기 keepalive와 복귀 신호 probe로 감지해 강제 재연결한다.
//
// 소켓 generation 가드: 각 open()이 만든 소켓 인스턴스를 캡처하고 모든 핸들러가
// "아직 현재 소켓인가"(ws === socket)를 검사한다 — 폐기(abandon)된 이전 소켓의
// 늦은 이벤트가 새 소켓을 파괴하거나 중복 재연결을 예약하지 못하게 한다.

const PING_INTERVAL_MS = 30_000; // OPEN 상태 keepalive 주기 — half-open 상시 감지
const PROBE_TIMEOUT_MS = 5_000; // ping 응답 대기 한도 · CONNECTING/CLOSING 잔류 한도

export function connect({ token, onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let delay = 1000;
  let reconnectTimer = null;
  let probeTimer = null; // ping 응답 watchdog 또는 CONNECTING 잔류 watchdog (동시 1개)
  let keepaliveTimer = null;

  function url() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function clearProbe() {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  function clearKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  // 재연결 예약 단일 경로 — 이미 예약돼 있으면 중복 예약하지 않는다.
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
    delay = Math.min(delay + 1000, 5000);
  }

  // 폐기 소켓의 핸들러를 떼어낸다 — half-open 소켓이 네이티브 계층에 오래 남아도
  // connect 클로저를 계속 붙들지 않도록(그리고 늦은 이벤트를 원천 차단).
  function detach(socket) {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  // 현재 소켓을 폐기하고 onclose를 기다리지 않고 재연결을 예약한다 —
  // half-open 소켓은 close()가 CLOSING에 머물며 onclose가 오지 않을 수 있다.
  function abandon() {
    const dead = ws;
    ws = null;
    clearProbe();
    clearKeepalive();
    detach(dead);
    if (!closed) {
      if (onStatus) onStatus('closed');
      scheduleReconnect();
    }
  }

  function open() {
    if (closed || ws) return;
    if (onStatus) onStatus('connecting');
    const socket = new WebSocket(url());
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      delay = 1000;
      clearProbe(); // CONNECTING 잔류 watchdog 해제
      clearKeepalive();
      keepaliveTimer = setInterval(probe, PING_INTERVAL_MS);
      if (onStatus) onStatus('open');
    };

    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      clearProbe(); // 유효한 서버 프레임 = 소켓 생존 확인
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // non-JSON frames are ignored
      }
      if (msg && msg.type === 'pong') return; // 헬스체크 응답은 내부에서 소비
      if (onMessage) onMessage(msg);
    };

    socket.onclose = () => {
      if (ws !== socket) return; // 폐기된 이전 소켓의 늦은 close
      ws = null;
      clearProbe();
      clearKeepalive();
      if (closed) return;
      if (onStatus) onStatus('closed');
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      // onclose will follow and schedule the reconnect
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  function sendRaw(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // 소켓 생존 확인 — keepalive 주기와 절전 복귀 신호에서 호출된다.
  // OPEN이면 ping을 보내고 PROBE_TIMEOUT 내 서버 프레임이 없으면 폐기,
  // CONNECTING/CLOSING에 머물러 있으면 같은 시간 내 정리되지 않을 때 폐기한다.
  function probe() {
    if (closed || probeTimer) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!sendRaw({ type: 'ping' })) {
        abandon();
        return;
      }
      const socket = ws; // generation 캡처 — 소켓·타이머가 바뀌었으면 늦은 발화 무시
      const timer = setTimeout(() => {
        if (probeTimer !== timer) return; // 구세대 콜백 — 새 probe 핸들을 건드리지 않는다
        probeTimer = null;
        if (ws === socket) abandon(); // half-open — 응답 없음
      }, PROBE_TIMEOUT_MS);
      probeTimer = timer;
    } else if (ws) {
      const socket = ws;
      const timer = setTimeout(() => {
        if (probeTimer !== timer) return;
        probeTimer = null;
        if (ws === socket && ws.readyState !== WebSocket.OPEN) abandon();
      }, PROBE_TIMEOUT_MS);
      probeTimer = timer;
    } else {
      scheduleReconnect(); // 방어 — 소켓도 예약도 없는 상태라면 즉시 복구 시도
    }
  }

  // 실제 탭 닫힘/이탈에서만 발화(절전·백그라운드 freeze에서는 미발화) — 서버에
  // "의도적 닫힘"을 best-effort로 알린다. bfcache 보존(persisted)이면 탭이 죽는 게
  // 아니므로 보내지 않는다.
  const onPageHide = (ev) => {
    if (ev && ev.persisted) return;
    sendRaw({ type: 'bye' });
  };
  const onWake = () => probe();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') probe();
  };

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onVisibility);

  open();

  return {
    send(obj) {
      return sendRaw(obj);
    },
    close() {
      closed = true;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearProbe();
      clearKeepalive();
      const dead = ws;
      ws = null;
      detach(dead);
    },
  };
}
