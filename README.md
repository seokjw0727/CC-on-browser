# Claude Code on Browser

**한국어** · [English](README.en.md)

CLI 기반 Claude Code를 브라우저에서 쓰는 **로컬 전용** 웹 앱.
터미널 TUI 대신 스트리밍 마크다운 채팅, 도구 실행 카드, 권한 다이얼로그, 세션 재개 UI를 제공합니다.

**SDK/API를 사용하지 않습니다.** `@anthropic-ai/sdk`, `claude-agent-sdk` 없이,
로컬에 설치된 `claude` CLI를 자식 프로세스로 구동합니다. 인증과 과금은 전적으로 사용자의
Claude 구독(예: Claude Max)을 따르며, API 키가 필요 없습니다. 단 하나의 예외로, 상태줄의
공식 사용률(%)은 CLI가 저장한 구독 OAuth 토큰으로 api.anthropic.com의 사용량 메타데이터
endpoint 하나만 조회해 얻습니다 — 모델 호출이 아니므로 과금이 없습니다.

## 무엇을 제공하나요

- **스트리밍 마크다운 채팅** — 부분 메시지(`--include-partial-messages`)를 실시간 렌더. delta 덩어리를 그대로 그리지 않고 프레임 단위 페이서로 부드럽게 드러냄(타자기식, reduced-motion 존중). 코드 하이라이트(highlight.js) + XSS 정화(DOMPurify).
- **도구 실행 카드** — Bash·Edit·Write·Read·Grep 등 도구 호출을 입력/결과 카드로, 긴 결과는 접기.
- **사고(thinking) 블록** — 확장 사고 스트림을 별도 블록으로 표시.
- **권한 다이얼로그** — `can_use_tool` 요청을 모달로 띄워 허용/거부. 제안(suggestion)은 "항상 허용" 같은 모호한 문구 대신 실제 효과를 그대로 서술. 새 세션의 기본 권한 모드는 **신뢰모드(bypassPermissions)** — 새 세션 모달·컴포저에서 언제든 바꿀 수 있고, 다이얼로그는 확인이 필요한 모드에서 동작합니다. 모드는 기본모드(무색)·자동모드(파랑)·플랜모드(초록)·신뢰모드(빨강)로 색을 구분해 표시합니다.
- **세션 재개** — 현재 프로젝트의 과거 세션 목록에서 트랜스크립트를 불러와 이어가기(`--resume`).
- **작업 디렉터리 지정** — 새 세션 모달에서 경로를 직접 입력·붙여넣고, 그 아래 하위 폴더 트리에서 클릭으로 선택.
- **상태줄(statusline)** — 세션 컨텍스트(모델 창 대비 — 기본 200k, `[1m]` 모델은 1M)와 계정의 공식 5시간·7일 사용률(%)을 원형
  게이지로 표시. 컨텍스트는 API 호출별 usage(입력+캐시)의 마지막 값 기준 — result의 턴 합산
  usage는 도구 왕복 수만큼 부풀어 쓰지 않습니다. 공식 수치는 `/usage` 패널과 동일하고, 로컬
  트랜스크립트 집계는 툴팁 참고치로 제공.
  턴별 토큰 입/출력은 상태줄이 아니라 CLI처럼 채팅에 작은 꼬리표(`↑ 12 ↓ 345 tok · 5.3s`)로 남습니다.
- **런타임 컨트롤** — claude.ai식 모델 피커(Haiku 4.5 / Sonnet 5 / Opus 4.8 / Fable 5 — 버전·설명 표기)와
  노력 수준 진행 바(low~max, `--effort`가 시작 시 전용이라 변경 시 같은 대화로 재시작 — 대화가 디스크에
  있으면 `--resume`, 첫 턴 전이면 새로 시작), 권한 모드 전환, `/` 슬래시 커맨드 자동완성, 턴 중단(Esc).
  설정 변경 확인과 오류는 채팅 기록에 남지 않고 **토스트 알림**으로 잠시 표시된 뒤 사라집니다.
