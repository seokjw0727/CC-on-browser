// Claude Code Config 편집기 — ~/.claude/settings.json 원문을 그대로 고치는 모달.
//
// 설정 모달(FootModal)의 **형제**로 렌더된다(중첩 금지: 두 포커스 트랩이 서로
// 간섭하지 않게 — 새 세션 모달 ↔ 삭제 확인 모달과 같은 패턴). 아래 레이어를 inert로
// 잠그는 일은 부모(Sidebar)가 맡는다.
//
// 저장 규칙:
//  · 보낼 내용은 사용자가 친 원문 그대로다(들여쓰기·키 순서 보존 — 우리가 다시
//    직렬화하면 남의 파일을 마음대로 재포맷하는 셈이 된다).
//  · 저장 전에 클라이언트에서 먼저 JSON.parse로 검증한다(서버도 다시 검증한다).
//  · 기준선(mtimeMs)은 로드 시각의 것이고, 저장에 성공하면 응답의 새 값으로 갈아
//    끼운다 — 그러지 않으면 두 번째 저장이 자기 자신과 충돌한다.
//  · 409(다른 곳에서 수정됨)는 덮어쓰지 않고 "다시 불러오기"를 안내한다.
import { useEffect, useRef, useState } from 'react';
import { fetchClaudeConfig, saveClaudeConfig } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';

export default function ConfigEditorModal({ presenceStatus, restoreRef, onClose, notify }) {
  const dialogRef = useFocusTrap(true, undefined, restoreRef);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState(''); // 마지막으로 로드/저장한 내용
  const [mtimeMs, setMtimeMs] = useState(null); // 저장에 쓸 기준선
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null); // 인라인 오류(JSON 문법·저장 실패)
  const [conflict, setConflict] = useState(false);
  // 요청 세대 — 닫혔다 다시 열리거나 "다시 불러오기"를 누른 뒤 늦게 도착한 응답이
  // 현재 편집 내용을 덮어쓰지 못하게 한다.
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  // StrictMode(개발)는 마운트 직후 정리→재설정을 한 번 흉내 낸다. 정리에서 false로만
  // 두면 그 뒤의 응답이 전부 폐기돼 "불러오는 중…"에서 멈춘다 — 설정에서 다시 켠다.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  // 저장하지 않은 변경이 있는 채로 닫으려 했는가 — 한 번 더 확인받는다.
  const [confirmingClose, setConfirmingClose] = useState(false);

  const load = async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    setConflict(false);
    try {
      const res = await fetchClaudeConfig();
      if (!aliveRef.current || genRef.current !== gen) return;
      setPath(res.path || '');
      setText(res.content ?? '{}');
      setBaseline(res.content ?? '{}');
      setMtimeMs(res.mtimeMs ?? null);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      setLoadError(String(err.message ?? err));
    } finally {
      if (aliveRef.current && genRef.current === gen) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = text !== baseline;

  const save = async () => {
    if (saving || !dirty) return;
    try {
      JSON.parse(text);
    } catch (err) {
      setError(`JSON 문법 오류: ${err.message}`);
      return;
    }
    const gen = genRef.current;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const res = await saveClaudeConfig({ content: text, expectedMtimeMs: mtimeMs });
      if (!aliveRef.current || genRef.current !== gen) return;
      // 새 기준선으로 갈아 끼운다 — 모달을 열어 둔 채 이어서 저장할 수 있게.
      setMtimeMs(res.mtimeMs ?? null);
      setBaseline(text);
      setConflict(false);
      setConfirmingClose(false); // 저장했으니 "저장하지 않은 변경" 경고는 유효하지 않다
      notify?.('Claude Code 설정을 저장했습니다. 이후 시작되는 세션부터 적용됩니다.');
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      if (err?.status === 409) {
        setConflict(true);
        setError('다른 곳에서 파일이 바뀌었습니다. 덮어쓰지 않았습니다 — 다시 불러온 뒤 편집하세요.');
      } else {
        setError(String(err.message ?? err));
      }
    } finally {
      if (aliveRef.current && genRef.current === gen) setSaving(false);
    }
  };

  // 저장 중에는 닫기를 막는다 — 진행 중 사라지면 결과를 알 수 없다.
  // 저장하지 않은 편집이 있으면 첫 시도는 경고만 띄우고 닫지 않는다(Esc·배경 클릭·✕
  // 어느 쪽으로 왔든 동일) — 텍스트를 통째로 잃는 사고를 막는다.
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  return (
    <div
      className={`modal-overlay config-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          requestClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Claude Code Config 편집"
      >
        <div className="modal-title">
          Claude Code Config
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            disabled={saving}
            aria-label="닫기"
            data-tip="닫기"
          >
            ✕
          </button>
        </div>

        <div className="modal-body config-body">
          <div className="config-path dim truncate" data-tip={path || undefined}>
            {path || '경로를 불러오는 중…'}
          </div>

          <div className="mode-warning">
            ⚠ 이 파일은 Claude Code CLI 전체의 설정입니다. 저장한 내용은 이 앱 밖에서
            시작되는 세션에도 적용되며, 이미 실행 중인 세션에는 반영되지 않습니다.
            JSON 문법만 검사하므로, 값이 잘못됐거나 권한을 넓히는 설정은 걸러지지 않습니다.
          </div>

          {/* 비동기 상태(로딩·실패)는 시각 표시만으로 전달되지 않는다 — 라이브 영역으로. */}
          <div role="status">
            {loading && <span className="dim foot-note">불러오는 중…</span>}
            {loadError && (
              <span className="past-note past-note-error">
                <span className="dim">설정을 불러오지 못했습니다: {loadError}</span>
                <button type="button" className="past-retry" onClick={load}>
                  다시 시도
                </button>
              </span>
            )}
          </div>

          {!loading && !loadError && (
            <textarea
              className="config-text"
              value={text}
              spellCheck={false}
              autoComplete="off"
              aria-label="settings.json 내용"
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
                // 내용을 고치는 순간 이전 결과(충돌·닫기 확인)는 더 이상 유효하지 않다
                setConflict(false);
                setConfirmingClose(false);
              }}
            />
          )}

          {/* 오류·충돌은 role=alert로 — 시각 표시만으로는 전달되지 않는다. */}
          {error && (
            <div className="sidebar-error" role="alert">
              {error}
              {conflict && (
                <button type="button" className="past-retry" onClick={load}>
                  다시 불러오기
                </button>
              )}
            </div>
          )}

          {confirmingClose && (
            <div className="sidebar-error" role="alert">
              저장하지 않은 변경이 있습니다. 그대로 닫으면 편집 내용이 사라집니다.
              {/* 저장 중에는 이 길도 막는다 — 진행 중인 저장의 결과를 못 보고 닫히는 건
                  ✕·Esc를 막아 둔 이유와 같다. */}
              <button type="button" className="past-retry" disabled={saving} onClick={onClose}>
                변경 버리고 닫기
              </button>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={requestClose} disabled={saving}>
            닫기
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={saving || loading || !!loadError || !dirty}
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
