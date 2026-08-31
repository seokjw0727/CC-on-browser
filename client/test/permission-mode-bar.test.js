// PermissionModeBar — 권한 모드 셀렉트의 계약을 소스로 고정한다. 이 셀렉트는 컴포저
// 하단 pill 행 → 메인 우측 상단 → 입력 상자 안쪽 우측 상단으로 두 번 옮겨 다녔다.
// 옮겨도 로직은 이 컴포넌트 하나가 소유한다는 것이 아래 계약들의 축이다.
// 브라우저 없이 렌더할 수 없는 컴포넌트라(스토어 컨텍스트 의존) 동작 검증은
// e2e/ui-chrome.spec.mjs와 e2e/app.spec.js가 맡고, 여기서는 "옮기는 과정에서
// 조용히 빠질 수 있는 것"만 잡는다 — 특히 신뢰모드 게이팅.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const bar = readFileSync(join(SRC, 'components/PermissionModeBar.jsx'), 'utf8');
const composer = readFileSync(join(SRC, 'components/Composer.jsx'), 'utf8');
const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
// CSS 계약은 주석을 걷어낸 뒤 본다 — 안 그러면 주석 안의 설명("…position: absolute로
// 띄운다")이 규칙으로 오인돼 단언이 헛통과한다(codex 지적).
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const interactCss = stripCssComments(readFileSync(join(SRC, 'components/interact.css'), 'utf8'));
const themeCss = stripCssComments(readFileSync(join(SRC, 'theme.css'), 'utf8'));

test('신뢰모드는 스폰 시에만 진입 가능하다는 가드가 살아 있다', () => {
  // 서버가 권위 경계지만 UI에서도 먼저 막는다 — 옮기면서 이 가드를 흘리면
  // 사용자는 막힌 이유도 모른 채 실패한 전환을 반복한다.
  assert.match(bar, /spawnPermissionMode !== 'bypassPermissions'/);
  assert.match(bar, /신뢰모드는 세션 시작 시에만 설정할 수 있습니다/);
  assert.match(bar, /'error'/, '차단 안내는 에러 토스트여야 한다');
});

test('전송이 실패하면 낙관적 갱신을 하지 않는다', () => {
  // send()가 false면 CLI에 전달되지 않았다는 뜻 — 여기서 dispatch까지 가면
  // UI만 바뀌어 실제 권한 모드와 desync된다.
  assert.match(bar, /if \(!send\(\{ type: 'setPermissionMode'.*\}\)\) return;/s);
});

test('옵션 목록은 신뢰 스폰이거나 현재 모드가 신뢰일 때만 신뢰모드를 노출한다', () => {
  // 두 번째 조건(표시 정합성 폴백)이 빠지면 CLI가 신뢰로 보고할 때 select가
  // 빈 값으로 렌더된다.
  assert.match(bar, /session\.spawnPermissionMode === 'bypassPermissions'/);
  assert.match(bar, /session\.permissionMode === 'bypassPermissions'/);
});

test('접근 가능한 이름 "권한 모드"는 앱 전체에서 이 컴포넌트에만 있다', () => {
  // e2e가 page.getByLabel('권한 모드')로 잡는다 — 두 곳이 되면 strict mode 위반.
  assert.match(bar, /aria-label="권한 모드"/);
  assert.doesNotMatch(composer, /aria-label="권한 모드"/);
});

test('권한 모드 변경 로직이 컴포저에 남아 있지 않다', () => {
  // 컴포저는 자리만 내준다 — 상태·전송 로직까지 따라오면 한쪽만 고치는 사고가 난다.
  // (컴포넌트를 import해 마운트하는 것은 로직 복제가 아니다.)
  assert.doesNotMatch(composer, /setPermissionMode/);
  assert.doesNotMatch(composer, /composer-top/);
  assert.doesNotMatch(composer, /repo-pill/);
});

