# 세션 트리 통합 + 자연스러운 모션 — 설계

- 작성일: 2026-07-08
- 대상: `client/` (React 19 SPA). **서버 API·스트림 프로토콜·store 리듀서 변경 없음.**
- 선행: `2026-07-06-claude-code-on-browser-design.md`(초기 설계), UI 재설계(컴포저 중심)·모달 포커스 트랩 작업 이후.

## 목표

1. 사이드바의 '열린 세션 / 최근 세션' 분리 구조를 **현재 세션 중심의 통합 디렉토리 트리**로 재구성.
2. 화면전환·반응형 등 **자연스러운 모션**을 절제된 톤으로 추가.

## 확정 결정

- **세션 트리 = 현재 세션 핀 고정**: 활성 세션의 디렉토리를 상단에 박스로 고정·자동 펼침, 나머지 디렉토리는 접어서 아래.
- **모션 톤 = 절제·빠름(A)**: 120–220ms, `ease-out`, 페이드 + 짧은 슬라이드. 오버슈트/스프링 없음.
- **구현 = 순수 CSS**: 새 의존성 0, CSP 안전(무 CDN). 모션 라이브러리·View Transitions API 미사용.
- **접근성**: `prefers-reduced-motion: reduce`에서 모션 전역 축소.
- **불변**: 서버 REST/WS API, CLI 프로토콜, store 리듀서 스키마.

---

## 1. 세션 내비게이션 재구성

### 1.1 데이터 모델 (Sidebar에서 파생 — store 변경 없음)

- 소스 둘을 클라이언트에서 **cwd(디렉토리) 단위**로 병합:
  - 라이브: `state.sessions`(열린 세션, `cwd`·`status`·`sessionId` 보유)
  - 히스토리: `state.projects`(`fetchProjects`) + 디렉토리 펼칠 때 `fetchSessions`(재개 가능 세션)
- **식별·dedupe 규칙** (라이브 세션의 초기 `sessionId`는 CLI 이벤트 도착 전까지 null일 수 있음에 유의):
  - 라이브 세션은 hub `key`로 식별하고 항상 별도 행으로 표시 — `sessionId`가 null이어도 서로 절대 합치지 않음(같은 디렉토리의 여러 라이브 세션이 하나로 뭉치는 버그 방지).
  - 히스토리 세션은 `sessionId`로 식별.
  - 병합: 히스토리 행 중 **재개된 라이브 세션과 같은 non-null `sessionId`** 를 가진 것만 숨김(라이브가 대체). `sessionId`가 null인 라이브와는 매칭하지 않음.
- 디렉토리 정렬: ① 활성 세션의 디렉토리 → ② 라이브 세션이 있는 다른 디렉토리 → ③ 히스토리 전용 디렉토리, 각 그룹 내 최근성 순.

### 1.2 레이아웃

```
┏━ 현재 세션 ━━━━━━━━━━━━━┓
┃ 📁 ClaudeCode on Browser    ┃   ← 활성 세션 디렉토리: 상단 고정·자동 펼침·강조 박스
┃   ● …\myapp   · 생각 중  ✕ ┃   ← 활성 세션(하이라이트) + status 배지 + 종료(✕)
┃   ○ 어제 리팩터링  · 재개    ┃   ← 같은 디렉토리의 재개 가능 세션
┗━━━━━━━━━━━━━━━━━━━━┛
다른 프로젝트                  ↻
▸ 📁 Leave Fable         (2)      ← 접힘. 펼치면 라이브(●)+히스토리(○) 함께
▸ 📁 convanytoany        (5)
```

### 1.3 노드 동작

- **디렉토리 헤더**: 펼침/접힘(▸/▾), 세션 수 배지, cwd 축약 표시. 활성 디렉토리는 상단 고정 + 기본 펼침 + 강조 박스. 접힌 디렉토리에 라이브 세션이 있으면 헤더에 `●` 표식으로 활성 위치를 인지 가능하게.
- **세션 행**: 라이브(`●`, status 배지, 종료 `✕`) / 히스토리(`○`, "재개", 시각). 활성 세션은 배경 하이라이트.
- **유지**: 브랜드 헤더, "새 세션" 버튼, 계정 칩, 새로고침(↻).

