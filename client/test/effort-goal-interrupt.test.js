// 신규 기능 단위 테스트:
//  - lib/effort.js: ultracode(UI 최상위 티어) ↔ CLI 페이로드 매핑, 라벨/설명/판별,
//    슬라이더 좌표·키보드 헬퍼
//  - reduce-cli-event: /goal 추적(커맨드 에코·stdout), stdout 노이즈 억제,
//    lastUserText(인터럽트 복구용), 순수성(입력 불변)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceCliEvent, deriveGoalFromMessages } from '../src/lib/reduce-cli-event.js';
import { createSessionState } from '../src/lib/store-reducer.js';
import {
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  isUiEffort,
  effortLabel,
  effortDesc,
  effortPayload,
  uiEffort,
  effortIndexFromRatio,
  effortRatioFromIndex,
  nextEffortIndex,
  visibleEffortLevels,
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

test('effort: ultracode는 CLI와 같은 의미로 분해된다 — xhigh + ultracode 플래그', () => {
  // 실 CLI v2.1.233의 /effort ultracode와 동일: effortLevel 'xhigh' + ultracode true.
  assert.deepEqual(effortPayload('ultracode'), { effort: 'xhigh', ultracode: true });
  assert.deepEqual(effortPayload('max'), { effort: 'max', ultracode: false });
  assert.deepEqual(effortPayload('low'), { effort: 'low', ultracode: false });
  assert.deepEqual(effortPayload(null), { effort: null, ultracode: false });
  assert.deepEqual(effortPayload(undefined), { effort: null, ultracode: false });
  // 서버 검증(low..max)을 통과하는 값만 나간다 — 'ultracode' 문자열은 절대 전송되지 않는다
  for (const level of EFFORT_LEVELS) {
    assert.notEqual(effortPayload(level.value).effort, 'ultracode', level.value);
  }
  // 역매핑(서버 effortSet 방송 → UI 티어)이 왕복에서 원값을 되돌린다
  for (const level of EFFORT_LEVELS) {
    assert.equal(uiEffort(effortPayload(level.value)), level.value, level.value);
  }
  assert.equal(uiEffort({ effort: 'xhigh', ultracode: false }), 'xhigh');
  assert.equal(uiEffort({ effort: null, ultracode: false }), null);
  assert.equal(uiEffort({}), null);
  assert.equal(uiEffort(), null);

  assert.equal(isUiEffort('ultracode'), true);
  assert.equal(isUiEffort('max'), false);
  assert.equal(effortLabel('ultracode'), '울트라코드');
  assert.equal(DEFAULT_EFFORT, 'high');
  // ultracode는 목록의 최상위이자 유일한 ultra 티어
  assert.equal(EFFORT_LEVELS[EFFORT_LEVELS.length - 1].value, 'ultracode');
  assert.equal(EFFORT_LEVELS.filter((l) => l.ultra).length, 1);
  // 레벨마다 hover 도움말 문구가 있다(툴팁·팝오버 설명의 단일 출처)
  for (const level of EFFORT_LEVELS) {
    assert.ok(effortDesc(level.value).length > 0, `${level.value} desc`);
  }
  assert.equal(effortDesc('nope'), '');
});

test('effort 슬라이더: 비율 ↔ 인덱스 환산은 양끝으로 붙고 범위를 넘지 않는다', () => {
  const n = 6; // EFFORT_LEVELS 기본 개수
  assert.equal(effortIndexFromRatio(0, n), 0);
  assert.equal(effortIndexFromRatio(1, n), n - 1);
  // 트랙 밖 드래그(포인터 캡처)도 양끝으로 클램프
  assert.equal(effortIndexFromRatio(-0.4, n), 0);
  assert.equal(effortIndexFromRatio(4, n), n - 1);
  // 가장 가까운 도트로 스냅
  assert.equal(effortIndexFromRatio(0.19, n), 1);
  assert.equal(effortIndexFromRatio(0.5, n), 3);
  assert.equal(effortIndexFromRatio(0.42, n), 2);
  // 비정상 입력은 0으로(NaN이 style/aria로 새지 않게)
  assert.equal(effortIndexFromRatio(NaN, n), 0);
  assert.equal(effortIndexFromRatio(0.5, 0), 0);

  assert.equal(effortRatioFromIndex(0, n), 0);
  assert.equal(effortRatioFromIndex(n - 1, n), 1);
  assert.equal(effortRatioFromIndex(3, n), 0.6);
  // 모델 변경으로 레벨 수가 줄어든 뒤의 낡은 인덱스도 트랙을 넘지 않는다
  assert.equal(effortRatioFromIndex(9, n), 1);
  assert.equal(effortRatioFromIndex(-2, n), 0);
  assert.equal(effortRatioFromIndex(0, 1), 0);
  // 왕복: 인덱스 → 비율 → 인덱스는 자기 자신
  for (let i = 0; i < n; i++) assert.equal(effortIndexFromRatio(effortRatioFromIndex(i, n), n), i);
});

test('effort 슬라이더: ARIA 키보드 규약 — 처리하지 않는 키는 null(기본 동작 보존)', () => {
  const n = 6;
  assert.equal(nextEffortIndex('ArrowRight', 2, n), 3);
  assert.equal(nextEffortIndex('ArrowUp', 2, n), 3);
  assert.equal(nextEffortIndex('ArrowLeft', 2, n), 1);
  assert.equal(nextEffortIndex('ArrowDown', 2, n), 1);
  assert.equal(nextEffortIndex('Home', 4, n), 0);
  assert.equal(nextEffortIndex('End', 1, n), n - 1);
  assert.equal(nextEffortIndex('PageUp', 1, n), 3);
  assert.equal(nextEffortIndex('PageDown', 4, n), 2);
  // 양끝에서 더 밀어도 머문다
  assert.equal(nextEffortIndex('ArrowRight', n - 1, n), n - 1);
  assert.equal(nextEffortIndex('ArrowLeft', 0, n), 0);
  assert.equal(nextEffortIndex('PageDown', 1, n), 0);
  // Tab·Enter·Escape 등은 슬라이더가 삼키지 않는다(팝오버 닫기·포커스 이동 보존)
  for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a']) {
    assert.equal(nextEffortIndex(key, 2, n), null, key);
  }
  assert.equal(nextEffortIndex('ArrowRight', 0, 0), null);
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

// ----- visibleEffortLevels — 모델을 바꿨을 뿐인데 노력 수준이 '낮음'으로 뭉개지던 문제 -----
// 설계 근거: .certify/design/2026-08-23-model-effort-change-desync.html
test('visibleEffortLevels: 지원 목록으로 거르되 현재 값은 표시에서 잃지 않는다', () => {
  const values = (ls) => ls.map((l) => l.value);

  // 지원 목록을 보고하지 않는 모델은 전부 노출(기존 동작 — 판단 근거가 없다)
  assert.equal(visibleEffortLevels(null, 'high'), EFFORT_LEVELS);
  assert.equal(visibleEffortLevels([], 'high'), EFFORT_LEVELS);

  // 보고하면 그걸로 거른다. ultracode는 목록에 없지만 xhigh를 지원할 때만 노출된다
  assert.deepEqual(
    values(visibleEffortLevels(['low', 'medium', 'high'], 'high')),
    ['low', 'medium', 'high'],
    'xhigh 미지원 모델에는 울트라코드가 나오지 않는다',
  );
  assert.deepEqual(
    values(visibleEffortLevels(['low', 'high', 'xhigh'], 'high')),
    ['low', 'high', 'xhigh', 'ultracode'],
  );

  // 핵심: 현재 값이 지원 목록 밖이어도 표시 목록에는 남는다 — 빠지면 슬라이더가
  // 사용자 입력 없이 '낮음'(index 0)으로 내려앉는다
  const kept = visibleEffortLevels(['low', 'medium'], 'max');
  assert.deepEqual(values(kept), ['low', 'medium', 'max'], '전역 순서를 유지한 채 끼워 넣는다');
  assert.equal(kept.findIndex((l) => l.value === 'max'), 2, '현재 값의 위치를 특정할 수 있다');

  // 울트라코드가 현재 값이면 xhigh 미지원 모델에서도 표시로는 남는다(값을 잃지 않는다)
  assert.ok(values(visibleEffortLevels(['low'], 'ultracode')).includes('ultracode'));

  // 값이 실제로 바뀌면 옛 미지원 값은 그 즉시 목록에서 사라진다 —
  // 이것이 "표시 보존이 미지원 값의 재전송으로 번지지 않는" 근거다
  assert.deepEqual(values(visibleEffortLevels(['low', 'medium'], 'low')), ['low', 'medium']);

  // EFFORT_LEVELS에 없는 미지의 값은 끼워 넣지 않는다(목록을 오염시키지 않는다)
  assert.deepEqual(values(visibleEffortLevels(['low'], 'bogus')), ['low']);
});