// ----- 마운트 위치: 메인 우측 상단 → 입력 상자 안쪽 우측 상단 (사용자 요청, 2026-08-31)
// 설계 근거: .certify/design/2026-08-31-perm-mode-into-composer.html
test('Composer가 입력 상자(.composer-input) 안에 이 컴포넌트를 마운트한다', () => {
  assert.match(composer, /import PermissionModeBar from '\.\/PermissionModeBar\.jsx';/);
  // 셸이 아니라 **입력 상자** 안이어야 한다 — 셸 최상단은 GOAL 배지·인터럽트 복구 바가
  // 조건부로 차지하는 자리라, 거기 얹으면 서로를 가린다.
  // 사이 구간에서 </div>를 금지해 "상자 밖에 나란히 놓기"를 배제한다 — 글자 수 창으로만
  // 재면 상자를 닫고 뒤에 둔 배치도 통과한다(codex 지적). textarea와의 앞뒤 순서는
  // 묶지 않는다 — 절대 배치라 소스 순서가 화면을 바꾸지 않는데 묶으면 무해한 재배열에
  // 테스트만 깨진다(codex 지적).
  assert.match(
    composer,
    /<div className="composer-input">(?:(?!<\/div>)[\s\S])*?<PermissionModeBar\s*\/>/,
    'PermissionModeBar는 .composer-input 안에 있어야 한다',
  );
  // 마운트는 정확히 하나 — 컴포저 안에서 두 번 렌더돼도 aria-label이 둘이 된다.
  assert.equal((composer.match(/<PermissionModeBar\b/g) ?? []).length, 1);
});

test('App은 더 이상 이 컴포넌트를 마운트하지 않는다 — 이중 마운트 방지', () => {
  // 두 곳에서 렌더되면 aria-label '권한 모드'가 둘이 되어 e2e가 strict mode로 깨지고,
  // 사용자에게는 같은 셀렉트가 두 개 보인다. 이름을 언급하는 주석까지 막지 않도록
  // import 문과 실제 태그만 못박는다(codex 지적).
  assert.doesNotMatch(app, /import PermissionModeBar\b/);
  assert.doesNotMatch(app, /<PermissionModeBar\b/);
  // 이름만 막으면 `import Bar from './components/PermissionModeBar.jsx'` 같은 별칭
  // 재도입이 그대로 빠져나간다 — 모듈 경로 자체를 막는다(codex 지적).
  assert.doesNotMatch(app, /from '\.\/components\/PermissionModeBar\.jsx'/);
});

test('우측 상단 배지 띠는 배지가 실제로 보일 때만 만들어진다', () => {
  // 권한 모드가 빠져나간 뒤 .main-top-right에 남은 것은 세션 이름 배지뿐이다.
  // 래퍼와 채팅 상단 여백(has-top-controls)이 같은 조건을 봐야 사이드바가 펼쳐진
  // 평소에 빈 상자와 56px 여백만 남지 않는다.
  assert.match(app, /const sessionBadge = !!session && !sidebarOpen;/);
  // 조건 블록이 닫히기( `)}` ) 전에 래퍼가 나와야 실제로 그 조건 안에 든 것이다.
  assert.match(app, /\{sessionBadge && \((?:(?!\)\})[\s\S])*?className="main-top-right"/);
  assert.match(app, /`main\$\{sessionBadge \? ' has-top-controls' : ''\}`/);
  // 조건부 래퍼 하나만 있는지까지 세지 않으면, 무조건 렌더되는 두 번째 래퍼가 옆에
  // 생겨도 위 단언은 그대로 통과한다(codex 지적).
  assert.equal((app.match(/className="main-top-right"/g) ?? []).length, 1);
  // 주석의 언급까지 세지 않도록 클래스로 붙는 형태(`' has-top-controls'`)만 센다.
  assert.equal((app.match(/' has-top-controls'/g) ?? []).length, 1);
  // 래퍼 안에 실제로 배지가 들어 있어야 "배지가 보일 때만"이 의미를 갖는다.
  assert.match(app, /className="main-top-right">(?:(?!<\/div>)[\s\S])*?className="session-name-badge"/);
});

