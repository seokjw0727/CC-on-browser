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
- **Remote Control is opt-in, and it is the one feature that reaches outside
  this machine.** Turning it on runs `claude remote-control` for that repository
  directory, which connects *outbound* to Anthropic's backend and makes the
  directory available to claude.ai/code and the Claude mobile app **signed in to
  your own Claude account**. Anyone with access to that account can then create
  sessions in that directory and run tools there. This does not open any inbound
  port — the app's own HTTP server stays bound to `127.0.0.1`. The browser never
  supplies the target path: it sends only a session key and the server resolves
  the directory from its own session ledger, so a compromised page cannot point
  Remote Control at an arbitrary directory. Turning it off terminates the process
  tree. **While it is on, the daemon deliberately keeps running after you close
  the browser** (otherwise the feature would be pointless), so a forgotten Remote
  Control leaves a background process alive until you stop it or reboot.
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
- **One writable file: `~/.claude/settings.json`** (Settings → Claude Code
  Config, since v1.8.3). `GET/PUT /api/claude-config` read and replace exactly
  that one server-chosen path — the client cannot name a different file. Writes
  require the same token and `Origin` checks as every other endpoint, must parse
  as a JSON object, are serialised and applied atomically (temp file + rename,
  new files created `0600`, existing permissions preserved), and are rejected if
  the file changed since it was loaded. Symlinks and non-regular files are
  refused. Note that this is a real capability increase: whatever you save here
  applies to **every Claude Code session started afterwards, including ones
  outside this app** (e.g. permission rules and hooks), and only JSON syntax is
  validated — not whether the settings themselves are safe.
- **No telemetry, no external calls** from the server itself, with one
  exception: the official usage percentages are fetched from a single
  `api.anthropic.com` metadata endpoint using the OAuth token the CLI already
  stored. No model calls are made outside your own sessions.
- The daemon scrubs the auth token from its process environment after startup
  so spawned CLI sessions and their child shells do not inherit it.
- **Instance file (since v1.8.0)** — a background daemon records its port, auth
  token, pid and version in `~/.cc-on-browser/instance-<port>.json` so that
  re-running `cc-on-browser` can recognize its own daemon and just open a new
  browser tab instead of failing with "port already in use". The directory is
  created `0700` and the file `0600`; on Windows Node's mode bits do not set
  confidentiality ACLs, so the effective protection is the inherited ACL of your
  user profile — the same trust boundary as the CLI's own `~/.claude`
  credentials. The token is never stored outside your profile and never sent to
  any external host. On a clean shutdown the daemon removes the record before it
  releases the port, and only if the record still carries its own token (plus its
  pid, when the record has one) — so it never deletes a successor daemon's
  record. A daemon killed outright can leave a stale record behind; that is
  harmless because a relaunch only trusts a record whose token authenticates
  against a live server on that same port. Deliberately *not* implemented: an
  unauthenticated "open a browser" HTTP endpoint, which would be reachable by
  any local process or web page.

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
- **원격 제어는 선택 기능이며, 이 앱에서 유일하게 이 컴퓨터 밖으로 나가는
  기능입니다.** 켜면 해당 레포 디렉터리에 대해 `claude remote-control`이 실행되어
  Anthropic 백엔드로 **나가는 방향** 연결을 맺고, **당신의 Claude 계정으로 로그인한**
  claude.ai/code와 Claude 모바일 앱이 그 디렉터리에서 세션을 만들고 도구를 실행할 수
  있게 됩니다. 그 계정에 접근할 수 있는 사람은 누구나 같은 일을 할 수 있습니다.
  들어오는 포트를 여는 것은 아니며 앱의 HTTP 서버는 `127.0.0.1` 전용 그대로입니다.
  대상 경로는 브라우저가 정하지 않습니다 — 세션 key만 보내고 서버가 자기 세션
  장부에서 디렉터리를 되찾으므로, 침해된 페이지가 임의 디렉터리를 원격 제어에
  물릴 수 없습니다. 끄면 프로세스 트리를 종료합니다. **켜져 있는 동안에는 브라우저를
  닫아도 데몬이 의도적으로 살아 있습니다**(그러지 않으면 기능이 성립하지 않습니다).
  따라서 끄는 것을 잊으면 중지하거나 재부팅할 때까지 백그라운드 프로세스가 남습니다.
- **기동마다 생성되는 랜덤 토큰**이 REST API(`x-auth-token` 헤더)와
  WebSocket(`?token=`) 접근을 보호합니다(정적 HTML/JS/CSS는 무인증 제공).
  토큰은 URL fragment(`#token=…`)로 1회 전달되며, 이 URL을 공유하지 마세요.
