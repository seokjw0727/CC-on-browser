// Icon.jsx(아이콘 세트)의 통일성을 고정하는 테스트.
//
// Icon.jsx는 진짜 JSX(<path .../>)를 담고 있어 client/test의 평범한 node --test로는
// import할 수 없다(이 프로젝트엔 JSX 트랜스폼이 붙은 로더가 없다 — Vite는 빌드 때만
// 관여한다). 그래서 .certify/scan-emoji.mjs와 같은 방식으로 소스 텍스트를 스캔한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

function extractIconNames(iconJsxSrc) {
  const start = iconJsxSrc.indexOf('export const ICON_PATHS');
  const end = iconJsxSrc.indexOf('\n};', start);
  const body = iconJsxSrc.slice(start, end);
  const re = /^\s*(?:'([a-z][a-z0-9-]*)'|([a-z][a-zA-Z0-9]*)):/gm;
  const names = [];
  let m;
  while ((m = re.exec(body))) names.push(m[1] ?? m[2]);
  return names;
}

const ICON_SRC = readFileSync(join(SRC, 'components/Icon.jsx'), 'utf8');
const ICON_NAMES = extractIconNames(ICON_SRC);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 주석을 걷어낸 소스. 주석 속 예시(`// <Icon name="bogus"/>`)가 실제 참조로
 * 잡히면 "미사용 아이콘" 검사가 헐거워지고 "미정의 참조" 검사는 거짓 실패한다(codex 지적).
 * `//`는 앞에 `:`가 없을 때만 주석으로 본다 — `https://`를 잘라 내지 않기 위해서다.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 한 파일에서 아이콘 이름 리터럴을 전부 모은다 — 세 가지 형태를 다룬다:
 *   ① `<Icon name="x">` / `<Icon name='x'>`  정적 문자열 prop(따옴표 두 종류 모두)
 *   ② `<Icon name={a ? 'x' : 'y'}>`  삼항 등 표현식 안의 문자열 리터럴(중첩 `{}` 없음 전제)
 *   ③ `icon: 'x'`               데이터 리터럴(running-work.js·Sidebar 메뉴)
 */
