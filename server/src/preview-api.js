// preview-api.js — 결과물 미리보기(사이드 패널)용 파일 서빙.
//
// 왜 "티켓"인가 — 미리보기 HTML은 <iframe>·<img>가 직접 URL을 열어야 렌더된다.
// 그런데 그 URL에 메인 인증 토큰을 실으면, sandbox 안의 스크립트가 자기
// location.href에서 토큰을 읽어 밖으로 보낼 수 있다. 그래서 인증된 API 경로에서
// **그 파일의 디렉터리에만 유효한 단명 capability(티켓)**를 발급하고, 서빙은
// 티켓만으로 한다. 티켓은 추측 불가(128bit)·30분 만료·세션 종료 시 즉시 폐기다.
//
// 읽기 범위는 라이브 세션의 cwd 안으로 못박는다. 경로는 클라이언트 말을 믿지 않고
// 서버가 세션 장부(hub.cwdOf)에서 되찾은 cwd를 기준으로 realpath 격리 검사한다
// (remote-control.js가 대상 디렉터리를 정하는 방식과 같은 원칙).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PREVIEW_PREFIX = '/preview/';
const TICKET_TTL_MS = 30 * 60_000;
const MAX_TICKETS = 200;
// 미리보기 1건의 바이트 상한. 넘으면 413 — 브라우저가 수백 MB를 물고 늘어지지 않게.
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

// 확장자 → Content-Type. server.js의 정적 서빙 표(CONTENT_TYPES)는 앱 자산용이라
// md·jpeg·pdf·코드 확장자가 없다. 여기 표는 "사용자가 만든 결과물"을 위한 것이다.
const PREVIEW_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ipynb': 'application/json; charset=utf-8',
};

// 브라우저가 문서로 해석·실행할 수 있는 타입 — CSP sandbox를 강제할 대상.
// (iframe의 sandbox 속성은 우리 앱 안에서만 유효하다. 사용자가 "새 탭으로 열기"를
//  누르면 그 방어가 사라지므로, 응답 헤더로도 같은 제약을 건다.)
const SANDBOXED_TYPES = new Set(['text/html; charset=utf-8', 'image/svg+xml', 'text/xml; charset=utf-8']);