- **컴포저 중심 UI** — 상단 바 없이 입력창 한 곳에 레포·권한모드·모델·전송·사용량을 접어 넣은 레이아웃. 라이트/다크 테마, 외부 폰트·이미지 의존 0(브랜드 자산은 자체 내장 SVG — 로컬 CSP 안전).
- **살아있는 마스코트(CLAW'D)** — 컴포저 우측 하단에 실제 Claude Code CLI에 내장된 공식 아트를
  그대로 옮긴 CLAW'D(주황 몸통 rgb(215,119,87)·검정 눈, 쿼드런트 픽셀)가 세션 상태에 반응합니다
  (무드 어휘는 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)의 상태 매핑을 축소 이식):
  대기 중 깜박임 + **커서를 따라가는 눈**, 응답 생성 중 말풍선(점 3개), 도구 실행 중 좌우 두리번 스캐틀,
  서브에이전트(Task) 실행 중 집게 들고 저글링, 권한 응답 대기 시 집게 들고 폴짝(공식 arms-up 포즈),
  턴이 끝나면 환호(에러면 어지럼 — 직접 중단한 턴은 제외), 60초 무입력이면 zzz와 함께 잠들고 입력에 깨어나며,
  세션 없음·연결 끊김엔 졸기. 클릭하면 움찔, 빠르게 4연타하면 어지럼(이스터에그). 전부 자체 SVG
  프레임 스왑 + CSS (`prefers-reduced-motion` 존중, 외부 이미지 0).

## 요구사항

