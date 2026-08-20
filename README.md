# Claude Code on Browser

**한국어** · [English](README.en.md)

CLI 기반 Claude Code를 브라우저에서 쓰는 **로컬 전용** 웹 앱.
터미널 TUI 대신 스트리밍 마크다운 채팅, 도구 실행 카드, 권한 다이얼로그, 세션 재개 UI를 제공합니다.

**SDK/API 키를 사용하지 않습니다.** 로컬에 설치된 `claude` CLI를 자식 프로세스로 구동하므로
인증과 과금은 전적으로 사용자의 Claude 구독(예: Claude Max)을 따릅니다. 단 하나의 예외로,
상태줄의 공식 사용률(%)은 CLI가 저장한 구독 OAuth 토큰으로 api.anthropic.com의 사용량
메타데이터 endpoint 하나만 조회해 얻습니다 — 모델 호출이 아니므로 과금이 없습니다.

## 빠른 시작

**필요한 것** — ① Windows / macOS / Linux + [Node.js](https://nodejs.org) 22 이상
② [Claude Code CLI](https://claude.com/claude-code) 설치 + **로그인 완료**
(터미널에서 `claude` 실행 → `/login`).

[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases)에서
`cc-on-browser-<버전>.tgz`를 받아 전역 설치하면 끝입니다 (빌드 불필요):

```sh
npm install -g ./cc-on-browser-<버전>.tgz
cc-on-browser
```

실행하면 접속 URL을 출력한 뒤 **기본 브라우저가 자동으로 열리고, 서버는 콘솔 창 없이
백그라운드로** 돌아갑니다. 브라우저 탭을 모두 닫으면 약 10초 뒤 서버가 스스로 종료되므로
따로 끌 필요가 없습니다.

```
Claude Code on Browser v1.8.0 — http://127.0.0.1:8787/#token=<랜덤토큰>
Opening your browser... The server runs in the background (127.0.0.1 only)
and stops automatically once every tab is closed. (--no-open for a foreground server)
claude CLI: 2.1.215 (Claude Code)
```

자주 쓰는 옵션:

```sh
cc-on-browser --port 9000    # 포트 지정 (-p)
cc-on-browser --no-open      # 브라우저 없이 포그라운드 콘솔 서버 (Ctrl+C로 종료)
cc-on-browser --shortcut     # (Windows) 콘솔 없이 실행되는 바로가기 생성
cc-on-browser --help         # 전체 옵션
```

### 콘솔 창 없이 실행하기 (Windows)

Win+R이나 탐색기에서 `cc-on-browser`를 실행하면 명령 프롬프트 창이 1~3초 떴다가
사라집니다. npm이 만든 `cc-on-browser.cmd`가 실행되는 순간 이미 콘솔이 생기기
때문에 그 창은 앱이 숨길 수 없습니다. **한 번만** 아래를 실행해 두세요:

```sh
cc-on-browser --shortcut
```

바탕화면과 시작 메뉴에 **"Claude Code on Browser"** 바로가기가 생기고, 그걸로
실행하면 **콘솔 없이 브라우저만** 뜹니다(내부적으로 `wscript.exe`가 창 숨김으로
서버를 띄웁니다). Node를 재설치해 경로가 바뀌면 `--shortcut`을 다시 실행하세요.

### 이미 실행 중일 때 다시 실행하면

브라우저를 닫아도 서버는 잠시 살아 있습니다(의도적으로 탭을 다 닫으면 약 10초,
절전·연결 유실이면 더 길게). 그 사이 `cc-on-browser`를 다시 실행하면 오류 없이
**실행 중인 서버에 새 탭만 열립니다** — 돌고 있던 CLI 세션도 그대로입니다.

```
Already running (v1.8.0) on port 8787 — opened a new browser tab.
```

> npm 레지스트리 게시 후에는 `npm install -g cc-on-browser` 한 줄로도 설치할 수
> 있습니다 — 게시 상태는 Releases 페이지에서 안내합니다.

## 무엇을 제공하나요

- **스트리밍 마크다운 채팅** — 부분 메시지(`--include-partial-messages`)를 실시간 렌더. delta 덩어리를 그대로 그리지 않고 프레임 단위 페이서로 부드럽게 드러냄(타자기식, reduced-motion 존중). 코드 하이라이트(highlight.js) + XSS 정화(DOMPurify).
- **도구 실행 카드** — Bash·Edit·Write·Read·Grep 등 도구 호출을 입력/결과 카드로, 긴 결과는 접기.
- **사고(thinking) 블록** — 확장 사고 스트림을 별도 블록으로 표시.
- **권한 다이얼로그** — `can_use_tool` 요청을 모달로 띄워 허용/거부. 제안(suggestion)은 "항상 허용" 같은 모호한 문구 대신 실제 효과를 그대로 서술. **새 세션의 기본 권한 모드는 기본모드(default)** — CLI 정책과 사용자 허용 규칙상 확인이 필요한 도구 사용 전에 묻습니다. 기본·자동·플랜모드는 컴포저에서 언제든 바꿀 수 있고, 모드는 기본모드(무색)·자동모드(파랑)·플랜모드(초록)·신뢰모드(빨강)로 색을 구분해 표시합니다. **신뢰모드(bypassPermissions)는 세션 시작 시(새 세션 모달)에만 선택할 수 있습니다** — 다른 모드로 시작한 세션은 실행 중에 신뢰모드로 전환할 수 없습니다(서버가 차단). 신뢰모드로 시작한 세션은 다른 모드로 갔다가 신뢰모드로 복귀할 수 있습니다.
- **세션 재개 + 지난 세션 관리** — **새 세션 모달의 "지난 세션" 목록**(요약 제목 · 마지막 접근 · 대화 크기, 기본 20개 + "더 보기"로 50개)에서 클릭 한 번으로 이어가기(`--resume`), 필요 없는 세션은 확인 후 삭제. 재개할 때는 **모달에서 고른 모델·권한 모드가 그대로 적용**됩니다(모델을 "(기본 모델)"로 두면 그 세션이 쓰던 모델이 유지됩니다). 사이드바는 지금 열려 있는 세션만 보여줍니다.
- **작업 디렉터리 지정** — 새 세션 모달에서 Windows 네이티브 폴더 선택 대화상자로 선택(비-Windows는 직접 입력).
- **상태줄(statusline)** — 세션 컨텍스트(모델 창 대비 — 기본 200k, `[1m]` 모델은 1M)와 계정의 공식 5시간·7일 사용률(%)을 원형 게이지로 표시. 턴별 토큰 입/출력은 CLI처럼 채팅에 작은 꼬리표(`↑ 12 ↓ 345 tok · 5.3s`)로 남습니다.
- **런타임 컨트롤** — claude.ai식 모델 피커와 노력 수준 진행 바, 권한 모드 전환, `/` 슬래시 커맨드·`@` 파일 참조 자동완성, 턴 중단(Esc). 설정 변경 확인과 오류는 **토스트 알림**으로 표시됩니다.
- **컴포저 중심 UI** — 상단 바 없이 입력창 한 곳에 레포·권한모드·모델·전송·사용량을 접어 넣은 레이아웃. 라이트/다크 테마, 외부 폰트·이미지 의존 0(로컬 CSP 안전).
- **살아있는 마스코트(CLAW'D)** — 실제 Claude Code CLI에 내장된 공식 아트를 옮긴 마스코트가 세션 상태에 반응합니다(대기 깜박임·커서 추적 눈, 응답 중 말풍선, 도구 실행 스캐틀, 서브에이전트 저글링, 권한 대기 폴짝, 턴 종료 환호, 60초 무입력 zzz — `prefers-reduced-motion` 존중).
- **원격 제어(Remote Control)** — **사이드바 세션 행을 우클릭**(키보드는 Shift+F10)해
  "원격 제어 켜기"를 고르면, 그 레포를 **claude.ai/code와 Claude 모바일 앱에서
  조종**할 수 있습니다. 지금 보고 있지 않은 다른 프로젝트의 세션도 같은 자리에서
  다룹니다. 켜진 세션은 행에 📱 표시가 붙고, 접속 주소가 나오면 같은 메뉴에
  "claude.ai/code에서 열기"가 생깁니다. 켜져 있는 동안에는 **브라우저를 닫아도 앱이
  종료되지 않습니다**(폰에서 계속 쓰라고 켠 기능이므로) — 다 쓰면 꺼 주세요.
  노출 범위는 [SECURITY.md](SECURITY.md)를 읽어 보세요.
- **실행 중 작업 도크** — 입력창 **아래**에 지금 돌고 있는 백그라운드 셸·서브에이전트·
  진행 중인 도구가 모여 표시되고, 항목을 누르면 대화 속 해당 카드로 이동합니다.
  목록은 CLI가 직접 알려 주는 실행 목록이라 실제로 도는 것만 뜹니다.
- **메시지 시각** — 사용자 메시지와 답변에 작은 `HH:MM`(24시간제)이 붙습니다. 지난
  대화를 재개해도 그때의 실제 시각이 나오고, 마우스를 올리면 날짜까지 보입니다.
- **절전 생존** — 노트북 리드 닫힘·절전으로 연결만 끊긴 경우 서버가 종료되지 않고, 실행 중인 CLI 세션을 유지한 채 복귀 시 자동 재접속합니다.

## 사용 방법

1. **접속** — 기본 실행은 브라우저가 자동으로 열립니다. 수동 접속은 기동 시 출력된
   `http://127.0.0.1:8787/#token=…` URL을 그대로 엽니다(토큰 없는 주소는 인증 실패).
2. **새 세션 시작** — 사이드바 **새 세션** → 작업 디렉터리 선택 → 필요하면 모델·권한
   모드 변경 후 시작. 기본값은 계정 기본 모델 + **기본모드(default)** — 확인이 필요한
   도구 사용 전에 묻는 모드입니다. 확인 없이 실행하는 신뢰모드(bypassPermissions)는
   선택 시 경고와 함께 사용할 수 있으며, **세션 시작 시에만 선택 가능**합니다 —
   실행 중 전환은 차단됩니다. 재개도 같은 모달에서 하므로, 거기서 고른 모델·권한
   모드가 그대로 적용됩니다(신뢰모드 재개도 이 경로로 가능합니다).
   모달에서 매번 고르기 번거로우면 **사이드바 하단 "설정"에서 기본 모델·기본 권한
   모드**를 지정해 두세요 — 새 세션 모달을 열 때의 초기 선택값이 됩니다(이미 실행
   중인 세션에는 영향을 주지 않습니다). 모델 목록은 CLI가 세션을 시작할 때 알려주므로,
   앱을 켠 뒤 세션을 한 번 시작해야 기본 모델을 고를 수 있습니다.
3. **대화** — **Enter** 전송, **Shift+Enter** 줄바꿈. 진행 중인 턴은 **Esc** 또는 정지
   버튼으로 중단합니다.
4. **슬래시 커맨드 / @ 파일 참조** — `/`와 `@` 입력 시 자동완성 드롭다운(Tab/Enter 선택).
5. **권한 응답** — 확인이 필요한 모드에서는 도구 실행 전에 다이얼로그가 떠 허용/거부를
   선택합니다. Claude가 질문할 때(AskUserQuestion)는 선택지·직접 입력·건너뛰기를 갖춘
   질문 다이얼로그가 뜹니다.
6. **모델·노력 수준 변경** — 컴포저에서 대화 중에도 변경. 노력 수준은 **세션 재시작
   없이 즉시 적용**됩니다(CLI 런타임 채널). 이 채널을 모르는 구버전 CLI에서만 같은
   대화로 재시작하며, 그때는 "재시작합니다" 안내가 먼저 뜹니다.
7. **세션 재개·삭제** — **새 세션** 모달의 "지난 세션"에서 클릭으로 재개(위에서 고른
   모델·권한 모드가 적용), 휴지통 버튼으로 삭제(실행 중 세션은 보호됨). 대화 기록은
   CLI가 `~/.claude`에 남기므로 서버를 껐다 켜도 유지됩니다.
8. **원격 제어(선택)** — 사이드바 세션 행을 **우클릭 → "원격 제어 켜기"**. 주소가
   나오면 같은 메뉴의 "claude.ai/code에서 열기"로 접속하고, 다 쓰면 **"원격 제어
   끄기"**를 누르세요 — 켜 둔 동안에는 브라우저를 닫아도 앱이 살아 있습니다.
9. **실행 중 작업 보기** — 입력창 아래 도크에서 지금 돌고 있는 셸·서브에이전트를 확인하고,
   누르면 대화의 해당 위치로 이동합니다.
10. **종료** — 탭을 모두 닫으면 약 10초 뒤 자동 종료(`--no-open`은 `Ctrl+C`). 이때
   **실행 중이던 CLI 세션도 함께 끝납니다** — 서버는 세션 프로세스와 그 자식(셸·MCP
   서버 등)이 실제로 종료된 것을 확인한 뒤에야 내려갑니다. 긴 작업을 돌려 둔 채
   브라우저만 닫으려면 원격 제어를 켜 두세요. 절전·리드 닫힘은 종료로 치지 않습니다.
   **원격 제어가 켜져 있으면 종료하지 않습니다.**

## 문제해결 (Troubleshooting)

| 증상 | 원인 · 해결 |
| --- | --- |
| `WARNING: claude CLI not found` | CLI 미설치 또는 PATH 밖. [설치](https://claude.com/claude-code) 후 `claude`가 터미널에서 실행되는지 확인하거나, `CLAUDE_WEB_CLI_PATH`에 절대 경로를 지정하세요. |
| 세션 시작 실패 | CLI 로그인 안 됨 — 터미널에서 `claude` 실행 → `/login`. |
| 원격 제어가 `Workspace not trusted`로 실패 | 그 폴더의 신뢰 대화상자를 아직 수락하지 않았습니다. 해당 폴더에서 `claude`를 한 번 실행해 승인한 뒤 다시 켜세요(보안 판단이라 앱이 대신 수락하지 않습니다). |
| 실행할 때 검은 콘솔 창이 깜빡임 | npm의 `.cmd` shim이 만드는 창입니다. `cc-on-browser --shortcut`으로 만든 바로가기로 실행하면 콘솔이 전혀 뜨지 않습니다([위 안내](#콘솔-창-없이-실행하기-windows)). |
| `Port 8787 is already in use` | 다른 프로그램이 그 포트를 쓰고 있거나, 우리 인스턴스이지만 **신원을 확인할 수 없는** 경우입니다(구버전 인스턴스, 인스턴스 파일 누락·손상). 정상 인식되면 오류 대신 새 탭이 열립니다 — 그렇지 않으면 `cc-on-browser --port 9000`처럼 다른 포트를 지정하세요. |
| 노력 수준을 바꾸면 세션이 재시작되거나 `unknown message type: setEffort` 오류 | 업그레이드 전에 띄운 **구버전 백그라운드 서버**가 아직 살아 있어 새 화면과 짝이 맞지 않는 상태입니다(사이드바 하단에 버전 경고가 뜹니다). 세션을 모두 종료한 뒤 앱을 다시 실행하면 런처가 유휴 구버전 서버를 자동으로 교체합니다. |
| 접속 시 401 / 빈 화면 | 토큰 없는 URL로 접속함 — 기동 시 출력된 `#token=` 포함 URL 전체를 사용하세요. |
| 브라우저가 안 열림 | `--no-open`으로 포그라운드 실행 후 출력된 URL을 직접 열기. `BROWSER` 환경변수로 열 브라우저를 지정할 수도 있습니다. |
| 서버가 저절로 꺼짐/안 꺼짐 | 탭 전부 닫기 = 약 10초 뒤 종료(정상). 절전·연결 유실은 세션이 살아있는 한 대기(정상 — 세션이 없으면 30분 뒤 정리). |
| CLI 업데이트 후 이상 동작 | [프로토콜 경고](#프로토콜-경고) 참조 — 이슈로 CLI 버전과 함께 제보해 주세요. |

**환경변수**: `PORT`(=`--port`) · `BROWSER`(URL을 열 명령) · `CLAUDE_WEB_CLI_PATH`(CLI 절대 경로).
CLI 경로 해석 순서: `CLAUDE_WEB_CLI_PATH` → OS `PATH`의 `claude`(Windows는 `claude.exe`).

## 소스에서 실행 / 개발

```sh
git clone https://github.com/seokjw0727/CC-on-browser.git
cd CC-on-browser
npm run install:all   # 루트(서버)·client/ 의존성 설치
npm run build         # client → client/dist
npm start             # = node bin/cc-on-browser.mjs
```

### 구독 소모 없는 데모 (fake CLI)

실제 CLI 대신 프로토콜을 모사하는 가짜 CLI로 전체 스택을 띄워볼 수 있습니다:

```sh
node scripts/dev-fake.mjs                       # echo 시나리오 (기본 포트 8788)
node scripts/dev-fake.mjs --scenario permission # 권한 다이얼로그 시나리오
node scripts/dev-fake.mjs --scenario question   # Claude의 질문 다이얼로그 시나리오
```

### 테스트

전부 fake CLI로만 동작하므로 구독을 소모하지 않습니다:

```sh
npm test              # 서버·클라이언트 단위/통합 (node --test)
npm run build && npx playwright install chromium
npm run test:e2e      # 브라우저 E2E (Playwright — 세션 시작·스트리밍·권한 왕복)
```

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
bin/cc-on-browser.mjs  CLI 진입점 — 인자 파싱·사전 점검 후 백그라운드 서버 기동 + 브라우저 실행
server/src/
  server.js          HTTP(REST + 정적 서빙) + WebSocket 허브. 127.0.0.1 전용, 토큰·Origin 인증
  session-hub.js     세션 레지스트리 — 키↔ClaudeSession, 이벤트 브로드캐스트/리플레이 중계
  claude-session.js  CLI 자식 프로세스 1개 래핑 — stream-json 송수신, 미문서 프로토콜 격리
  history.js         ~/.claude 프로젝트·세션·트랜스크립트 읽기 (세션 재개·삭제)
  usage.js           ~/.claude 트랜스크립트 로컬 집계 — 5h/7d 참고치 (/api/usage)
  quota.js           계정 공식 사용률(5h/7d %) — CLI의 OAuth 토큰 사용, 유일한 api.anthropic.com 접점
  fs-api.js          디렉터리 나열·파일명 검색 — 파일 내용은 미제공
  jsonl.js           라인 단위 JSON 파서
client/src/
  App.jsx            셸 레이아웃·테마 소유
  lib/               store.jsx(상태) · ws.js(자동 재접속) · reduce-cli-event.js(CLI 이벤트→상태) · markdown.js · api.js
  components/        Sidebar · Composer · ChatView · Message · ToolCard · ThinkingBlock · PermissionDialog · QuestionDialog · Toasts · Clawd · Brand
scripts/dev-fake.mjs 구독 미소모 데모 런처(fake CLI)
server/test/         fake CLI 기반 통합·단위 테스트 (실제 claude 미실행)
e2e/                 Playwright 브라우저 E2E (fake CLI 스택)
docs/superpowers/    스펙·플랜 문서
```

## 보안

이 앱은 파일시스템과 셸에 접근할 수 있는 CLI를 구동합니다. **원격 노출 금지**, 토큰 URL
비공유 등 반드시 [SECURITY.md](SECURITY.md)의 위협 모델과 주의사항을 읽어 주세요.
취약점은 공개 이슈 대신 비공개로 제보 부탁드립니다(경로는 SECURITY.md 참조).

## CLI 호환성

stream-json 제어 프로토콜(`--permission-prompt-tool stdio` 포함)은 **공식 미문서
인터페이스**입니다. Claude Code CLI **v2.1.201에서 프로토콜 실측 검증**했고, **v2.1.215까지
동작 확인**했습니다. CLI 업데이트로 형식이 바뀔 수 있으며, 알 수 없는 메시지는 버리지 않고
raw 이벤트로 UI에 전달되도록 설계돼 있습니다.

<a id="프로토콜-경고"></a>프로토콜 변경이 의심되면
`docs/superpowers/specs/2026-07-06-claude-code-on-browser-design.md`의 프로브 절차로 재검증하세요.

## 제한 사항 (v1 범위 밖)

이미지 첨부, 서브에이전트 트리 시각화, MCP 서버 관리 UI, PTY 터미널 탭,
다중 브라우저 클라이언트 동시 접속 동기화, 원격(비 localhost) 접근.

## 변경 이력 · 라이선스

[CHANGELOG.md](CHANGELOG.md) · [MIT](LICENSE)
