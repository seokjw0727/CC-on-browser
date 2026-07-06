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

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let body;
      if (language && hljs.getLanguage(language)) {
        try {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch {
          body = escapeHtml(text);
        }
      } else {
        body = escapeHtml(text);
      }
      const cls = language ? ` language-${escapeHtml(language)}` : '';
      return `<pre><code class="hljs${cls}">${body}</code></pre>\n`;
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
