// 모달 leave 애니메이션용 존재(presence) 훅.
// isOpen이 false로 바뀌면 duration 동안 mounted를 유지하며 status='closing' →
// 소비 측이 .closing 클래스로 페이드아웃 후 언마운트.
import { useEffect, useRef, useState } from 'react';

export function usePresence(isOpen, duration = 140) {
  const [state, setState] = useState(() => ({
    mounted: isOpen,
    status: isOpen ? 'open' : 'closed',
  }));
  const timerRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setState({ mounted: true, status: 'open' });
      return undefined;
    }
    // 닫힘 시작
    setState((s) => (s.mounted ? { mounted: true, status: 'closing' } : s));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState({ mounted: false, status: 'closed' });
    }, duration);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isOpen, duration]);

  return { mounted: state.mounted, status: state.status };
}