test('인라인 셀렉트의 절대 위치는 .composer-input으로 한정해 선언한다', () => {
  // 공용 .pill-select-wrap이 같은 특이도(0,1,0)로, 그것도 **나중에**
  // position:relative를 선언한다 — 클래스 하나로 쓰면 그쪽이 이겨 셀렉트가 흐름에
  // 남는다(codex가 잡은 회귀). 앵커가 될 .composer-input의 relative도 함께 고정한다.
  assert.match(
    interactCss,
    /\.composer-input \.perm-mode-inline\s*\{[^}]*position:\s*absolute;/,
  );
  // 이 작업의 요구사항 자체가 "우측 상단"이다 — position만 보면 좌하단으로 옮겨도
  // 통과한다(codex 지적). 값은 묶지 않고 두 축을 잡는다는 것만 못박는다.
  assert.match(interactCss, /\.composer-input \.perm-mode-inline\s*\{[^}]*\btop:/);
  assert.match(interactCss, /\.composer-input \.perm-mode-inline\s*\{[^}]*\bright:/);
  // 한정하지 않은 규칙이 position을 잡으면 그 회귀가 그대로 돌아온다. 들여쓰기·공백
  // 변형까지 걸리도록 규칙 경계에서 찾는다 — 경계에는 `}`(직전 블록)뿐 아니라
  // `{`(@media 안 첫 규칙)와 `,`(콤마 선택자 목록의 뒤쪽 항목)도 넣는다(codex 지적).
  assert.doesNotMatch(
    interactCss,
    /(^|[{},])\s*\.perm-mode-inline\s*[,{][^}]*position\s*:/,
    '한정하지 않은 .perm-mode-inline 규칙은 .pill-select-wrap에 덮인다',
  );
  assert.match(interactCss, /\.composer-input\s*\{[^}]*position:\s*relative;/);
  // 셀렉트 폭과 textarea가 비우는 폭은 반드시 같은 변수여야 한다 — 따로 두면 한쪽만
  // 바뀌어 글자가 셀렉트 밑으로 파고든다. 그래서 양쪽 사용처를 모두 못박는다.
  assert.match(interactCss, /\.composer-input\s*\{[^}]*--perm-inline-w:\s*\d/);
  assert.match(
    interactCss,
    /\.composer-input \.perm-mode-inline\s*\{[^}]*width:\s*var\(--perm-inline-w\)/,
  );
  assert.match(
    interactCss,
    /\.composer-input:has\(\.perm-mode-inline\) textarea\s*\{[^}]*padding-right:\s*calc\(var\(--perm-inline-w\)\s*\+/,
  );
  // 떠 있던 시절의 규칙은 실제 **선언**으로 남아 있으면 안 된다. 이 이름을 설명하는
  // 주석은 theme.css에 일부러 남겨 뒀는데(왜 없어졌는지의 기록), stripCssComments가
  // 매칭 대상에서 걷어내므로 여기 걸리지 않는다. 이름이 겹치는 다른 클래스는 막지 않는다.
  assert.doesNotMatch(themeCss, /(^|[{},])\s*\.perm-mode-float[\s,{]/);
});

// ----- 모델 피커 — 낙관 갱신 금지 계약 (같은 파일에 두는 이유: 대상이 Composer.jsx로
// 같고, 브라우저 없이 렌더할 수 없어 검증 수단도 소스 고정으로 같다) -----
// 이 계약이 이번 수정의 핵심이다: 예전 changeModel은 소켓 write가 성공하면 곧바로
// session.model/spawnModel을 바꿨고, CLI가 그 모델을 거부해도 화면만 새 모델로 남았다.
// e2e 해피패스는 낙관 갱신을 되살려도 그대로 통과하므로(둘 다 끝에는 Sonnet이 보인다)
// 그 회귀를 잡는 그물이 여기뿐이다. 설계 근거:
// .certify/design/2026-08-23-model-effort-change-desync.html
test('모델 변경은 ack를 기다린다 — 표시 갱신을 낙관적으로 하지 않는다', () => {
  // 전송 결과가 아니라 store.setModel의 **결론**을 기다린다.
  assert.match(composer, /const outcome = await setModel\(key, model\);/);
  // 성공 시에도 model/contextWindow를 직접 쓰지 않는다 — 표시는 modelSet 방송을 받은
  // 리듀서 한 곳에서만 바뀐다. 여기서 dispatch가 되살아나면 desync도 함께 돌아온다.
  assert.doesNotMatch(
    composer,
    /update-session[\s\S]{0,200}?\bcontextWindow: null/,
    'changeModel의 낙관적 update-session dispatch가 되살아났다',
  );
  // 결론별 안내가 모두 살아 있다(어느 하나가 빠지면 사용자가 결과를 모른 채 남는다).
  assert.match(composer, /outcome === 'applied'/);
  assert.match(composer, /outcome === 'unsent'/);
  assert.match(composer, /outcome === 'unknown'/);
  // 'refused'는 서버 error 토스트가 사유를 알리므로 여기서 또 알리지 않는다(중복 방지).
  assert.doesNotMatch(composer, /outcome === 'refused'/);
});

test('적용 여부를 모르면(unknown) 스폰 계보를 비운다 — 재시작이 옛 모델을 되살리지 않게', () => {
  // 구버전 데몬은 ack 없이도 set_model을 CLI에 전달한다 — 이미 바뀌었을 수 있는데
  // 옛 spawnModel을 남기면 노력 수준 폴백 재시작이 `--model <옛 모델>`로 되돌린다.
  assert.match(composer, /spawnModel: null/);
  // 다만 기다리는 동안 다른 변경이 성공했다면 그쪽이 최신 계보다 — 늦게 끝난 타임아웃이
  // 그걸 지우지 않도록 보내기 직전 값과 대조한다(연타 경로).
  assert.match(composer, /s\.spawnModel === spawnBefore/);
});
