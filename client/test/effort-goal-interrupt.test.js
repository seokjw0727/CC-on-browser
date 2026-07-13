// 신규 기능 단위 테스트:
//  - lib/effort.js: ultracode(UI 의사 티어) → spawn max 매핑, 라벨/판별
//  - reduce-cli-event: /goal 추적(커맨드 에코·stdout), stdout 노이즈 억제,
//    lastUserText(인터럽트 복구용), 순수성(입력 불변)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceCliEvent, deriveGoalFromMessages } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';
import {
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  spawnEffort,
  isUiEffort,
  effortLabel,
} from '../src/lib/effort.js';

const cmdEcho = (name, args = '') => ({
  type: 'user',
  optimistic: true,
  message: {
    role: 'user',
    content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
  },
});
const stdout = (text) => ({
  type: 'user',
  message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
});
const userText = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('effort: ultracode는 UI 의사 티어 — spawn 시 max로 매핑, 나머지는 그대로', () => {
  assert.equal(spawnEffort('ultracode'), 'max');
  assert.equal(spawnEffort('max'), 'max');
  assert.equal(spawnEffort('low'), 'low');
  assert.equal(spawnEffort(null), null);
  assert.equal(spawnEffort(undefined), null);
  assert.equal(isUiEffort('ultracode'), true);
  assert.equal(isUiEffort('max'), false);
  assert.equal(effortLabel('ultracode'), '울트라코드');
  assert.equal(DEFAULT_EFFORT, 'high');
  // ultracode는 목록의 최상위이자 유일한 ultra 티어
  assert.equal(EFFORT_LEVELS[EFFORT_LEVELS.length - 1].value, 'ultracode');
  assert.equal(EFFORT_LEVELS.filter((l) => l.ultra).length, 1);
});

test('goal: /goal <텍스트>는 목표 설정, /goal clear는 해제, 인자없는 /goal은 불변', () => {
  let s = createSessionState({ key: 'k' });
  s = reduceCliEvent(s, cmdEcho('goal', '리팩터 끝내기'));
  assert.equal(s.goal, '리팩터 끝내기');
  // 커맨드 칩은 그대로 남는다(배지는 부수효과)
  assert.equal(s.messages.filter((m) => m.kind === 'command').length, 1);

  s = reduceCliEvent(s, cmdEcho('goal', 'clear'));
  assert.equal(s.goal, null);

  s = reduceCliEvent(s, cmdEcho('goal', '두번째 목표'));
  assert.equal(s.goal, '두번째 목표');
  // 인자 없는 /goal(조회)은 기존 목표를 건드리지 않는다
  s = reduceCliEvent(s, cmdEcho('goal', ''));
  assert.equal(s.goal, '두번째 목표');
});

test('goal: "Goal set:" stdout은 /goal 직후에만 흡수된다(임의 출력 오삼킴 방지)', () => {
  // 직전 커맨드가 /goal이 아니면 "Goal set:"으로 시작하는 출력도 삼키지 않는다 —
  // 임의 커맨드 출력/오류가 사라지는 것을 막는다(scoped absorption).
  let s = createSessionState({ key: 'k' });
  s = reduceCliEvent(s, stdout('Goal set: 진짜 커맨드 출력인데 우연히 같은 접두사'));
  assert.equal(s.goal, null, '직전 /goal 없으면 흡수 안 함');
  assert.equal(s.messages.filter((m) => m.kind === 'command-output').length, 1, '출력은 보존');

  // /goal 커맨드 직후의 "Goal set:"/"Goal cleared" stdout만 흡수(중복 출력 억제)
  let t = createSessionState({ key: 'k2' });
  t = reduceCliEvent(t, cmdEcho('goal', '초기 목표'));
  assert.equal(t.goal, '초기 목표');
  t = reduceCliEvent(t, stdout('Goal set: stdout 경로 목표'));
  assert.equal(t.goal, 'stdout 경로 목표');
  assert.equal(t.messages.filter((m) => m.kind === 'command-output').length, 0, '중복 출력 억제');
  t = reduceCliEvent(t, stdout('Goal cleared'));
  assert.equal(t.goal, null);
});

test('goal: deriveGoalFromMessages는 프리로드 메시지에서 마지막 목표를 복원한다(재시작/재개)', () => {
  const cmd = (args) => ({ uid: `c${Math.round(args.length)}`, kind: 'command', name: 'goal', args });
  assert.equal(deriveGoalFromMessages([]), null);
  assert.equal(deriveGoalFromMessages([cmd('A'), cmd('B')]), 'B', '마지막 설정');
  assert.equal(deriveGoalFromMessages([cmd('A'), cmd('clear')]), null, '마지막이 해제');
  // 조회(빈 인자)는 건너뛰고 더 이전 설정을 찾는다
  assert.equal(deriveGoalFromMessages([cmd('A'), cmd('')]), 'A');
  // goal 커맨드가 없으면 null
  assert.equal(deriveGoalFromMessages([{ kind: 'user-text', text: 'hi' }]), null);
});

test('raw: 서버가 중계한 stderr({type:raw,line})는 숨기지 않고 notice로 표시한다', () => {
  let s = createSessionState({ key: 'k' });
  s = reduceCliEvent(s, { type: 'raw', line: 'some stderr diagnostic' });
  const notices = s.messages.filter((m) => m.kind === 'notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, 'some stderr diagnostic');
  // 빈 라인은 무시
  s = reduceCliEvent(s, { type: 'raw', line: '   ' });
  assert.equal(s.messages.filter((m) => m.kind === 'notice').length, 1);
  // 미지의 "구조화" 이벤트는 여전히 raw로 담긴다(뷰에서 디버그 게이트로 숨김)
  s = reduceCliEvent(s, { type: 'unknown-structured-xyz', foo: 1 });
  assert.equal(s.messages.some((m) => m.kind === 'raw'), true);
});

test('lastUserText: 사용자 프롬프트(문자열·배열 텍스트)를 기억한다(복구용)', () => {
  let s = createSessionState({ key: 'k' });
  assert.equal(s.lastUserText, null);
  s = reduceCliEvent(s, userText('배열 텍스트 프롬프트'));
  assert.equal(s.lastUserText, '배열 텍스트 프롬프트');
  s = reduceCliEvent(s, { type: 'user', message: { role: 'user', content: '문자열 프롬프트' } });
  assert.equal(s.lastUserText, '문자열 프롬프트');
  // 커맨드 턴은 lastUserText를 비운다 — 이후 그 커맨드가 인터럽트돼도 복구 바가 직전
  // plain 프롬프트를 stale하게 재시도하지 않게 한다(예: 프롬프트 완료 후 /compact Esc).
  s = reduceCliEvent(s, cmdEcho('compact'));
  assert.equal(s.lastUserText, null);
});

test('순수성: goal/lastUserText 갱신이 입력 세션을 변형하지 않는다', () => {
  const s0 = createSessionState({ key: 'k' });
  const snap = JSON.stringify(s0);
  const s1 = reduceCliEvent(s0, cmdEcho('goal', 'X'));
  const s2 = reduceCliEvent(s0, userText('Y'));
  assert.equal(JSON.stringify(s0), snap, '입력 불변');
  assert.notEqual(s1, s0);
  assert.notEqual(s2, s0);
  assert.equal(s1.goal, 'X');
  assert.equal(s2.lastUserText, 'Y');
  assert.equal(s0.goal, null);
  assert.equal(s0.lastUserText, null);
});
