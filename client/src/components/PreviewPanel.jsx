// 결과물 미리보기 패널 — 대화 오른쪽에서 Claude가 쓴 파일을 바로 확인한다.
//
// 서빙은 인증된 /api/preview-ticket이 발급한 단명 티켓 URL(/preview/<ticket>/…)로만
// 한다. iframe/img가 여는 URL이라 메인 토큰을 실을 수 없기 때문이다(preview-api.js
// 서두 참조). 그래서 HTML이 참조하는 상대 리소스(./style.css, img/a.png)도 같은
// 티켓 스코프 안에서 그대로 로드된다.
//
// 렌더 정책:
//   html/svg  → sandbox iframe (allow-same-origin 없음 → opaque origin이라 앱의
//               sessionStorage/토큰에 접근 불가. 서버도 CSP sandbox를 같이 건다)
//   md        → 티켓으로 원문을 받아 기존 render()로 그리고, 상대 링크는 티켓 base로 보정
//   이미지    → <img>
//   pdf       → 브라우저 내장 뷰어(iframe)
//   그 외 텍스트 → hljs 하이라이트(상한 초과분은 잘라서 표시)
//   나머지    → 다운로드 안내
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPreviewTicket } from '../lib/api.js';
import { highlightCode, render } from '../lib/markdown.js';
import { baseName } from '../lib/artifacts.js';
// 확장자 분류는 lib/preview-kind.js가 유일한 출처다 — 턴 종료 자동 열기의 주 산출물
// 우선순위도 같은 분류를 쓰므로, 여기에 사본을 두면 둘이 조용히 어긋난다.
import { extOf, previewKind } from '../lib/preview-kind.js';
import Icon from './Icon.jsx';
import './preview.css';

// 하이라이트/마크다운 파싱에 넣을 텍스트 상한. 서버 바이트 상한(10MB)과 별개로,
// 이보다 큰 텍스트를 파서에 통째로 넣으면 서버가 멀쩡해도 탭이 수 초간 멈춘다.
const MAX_RENDER_CHARS = 1_000_000;

// hljs 언어 힌트로 그대로 쓸 수 있는 확장자 매핑(없으면 확장자 그대로 넘긴다).
const HLJS_LANG = { mjs: 'javascript', cjs: 'javascript', jsonl: 'json', ipynb: 'json', h: 'cpp' };

/**
 * 마크다운의 상대 링크·이미지를 티켓 URL 기준으로 보정한다.
 * 이미 sanitize를 마친 HTML만 들어온다(render()의 출력) — 여기서는 속성 값만 고친다.
 * 절대 URL(스킴 있음)·앵커(#)·앱 루트(/)는 건드리지 않는다.
 */
export function rebaseHtml(html, baseUrl) {
  if (!baseUrl || typeof document === 'undefined') return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const isRelative = (v) => v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('#') && !v.startsWith('/');
  for (const el of tpl.content.querySelectorAll('[src]')) {
    const v = el.getAttribute('src');
    if (isRelative(v)) el.setAttribute('src', new URL(v, new URL(baseUrl, window.location.origin)).href);
  }
  for (const el of tpl.content.querySelectorAll('[href]')) {
    const v = el.getAttribute('href');
    if (isRelative(v)) el.setAttribute('href', new URL(v, new URL(baseUrl, window.location.origin)).href);
  }
  return tpl.innerHTML;
}

const STATUS_MESSAGES = {
  403: '이 파일은 세션의 작업 디렉터리 밖에 있어 미리볼 수 없습니다.',
  404: '파일을 찾을 수 없습니다 — 이동되었거나 삭제된 것 같습니다.',
  413: '파일이 너무 커서 미리볼 수 없습니다 (10MB 초과).',
  415: '미리볼 수 있는 형식이 아닙니다.',
};

function friendlyError(err) {
  return STATUS_MESSAGES[err?.status] ?? (err?.message || '미리보기를 불러오지 못했습니다.');
}

/**
 * @param {object} props
 * @param {string} props.sessionKey 티켓 발급 대상 세션(서버가 이 key로 cwd를 되찾는다)
 * @param {string} props.path 볼 파일의 절대경로(원본 철자)
 * @param {Array} props.artifacts 이 세션의 산출물 목록(헤더 선택기)
 * @param {string|number} props.revision 값이 바뀌면 다시 불러온다(파일 재수정·수동 새로고침)
 * @param {(path: string) => void} props.onSelect
 * @param {() => void} props.onClose
 */