/** 확장자 기반 Content-Type. 모르는 확장자는 null(= 다운로드로 유도). */
export function contentTypeFor(filePath) {
  return PREVIEW_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** child가 parent와 같거나 그 하위인가 — 철자 그대로(대소문자 구분) 비교. */
function containsExact(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** win32는 보통 경로 대소문자를 구분하지 않는다 — 아래 fold 비교의 기준. */
const foldCase = (p, platform) => (platform === 'win32' ? p.toLowerCase() : p);

function containsFolded(parent, child, platform) {
  return containsExact(foldCase(path.resolve(parent), platform), foldCase(path.resolve(child), platform));
}

/**
 * 격리 판정 — child가 parent 안에 있는가. 두 경로 모두 realpath를 거친 값이어야 한다.
 *
 * win32에서 단순 소문자 접기만 쓰면 **디렉터리별 대소문자 구분**(fsutil로 켤 수 있고
 * WSL이 만든 디렉터리에 흔하다)이 켜진 환경에서 `C:\w\Repo`와 `C:\w\repo`가 같은 키로
 * 접혀, cwd 밖 파일이 안쪽으로 오인된다(codex 지적). 반대로 대소문자 구분 비교만 쓰면
 * realpath가 입력 철자를 살려 주는 환경에서 정상 파일이 거부된다.
 *
 * 그래서 ① 철자 그대로 맞으면 통과, ② 아니면 fold 비교로 후보를 좁힌 뒤
 * ③ 파일시스템 신원(dev/ino)으로 확정한다 — 대소문자만 다른 별개 디렉터리는
 * 여기서 걸러진다. ③은 철자가 어긋난 드문 경우에만 돌아 비용이 무시할 만하다.
 */
async function pathIsInside(parent, child, platform) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (containsExact(a, b)) return true;
  if (!containsFolded(a, b, platform)) return false;
  // fold로만 통과한 경우 — b의 조상 중 a와 같은 깊이의 것이 실제로 a와 같은
  // 디렉터리인지 확인한다.
  const depth = (p) => p.split(path.sep).filter(Boolean).length;
  let ancestor = b;
  for (let i = depth(b) - depth(a); i > 0; i -= 1) {
    const up = path.dirname(ancestor);
    if (up === ancestor) return false;
    ancestor = up;
  }
  try {
    const [pa, ch] = await Promise.all([fs.stat(a), fs.stat(ancestor)]);
    return pa.dev === ch.dev && pa.ino === ch.ino;
  } catch {
    return false;
  }
}

function fail(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * 미리보기 티켓 저장소 + 파일 서빙.
 *
 * @param {object} opts
 * @param {() => number} [opts.now] 테스트 주입용 시계
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.maxTickets]
 * @param {number} [opts.maxBytes]
 * @param {string} [opts.platform] 경로 대소문자 정책(win32 여부)
 */
export function createPreviewApi({
  now = Date.now,
  ttlMs = TICKET_TTL_MS,
  maxTickets = MAX_TICKETS,
  maxBytes = MAX_PREVIEW_BYTES,
  platform = process.platform,
} = {}) {
  /** @type {Map<string, {root: string, file: string, sessionKey: string, expiresAt: number}>} */
  const tickets = new Map();

  function sweep() {
    const t = now();
    for (const [id, entry] of tickets) {
      if (entry.expiresAt <= t) tickets.delete(id);
    }
  }

  /**
   * 절대경로 파일을 세션 cwd 안에서 검증하고 티켓을 발급한다.
   * 티켓의 스코프는 그 파일이 있는 디렉터리(하위 포함) — HTML이 참조하는
   * ./style.css, img/foo.png 같은 상대 리소스가 같은 티켓으로 열리게 하기 위함이다.
   *
   * @returns {Promise<{ticket: string, url: string, name: string}>}
   * @throws code 'EPREVIEWSCOPE'(403) | 'ENOENT'(404) | 'EPREVIEWTYPE'(415)
   */
  async function issue({ sessionKey, cwd, filePath }) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw fail('path is required', 'EPREVIEWARG', 400);
    }
    if (!path.isAbsolute(filePath)) {
      throw fail('path must be absolute', 'EPREVIEWARG', 400);
    }
    // UNC/네트워크/디바이스 경로는 fs-api와 같은 원칙으로 거부한다.
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
      throw fail('UNC/network paths are not allowed', 'EPREVIEWARG', 400);
    }
    if (!cwd) throw fail('session is not live', 'EPREVIEWSCOPE', 404);

    // realpath로 심링크·정션·대소문자 철자를 정규화한 뒤에 격리를 판정한다 —
    // resolve()만으로는 cwd 안의 심링크가 밖을 가리키는 경우를 잡지 못한다.
    const realCwd = await fs.realpath(cwd);
    const realFile = await fs.realpath(filePath); // 없으면 ENOENT → 404
    if (!(await pathIsInside(realCwd, realFile, platform))) {
      throw fail('path is outside the session working directory', 'EPREVIEWSCOPE', 403);
    }
    const st = await fs.stat(realFile);
    if (!st.isFile()) throw fail('not a regular file', 'EPREVIEWTYPE', 415);

    sweep();
    const ticket = crypto.randomBytes(16).toString('hex');
    const root = path.dirname(realFile);
    tickets.set(ticket, {
      root,
      file: realFile,
      sessionKey: sessionKey ?? null,
      expiresAt: now() + ttlMs,
    });
    // 상한 초과분은 가장 오래된 것부터 버린다(Map은 삽입 순서를 보존한다).
    while (tickets.size > maxTickets) {
      const oldest = tickets.keys().next();
      if (oldest.done) break;
      tickets.delete(oldest.value);
    }
    const name = path.basename(realFile);
    return {
      ticket,
      name,
      url: `${PREVIEW_PREFIX}${ticket}/${encodeURIComponent(name)}`,
    };
  }

  /** 특정 티켓 폐기 — 발급 도중 세션이 끝난 경우의 되돌리기용. */
  function revoke(ticket) {
    return tickets.delete(ticket);
  }

  /** 세션이 끝나면 그 세션이 발급한 티켓을 즉시 무효화한다. */
  function revokeSession(sessionKey) {
    if (!sessionKey) return 0;
    let n = 0;
    for (const [id, entry] of tickets) {
      if (entry.sessionKey === sessionKey) {
        tickets.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /**
   * '/preview/<ticket>/<relpath>' 를 티켓 + 디스크 경로로 해석한다.
   * 세그먼트는 정확히 한 번만 디코드하고, 구분자·상위참조·NUL·드라이브 경로를 거부한다.
   * @throws code 'EPREVIEWARG'(400) | 'EPREVIEWTICKET'(404)
   */
  function resolveRequest(pathname) {
    if (!pathname.startsWith(PREVIEW_PREFIX)) {
      throw fail('not a preview path', 'EPREVIEWARG', 404);
    }
    const rest = pathname.slice(PREVIEW_PREFIX.length);
    const slash = rest.indexOf('/');
    const ticket = slash < 0 ? rest : rest.slice(0, slash);
    const rawRel = slash < 0 ? '' : rest.slice(slash + 1);
    if (!/^[0-9a-f]{32}$/.test(ticket)) {
      throw fail('invalid ticket', 'EPREVIEWTICKET', 404);
    }
    sweep();
    const entry = tickets.get(ticket);
    if (!entry) throw fail('ticket expired or unknown', 'EPREVIEWTICKET', 404);
    // 사용 시각 갱신 — Map은 삽입 순서를 보존하므로 재삽입이 곧 "최근 사용"이다.
    // 이게 없으면 상한 초과 축출이 FIFO가 되어, 지금 보고 있는 오래된 티켓이 먼저
    // 잘려 나간다(codex 지적).
    tickets.delete(ticket);
    tickets.set(ticket, entry);
    if (rawRel === '') return { entry, target: entry.file };

    const segments = [];
    const rawSegments = rawRel.split('/');
    // 끝 슬래시 하나(디렉터리 표기)는 허용하되, 그 밖의 빈 세그먼트('//', 선행 '/')는
    // 거부한다 — 조용히 접으면 루트 상대 경로가 통과한 것처럼 보인다.
    if (rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === '') rawSegments.pop();
    for (const raw of rawSegments) {
      let seg;
      try {
        seg = decodeURIComponent(raw); // 정확히 1회 디코드
      } catch {
        throw fail('malformed path encoding', 'EPREVIEWARG', 400);
      }
      // 디코드 후에 나타나는 구분자·상위참조·NUL·드라이브 표기는 전부 거부한다
      // (이중 인코딩으로 스코프를 빠져나가려는 시도).
      if (
        seg === '' ||
        seg === '.' ||
        seg === '..' ||
        seg.includes('/') ||
        seg.includes('\\') ||
        seg.includes('\0') ||
        /^[a-zA-Z]:/.test(seg)
      ) {
        throw fail('invalid path segment', 'EPREVIEWARG', 400);
      }
      segments.push(seg);
    }
    // 세그먼트에 구분자·상위참조가 없음을 위에서 확인했으므로 target은 root에서
    // 아래로만 자란다. 같은 root 문자열에서 만든 값이라 철자 비교로 충분하다.
    const target = path.resolve(entry.root, ...segments);
    if (!containsExact(entry.root, target)) {
      throw fail('path escapes the preview scope', 'EPREVIEWARG', 400);
    }
    return { entry, target };
  }

  /**
   * 파일을 읽어 응답 재료를 만든다. 검증한 경로와 실제로 연 핸들이 같은 파일인지
   * (dev/ino) 확인하고, 상한+1바이트까지만 읽어 크기를 강제한다 — stat 후 readFile
   * 사이에 파일이 커지거나 바뀌는 경합을 막기 위함(claude-config.js와 같은 패턴).
   * @throws code 'ENOENT'(404) | 'EPREVIEWTYPE'(415) | 'EPREVIEWSIZE'(413)
   */
  async function readForResponse(target, root) {
    // 링크를 따라간 최종 실체가 스코프 안인지 다시 본다(검사~열기 사이 교체 방어).
    const realTarget = await fs.realpath(target);
    if (!(await pathIsInside(root, realTarget, platform))) {
      throw fail('path escapes the preview scope', 'EPREVIEWARG', 400);
    }
    const pre = await fs.stat(realTarget);
    if (!pre.isFile()) throw fail('not a regular file', 'EPREVIEWTYPE', 415);

    const handle = await fs.open(realTarget, 'r');
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw fail('not a regular file', 'EPREVIEWTYPE', 415);
      // 검증한 그 파일을 열었는가 — 아니면 사이에 바꿔치기된 것이다.
      if (st.dev !== pre.dev || st.ino !== pre.ino) {
        throw fail('file changed during read', 'EPREVIEWTYPE', 409);
      }
      // 상한+1까지 읽어 "넘었는지"를 내용으로 판정한다(stat 크기를 믿지 않는다).
      const buf = Buffer.alloc(maxBytes + 1);
      let read = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
        if (read >= buf.length) break;
      }
      if (read > maxBytes) throw fail('file is too large to preview', 'EPREVIEWSIZE', 413);
      return { body: buf.subarray(0, read), mtimeMs: st.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  /**
   * '/preview/...' GET 요청을 처리한다. 성공 시 헤더+본문을 직접 응답에 쓴다.
   * @returns {Promise<void>}
   * @throws 위 코드들 — 호출측(server.js)이 status로 매핑한다.
   */
  async function serve(req, res, pathname) {
    const { entry, target } = resolveRequest(pathname);
    const { body } = await readForResponse(target, entry.root);
    const type = contentTypeFor(target);
    const headers = {
      'content-type': type ?? 'application/octet-stream',
      'content-length': String(body.length),
      // 미리보기는 늘 최신을 보여야 한다(다시 쓰인 파일을 캐시가 가리지 않게).
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // opaque origin(sandbox) iframe에서 module script·fetch·웹폰트가 동작하려면
      // 자격증명 없는 CORS 허용이 필요하다. 이 경로에만 준다 — /api/*의 Origin
      // 검사는 그대로다.
      'access-control-allow-origin': '*',
    };
    if (type == null) {
      // 모르는 타입은 렌더하지 않고 내려받게 한다(스니핑으로 실행되는 일 방지).
      headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(target))}"`;
    } else if (SANDBOXED_TYPES.has(type)) {
      // 새 탭으로 직접 열어도 앱 오리진 권한 없이 돌게 한다(iframe sandbox와 동일 제약).
      headers['content-security-policy'] = 'sandbox allow-scripts allow-modals';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return {
    issue,
    revoke,
    revokeSession,
    resolveRequest,
    readForResponse,
    serve,
    /** 테스트/진단용 — 현재 살아 있는 티켓 수. */
    get size() {
      sweep();
      return tickets.size;
    },
  };
}