### 1.4 빈 상태

- 활성 세션 없음 → 핀 박스 숨김, "다른 프로젝트"만 표시.
- 프로젝트도 없음 → 기존 마스코트 빈 상태 유지.

### 1.5 영향 파일

- 신규 `client/src/lib/sessionTree.js` — 라이브+히스토리 병합·정렬·dedupe 순수 함수(격리·테스트 가능).
- `client/src/components/Sidebar.jsx` — 트리 재구성(주요), `sessionTree.js` 소비.
- `client/src/components/interact.css` — 핀 박스·디렉토리 헤더·세션 행·펼침 스타일.

---

## 2. 모션 시스템

### 2.1 토큰 (`theme.css`)

```css
--ease-out: cubic-bezier(.2, 0, 0, 1);   /* 절제된 감속 */
--dur-micro: 90ms;
--dur-fast:  120ms;
--dur-base:  180ms;
--dur-slow:  220ms;
```

모든 전환·애니메이션은 이 토큰을 참조(일관성·조정 용이). 스프링/오버슈트 없음.

### 2.2 애니메이션 카탈로그 (엄선)

| # | 표면 | 모션 | 파라미터 |
|---|------|------|----------|
| 1 | 세션/뷰 전환(화면전환) | 컨테이너 페이드+상승(자식 remount 아님) | opacity 0→1 + translateY(6px→0), `--dur-base`, activeKey 변경 시 enter 클래스 재적용 |
| 2 | 사이드바 접기/펼치기 | 폭 전환 + 내용 페이드 | grid-columns transition `--dur-slow`; reopen 버튼 페이드 |
| 3 | 디렉토리 펼침/접힘 | 세션 행 높이+투명도, 캐럿 회전 | grid-rows 0fr→1fr + opacity `--dur-base`; ▸→▾ rotate `--dur-fast` |
| 4 | 핀/활성 전환 | 핀 박스 강조 페이드(테두리/배경) | 200ms; 재정렬 FLIP 없음 |
| 5 | 메시지 등장 | 페이드+상승 | opacity + translateY(8px→0), `--dur-base`, **새로 추가된 메시지에만**(세션 전환 시 재생 안 함) |
| 6 | 도구 카드 등장·결과 펼침 | 카드 페이드+상승, 결과 높이 전개 | `--dur-base` / `--dur-fast` |
| 7 | 모달 개폐 | 배경 페이드 + 다이얼로그 scale(.98→1)+상승 | `--dur-fast`~`--dur-base`, 개·폐 모두 |
| 8 | 버튼·pill 마이크로 | press 축소, hover 전환 | `:active` scale(.97) `--dur-micro` |

### 2.3 leave(닫힘) 처리

- 대부분은 **enter-only**로 충분(세션 전환·리스트 항목).
- **NewSessionModal만** `usePresence(isOpen)` 훅으로 닫힐 때 ~140ms 유지 후 페이드아웃(불리언 `newSessionOpen`으로 마운트/언마운트가 깔끔).
- **PermissionDialog은 leave 애니메이션 미적용**(닫힘은 즉시 언마운트). 강제 결정 모달이자, 직전에 고친 '권한 대기 중 프로세스 종료 시 모달 자동 종료'(pendingPermissions clear)와 포커스 트랩/복원 타이밍을 건드리지 않기 위함. 닫힘 애니메이션이 필요하면 마지막 req/세션을 closing 동안 보존하고 포커스 복원을 언마운트 시점으로 미루는 별도 설계가 필요 — **이번 범위 밖**.

