// WebSocket connection with auto-reconnect (1s -> 5s backoff).
// Re-sending `attach` per session after reconnect is the store's job
// (store listens for onStatus('open')).

export function connect({ token, onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let delay = 1000;
  let timer = null;

  function url() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function open() {
    if (closed) return;
    if (onStatus) onStatus('connecting');
    ws = new WebSocket(url());

    ws.onopen = () => {
      delay = 1000;
      if (onStatus) onStatus('open');
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // non-JSON frames are ignored
      }
      if (onMessage) onMessage(msg);
    };

    ws.onclose = () => {
      ws = null;
      if (closed) return;
      if (onStatus) onStatus('closed');
      timer = setTimeout(open, delay);
      delay = Math.min(delay + 1000, 5000);
    };

    ws.onerror = () => {
      // onclose will follow and schedule the reconnect
      try {
        if (ws) ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  open();

  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        if (ws) ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
