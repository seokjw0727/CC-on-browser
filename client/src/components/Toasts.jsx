// 토스트 알림 스택 — 설정 변경 확인·오류를 화면 상단에 잠시 표시하고 자동 소멸.
// 채팅 기록에는 아무것도 남기지 않는다(store.toasts가 유일한 상태).
// 클릭하면 즉시 닫힌다. 오류는 role="alert"로 스크린리더에 즉시 전달.
import { useEffect } from 'react';
import { useStore } from '../lib/store.jsx';
import './interact.css';

const TOAST_MS = { info: 3_000, error: 6_000 };

function Toast({ toast, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, TOAST_MS[toast.kind] ?? TOAST_MS.info);
    return () => clearTimeout(t);
    // onDone은 store dispatch 래퍼로 안정적 — 재무장 없이 1회 타이머면 충분
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <button
      type="button"
      className={`toast ${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      title="클릭하여 닫기"
      onClick={onDone}
    >
      <span className="toast-ico" aria-hidden="true">
        {toast.kind === 'error' ? '⚠' : 'ℹ'}
      </span>
      <span className="toast-text">{toast.text}</span>
    </button>
  );
}

export default function Toasts() {
  const { state, dispatch } = useStore();
  if (state.toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {state.toasts.map((t) => (
        <Toast
          key={t.id}
          toast={t}
          onDone={() => dispatch({ type: 'remove-toast', id: t.id })}
        />
      ))}
    </div>
  );
}
