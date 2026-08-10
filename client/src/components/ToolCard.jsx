// 도구 호출 카드 — 도구별 입력 렌더 + 결과(접기) 연결.
// item: {name, input|null, inputJson, result:{content,isError,structured}|null,
//        streaming, parentToolUseId}
// chat.css를 직접 import — PermissionDialog가 ChatView 없이 ToolCard를 써도 스타일 보장.
import { previewPathOf } from '../lib/artifacts.js';
import './chat.css';

function textOfResult(result) {
  if (!result) return '';
  const c = result.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) =>
        typeof x === 'string'
          ? x
          : x && x.type === 'text'
            ? (x.text ?? '')
            : JSON.stringify(x),
      )
      .join('\n');
  }
  if (c == null) return '';
  return JSON.stringify(c, null, 2);
}

function Collapse({ summary, children, defaultOpen = false }) {
  return (
    <details className="collapse" open={defaultOpen}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function CodeBlock({ text, label = '내용', className = '', maxLines = 20 }) {
  const t = text == null ? '' : String(text);
  const lines = t ? t.split('\n').length : 0;
  const pre = <pre className={`tool-code ${className}`.trim()}>{t}</pre>;
  if (lines > maxLines) {
    return <Collapse summary={`${label} (${lines}줄)`}>{pre}</Collapse>;
  }
  return pre;
}

// ----- 도구별 입력 렌더 -----

function BashBody({ input }) {
  return (
    <>
      {input?.description && <div className="dim tool-desc">{input.description}</div>}
      <CodeBlock label="명령" text={input?.command} />
    </>
  );
}

function EditBody({ input }) {
  return (
    <>
      <div className="tool-path">
        {input?.file_path}
        {input?.replace_all ? ' (모두 교체)' : ''}
      </div>
      <CodeBlock label="− 이전" className="diff-removed" text={input?.old_string} />
      <CodeBlock label="+ 이후" className="diff-added" text={input?.new_string} />
    </>
  );
}

function WriteBody({ input }) {
  return (
    <>
      <div className="tool-path">{input?.file_path}</div>
      <CodeBlock label="파일 내용" text={input?.content} />
    </>
  );
}

const SUMMARY_FIELDS = [
  'file_path',
  'pattern',
  'path',
  'glob',
  'query',
  'url',
  'type',
  'output_mode',
  'offset',
  'limit',
];

function QueryBody({ input }) {
  if (!input) return null;
  const shown = SUMMARY_FIELDS.filter((k) => input[k] !== undefined);
  const rest = Object.keys(input).filter((k) => !SUMMARY_FIELDS.includes(k));
  return (
    <div className="tool-kv">
      {shown.map((k) => (
        <div key={k}>
          <span className="dim">{k}:</span>{' '}
          <code>{typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}</code>
        </div>
      ))}
      {rest.length > 0 && (
        <Collapse summary="기타 입력">
          <pre className="tool-code">
            {JSON.stringify(
              Object.fromEntries(rest.map((k) => [k, input[k]])),
              null,
              2,
            )}
          </pre>
        </Collapse>
      )}
    </div>
  );
}

function DefaultBody({ input }) {
  if (input == null) return null;
  return (
    <Collapse summary="입력">
      <pre className="tool-code">{JSON.stringify(input, null, 2)}</pre>
    </Collapse>
  );
}

// AskUserQuestion — 질문·선택지를 읽히게 요약(답변은 tool_result 텍스트에 실려 온다).
function AskUserQuestionBody({ input }) {
  const questions = Array.isArray(input?.questions) ? input.questions : null;
  if (!questions || questions.length === 0) return <DefaultBody input={input} />;
  return (
    <div className="tool-kv">
      {questions.map((q, i) => (
        <div key={i}>
          {q.header && <span className="dim">{q.header}: </span>}
          {q.question}
          {Array.isArray(q.options) && q.options.length > 0 && (
            <span className="dim"> — {q.options.map((o) => o.label).join(' / ')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// Task/Agent — 서브에이전트 스폰 호출. description·유형을 구조화하고 prompt는
// 한 줄이어도 길 수 있어 줄 수와 무관하게 기본 접힘. 알려진 필드 외 나머지는
// "기타 입력"으로 보존한다(미문서 프로토콜의 새 필드 소실 방지). fake-cli처럼
// prompt만 오는 입력(description/type 부재)도 그대로 안전하다.
const TASK_FIELDS = ['description', 'subagent_type', 'prompt'];

function TaskBody({ input }) {
  if (!input) return null;
  const rest = Object.keys(input).filter((k) => !TASK_FIELDS.includes(k));
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  return (
    <div className="tool-kv">
      {(input.description || input.subagent_type) && (
        <div className="tool-desc">
          {input.subagent_type && <span className="tool-chip">{input.subagent_type}</span>}{' '}
          {input.description}
        </div>
      )}
      {prompt !== '' && (
        <Collapse summary={`프롬프트 (${prompt.split('\n').length}줄)`}>
          <pre className="tool-code">{prompt}</pre>
        </Collapse>
      )}
      {rest.length > 0 && (
        <Collapse summary="기타 입력">
          <pre className="tool-code">
            {JSON.stringify(Object.fromEntries(rest.map((k) => [k, input[k]])), null, 2)}
          </pre>
        </Collapse>
      )}
    </div>
  );
}

const BODY_BY_TOOL = {
  Bash: BashBody,
  Edit: EditBody,
  Write: WriteBody,
  Read: QueryBody,
  Grep: QueryBody,
  Glob: QueryBody,
  WebFetch: QueryBody,
  WebSearch: QueryBody,
  AskUserQuestion: AskUserQuestionBody,
  Task: TaskBody,
  Agent: TaskBody,
};

// 결과를 기본 접힘으로 두는 도구들 — Task/Agent는 서브에이전트 최종 보고가 길다
const RESULT_COLLAPSED = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent']);

function ResultBlock({ result, collapsedByDefault }) {
  const text = textOfResult(result);
  const lines = text ? text.split('\n').length : 0;
  const pre = <pre className="tool-code">{text || '(빈 결과)'}</pre>;
  if (collapsedByDefault || lines > 20) {
    return (
      <Collapse summary={`결과${lines ? ` (${lines}줄)` : ''}`}>{pre}</Collapse>
    );
  }
  return (
    <div className="tool-result">
      <div className="dim result-label">결과</div>
      {pre}
    </div>
  );
}

// item: 위 계약 + (선택) onPreview — 있으면 "미리보기" 버튼을 띄운다.
// 이 prop은 **채팅 뷰에서만** 내려온다. PermissionDialog도 같은 카드를 재사용하는데,
// 거기 카드는 아직 승인되지 않은(=파일이 만들어지기 전) 호출이라 열 대상이 없다.
export default function ToolCard({ item, onPreview }) {
  const { name, input, inputJson, result, streaming } = item;
  const isError = !!(result && result.isError);
  // 성공한 파일 쓰기만 미리보기 대상 — 실패·미완 카드에는 버튼이 생기지 않는다.
  const previewPath = onPreview ? previewPathOf(item) : null;
  const chip = streaming
    ? { cls: 'running', label: '입력 수신 중' }
    : result == null
      ? { cls: 'running', label: '실행 중' }
      : isError
        ? { cls: 'err', label: '오류' }
        : { cls: 'done', label: '완료' };

  const Body = BODY_BY_TOOL[name] || DefaultBody;

  return (
    <div className={`tool-card${isError ? ' error' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">{name || '도구'}</span>
        {item.parentToolUseId && <span className="tool-chip">서브에이전트</span>}
        <span className="spacer" />
        {previewPath && (
          <button
            type="button"
            className="tool-preview-btn"
            onClick={() => onPreview(previewPath)}
            data-tip="옆에서 결과물 미리보기"
          >
            미리보기
          </button>
        )}
        <span className={`tool-chip ${chip.cls}`}>
          {(streaming || result == null) && <span className="pulse-dot on" />}{' '}
          {chip.label}
        </span>
      </div>
      <div className="tool-body">
        {input != null ? (
          <Body input={input} />
        ) : inputJson ? (
          <pre className="tool-code dim">{inputJson}</pre>
        ) : null}
        {result != null && (
          <ResultBlock result={result} collapsedByDefault={RESULT_COLLAPSED.has(name)} />
        )}
      </div>
    </div>
  );
}
