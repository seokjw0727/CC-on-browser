import { StringDecoder } from 'node:string_decoder';

export function createJsonlParser(onMessage, onRaw = () => {}) {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { onRaw(line); }
    }
  };
}
