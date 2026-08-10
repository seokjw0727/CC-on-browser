// 상태 점 해석기 단위 테스트 — 화면에서 상태 텍스트가 사라졌으므로 라벨·색 매핑이
// 틀리면 사용자에게 알릴 방법이 전혀 없다. e2e에는 질문 대기(AskUserQuestion)
// 시나리오 픽스처가 없어 그 분기는 여기서만 고정된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusDotOf } from '../src/lib/session-status.js';

test('statusDotOf: 다섯 상태가 각각 다른 색 클래스를 받는다', () => {
  assert.deepEqual(statusDotOf('idle'), { label: '대기', cls: 'st-idle' });
  assert.deepEqual(statusDotOf('thinking'), { label: '생각 중', cls: 'st-think' });
  assert.deepEqual(statusDotOf('tool'), { label: '도구', cls: 'st-tool' });
  assert.deepEqual(statusDotOf('awaiting-permission'), { label: '권한 대기', cls: 'st-attn' });
  assert.deepEqual(statusDotOf('exited'), { label: '종료', cls: 'st-exited' });

  // 색으로 구분되려면 진행 중 상태끼리 클래스가 겹치면 안 된다.
  const classes = ['idle', 'thinking', 'tool', 'awaiting-permission', 'exited']
    .map((s) => statusDotOf(s).cls);
  assert.equal(new Set(classes).size, 5);
});

test('statusDotOf: 질문 대기는 라벨만 갈리고 색은 권한 대기와 공유한다', () => {
  const perm = statusDotOf('awaiting-permission', false);
  const question = statusDotOf('awaiting-permission', true);
  assert.equal(question.label, '질문 대기');
  assert.equal(question.cls, perm.cls, '같은 "확인 필요" 상태라 색은 하나');
  assert.notEqual(question.label, perm.label, '라벨은 구분돼야 한다');
});

test('statusDotOf: 질문 플래그는 권한 대기 이외의 상태를 바꾸지 않는다', () => {
  // 대기 중 요청이 남아 있는 채로 상태만 먼저 넘어가는 순간이 있다 — 그때
  // 엉뚱한 행이 '질문 대기'로 보이면 안 된다.
  for (const s of ['idle', 'thinking', 'tool', 'exited']) {
    assert.deepEqual(statusDotOf(s, true), statusDotOf(s, false), s);
  }
});

test('statusDotOf: 모르는 상태는 색 없이 원문 라벨로 폴백한다', () => {
  assert.deepEqual(statusDotOf('compacting'), { label: 'compacting', cls: '' });
  assert.deepEqual(statusDotOf(undefined), { label: '알 수 없음', cls: '' });
  assert.deepEqual(statusDotOf(null), { label: '알 수 없음', cls: '' });
});
