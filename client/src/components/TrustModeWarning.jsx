// 신뢰모드(bypassPermissions) 선택 시의 공통 경고.
//
// 세 곳이 함께 쓴다: 새 세션 모달 · 설정 패널의 "기본 권한 모드" · Config 편집기의
// permissions.defaultMode. Sidebar.jsx 안에 두면 ConfigEditorModal이 Sidebar를
// 거꾸로 import해야 해서(Sidebar → ConfigEditorModal이 이미 있다) 순환이 된다 —
// 그래서 독립 파일이다.
import Icon from './Icon.jsx';

export default function TrustModeWarning() {
  return (
    <div className="mode-warning">
      <Icon name="warning" className="ico-danger" /> 신뢰모드(bypassPermissions): 모든 도구가 확인 없이 실행됩니다. 파일
      수정·명령 실행이 즉시 반영되므로 신뢰할 수 있는 작업에만 사용하세요.
    </div>
  );
}