- Windows / macOS / Linux + Node.js 22 이상
- [Claude Code CLI](https://claude.com/claude-code) 설치 및 **로그인 완료** (`claude` 실행 → `/login`)
  - 이 앱은 CLI의 인증 상태를 그대로 사용합니다. CLI에서 로그인돼 있지 않으면 세션 시작이 실패합니다.

## 설치 / 실행

### A. 패키지로 설치 (빌드 불필요)

[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases)에서 `cc-on-browser-<버전>.tgz`를 받아 전역 설치합니다:

```sh
npm install -g ./cc-on-browser-1.1.0.tgz
cc-on-browser                # 기본 포트 8787 (PORT 환경변수로도 변경 가능)
cc-on-browser --port 9000    # 포트 지정 (-p), --help 로 전체 옵션 확인
```

### B. 소스에서 실행

```sh
git clone https://github.com/seokjw0727/CC-on-browser.git
cd CC-on-browser
npm run install:all   # 루트(서버)·client/ 의존성 설치
npm run build         # client → client/dist
npm start             # = node bin/cc-on-browser.mjs
```

기동하면 콘솔에 접속 URL이 출력됩니다:

```
Claude Code on Browser v1.1.0 — http://127.0.0.1:8787/#token=<랜덤토큰>
```

이 URL(토큰 포함)로 브라우저에서 접속하세요. `claude` CLI를 찾지 못하면 설치·PATH 안내 경고가
출력됩니다(서버는 뜨지만 세션 시작은 실패).

**CLI 경로 해석 순서**: `CLAUDE_WEB_CLI_PATH` 환경변수(설정 시) → OS `PATH`의 `claude`(Windows는
`claude.exe`). `claude`가 PATH에 있으면 추가 설정이 필요 없고, 특이한 위치에 설치했다면
`CLAUDE_WEB_CLI_PATH`로 절대 경로를 지정하세요.

### 구독 소모 없는 데모 (fake CLI)

실제 CLI 대신 프로토콜을 모사하는 가짜 CLI로 전체 스택을 띄워볼 수 있습니다:

```sh
node scripts/dev-fake.mjs                       # echo 시나리오 (기본 포트 8788)
node scripts/dev-fake.mjs --scenario permission # 권한 다이얼로그 시나리오 (모든 셸 공통)
```

환경변수를 선호하면 POSIX 셸은 `FAKE_SCENARIO=permission node scripts/dev-fake.mjs`,
PowerShell은 `$env:FAKE_SCENARIO='permission'; node scripts/dev-fake.mjs` 로도 동일하게 동작합니다.

테스트도 전부 fake CLI로만 동작하므로 구독을 소모하지 않습니다: `npm test`

## 아키텍처

```
브라우저 (SPA: Vite + React)
   │  WebSocket + REST (127.0.0.1, 토큰 인증, Origin 검증)
   ▼
Node 서버 (server/src/server.js — http + ws)
   ├─ static: client/dist 서빙
   ├─ REST: /api/bootstrap /api/projects /api/sessions /api/transcript /api/browse /api/usage
   └─ SessionHub ── ClaudeSession (세션당 CLI 프로세스 1개, 이벤트 링버퍼 리플레이)
         │  spawn (stdio pipe, JSONL)
         ▼
      claude -p --input-format stream-json --output-format stream-json
             --verbose --include-partial-messages --permission-prompt-tool stdio
             [--resume <id>] [--model <m>] [--permission-mode <mode>] [--effort <level>]
             (cwd = 선택한 프로젝트)
```

- 도구 권한 요청(`can_use_tool`)은 stdio로 서버에 전달되고, 브라우저의 권한 다이얼로그에서
  허용/거부를 결정해 CLI에 회신합니다.
- 스폰된 CLI는 사용자의 훅·스킬·설정을 그대로 로드합니다 — 브라우저 UI는 실제 CLI 환경의 전면부입니다.
- 미문서 CLI 프로토콜 지식은 `server/src/claude-session.js` 한 모듈에 격리돼 있습니다.

## 프로젝트 구조

```
bin/cc-on-browser.mjs  CLI 진입점 — 인자 파싱·사전 점검 후 서버 기동 (npm start·전역 설치 공용)
server/src/
  server.js          HTTP(REST + 정적 서빙) + WebSocket 허브. 127.0.0.1 전용, 토큰·Origin 인증
  session-hub.js     세션 레지스트리 — 키↔ClaudeSession, 이벤트 브로드캐스트/리플레이 중계
  claude-session.js  CLI 자식 프로세스 1개 래핑 — stream-json 송수신, 미문서 프로토콜 격리
  history.js         ~/.claude 프로젝트·세션·트랜스크립트 읽기 (세션 재개용)
  usage.js           ~/.claude 트랜스크립트 로컬 집계 — 5h/7d 참고치 (/api/usage)
  quota.js           계정 공식 사용률(5h/7d %) — CLI의 OAuth 토큰 사용, 유일한 api.anthropic.com 접점
  fs-api.js          디렉터리 나열(/api/browse) — 파일 내용은 미제공
  jsonl.js           라인 단위 JSON 파서
client/src/
  App.jsx            셸 레이아웃·테마 소유
  lib/               store.jsx(상태) · ws.js(자동 재접속) · reduce-cli-event.js(CLI 이벤트→상태) · markdown.js · api.js
  components/        Sidebar · Composer · ChatView · Message · ToolCard · ThinkingBlock · PermissionDialog · Toasts · Clawd · Brand
scripts/dev-fake.mjs 구독 미소모 데모 런처(fake CLI)
server/test/         fake CLI 기반 통합·단위 테스트 (실제 claude 미실행)
docs/superpowers/    스펙·플랜 문서
```

## 보안 주의

- 서버는 `127.0.0.1`에만 바인드됩니다. **원격 노출(포트포워딩, 리버스 프록시)을 하지 마세요** —
  이 앱은 사용자의 파일시스템과 셸에 접근할 수 있는 CLI를 구동합니다.
- 기동 시 생성되는 랜덤 토큰이 URL fragment(`#token=`)로 전달됩니다. 이 URL을 공유하지 마세요.
  WS는 `?token=` 쿼리, REST는 `x-auth-token` 헤더로 재전송해 검증하며, Origin 헤더도 검증합니다.
- 파일시스템 API(`/api/browse`)는 디렉터리 나열만 제공합니다. 파일 내용 접근은 CLI 도구 경유 +
  권한 다이얼로그로 통제됩니다.

## 제한 사항 (v1 범위 밖)

이미지 첨부, 서브에이전트 트리 시각화, MCP 서버 관리 UI, PTY 터미널 탭,
다중 브라우저 클라이언트 동시 접속 동기화, 원격(비 localhost) 접근.

## 프로토콜 경고

stream-json 제어 프로토콜(`--permission-prompt-tool stdio` 포함)은 **공식 미문서 인터페이스**입니다
(CLI v2.1.201에서 실측 검증). CLI 업데이트로 형식이 바뀔 수 있으며, 알 수 없는 메시지는 버리지 않고
raw 이벤트로 UI에 전달되도록 설계돼 있습니다. 프로토콜 변경이 의심되면
`docs/superpowers/specs/2026-07-06-claude-code-on-browser-design.md`의 프로브 절차로 재검증하세요.

## 라이선스

[MIT](LICENSE)
