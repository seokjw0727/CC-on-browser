// 버전 스큐 판정(lib/app-version.js)의 계약을 고정한다.
//
// 이 모듈은 vite define(__APP_VERSION__)에 의존하는데, node --test에는 그 정의가
// 없다 — 그래서 여기서 검증하는 것은 "정의가 없을 때 조용히 비교를 포기한다"는
// 폴백 계약이다. 실제 값이 박히는 경로(빌드)는 vite.config.js가 소유한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_VERSION, versionSkew } from '../src/lib/app-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('define이 없는 환경에서는 APP_VERSION이 null이고 비교를 하지 않는다', () => {
  // typeof는 선언되지 않은 식별자에도 던지지 않는다 — import 자체가 성공해야 한다.
  assert.equal(APP_VERSION, null);
  // 번들 버전을 모르면 서버가 무엇을 말하든 경고를 띄우지 않는다(거짓 경보 방지).
  assert.equal(versionSkew('9.9.9'), null);
  assert.equal(versionSkew(undefined), null);
});

test('vite.config가 __APP_VERSION__을 루트 package.json 버전으로 박아 넣는다', () => {
  // 정의가 사라지면 배너는 영원히 뜨지 않으므로(APP_VERSION=null), 그 배선을
  // 텍스트로 고정한다 — 이 파일은 node --test로 import할 수 없다(vite 의존).
  const cfg = readFileSync(join(__dirname, '..', 'vite.config.js'), 'utf8');
  assert.match(cfg, /__APP_VERSION__:\s*JSON\.stringify\(version\)/);
  assert.match(cfg, /package\.json/);
});

test('스큐 판정은 서버가 version을 싣지 않는 구버전도 다룬다', async () => {
  // APP_VERSION이 null인 환경에서는 versionSkew가 늘 null이므로, 판정 규칙 자체를
  // 같은 식으로 다시 구현해 계약을 명시한다(구현이 바뀌면 이 테스트가 먼저 깨진다).
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'app-version.js'), 'utf8');
  // ① 서버 버전이 같으면 null(정상)
  assert.match(src, /serverVersion === APP_VERSION/);
  // ② 서버가 version을 안 주면 server: null로 보고한다 — 그 자체가 구버전의 증거다.
  assert.match(src, /typeof serverVersion === 'string' \? serverVersion : null/);
});

// ----- 정보 모달의 값 표시 규칙 -----

test('infoValue — 문자열은 다듬어서 그대로', async () => {
  const { infoValue } = await import('../src/lib/app-version.js');
  assert.equal(infoValue('1.9.5'), '1.9.5');
  assert.equal(infoValue('  2.1.233 (Claude Code)  '), '2.1.233 (Claude Code)');
});

test('infoValue — 모르는 값 세 모양을 한 라벨로 접는다', async () => {
  const { infoValue, UNKNOWN_LABEL } = await import('../src/lib/app-version.js');
  // ① 구버전 데몬은 키를 빼먹어 undefined ② --version 타임아웃이면 서버가 null
  // ③ 그 전에 죽으면 빈 문자열. 접지 않으면 화면에 undefined가 그대로 찍힌다.
  for (const bad of [undefined, null, '', '   ', {}, []]) {
    assert.equal(infoValue(bad), UNKNOWN_LABEL, JSON.stringify(bad));
  }
});

test('infoValue — 포트 0은 진짜 값이라 접지 않는다', async () => {
  const { infoValue, UNKNOWN_LABEL } = await import('../src/lib/app-version.js');
  assert.equal(infoValue(0), '0');
  assert.equal(infoValue(8787), '8787');
  assert.equal(infoValue(NaN), UNKNOWN_LABEL);
});

test('하단 패널이 표 하나로 정의되고 패널별 분기가 되살아나지 않았다', () => {
  // 제목·아이콘·본문이 다시 흩어지면 다섯 번째 패널을 넣을 때 또 하나를 빠뜨린다.
  const src = readFileSync(join(__dirname, '..', 'src', 'components', 'Sidebar.jsx'), 'utf8');

  // ① 화면 순서 배열과 표의 키가 정확히 같은 집합이어야 한다. 순서 배열에만 있는 키는
  //    빈 모달을 띄우고, 표에만 있는 키는 영영 화면에 나오지 않는다 — 문자열 하나를
  //    통째로 비교하던 예전 방식은 어느 쪽도 잡지 못했다(codex 지적).
  const orderSrc = src.match(/FOOT_PANEL_ORDER\s*=\s*\[([^\]]*)\]/);
  assert.ok(orderSrc, 'FOOT_PANEL_ORDER 배열을 찾지 못했다');
  const order = [...orderSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['stats', 'worktree', 'settings', 'info']);

  const tableSrc = src.match(/const FOOT_PANELS = \{([\s\S]*?)\n\};/);
  assert.ok(tableSrc, 'FOOT_PANELS 표를 찾지 못했다');
  // 표의 최상위 항목만 — 들여쓰기 두 칸의 `키: {`가 항목의 시작이다.
  const entries = [...tableSrc[1].matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]);
  assert.deepEqual([...entries].sort(), [...order].sort());

  // ② 모든 항목이 세 필수 필드를 갖는다 — 하나라도 빠지면 제목 없는 모달이 뜬다.
  //    항목 블록은 다음 항목의 시작(들여쓰기 두 칸 + `키: {`)까지로 자른다.
  const table = tableSrc[1];
  const starts = entries.map((key) => ({ key, at: table.search(new RegExp(`^ {2}${key}: \\{$`, 'm')) }));
  starts.forEach(({ key, at }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : table.length;
    const block = table.slice(at, end);
    for (const field of ['title:', 'Glyph:', 'body:']) {
      assert.ok(block.includes(field), `${key}에 ${field}가 없다`);
    }
  });

  // ③ 패널별 예외를 표 밖 분기로 되돌리는 것이 이 테스트가 막는 회귀다. 따옴표 종류·
  //    비교 방향·if/switch까지 함께 막는다(예전 정규식은 작은따옴표 삼항 하나만 봤다).
  for (const key of order) {
    const q = `["']${key}["']`;
    assert.doesNotMatch(src, new RegExp(`panel\\s*===\\s*${q}`), `panel === ${key} 분기 부활`);
    assert.doesNotMatch(src, new RegExp(`${q}\\s*===\\s*panel`), `${key} === panel 분기 부활`);
    assert.doesNotMatch(src, new RegExp(`case\\s+${q}\\s*:`), `case ${key} 분기 부활`);
  }
});
