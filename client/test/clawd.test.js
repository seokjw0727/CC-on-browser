// CLAW'D 프레임 비트맵 무결성 + 무드 매핑 테스트.
// 프레임은 실제 CLI 바이너리 아트의 쿼드런트 전사(lib/clawd.js 헤더 참조) —
// 행 단위 diff를 고정해 의도치 않은 실루엣 드리프트를 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAWD_FRAMES, CLAWD_PIXEL_ASPECT, clawdMood } from '../src/lib/clawd.js';

const FRAME_NAMES = ['base', 'blink', 'lookLeft', 'lookRight', 'claws', 'doze'];

test('모든 프레임은 18x5이고 0/1/2로만 구성된다', () => {
  assert.deepEqual(Object.keys(CLAWD_FRAMES).sort(), [...FRAME_NAMES].sort());
  for (const name of FRAME_NAMES) {
    const bits = CLAWD_FRAMES[name];
    assert.equal(bits.length, 5, `${name}: 5행`);
    for (const row of bits) {
      assert.equal(row.length, 18, `${name}: 18열`);
      assert.match(row, /^[012]+$/, `${name}: 0/1/2만`);
    }
  }
});

test('픽셀 종횡비는 터미널 쿼드런트(1:2)를 따른다', () => {
  assert.equal(CLAWD_PIXEL_ASPECT, 2);
});

function diffRows(a, b) {
  const rows = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) rows.push(i);
  return rows;
}
const eyeCount = (bits) => bits.join('').split('').filter((c) => c === '2').length;

test('base의 눈은 정확히 2개 — 눈 블록 "▛███▜"의 빠진 쿼드런트(1행 x5·x12)', () => {
  assert.equal(eyeCount(CLAWD_FRAMES.base), 2);
  assert.equal(CLAWD_FRAMES.base[1][5], '2');
  assert.equal(CLAWD_FRAMES.base[1][12], '2');
});

test('blink는 base와 눈 행(1행)만 다르고 눈이 사라진다(감음)', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.blink), [1]);
  assert.equal(eyeCount(CLAWD_FRAMES.blink), 0);
});

test('lookLeft/lookRight는 눈(0,1행)·다리(4행)만 다르다 — 두리번 + 스캐틀', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.lookLeft), [0, 1, 4]);
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.lookRight), [0, 1, 4]);
  // 눈이 윗행(0행)으로 올라가고(치켜뜸), 좌우가 서로 다른 위치를 본다
  assert.equal(eyeCount(CLAWD_FRAMES.lookLeft), 2);
  assert.equal(eyeCount(CLAWD_FRAMES.lookRight), 2);
  assert.notEqual(CLAWD_FRAMES.lookLeft[0], CLAWD_FRAMES.lookRight[0]);
  // 다리도 서로 반대 방향으로 움직인다 (교대 시 스캐틀로 보이는 근거)
  assert.notEqual(CLAWD_FRAMES.lookLeft[4], CLAWD_FRAMES.lookRight[4]);
});

test('claws(arms-up)는 팔 행(1,2행)만 다르다 — 집게가 머리 옆까지 올라온다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.claws), [1, 2]);
  assert.equal(eyeCount(CLAWD_FRAMES.claws), 2, '눈은 뜨고 있다');
});

test('doze는 눈(1행)·팔(2행)만 다르다 — 눈 감고 팔을 몸에 붙인다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.doze), [1, 2]);
  assert.equal(eyeCount(CLAWD_FRAMES.doze), 0);
});

test('clawdMood: 세션 상태·연결 상태 매핑', () => {
  assert.equal(clawdMood('idle', 'open'), 'idle');
  assert.equal(clawdMood('thinking', 'open'), 'busy');
  assert.equal(clawdMood('tool', 'open'), 'busy');
  assert.equal(clawdMood('awaiting-permission', 'open'), 'alert');
  assert.equal(clawdMood('exited', 'open'), 'doze');
  assert.equal(clawdMood('none', 'open'), 'doze');
  // 연결이 끊기면 무엇을 하고 있었든 존다
  assert.equal(clawdMood('thinking', 'closed'), 'doze');
  assert.equal(clawdMood('idle', 'connecting'), 'doze');
});
