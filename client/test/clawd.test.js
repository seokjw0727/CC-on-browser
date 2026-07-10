// CLAW'D 프레임 비트맵 무결성 + 무드 매핑 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAWD_FRAMES, clawdMood } from '../src/lib/clawd.js';

const FRAME_NAMES = ['base', 'blink', 'step', 'claws', 'doze'];

test('모든 프레임은 11x8이고 0/1로만 구성된다', () => {
  assert.deepEqual(Object.keys(CLAWD_FRAMES).sort(), [...FRAME_NAMES].sort());
  for (const name of FRAME_NAMES) {
    const bits = CLAWD_FRAMES[name];
    assert.equal(bits.length, 8, `${name}: 8행`);
    for (const row of bits) {
      assert.equal(row.length, 11, `${name}: 11열`);
      assert.match(row, /^[01]+$/, `${name}: 0/1만`);
    }
  }
});

function diffRows(a, b) {
  const rows = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) rows.push(i);
  return rows;
}

test('blink는 base와 눈 행(3행)만 다르다 — 눈 구멍이 채워진다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.blink), [3]);
  // base의 눈 구멍(x3, x7)이 blink에서는 칠해져 있다
  assert.equal(CLAWD_FRAMES.base[3][3], '0');
  assert.equal(CLAWD_FRAMES.base[3][7], '0');
  assert.equal(CLAWD_FRAMES.blink[3][3], '1');
  assert.equal(CLAWD_FRAMES.blink[3][7], '1');
});

test('step은 base와 다리·발 행(6,7행)만 다르다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.step), [6, 7]);
});

test('claws는 base와 팔 위치 행(2,5행)만 다르다 — 집게가 머리 옆으로 올라온다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.claws), [2, 5]);
});

test('doze는 더듬이(0,1행)와 눈(3행)만 다르다', () => {
  assert.deepEqual(diffRows(CLAWD_FRAMES.base, CLAWD_FRAMES.doze), [0, 1, 3]);
  assert.equal(CLAWD_FRAMES.doze[0], '00000000000', '더듬이 끝이 사라진다');
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