export default function PreviewPanel({
  sessionKey,
  path,
  artifacts = [],
  revision,
  onSelect,
  onClose,
}) {
  const kind = useMemo(() => previewKind(path), [path]);
  // {url, name} — 발급된 티켓. loading/error와 함께 하나의 상태로 다룬다.
  const [view, setView] = useState({ status: 'loading', url: null, text: null, error: null });
  // 수동 새로고침 카운터 — 같은 파일을 다시 누른 것만으로는 아래 loadId가 안 바뀐다.
  const [manualRev, setManualRev] = useState(0);
  const refresh = useCallback(() => setManualRev((n) => n + 1), []);
  // 이 값이 바뀔 때만 다시 불러온다(세션·파일·파일 재수정·수동 새로고침).
  // iframe/img의 remount 키이기도 하다 — 같은 src를 다시 대입하는 것만으로는
  // 브라우저가 리로드하지 않기 때문이다.
  const loadId = `${sessionKey}|${path}|${revision}|${manualRev}`;
  // 응답이 늦게 도착했을 때 지금 보고 있는 대상의 것인지 판별하는 기준.
  const loadIdRef = useRef(loadId);
  loadIdRef.current = loadId;

  useEffect(() => {
    if (!sessionKey || !path) return undefined;
    const mine = loadId;
    const ac = new AbortController();
    let alive = true;
    const current = () => alive && loadIdRef.current === mine;
    setView({ status: 'loading', url: null, text: null, error: null });

    (async () => {
      try {
        let ticket = await fetchPreviewTicket(sessionKey, path);
        if (!current()) return;
        // 텍스트류만 본문을 직접 받는다 — html/이미지/pdf는 브라우저가 URL로 연다.
        // 다만 그대로 넘기면 서빙 단계의 실패(413·404·415)를 사용자가 알 수 없다:
        // 큰 HTML은 iframe 안에 서버의 JSON 오류가 그려지고, 이미지는 그냥 깨진다
        // (codex 지적). HEAD로 미리 상태만 확인해 아래 오류 화면으로 보낸다.
        if (kind !== 'markdown' && kind !== 'text') {
          let head = await fetch(ticket.url, { method: 'HEAD', signal: ac.signal, cache: 'no-store' });
          if (!current()) return;
          if (head.status === 404) {
            ticket = await fetchPreviewTicket(sessionKey, path); // 티켓 만료 1회 복구
            if (!current()) return;
            head = await fetch(ticket.url, { method: 'HEAD', signal: ac.signal, cache: 'no-store' });
            if (!current()) return;
          }
          if (!head.ok) {
            throw Object.assign(new Error(`HTTP ${head.status}`), { status: head.status });
          }
          setView({ status: 'ready', url: ticket.url, text: null, error: null });
          return;
        }
        let res = await fetch(ticket.url, { signal: ac.signal, cache: 'no-store' });
        if (!current()) return;
        // 404는 "파일이 없다"일 수도, "티켓이 만료됐다"일 수도 있다 — 구분할 수 없으니
        // 새 티켓으로 딱 한 번 다시 시도한다(오래 열어 둔 패널의 만료 복구).
        if (res.status === 404) {
          ticket = await fetchPreviewTicket(sessionKey, path);
          if (!current()) return;
          res = await fetch(ticket.url, { signal: ac.signal, cache: 'no-store' });
          if (!current()) return;
        }
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        }
        const body = await res.text();
        if (!current()) return;
        setView({ status: 'ready', url: ticket.url, text: body, error: null });
      } catch (err) {
        if (!current() || err?.name === 'AbortError') return;
        setView({ status: 'error', url: null, text: null, error: err });
      }
    })();

    return () => {
      alive = false;
      ac.abort();
    };
  }, [loadId, sessionKey, path, kind]);

  // 텍스트 본문 렌더 — 상한을 넘으면 잘라서 보여 준다(브라우저 멈춤 방지).
  const body = useMemo(() => {
    if (view.status !== 'ready' || view.text == null) return null;
    const truncated = view.text.length > MAX_RENDER_CHARS;
    const text = truncated ? view.text.slice(0, MAX_RENDER_CHARS) : view.text;
    if (kind === 'markdown') {
      return { truncated, html: rebaseHtml(render(text), view.url), code: false };
    }
    // 잘라 낸 큰 파일은 하이라이트하지 않는다 — 1MB를 hljs에 넣는 것 자체가
    // 멈춤의 원인이다. 언어를 주지 않으면 highlightCode가 이스케이프한 원문을 준다.
    const ext = extOf(path);
    const lang = truncated ? null : (HLJS_LANG[ext] ?? ext);
    return { truncated, html: highlightCode(text, lang).html, code: true };
  }, [view, kind, path]);

  const openInNewTab = useCallback(() => {
    if (!view.url) return;
    // noopener — 새 탭이 이 창을 조작하지 못하게. 문서 자체는 서버가 붙인 CSP
    // sandbox 때문에 앱 오리진 권한 없이 열린다.
    window.open(view.url, '_blank', 'noopener,noreferrer');
  }, [view.url]);

  return (
    <aside className="preview-panel" aria-label="결과물 미리보기">
      <header className="preview-head">
        {artifacts.length > 1 ? (
          <select
            className="preview-select"
            value={path ?? ''}
            onChange={(e) => onSelect?.(e.target.value)}
            aria-label="미리볼 결과물"
          >
            {artifacts.map((a) => (
              <option key={a.key} value={a.path}>{a.name}</option>
            ))}
          </select>
        ) : (
          <span className="preview-name" title={path}>{baseName(path)}</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="preview-btn"
          onClick={refresh}
          data-tip="새로고침"
          aria-label="새로고침"
        >
          <Icon name="retry" />
        </button>
        <button
          type="button"
          className="preview-btn"
          onClick={openInNewTab}
          disabled={!view.url}
          data-tip="새 탭으로 열기"
          aria-label="새 탭으로 열기"
        >
          <Icon name="external" />
        </button>
        <button
          type="button"
          className="preview-btn"
          onClick={onClose}
          data-tip="미리보기 닫기"
          aria-label="미리보기 닫기"
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="preview-path dim" title={path}>{path}</div>

      <div className="preview-body">
        {view.status === 'loading' && (
          <div className="preview-state dim">
            <span className="pulse-dot on" /> 불러오는 중…
          </div>
        )}

        {view.status === 'error' && (
          <div className="preview-state err">
            <div>{friendlyError(view.error)}</div>
            <button type="button" className="preview-retry" onClick={refresh}>
              다시 시도
            </button>
          </div>
        )}

        {view.status === 'ready' && (kind === 'html' || kind === 'pdf') && (
          <iframe
            // key에 loadId를 넣어야 같은 URL로 다시 열 때도 확실히 리로드된다
            // (React는 동일한 src 값을 다시 쓰지 않는다 — no-store만으로는 부족).
            key={loadId}
            className="preview-frame"
            src={view.url}
            title={`미리보기: ${baseName(path)}`}
            // allow-same-origin은 절대 넣지 않는다 — 넣는 순간 미리본 문서가
            // 앱과 같은 오리진이 되어 sessionStorage의 토큰을 읽을 수 있다.
            sandbox="allow-scripts allow-modals"
            referrerPolicy="no-referrer"
          />
        )}

        {view.status === 'ready' && kind === 'image' && (
          <div className="preview-image-wrap">
            <img key={loadId} className="preview-image" src={view.url} alt={baseName(path)} />
          </div>
        )}

        {view.status === 'ready' && body && (
          <div className="preview-doc">
            {body.truncated && (
              <div className="preview-truncated dim">
                파일이 커서 앞부분 {MAX_RENDER_CHARS.toLocaleString()}자만 표시합니다 — 전체는 새 탭으로 열어 확인하세요.
              </div>
            )}
            {body.code ? (
              <pre className="preview-code">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: body.html }} />
              </pre>
            ) : (
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: body.html }} />
            )}
          </div>
        )}

        {view.status === 'ready' && kind === 'binary' && (
          <div className="preview-state dim">
            <div>이 형식은 미리보기를 지원하지 않습니다.</div>
            <a className="preview-retry" href={view.url ?? '#'} download={baseName(path)}>
              내려받기
            </a>
          </div>
        )}
      </div>
    </aside>
  );
}
