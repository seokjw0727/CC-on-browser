// ui-shape — 모서리 스타일 목록·기본값과, 신뢰할 수 없는 저장값의 정규화.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SHAPES, SHAPE_LABEL, DEFAULT_SHAPE, normalizeShape } from '../src/lib/ui-shape.js';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(CLIENT, 'src');

test('둥근·각진 두 가지이고 기본값은 둥근(pill)이다', () => {
  assert.deepEqual(SHAPES, ['pill', 'square']);
  assert.equal(DEFAULT_SHAPE, 'pill');
  assert.ok(SHAPES.includes(DEFAULT_SHAPE));
});

test('모든 모서리 값에 한국어 라벨이 있다', () => {
  for (const s of SHAPES) {
    assert.equal(typeof SHAPE_LABEL[s], 'string');
    assert.ok(SHAPE_LABEL[s].length > 0, `'${s}'에 라벨이 없다`);
  }
});

test('알려진 값은 그대로 통과한다', () => {
  for (const s of SHAPES) assert.equal(normalizeShape(s), s);
});

test('알 수 없는 값·빈 값은 전부 기본값으로 떨어진다', () => {
  // localStorage를 손으로 고치거나 옛 버전이 남긴 값이 data-shape에 실리면
  // 어느 토큰 블록에도 걸리지 않아 조용히 깨진다 — 그 경로를 막는 회귀 테스트.
  for (const bad of [null, undefined, '', 'Pill', 'SQUARE', 'round', 0, 1, {}, []]) {
    assert.equal(normalizeShape(bad), DEFAULT_SHAPE, `${JSON.stringify(bad)}가 통과했다`);
  }
});

test('theme.css가 모든 모서리 값에 대응하는 규칙을 갖는다', () => {
  // 값을 추가해 놓고 CSS를 빼먹으면 UI에서는 선택되는데 아무 변화가 없다.
  const css = readFileSync(join(SRC, 'theme.css'), 'utf8');
  for (const s of SHAPES) {
    if (s === DEFAULT_SHAPE) continue; // 기본값은 :root가 담당(별도 블록 없음)
    assert.ok(
      css.includes(`:root[data-shape='${s}']`),
      `theme.css에 :root[data-shape='${s}'] 블록이 없다`,
    );
  }
});

test('index.html 인라인 부트스트랩이 App.jsx와 같은 저장 키·기본값을 쓴다', () => {
  // 첫 페인트 깜빡임을 없애려고 키 이름이 index.html에 복제돼 있다 — 한쪽만 바꾸면
  // 새로고침 때 이전 스타일로 한 프레임 번쩍이고도 아무도 눈치채지 못한다.
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
  for (const key of ['ccob-theme', 'ccob-shape']) {
    assert.ok(html.includes(`'${key}'`), `index.html이 ${key}를 읽지 않는다`);
    assert.ok(app.includes(`'${key}'`), `App.jsx가 ${key}를 쓰지 않는다`);
  }
  assert.ok(
    html.includes(`|| '${DEFAULT_SHAPE}'`),
    `index.html의 모서리 기본값이 '${DEFAULT_SHAPE}'가 아니다`,
  );
});

test('각진 모드는 둥근 모드가 정의한 radius 토큰을 빠짐없이 덮는다', () => {
  // 일부만 덮으면 화면 절반은 둥글고 절반은 각진 혼합 상태가 된다.
  const css = readFileSync(join(SRC, 'theme.css'), 'utf8');
  const block = (selector) => {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `${selector}를 찾지 못했다`);
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };
  const tokensIn = (text) => new Set(
    [...text.matchAll(/(--r(?:-[a-z]+)?|--radius):/g)].map((m) => m[1]),
  );
  const base = tokensIn(block(':root {'));
  const square = tokensIn(block(":root[data-shape='square'] {"));
  assert.ok(base.size >= 6, `:root에서 찾은 radius 토큰이 너무 적다: ${[...base]}`);
  assert.deepEqual(
    [...base].filter((t) => !square.has(t)),
    [],
    '각진 모드가 덮지 않은 radius 토큰이 있다',
  );
});
