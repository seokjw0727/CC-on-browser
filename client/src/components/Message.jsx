// message 아이템 하나를 kind별로 렌더.
import { render } from '../lib/markdown.js';
import { fmtTok } from '../lib/format.js';
import ToolCard from './ToolCard.jsx';
import ThinkingBlock from './ThinkingBlock.jsx';

function rawSummary(payload) {
  if (!payload || typeof payload !== 'object') return '이벤트';
  const t = payload.type ?? '?';
  return payload.subtype ? `이벤트 ${t}/${payload.subtype}` : `이벤트 ${t}`;
}

export default function Message({ item, isNew }) {
  const enter = isNew ? ' msg-enter' : '';
  switch (item.kind) {
    case 'user-text':
      return (
        <div className={`msg msg-user${enter}`}>
          <pre className="user-text">{item.text}</pre>
        </div>
      );

    case 'assistant-text':
      return (
        <div className={`msg msg-assistant${enter}`}>
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: render(item.text) }}
          />
          {item.streaming && <span className="stream-cursor" />}
        </div>
      );

    case 'thinking':
      return <div className={enter ? 'msg-enter' : undefined}><ThinkingBlock item={item} /></div>;

    case 'tool_use':
      return <div className={enter ? 'msg-enter' : undefined}><ToolCard item={item} /></div>;

    case 'notice':
      return <div className={`msg msg-notice dim${enter}`}>{item.text}</div>;

    case 'usage':
      return (
        <div className={`msg msg-usage${enter}`}>
          ↑ {fmtTok(item.inTok)} ↓ {fmtTok(item.outTok)} tok
          {typeof item.durationMs === 'number'
            ? ` · ${(item.durationMs / 1000).toFixed(1)}s`
            : ''}
        </div>
      );

    case 'error':
      return <div className={`msg msg-error${enter}`}>{item.text}</div>;

    case 'raw':
      return (
        <details className={`msg-raw${enter}`}>
          <summary className="dim">{rawSummary(item.payload)}</summary>
          <pre>{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
      );

    default:
      return null;
  }
}
