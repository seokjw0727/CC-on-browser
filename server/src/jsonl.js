export function createJsonlParser(onMessage, onRaw = () => {}) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { onRaw(line); }
    }
  };
}
