// 권한 모드 셀렉트 — 메인 영역 우측 상단에 떠 있는 단독 컨트롤.
// 원래 컴포저 상단 pill 행에 있었으나, 입력창은 "지금 무엇을 보낼까"만 담고
// 세션 설정은 화면 상단에 상주하도록 분리했다. 스토어에서 직접 읽으므로
// App.jsx는 위치만 잡아 주고 props를 흘려보내지 않는다.
import { useStore, useActiveSession } from '../lib/store.jsx';
import { MODES, MODE_LABEL, MODE_CLASS } from '../lib/permission-modes.js';
import Icon from './Icon.jsx';

export default function PermissionModeBar() {
  const { state, dispatch, send, notify } = useStore();
  const session = useActiveSession();
  if (!session) return null;

  const live = session.status !== 'exited';

  // 낙관적 UI 갱신은 전송이 성공했을 때만 — 끊긴 상태에서 바꾸면 CLI에 전달되지
  // 않는데 UI만 바뀌어 권한 모드가 desync된다. 변경 확인은 채팅이 아니라 토스트로.
  const changeMode = (mode) => {
    if (!mode) return;
    // 신뢰모드는 스폰 시에만 진입 가능(서버가 권위 경계) — UI에서도 미리 막고 안내.
    // 신뢰모드로 스폰된 세션의 복귀만 허용한다.
    if (mode === 'bypassPermissions' && session.spawnPermissionMode !== 'bypassPermissions') {
      notify('신뢰모드는 세션 시작 시에만 설정할 수 있습니다', 'error');
      return;
    }
    if (!send({ type: 'setPermissionMode', key: session.key, mode })) return;
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, permissionMode: mode }) });
    notify(`권한 모드 변경: ${MODE_LABEL[mode] ?? mode}`);
  };

  return (
    <span className="pill-select-wrap perm-mode-float">
      <select
        aria-label="권한 모드"
        className={`pill-select ${MODE_CLASS[session.permissionMode] ?? ''}`.trim()}
        value={session.permissionMode || 'default'}
        disabled={!live || state.conn !== 'open'}
        data-tip="권한 모드 (setPermissionMode)"
        onChange={(e) => changeMode(e.target.value)}
      >
        {MODES.filter(
          (m) =>
            m !== 'bypassPermissions' ||
            session.spawnPermissionMode === 'bypassPermissions' ||
            // 표시 정합성 폴백 — CLI가 현재 모드를 신뢰로 보고 중이면
            // 옵션을 남겨 select가 빈 값으로 렌더되지 않게 한다(진입은 changeMode가 차단).
            session.permissionMode === 'bypassPermissions',
        ).map((m) => (
          <option key={m} value={m}>
            {MODE_LABEL[m]}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={10} className="pill-select-caret" />
    </span>
  );
}