function iconNamesReferencedIn(rawSrc) {
  const src = stripComments(rawSrc);
  const names = [];
  for (const m of src.matchAll(/<Icon\b[^>]*?\bname=['"]([a-z][a-z0-9-]*)['"]/g)) names.push(m[1]);
  for (const m of src.matchAll(/<Icon\b[^>]*?\bname=\{([^}]*)\}/g)) {
    // 비교 피연산자(`kind === 'error' ? …`)는 아이콘 이름이 아니다 — 먼저 걷어낸다.
    const expr = m[1].replace(/[=!]==?\s*['"][^'"]*['"]/g, '');
    for (const s of expr.matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)) names.push(s[1]);
  }
  for (const m of src.matchAll(/\bicon:\s*['"]([a-z][a-z0-9-]*)['"]/g)) names.push(m[1]);
  return names;
}

/**
 * 설계도 §3-1이 확정한 29종에서 'cloud'가 빠진 28종 — 컴포저의 workspace(레포) pill이
 * 유일한 사용처였고, 그 pill이 사라지면서 아이콘도 함께 내렸다.
 * 이름 자체를 여기 박아 두지 않으면 "N개이고 kebab-case이며 전부 참조된다"만 지켜진 채
 * 승인되지 않은 이름으로 갈아치워도 통과한다(codex 지적).
 */
const APPROVED_ICON_NAMES = [
  'menu', 'chevron-left', 'chevron-down', 'chevron-up', 'close', 'check',
  'arrow-up', 'arrow-down', 'stop', 'retry', 'undo', 'edit', 'external', 'trash', 'folder-open',
  'warning', 'info', 'blocked', 'compress', 'bolt',
  'folder', 'document', 'phone', 'bot', 'broom', 'command', 'sun', 'moon',
];

test('아이콘이 정확히 28종 정의돼 있다', () => {
  assert.equal(ICON_NAMES.length, 28);
});

test('정의된 이름이 설계도가 승인한 28종과 정확히 일치한다', () => {
  assert.deepEqual([...ICON_NAMES].sort(), [...APPROVED_ICON_NAMES].sort());
});

test('아이콘 이름은 전부 kebab-case다', () => {
  for (const name of ICON_NAMES) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/, `'${name}'은 kebab-case가 아니다`);
  }
});

test('아이콘 이름에 중복이 없다', () => {
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
});

test('running-work.js가 내보내는 icon 값은 전부 ICON_PATHS에 있다', () => {
  const src = readFileSync(join(SRC, 'lib/running-work.js'), 'utf8');
  const used = iconNamesReferencedIn(src);
  assert.ok(used.length > 0, '회귀 감지용 — 최소 한 곳은 icon을 내보내야 한다');
  for (const name of used) {
    assert.ok(ICON_NAMES.includes(name), `running-work.js가 알 수 없는 아이콘 '${name}'을 참조한다`);
  }
});

test('Sidebar.jsx 세션 메뉴가 내보내는 icon 값은 전부 ICON_PATHS에 있다', () => {
  const src = readFileSync(join(SRC, 'components/Sidebar.jsx'), 'utf8');
  const used = iconNamesReferencedIn(src);
  assert.ok(used.length > 0, '회귀 감지용 — 최소 한 곳은 icon을 내보내야 한다');
  for (const name of used) {
    assert.ok(ICON_NAMES.includes(name), `Sidebar.jsx가 알 수 없는 아이콘 '${name}'을 참조한다`);
  }
});

test('정의된 28종 중 어디서도 쓰이지 않는 이름이 없다', () => {
  const used = new Set();
  for (const file of walk(SRC)) {
    for (const name of iconNamesReferencedIn(readFileSync(file, 'utf8'))) used.add(name);
  }
  const unused = ICON_NAMES.filter((n) => !used.has(n));
  assert.deepEqual(unused, [], `아무 데서도 쓰이지 않는 아이콘: ${unused.join(', ')}`);
});

test('src 전체가 참조하는 아이콘 이름이 전부 ICON_PATHS에 있다 (오타 → 빈 렌더 방지)', () => {
  const bad = [];
  for (const file of walk(SRC)) {
    for (const name of iconNamesReferencedIn(readFileSync(file, 'utf8'))) {
      if (!ICON_NAMES.includes(name)) bad.push(`${file}: '${name}'`);
    }
  }
  assert.deepEqual(bad, [], `정의되지 않은 아이콘 참조:\n${bad.join('\n')}`);
});

// 설계도 §4 접근성 콜아웃의 약속 — 글리프가 SVG가 되면서 버튼의 "읽히는 이름"이
// 조용히 사라질 수 있다. 아이콘 하나만 든 버튼은 반드시 aria-label을 가져야 한다.
//
// <Icon>이 직계 자식일 때만 보면 <span>·fragment로 감싼 버튼이 조용히 빠져나간다(codex
// 지적). 그래서 버튼 본문에서 태그를 전부 지운 뒤 "남는 글자가 없다"로 판정한다 —
// 아이콘 말고는 읽힐 것이 없다는 뜻이므로 이때 aria-label이 유일한 이름이 된다.
test('아이콘만 든 버튼은 aria-label을 갖는다 (감싼 태그가 있어도)', () => {
  const missing = [];
  for (const file of walk(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    // 버튼은 중첩되지 않으므로 첫 </button>까지를 본문으로 본다.
    for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, inner] = m;
      if (!inner.includes('<Icon')) continue;
      // 태그를 지운 뒤 남는 것이 공백뿐이면 = 화면에 아이콘 말고는 아무것도 없다.
      if (inner.replace(/<[^>]*>/g, '').trim() !== '') continue;
      if (/\baria-label[=\s]/.test(attrs)) continue;
      missing.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, [], `이름 없는 아이콘 버튼:\n${missing.join('\n')}`);
});
