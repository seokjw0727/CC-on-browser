// Markdown -> sanitized HTML (marked + DOMPurify + highlight.js).
// 링크는 항상 target=_blank rel=noopener 로 강제.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * 코드 하이라이트 — 알 수 없는 언어이거나 실패하면 이스케이프한 원문으로 폴백한다.
 * 결과는 hljs가 만든 span 마크업이므로 **반드시 sanitize를 거쳐** DOM에 넣어야 한다
 * (여기서는 marked 파이프라인 끝의 DOMPurify가 처리하고, 코드 미리보기는
 * highlightCode의 결과만 쓰므로 자체적으로 안전한 이스케이프 폴백을 보장한다).
 * @param {string} text @param {string} lang 언어 힌트(확장자·펜스 라벨)
 * @returns {{html: string, language: string|null}}
 */
export function highlightCode(text, lang) {
  const language = (lang || '').trim().split(/\s+/)[0];
  if (language && hljs.getLanguage(language)) {
    try {
      return {
        html: hljs.highlight(text, { language, ignoreIllegals: true }).value,
        language,
      };
    } catch {
      /* 폴백: 이스케이프한 원문 */
    }
  }
  return { html: escapeHtml(text), language: language || null };
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const { html, language } = highlightCode(text, lang);
      const cls = language ? ` language-${escapeHtml(language)}` : '';
      return `<pre><code class="hljs${cls}">${html}</code></pre>\n`;
    },
  },
});

let hookInstalled = false;
function ensureLinkHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** @param {string} md @returns {string} sanitized HTML */
export function render(md) {
  ensureLinkHook();
  const html = marked.parse(md ?? '');
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    ADD_ATTR: ['target'],
  });
}
