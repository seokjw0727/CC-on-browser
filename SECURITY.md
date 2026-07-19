# Security Policy · 보안 정책

**English first · [한국어는 아래](#한국어)**

## Supported versions

Only the latest release receives security fixes. Please update to the newest
version before reporting an issue that may already be fixed.

## Threat model — what this app is

CC-on-browser is a **local-only** web front-end that drives your locally
installed Claude Code CLI as a child process. By design it can — through the
CLI and its permission system — read and modify files and run shell commands
on your machine. That makes the security boundary explicit:

- **The server binds to `127.0.0.1` only.** Never expose it remotely (port
  forwarding, reverse proxies, tunnels). Anyone who can reach the port and
  knows the token can drive a CLI with access to your filesystem and shell.
- **A random per-launch token** guards every REST API call (`x-auth-token`
  header) and WebSocket connection (`?token=`); static assets (HTML/JS/CSS) are
  served without it. The token is delivered once in the URL fragment
  (`#token=…`) — do not share the URL.
- **Origin checks**: REST/WebSocket requests carrying a non-local `Origin`
  header are rejected, mitigating cross-site request abuse from other pages.
- **No arbitrary file-content API**: the server's own endpoints list
  directories and file *names*, and serve conversation transcripts from
  `~/.claude` — they never read arbitrary project files. Project file access
  happens exclusively through CLI tools, gated by the CLI's permission system
  and the permission dialog (new sessions default to the `default` permission
  mode, which asks before tool uses that need confirmation under the CLI's
  policy and your own allow rules).
- **No telemetry, no external calls** from the server itself, with one
  exception: the official usage percentages are fetched from a single
  `api.anthropic.com` metadata endpoint using the OAuth token the CLI already
  stored. No model calls are made outside your own sessions.
- The daemon scrubs the auth token from its process environment after startup
  so spawned CLI sessions and their child shells do not inherit it.

## Hardening tips

- Prefer the `default` permission mode (the default since v1.5.0); use
  `bypassPermissions` ("trust mode") only for work you fully trust.
- Treat the printed URL like a password for the duration of the process.
- Run it only on machines/accounts you control; it is a single-user tool.

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue:

- Preferred: [GitHub private vulnerability reporting](https://github.com/seokjw0727/CC-on-browser/security/advisories/new)
  (if the form is unavailable, the repository may not have it enabled yet —
  use the fallback below).
- Fallback: contact the maintainer ([@seokjw0727](https://github.com/seokjw0727))
  through GitHub with a request for a private channel.

You can expect an acknowledgement within a few days. Please include steps to
reproduce and an impact assessment if possible.

---

## 한국어

### 지원 버전

보안 수정은 **최신 릴리스**에만 제공됩니다. 제보 전에 최신 버전에서 재현되는지
확인해 주세요.

### 위협 모델 — 이 앱의 성격

CC-on-browser는 로컬에 설치된 Claude Code CLI를 자식 프로세스로 구동하는
**로컬 전용** 웹 프런트엔드입니다. 설계상 CLI와 그 권한 시스템을 통해 파일
읽기/수정과 셸 명령 실행이 가능하므로, 보안 경계는 다음과 같습니다:

- **서버는 `127.0.0.1`에만 바인드됩니다.** 포트포워딩·리버스 프록시·터널 등
  원격 노출을 절대 하지 마세요. 포트에 접근하고 토큰을 아는 사람은 당신의
  파일시스템과 셸에 접근할 수 있는 CLI를 조종할 수 있습니다.
- **기동마다 생성되는 랜덤 토큰**이 REST API(`x-auth-token` 헤더)와
  WebSocket(`?token=`) 접근을 보호합니다(정적 HTML/JS/CSS는 무인증 제공).
  토큰은 URL fragment(`#token=…`)로 1회 전달되며, 이 URL을 공유하지 마세요.
- **Origin 검증**: 로컬이 아닌 Origin 헤더의 REST/WebSocket 요청은 거부됩니다.
- **임의 파일 내용 API 없음**: 서버 자체 endpoint는 디렉터리·파일 이름 나열과
  `~/.claude`의 대화 트랜스크립트 제공까지만 하며, 임의의 프로젝트 파일을 읽지
  않습니다. 프로젝트 파일 접근은 CLI 도구 + CLI 권한 시스템·권한 다이얼로그로만
  이뤄집니다(v1.5.0부터 새 세션 기본은 `default` 모드 — CLI 정책과 사용자 허용
  규칙상 확인이 필요한 도구 사용 전에 묻습니다).
- **텔레메트리 없음**: 서버의 외부 호출은 CLI가 저장한 OAuth 토큰으로
  공식 사용률 메타데이터 endpoint(`api.anthropic.com`) 하나를 조회하는 것이
  유일합니다.
- 데몬은 기동 직후 인증 토큰을 자신의 env에서 제거해, 스폰된 CLI 세션과 그
  자식 셸로 토큰이 상속되지 않게 합니다.

### 취약점 제보

공개 이슈 대신 **비공개로** 제보해 주세요:

- 우선: [GitHub 비공개 취약점 신고](https://github.com/seokjw0727/CC-on-browser/security/advisories/new)
  (폼이 열리지 않으면 저장소에서 아직 활성화되지 않은 것입니다 — 아래 대체
  경로를 사용해 주세요.)
- 대체: GitHub의 [@seokjw0727](https://github.com/seokjw0727) 프로필을 통해
  비공개 연락 채널을 요청해 주세요.

재현 절차와 영향 범위를 함께 적어 주시면 빠른 확인에 도움이 됩니다.