- **Origin 검증**: 로컬이 아닌 Origin 헤더의 REST/WebSocket 요청은 거부됩니다.
- **임의 파일 내용 API 없음**: 서버 자체 endpoint는 디렉터리·파일 이름 나열과
  `~/.claude`의 대화 트랜스크립트 제공까지만 하며, 임의의 프로젝트 파일을 읽지
  않습니다. 프로젝트 파일 접근은 CLI 도구 + CLI 권한 시스템·권한 다이얼로그로만
  이뤄집니다(v1.5.0부터 새 세션 기본은 `default` 모드 — CLI 정책과 사용자 허용
  규칙상 확인이 필요한 도구 사용 전에 묻습니다).
- **쓸 수 있는 파일은 `~/.claude/settings.json` 하나** (설정 → Claude Code Config,
  v1.8.3부터). `GET/PUT /api/claude-config`는 서버가 정한 이 한 경로만 읽고
  교체합니다 — 클라이언트가 다른 파일을 지정할 수 없습니다. 쓰기에도 다른 endpoint와
  같은 토큰·Origin 검증이 적용되고, JSON 객체로 파싱되는 내용만 허용하며, 직렬화된
  원자적 교체(임시 파일 + rename, 새 파일은 `0600`, 기존 권한 보존)로 반영합니다.
  불러온 뒤 파일이 바뀌었으면 덮어쓰지 않고 거부하며, 심볼릭 링크·비정규 파일도
  거부합니다. 다만 이는 실제로 권한이 넓어지는 기능입니다 — 저장한 내용은 **이후
  시작되는 모든 Claude Code 세션(이 앱 밖 포함)** 에 적용되고(권한 규칙·훅 등),
  검사하는 것은 JSON 문법뿐이지 설정 자체의 안전성이 아닙니다.
- **텔레메트리 없음**: 서버의 외부 호출은 CLI가 저장한 OAuth 토큰으로
  공식 사용률 메타데이터 endpoint(`api.anthropic.com`) 하나를 조회하는 것이
  유일합니다.
- 데몬은 기동 직후 인증 토큰을 자신의 env에서 제거해, 스폰된 CLI 세션과 그
  자식 셸로 토큰이 상속되지 않게 합니다.
- **인스턴스 파일 (v1.8.0부터)** — 백그라운드 데몬은 자신의 포트·인증 토큰·pid·
  버전을 `~/.cc-on-browser/instance-<port>.json`에 기록합니다. `cc-on-browser`를
  다시 실행할 때 "포트 사용 중" 오류로 죽는 대신 **자기 데몬임을 확인하고 브라우저
  탭만 새로 열기** 위한 용도입니다. 디렉터리는 `0700`, 파일은 `0600`으로 만들지만
  **Windows에서는 Node의 mode 비트가 기밀성 ACL을 설정하지 않으므로** 실질 보호는
  사용자 프로필의 상속 ACL에 의존합니다 — CLI 자신의 `~/.claude` 자격증명과 같은
  신뢰 경계입니다. 토큰이 프로필 밖에 저장되거나 외부 호스트로 전송되는 일은
  없습니다. 정상 종료 시 데몬은 **포트를 놓기 전에** 파일을 지우며, 기록의 토큰이
  자기 것일 때만(그리고 기록에 pid가 있으면 pid까지 맞을 때만) 지웁니다 — 후임
  데몬의 기록을 지우지 않기 위함입니다. 강제 종료된 데몬은 기록을 남길 수 있지만,
  재실행은 **같은 포트에서 살아 있는 서버가 그 토큰으로 인증되는 경우에만** 그
  기록을 신뢰하므로 무해합니다.
  **의도적으로 만들지 않은 것**: 인증 없는 "브라우저 열기" HTTP endpoint — 로컬
  프로세스나 웹페이지가 임의로 두드릴 수 있는 표면이 되기 때문입니다.

### 취약점 제보

공개 이슈 대신 **비공개로** 제보해 주세요:

- 우선: [GitHub 비공개 취약점 신고](https://github.com/seokjw0727/CC-on-browser/security/advisories/new)
  (폼이 열리지 않으면 저장소에서 아직 활성화되지 않은 것입니다 — 아래 대체
  경로를 사용해 주세요.)
- 대체: GitHub의 [@seokjw0727](https://github.com/seokjw0727) 프로필을 통해
  비공개 연락 채널을 요청해 주세요.

재현 절차와 영향 범위를 함께 적어 주시면 빠른 확인에 도움이 됩니다.
