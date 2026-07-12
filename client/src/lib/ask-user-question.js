// AskUserQuestion 판별·답변 페이로드 조립 — 순수 로직(node --test 검증용, React 없음).
//
// 프로토콜 근거 (실 CLI v2.1.207 실측, 2026-07-12 — 계획서 "검증된 CLI 프로토콜" 절):
// - AskUserQuestion은 권한 상승과 같은 can_use_tool 채널로 오되
//   requires_user_interaction:true + input.questions[]가 실린다.
// - 답변은 allow + updatedInput{...원본 input, answers:{질문 텍스트 → 답변 문자열}}.
//   multiSelect 답변은 ", " 조인, 자유 입력은 라벨 대신 원문 문자열(TUI 동작 미러).
// - answers가 빈 객체면 CLI가 비-오류 tool_result("The user did not answer the
//   questions.")를 합성한다 — 건너뛰기 경로(deny는 오류 tool_result라 쓰지 않는다).

/** pendingPermissions 항목이 AskUserQuestion 질문 요청인가 — 아니면 권한 다이얼로그로 폴백. */
export function isQuestionRequest(req) {
  return (
    req?.toolName === 'AskUserQuestion' &&
    Array.isArray(req?.input?.questions) &&
    req.input.questions.length > 0
  );
}

/**
 * 질문 인덱스별 선택({labels?: string[], text?: string})을 answers 레코드로.
 * 선택도 자유 입력도 없는 질문은 생략한다(부분 답변 허용 — 프로토콜상 유효).
 */
export function buildAnswers(questions, selections) {
  const answers = {};
  (questions ?? []).forEach((q, i) => {
    const sel = selections?.[i] ?? {};
    const labels = Array.isArray(sel.labels) ? sel.labels.filter(Boolean) : [];
    const text = typeof sel.text === 'string' ? sel.text.trim() : '';
    const parts = text ? [...labels, text] : labels;
    if (parts.length > 0) answers[q.question] = parts.join(', ');
  });
  return answers;
}

/** 답변 제출 페이로드 — 서버 'permission' WS 메시지에 그대로 병합된다. */
export function buildQuestionAnswerPayload(input, selections) {
  return {
    behavior: 'allow',
    updatedInput: { ...(input ?? {}), answers: buildAnswers(input?.questions, selections) },
    message: null,
  };
}

/** 건너뛰기 페이로드 — allow + 빈 answers(비-오류 "did not answer" 합성). */
export function buildQuestionSkipPayload(input) {
  return {
    behavior: 'allow',
    updatedInput: { ...(input ?? {}), answers: {} },
    message: null,
  };
}

/** 제출 게이트 — 모든 질문에 라벨 또는 자유 입력이 있는가(TUI allQuestionsAnswered 미러). */
export function allAnswered(questions, selections) {
  return (questions ?? []).every((q, i) => {
    const sel = selections?.[i] ?? {};
    return (
      (Array.isArray(sel.labels) && sel.labels.length > 0) ||
      (typeof sel.text === 'string' && sel.text.trim() !== '')
    );
  });
}
