// 사고 과정 블록 — 기본 접힘, 스트리밍 중에는 펄스 표시.
import { useState } from 'react';
import Icon from './Icon.jsx';

export default function ThinkingBlock({ item }) {
  const [open, setOpen] = useState(false);
  const streaming = !!item.streaming;

  return (
    <div className={`thinking-block${streaming ? ' streaming' : ''}`}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`pulse-dot${streaming ? ' on' : ''}`} />
        <span>{streaming ? '생각 중…' : '사고 과정'}</span>
        <span className="spacer" />
        <span className="dim">
          {open ? <><Icon name="chevron-up" /> 접기</> : <><Icon name="chevron-down" /> 펼치기</>}
        </span>
      </button>
      {open && (
        <pre className="thinking-body">{item.thinking || '(내용 없음)'}</pre>
      )}
    </div>
  );
}
