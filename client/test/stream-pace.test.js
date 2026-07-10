// 스트리밍 페이서(lib/stream-pace) 계약 고정 — 수렴·단조 전진·시간 기반 속도·
// 지연 상한·서로게이트 경계. rAF/React 없이 순수 함수만 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextShown, MAX_LAG } from '../src/lib/stream-pace.js';

test('shown < target 이면 항상 1 이상 전진하고 target을 넘지 않는다', () => {
  const text = 'a'.repeat(100);
  for (const streaming of [true, false]) {
    for (const shown of [0, 1, 50, 99]) {
      const next = nextShown(shown, text, streaming);
      assert.ok(next > shown, `전진 (shown=${shown}, streaming=${streaming})`);
      assert.ok(next <= text.length, '오버슛 없음');
    }
  }
});

test('반복 적용하면 유한 프레임 안에 target에 수렴한다', () => {
  const text = 'x'.repeat(5000);
  for (const streaming of [true, false]) {
    let shown = 0;
    let frames = 0;
    while (shown < text.length) {
      shown = nextShown(shown, text, streaming);
      frames += 1;
      assert.ok(frames < 2000, '무한 루프 방지');
    }
    assert.equal(shown, text.length);
  }
});

test('shown이 이미 target 이상이면 target을 그대로 반환한다', () => {
  assert.equal(nextShown(5, 'abcde', true), 5);
  assert.equal(nextShown(9, 'abcde', false), 5); // 텍스트 교체로 줄어든 경우 클램프
  assert.equal(nextShown(0, '', true), 0);
});

test('시간 기반: 같은 상태에서 dt가 크면 같거나 더 많이 전진한다', () => {
  const text = 'b'.repeat(1000);
  for (const streaming of [true, false]) {
    const at60hz = nextShown(0, text, streaming, 16.7);
    const at144hz = nextShown(0, text, streaming, 6.9);
    const throttled = nextShown(0, text, streaming, 100);
    assert.ok(at144hz <= at60hz, '고주사율 프레임은 프레임당 덜 전진');
    assert.ok(at60hz <= throttled, '긴 프레임은 더 많이 전진');
    // 등가 속도: dt 6.9 × (16.7/6.9)회 ≈ dt 16.7 × 1회 (반올림 오차 허용)
    let fine = 0;
    for (let i = 0; i < 12; i++) fine = nextShown(fine, text, streaming, 6.9);
    const coarse = (() => {
      let s = 0;
      for (let i = 0; i < 5; i++) s = nextShown(s, text, streaming, 16.7);
      return s;
    })();
    const ratio = fine / coarse; // 12×6.9ms ≈ 5×16.7ms
    assert.ok(ratio > 0.7 && ratio < 1.4, `주사율 독립 속도 (ratio=${ratio.toFixed(2)})`);
  }
});

test('dt가 시정수 이상이면 남은 분량을 한 번에 드러낸다', () => {
  const text = 'c'.repeat(1000);
  assert.equal(nextShown(0, text, true, 400), 1000);
  assert.equal(nextShown(0, text, false, 130), 1000);
});

test('스트림 종료(flush)는 스트리밍 중보다 같거나 빠르게 전진한다', () => {
  const text = 'y'.repeat(300);
  for (const shown of [0, 100, 250, 295]) {
    assert.ok(
      nextShown(shown, text, false) >= nextShown(shown, text, true),
      `flush >= stream (shown=${shown})`,
    );
  }
});

test('backlog가 MAX_LAG를 넘으면 초과분은 건너뛴다', () => {
  const text = 'z'.repeat(MAX_LAG * 3);
  const next = nextShown(0, text, true);
  assert.ok(next >= text.length - MAX_LAG, '지연 상한 준수');
});

test('서로게이트 쌍(이모지) 중간에서 끊지 않는다', () => {
  // '😀' = 2 코드 유닛. 경계가 쌍 중간(고위 서로게이트 직후)에 머물면 안 된다.
  const text = '😀 그리고 긴 꼬리 텍스트';
  const next = nextShown(0, text, true, 1);
  assert.ok(next >= 2, '고위 서로게이트 직후에서 멈추지 않음');
  const cut = text.charCodeAt(next - 1);
  assert.ok(!(cut >= 0xd800 && cut <= 0xdbff), '경계가 쌍 중간이 아님');
});
