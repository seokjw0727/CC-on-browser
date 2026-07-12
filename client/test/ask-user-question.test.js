// ask-user-question.js — AskUserQuestion 판별·답변 페이로드 조립의 순수 로직 검증.
// 형식 근거: 실 CLI v2.1.207 실측(2026-07-12) — allow + updatedInput{...input, answers:{질문→답}},
// multiSelect 답변은 ", " 조인, 자유 입력은 라벨 대신 원문 문자열.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuestionRequest,
  buildAnswers,
  buildQuestionAnswerPayload,
  buildQuestionSkipPayload,
  allAnswered,
} from '../src/lib/ask-user-question.js';

const QUESTIONS = [
  {
    question: '좋아하는 색은?',
    header: '색상',
    options: [
      { label: '빨강', description: '따뜻한 색상' },
      { label: '파랑', description: '시원한 색상' },
    ],
    multiSelect: false,
  },
  {
    question: '언어 선택',
    header: '언어',
    options: [
      { label: 'JS', description: '' },
      { label: 'Python', description: '' },
      { label: 'Rust', description: '' },
    ],
    multiSelect: true,
  },
];

test('isQuestionRequest: AskUserQuestion + questions 배열이면 true', () => {
  assert.equal(
    isQuestionRequest({ toolName: 'AskUserQuestion', input: { questions: QUESTIONS } }),
    true,
  );
});

test('isQuestionRequest: 일반 권한 요청(Write)·비정상 입력은 false', () => {
  assert.equal(
    isQuestionRequest({ toolName: 'Write', input: { file_path: 'x.txt' } }),
    false,
  );
  // 이름만 같고 questions가 없거나 비면 권한 다이얼로그로 폴백해야 한다
  assert.equal(isQuestionRequest({ toolName: 'AskUserQuestion', input: {} }), false);
  assert.equal(
    isQuestionRequest({ toolName: 'AskUserQuestion', input: { questions: [] } }),
    false,
  );
  assert.equal(isQuestionRequest(null), false);
});

test('buildAnswers: 단일 선택은 라벨 그대로', () => {
  const answers = buildAnswers(QUESTIONS, [{ labels: ['빨강'] }, {}]);
  assert.deepEqual(answers, { '좋아하는 색은?': '빨강' });
});

test('buildAnswers: multiSelect는 ", " 조인, 자유 입력은 원문 추가', () => {
  const answers = buildAnswers(QUESTIONS, [
    { text: ' 초록 ' }, // 자유 입력 — trim 후 원문 그대로
    { labels: ['JS', 'Rust'], text: 'Zig' },
  ]);
  assert.deepEqual(answers, {
    '좋아하는 색은?': '초록',
    '언어 선택': 'JS, Rust, Zig',
  });
});

test('buildQuestionAnswerPayload: allow + updatedInput{...input, answers} 형식(실측)', () => {
  const input = { questions: QUESTIONS };
  const payload = buildQuestionAnswerPayload(input, [{ labels: ['파랑'] }, { labels: ['JS'] }]);
  assert.equal(payload.behavior, 'allow');
  assert.equal(payload.message, null);
  // 원본 input 필드(questions)를 보존한 채 answers만 병합
  assert.deepEqual(payload.updatedInput.questions, QUESTIONS);
  assert.deepEqual(payload.updatedInput.answers, {
    '좋아하는 색은?': '파랑',
    '언어 선택': 'JS',
  });
});

test('buildQuestionSkipPayload: allow + 빈 answers — CLI가 비-오류 "did not answer"로 합성', () => {
  const input = { questions: QUESTIONS };
  const payload = buildQuestionSkipPayload(input);
  assert.equal(payload.behavior, 'allow');
  assert.deepEqual(payload.updatedInput, { questions: QUESTIONS, answers: {} });
});

test('allAnswered: 모든 질문에 라벨 또는 자유 입력이 있어야 true', () => {
  assert.equal(allAnswered(QUESTIONS, [{ labels: ['빨강'] }, { text: 'Zig' }]), true);
  assert.equal(allAnswered(QUESTIONS, [{ labels: ['빨강'] }, {}]), false);
  assert.equal(allAnswered(QUESTIONS, [{ labels: ['빨강'] }, { text: '   ' }]), false);
  assert.equal(allAnswered(QUESTIONS, []), false);
});