### 2.4 접근성 — reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
```

무한 pulse/blink는 1회로 수렴. 포커스·기능성 피드백은 유지(직전 a11y 기조 계승).

### 2.5 성능

- 대부분 `transform`/`opacity` 사용. **예외**: 사이드바 접기(`grid-template-columns`)·디렉토리 펼침(`grid-template-rows`)은 레이아웃 트랙 크기를 애니메이트한다 — 작고 드물고 국소적이라 허용하되 "리플로우 없음"으로 과장하지 않는다(필요 시 tree 펼침을 `transform`/`clip-path` 기법으로 대체 가능). `will-change`는 전환 중에만 적용.

### 2.6 영향 파일

- `theme.css`(토큰·reduced-motion·공용 keyframes), `chat.css`·`interact.css`(표면별 적용), `App.jsx`·`ChatView.jsx`(뷰 전환 컨테이너 클래스·새 메시지 게이팅), 신규 `client/src/lib/usePresence.js`, `Sidebar.jsx`(usePresence로 NewSessionModal leave·트리), `Message.jsx`·`ToolCard.jsx`(등장 클래스).

---

## 3. 구현 상세

### 3.1 뷰 전환

ChatView 전체를 remount하지 **않는다**(모든 메시지 등장 애니메이션 재생·스크롤 리셋 방지). 대신 `activeKey` 변경 시 컨테이너에 enter 클래스를 재적용(effect에서 클래스 제거→강제 reflow→추가)해 **패널만** 페이드+상승. 메시지 등장 애니메이션은 **새로 추가된 메시지에만** 적용(초기 렌더·세션 전환 시 기존 메시지는 애니메이션 없음) — 메시지별 '표시됨' 마커 또는 append 감지로 게이팅. 스크롤은 세션의 기존 자동 하단 스크롤 동작 유지.

### 3.2 `usePresence(isOpen, duration)` 훅 (신규, 무의존)

- 반환: `{ mounted, status }`. `status`는 `'open' | 'closing'`.
- `isOpen`이 false로 바뀌면 `duration`(≈140ms) 동안 `mounted`를 유지하고 `status='closing'` → 소비 측이 `.closing` 클래스로 페이드아웃 후 언마운트.
- 소비: **NewSessionModal만**(§2.3). PermissionDialog은 leave 애니메이션을 쓰지 않는다.

### 3.3 트리 펼침

`grid-template-rows: 0fr → 1fr` + opacity 전환(JS 높이 계산 불필요, 순수 CSS).

### 3.4 엣지 케이스

- reduced-motion: 전역 축소(2.4) — 모든 표면 즉시 상태로.
- 라이브+히스토리 `sessionId` dedupe. 활성 세션에 히스토리 없을 때 핀 박스는 라이브만.
- 사이드바 접힘 중 모달 오픈: 모달은 형제로 렌더(직전 수정 유지)라 영향 없음.
- 포커스 트랩(직전 작업)과 모달 leave: NewSessionModal은 `closing` 종료(언마운트) 시 트랩 해제·포커스 복원. PermissionDialog은 즉시 언마운트라 기존 트랩/복원 동작 그대로.

### 3.5 검증

- 서버 변경 없음 → `npm test` 38/38 유지 확인.
- `npm run build --prefix client` 통과 확인.
- **Brave 실측**(fake-cli): ① 통합 트리(핀 고정+펼침) ② 세션 전환 페이드 ③ 사이드바 접기 ④ 모달 개·폐 ⑤ 메시지·도구카드 등장 ⑥ `prefers-reduced-motion` 에뮬레이션 시 축소. 스크린샷/상태 캡처로 증거화.
- 클라이언트 단위 테스트 하니스는 없음(`store.jsx`가 JSX 포함) → 빌드 + 브라우저 실측으로 검증(직전 작업과 동일 기조). 순수 함수인 트리 병합 로직(`sessionTree.js`)은 JSX가 없어 `node --test`로 단위 테스트 가능 → 병합·정렬·dedupe 규칙에 테스트 추가.

### 3.6 범위 밖 (YAGNI)

- 스프링 물리·모션 라이브러리·전체 FLIP 재정렬·라우트 전환·서버/프로토콜 변경.
