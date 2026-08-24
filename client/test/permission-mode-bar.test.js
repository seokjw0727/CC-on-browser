// PermissionModeBar — 컴포저에서 옮겨 온 권한 모드 셀렉트의 계약을 소스로 고정한다.
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
  // 복붙이 아니라 이사여야 한다 — 양쪽에 남으면 한쪽만 고치는 사고가 난다.
  assert.doesNotMatch(composer, /setPermissionMode/);
  assert.doesNotMatch(composer, /composer-top/);
  assert.doesNotMatch(composer, /repo-pill/);
});

test('App이 이 컴포넌트를 우측 상단 묶음 안에 마운트한다', () => {
  assert.match(app, /import PermissionModeBar from/);
  assert.match(app, /className="main-top-right"/);
  assert.match(app, /<PermissionModeBar \/>/);
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
