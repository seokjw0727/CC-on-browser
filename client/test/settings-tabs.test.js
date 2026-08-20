// 설정 모달 4탭화와 플러그인 폼 공용화의 **배선**을 소스 텍스트로 고정한다.
// 이 프로젝트에는 JSX 로더가 없어 컴포넌트를 node --test로 import할 수 없으므로,
// icon.test.js와 같은 방식으로 원문을 스캔한다. 여기서 지키는 것은 렌더 결과가 아니라
// "되돌아가면 조용히 깨지는 계약"들이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8');

const sidebar = src('components', 'Sidebar.jsx');
const pluginsForm = src('components', 'PluginsForm.jsx');
const configEditor = src('components', 'ConfigEditorModal.jsx');
const draft = src('lib', 'claude-config-draft.js');

test('설정 탭은 테마·세션·플러그인·업데이트 넷이다', () => {
  const block = /const SETTINGS_TABS = \[([\s\S]*?)\];/.exec(sidebar);
  assert.ok(block, 'SETTINGS_TABS 선언이 있어야 한다');
  const ids = [...block[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['theme', 'session', 'plugins', 'update']);
  for (const label of ['테마', '세션', '플러그인', '업데이트']) {
    assert.ok(block[1].includes(label), label);
  }
});

test('탭 바가 WAI-ARIA 탭 패턴을 갖춘다', () => {
  assert.match(sidebar, /role="tablist"/);
  assert.match(sidebar, /id=\{`set-tab-\$\{t\.id\}`\}/);
  assert.match(sidebar, /aria-controls=\{`set-panel-\$\{t\.id\}`\}/);
  // 선택된 탭만 Tab 순서에 남긴다(로빙 tabindex) — 없으면 탭 넷이 모두 Tab에 걸린다
  assert.match(sidebar, /tabIndex=\{tab === t\.id \? 0 : -1\}/);
  assert.match(sidebar, /role="tabpanel"/);
  assert.match(sidebar, /aria-labelledby=\{`set-tab-\$\{t\.id\}`\}/);
  assert.match(sidebar, /hidden=\{tab !== t\.id\}/);
});

test('설정 모달의 탭 id는 Config 편집기와 겹치지 않는다', () => {
  // 두 모달은 동시에 마운트된다 — 같은 DOM id를 쓰면 aria-controls가 남의 모달을 가리킨다.
  assert.match(configEditor, /id=\{`cfg-tab-\$\{t\.id\}`\}/);
  assert.ok(!sidebar.includes('cfg-tab-'), '설정 모달은 set-tab-* 를 쓴다');
});

test('PluginsForm은 heading id를 하드코딩하지 않는다', () => {
  assert.ok(!pluginsForm.includes("'cfg-plugins-heading'"));
  assert.match(pluginsForm, /const headingId = `\$\{idPrefix\}-plugins-heading`/);
  // 두 호출측이 서로 다른 접두사를 넘겨야 id가 갈린다
  assert.match(configEditor, /idPrefix="cfg"/);
  assert.match(sidebar, /idPrefix="set"/);
});

test('플러그인 폼은 한 벌만 남는다 (추출이 되돌아가는 회귀 방지)', () => {
  assert.ok(!configEditor.includes('function PluginsTab'));
  assert.ok(!configEditor.includes('function PluginRow'));
  assert.match(configEditor, /import PluginsForm from '\.\/PluginsForm\.jsx'/);
  assert.match(sidebar, /import PluginsForm from '\.\/PluginsForm\.jsx'/);
});

test('draft 훅의 반환 함수는 전부 useCallback이다', () => {
  // 플러그인 탭이 이 함수들을 효과 의존성으로 쓴다 — 매 렌더 새 함수가 되면
  // 재조회 → setState → 재렌더가 무한히 돈다.
  for (const fn of ['load', 'loadPlugins', 'reload', 'reloadIfClean', 'apply', 'editText', 'save']) {
    assert.match(draft, new RegExp(`const ${fn} = useCallback\\(`), fn);
  }
});

test('draft 훅이 StrictMode 이중 마운트에서 멈추지 않는다', () => {
  // 정리에서 false로만 두면 그 뒤 응답이 전부 폐기돼 "불러오는 중…"에 영원히 멈춘다.
  assert.match(draft, /aliveRef\.current = true;/);
});

test('draft 훅의 저장은 성공 여부를 돌려준다', () => {
  // Config 편집기가 이 반환값으로 "저장하지 않은 변경" 경고를 거둔다 — void가 되면
  // 저장이 끝난 뒤에도 경고와 "변경 버리고 닫기"가 남아 거짓을 말한다.
  assert.match(draft, /optsRef\.current\.notify\?\.\(SAVED_NOTICE\);\s*\n\s*return true;/);
  assert.match(configEditor, /if \(await draft\.save\(\)\) setConfirmingClose\(false\);/);
});

test('플러그인 탭은 로드 전에 "JSON 문법 오류"를 먼저 띄우지 않는다', () => {
  // text 초기값 ''는 formReady가 false다 — 관문이 없으면 탭에 들어간 순간 거짓 안내가 뜬다.
  assert.match(sidebar, /\{!draft\.loading && !draft\.loadError && \(/);
});

test('업데이트 확인은 버튼에만 걸려 있다', () => {
  assert.match(sidebar, /onClick=\{check\}/);
  assert.doesNotMatch(sidebar, /useEffect\([^)]*fetchUpdateCheck/s);
});
