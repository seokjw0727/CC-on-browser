// 질문 다이얼로그 — AskUserQuestion을 권한 모달과 분리해 선택지 UI로 렌더한다.
// 같은 can_use_tool 채널로 오지만 이건 권한 상승이 아니라 "사용자에게 묻기"다:
// 허용/거부 대신 선택지·자유 입력·건너뛰기를 제공한다.
// 응답 형식 근거: 실 CLI v2.1.207 실측(2026-07-12) — lib/ask-user-question.js 참조.
import { useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import {
  allAnswered,
  buildQuestionAnswerPayload,
  buildQuestionSkipPayload,
} from '../lib/ask-user-question.js';
import './interact.css';

export default function QuestionDialog({ req, sessionKey, queueCount }) {
  const { send } = useStore();
  const questions = req.input.questions;
  // 질문 인덱스 → {labels: string[], text: string}
  const [selections, setSelections] = useState({});
  const [submitted, setSubmitted] = useState(false);
  // 초기 포커스는 첫 선택지 — 제출 버튼은 답변 전까지 disabled라 포커스 불가
  const firstOptRef = useRef(null);
  const dialogRef = useFocusTrap(true, firstOptRef);

  const selAt = (i) => selections[i] ?? { labels: [], text: '' };
  const selArray = questions.map((_, i) => selAt(i));
  const ready = allAnswered(questions, selArray);

  const toggleLabel = (i, label, multi) => {
    setSelections((prev) => {
      const cur = prev[i] ?? { labels: [], text: '' };
      const has = cur.labels.includes(label);
      const labels = multi
        ? has
          ? cur.labels.filter((l) => l !== label)
          : [...cur.labels, label]
        : has
          ? []
          : [label];
      // 단일 선택은 라벨/자유 입력이 상호 배타적 — 라벨 선택 시 자유 입력을 지운다.
      const text = multi ? cur.text : '';
      return { ...prev, [i]: { ...cur, labels, text } };
    });
  };

  const setText = (i, text, multi) => {
    setSelections((prev) => {
      const cur = prev[i] ?? { labels: [], text: '' };
      // 단일 선택은 자유 입력 시 기존 라벨 선택을 지운다(위 toggleLabel과 대칭).
      const labels = multi ? cur.labels : [];
      return { ...prev, [i]: { ...cur, labels, text } };
    });
  };

  const respond = (payload) => {
    if (submitted) return;
    setSubmitted(true);
    const ok = send({
      type: 'permission',
      key: sessionKey,
      requestId: req.requestId,
      ...payload,
    });
    if (!ok) setSubmitted(false); // 연결 끊김 — 재시도 가능하게
  };

  const submit = () => {
    if (ready) respond(buildQuestionAnswerPayload(req.input, selArray));
  };
  const skip = () => respond(buildQuestionSkipPayload(req.input));

  return (
    <div
      className="modal-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // 명시적 선택 강제 — 건너뛰기 버튼이 탈출구
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal q-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Claude의 질문"
      >
        <div className="modal-title">
          Claude의 질문
          <span className="spacer" />
          {queueCount > 1 && (
            <span className="perm-queue">+{queueCount - 1}건 대기 중</span>
          )}
        </div>

        <div className="modal-body">
          {questions.map((q, i) => {
            const sel = selAt(i);
            const multi = !!q.multiSelect;
            return (
              <div className="q-block" key={i}>
                <div className="q-head">
                  {q.header && <span className="q-chip">{q.header}</span>}
                  {multi && <span className="dim q-multi-note">복수 선택 가능</span>}
                </div>
                <div className="q-text">{q.question}</div>
                <div className="q-options" role="group" aria-label={q.question}>
                  {(q.options ?? []).map((opt, j) => {
                    const on = sel.labels.includes(opt.label);
                    return (
                      <button
                        key={j}
                        ref={i === 0 && j === 0 ? firstOptRef : undefined}
                        type="button"
                        className={`q-opt${on ? ' sel' : ''}`}
                        aria-pressed={on}
                        onClick={() => toggleLabel(i, opt.label, multi)}
                      >
                        <span className="q-opt-label">{opt.label}</span>
                        {opt.description && (
                          <span className="q-opt-desc dim">{opt.description}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="q-free"
                  aria-label={`직접 입력 (선택) — ${q.question}`}
                  placeholder="직접 입력…"
                  value={sel.text ?? ''}
                  onChange={(e) => setText(i, e.target.value, multi)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" disabled={submitted} onClick={skip}>
            건너뛰기
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={submitted || !ready}
            onClick={submit}
          >
            답변 보내기
          </button>
        </div>
      </div>
    </div>
  );
}
