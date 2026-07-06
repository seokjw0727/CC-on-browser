// message 아이템 하나를 kind별로 렌더.
import { render } from '../lib/markdown.js';
import ToolCard from './ToolCard.jsx';
import ThinkingBlock from './ThinkingBlock.jsx';

function rawSummary(payload) {
  if (!payload || typeof payload !== 'object') return '이벤트';
  const t = payload.type ?? '?';
  return payload.subtype ? `이벤트 ${t}/${payload.subtype}` : `이벤트 ${t}`;
}

export default function Message({ item }) {
  switch (item.kind) {
    case 'user-text':
      return (
        <div className="msg msg-user">
          <pre className="user-text">{item.text}</pre>
        </div>
      );

    case 'assistant-text':
      return (
        <div className="msg msg-assistant">
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: render(item.text) }}
          />
          {item.streaming && <span className="stream-cursor" />}
        </div>
      );

    case 'thinking':
      return <ThinkingBlock item={item} />;

    case 'tool_use':
      return <ToolCard item={item} />;

    case 'notice':
      return <div className="msg msg-notice dim">{item.text}</div>;

    case 'error':
      return <div className="msg msg-error">{item.text}</div>;

    case 'raw':
      return (
        <details className="msg-raw">
          <summary className="dim">{rawSummary(item.payload)}</summary>
          <pre>{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
      );

    default:
      return null;
  }
}
