// 권한 다이얼로그 — permission_request 큐를 순차 표시하는 모달.
// Esc로 닫히지 않음(명시적 허용/거부 강제). 입력 렌더는 ToolCard 재사용.
// 큐 앞머리가 AskUserQuestion이면 권한 프롬프트 대신 QuestionDialog로 위임한다 —
// 같은 can_use_tool 채널이지만 권한 상승이 아니라 질문이다(ask-user-question.js).
import { useEffect, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import ToolCard from './ToolCard.jsx';
import QuestionDialog from './QuestionDialog.jsx';
import { isQuestionRequest } from '../lib/ask-user-question.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import './interact.css';

// suggestion 라벨: 제안의 실제 효과를 그대로 서술한다.
// ("항상 허용" 같은 모호한 문구 금지 — 계획서 Task 8)
function destinationLabel(dest) {
  switch (dest) {
    case 'session':
      return '이 세션에만 적용';
    case 'localSettings':
      return '이 프로젝트의 내 로컬 설정에 저장';
    case 'projectSettings':
      return '이 프로젝트의 공유 설정에 저장';
    case 'userSettings':
      return '내 사용자 설정(모든 프로젝트)에 저장';
    default:
      return dest ? `적용 범위: ${String(dest)}` : null;
  }
}

function suggestionLabel(s) {
  if (!s || typeof s !== 'object') return String(s);
  const dest = destinationLabel(s.destination);

  if (s.type === 'setMode') {
    const modeDesc =
      {
        acceptEdits: '이 세션에서 파일 편집 자동 허용 (자동모드)',
        bypassPermissions: '모든 권한 확인 생략 (신뢰모드)',
        plan: '플랜모드로 변경',
        default: '기본모드로 변경',
      }[s.mode] || `권한 모드를 ${String(s.mode)}(으)로 변경`;
    return dest ? `${modeDesc} — ${dest}` : modeDesc;
  }

  if (s.type === 'addRules' && Array.isArray(s.rules)) {
    const rules = s.rules
      .map((r) =>
        r && r.ruleContent
          ? `${r.toolName}(${r.ruleContent})`
          : String(r?.toolName ?? '?'),
      )
      .join(', ');
    const behavior = s.behavior === 'deny' ? '계속 거부' : '계속 허용';
    return `도구 ${rules} ${behavior}${dest ? ` — ${dest}` : ''}`;
  }

  if (s.type === 'addDirectories' && Array.isArray(s.directories)) {
    return `디렉터리 접근 계속 허용: ${s.directories.join(', ')}${dest ? ` — ${dest}` : ''}`;
  }

  // 미지의 제안 타입 — 효과를 원문 그대로 노출
  return `제안 적용: ${JSON.stringify(s)}`;
}

// 디스패처 — 큐 앞머리 요청의 종류에 따라 질문/권한 프롬프트를 고른다.
// (자식이 각자 훅을 소유하므로 여기서 분기해도 훅 순서가 안 깨진다.)
export default function PermissionDialog() {
  const session = useActiveSession();
  // attach 리플레이가 pending 요청을 재전송할 수 있어 requestId로 dedupe
  // (해결 시 store가 같은 requestId 전부 제거하므로 표시만 정리하면 됨)
  const queue = [];
  {
    const seen = new Set();
    for (const p of session?.pendingPermissions ?? []) {
      if (p && !seen.has(p.requestId)) {
        seen.add(p.requestId);
        queue.push(p);
      }
    }
  }
  const req = queue[0] ?? null;
  if (!session || !req) return null;
  const Dialog = isQuestionRequest(req) ? QuestionDialog : PermissionPrompt;
  return (
    <Dialog
      key={req.requestId}
      req={req}
      sessionKey={session.key}
      queueCount={queue.length}
    />
  );
}

function PermissionPrompt({ req, sessionKey, queueCount }) {
  const { send } = useStore();
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  // 포커스 트랩 — 열려 있는 동안 Tab이 배경(컴포저/사이드바)으로 새지 않게 가둔다.
  const allowRef = useRef(null);
  const dialogRef = useFocusTrap(true, allowRef);

  // 다음 요청으로 넘어가면 입력 초기화
  useEffect(() => {
    setReason('');
    setChecked(new Set());
    setSubmitted(false);
  }, [req.requestId]);

  const suggestions = Array.isArray(req.suggestions) ? req.suggestions : [];

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

  const allow = () => {
    // 체크한 제안만 동봉 — CLI가 제안한 것 이상으로 범위를 넓히지 않는다.
    const updatedPermissions = suggestions.filter((_, i) => checked.has(i));
    respond({
      behavior: 'allow',
      updatedInput: req.input ?? {},
      message: null,
      ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
    });
  };

  const deny = () => {
    respond({
      behavior: 'deny',
      updatedInput: null,
      message: reason.trim() || '사용자가 거부했습니다',
    });
  };

  const toggle = (i) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div
      className="modal-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // 명시적 선택 강제 — Esc로 닫지 않음
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal perm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="도구 사용 권한 요청"
      >
        <div className="modal-title">
          권한 요청: {req.displayName || req.toolName}
          <span className="spacer" />
          {queueCount > 1 && (
            <span className="perm-queue">+{queueCount - 1}건 대기 중</span>
          )}
        </div>

        {req.description && <div className="perm-desc dim">{req.description}</div>}

        <ToolCard
          item={{
            name: req.toolName,
            input: req.input ?? null,
            inputJson: '',
            result: null,
            streaming: false,
          }}
        />

        {suggestions.length > 0 && (
          <div className="perm-suggestions">
            {suggestions.map((s, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  checked={checked.has(i)}
                  onChange={() => toggle(i)}
                />
                <span>{suggestionLabel(s)}</span>
              </label>
            ))}
          </div>
        )}

        <div className="perm-deny-row">
          <input
            type="text"
            aria-label="거부 사유 (선택)"
            placeholder="거부 사유 (선택)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                deny();
              }
            }}
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-danger" disabled={submitted} onClick={deny}>
            거부
          </button>
          <button
            ref={allowRef}
            type="button"
            className="btn-primary"
            disabled={submitted}
            onClick={allow}
          >
            허용
          </button>
        </div>
      </div>
    </div>
  );
}
