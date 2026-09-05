# Security Policy · 보안 정책

**English first · [한국어는 아래](#한국어)**

## Supported versions

Only the latest release receives security fixes. Please update to the newest
version before reporting an issue that may already be fixed.

## Threat model — what this app is

CC on Browser is a **local-only** web front-end that drives your locally
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
  policy and your own allow rules). The one narrow exception is the artifact
  preview panel, described next.
- **Artifact preview (since v1.9.0)** — the side panel that renders files the
  assistant wrote reads file *contents*, but only within a deliberately narrow
  capability. `GET /api/preview-ticket` requires the same token and `Origin`
  checks as every other endpoint; the client sends only a session key and a
  path, and the server re-derives the working directory from **its own session
  ledger** (never the browser's claim), resolves symlinks with `realpath`, and
  refuses anything that is not a regular file inside that live session's `cwd`.
  It returns a short-lived **ticket** — 128 bits of randomness, 30 minutes,
  scoped to that one file's directory, and revoked the moment the session
  exits. `GET /preview/<ticket>/<relpath>` then serves bytes without the main
  token: `<iframe>`/`<img>` cannot send headers, and putting the real token in
  a URL would let previewed scripts read it out of `location.href`. Served
  responses are capped at 10 MB, carry `nosniff` and `no-store`, and HTML/SVG
  additionally carry `Content-Security-Policy: sandbox allow-scripts
  allow-modals`, so previewed documents run without the app origin's storage or
  API access **even if opened directly in a new tab** (the panel's `<iframe>`
  omits `allow-same-origin` for the same reason). Unknown types are sent as
  `attachment` rather than rendered. What this does **not** do: sandboxing
  restricts app-origin privileges, not outbound network requests made by
  content you authored; there is no preview for historical (non-live) sessions,
  no path outside the session `cwd`, and no file-watcher — only files written
  through the structured `Write`/`Edit`/`NotebookEdit` tools appear in the list.
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
- **No telemetry. No outbound requests by default.** The server makes none of its
  own unless you ask for one. There are exactly two ways it can reach the network,
  and both are opt-in:
  - **Official account usage (off by default).** Turning on "계정 공식 사용률 조회"
    in Settings lets the server read the OAuth token the Claude Code CLI already
    stored in `~/.claude/.credentials.json` and `GET` a single
    `api.anthropic.com` usage-metadata endpoint every 60 seconds while the app is
    open. It is not a model call, so it costs nothing, and only utilization numbers
    come back. The token is never written anywhere, never sent to any other host, and
    never leaves that one module. **The gate is server-side**: without an explicit
    opt-in the request handler does not call the module at all, so a stale browser
    tab or a direct `curl` cannot make it happen either. Turning it off clears the
    numbers from the screen immediately and stops the requests.

    Worth knowing before you enable it: Anthropic's Claude Code terms say OAuth
    subscription credentials are intended for Claude Code and Anthropic's own
    applications. Using them from a third-party tool — even one that only reads a
    usage counter, and even on your own machine with your own account — sits outside
    that intent. That is why the default is off and why this is your decision, not
    the app's. Everything else in the app works with it off; you simply see local
    transcript token counts instead of official percentages.
  - **Update check (manual only).** Settings → Updates fetches one GitHub Releases URL
    (`api.github.com/repos/seokjw0727/CC-on-browser/releases/latest`) when you press the
    button, and reads the release tag from it. It sends three generic headers GitHub asks
    of every API request (`User-Agent: cc-on-browser`, `Accept`, `X-GitHub-Api-Version`)
    and nothing else — no token, no cookie, no query string, no installation identifier.

  No model calls are ever made outside your own CLI sessions.
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

CC on Browser는 로컬에 설치된 Claude Code CLI를 자식 프로세스로 구동하는
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
  규칙상 확인이 필요한 도구 사용 전에 묻습니다). 유일하게 좁은 예외가 아래의
  결과물 미리보기입니다.
- **결과물 미리보기 (v1.9.0부터)** — 어시스턴트가 쓴 파일을 옆 패널에서 렌더하는
  기능은 파일 *내용*을 읽지만, 의도적으로 좁힌 capability 안에서만 그렇습니다.
  `GET /api/preview-ticket`은 다른 endpoint와 같은 토큰·Origin 검증을 요구하고,
  클라이언트는 세션 key와 경로만 보냅니다 — 격리 기준이 되는 작업 디렉터리는
  **서버가 자기 세션 장부에서** 되찾습니다(브라우저의 주장을 신뢰하지 않습니다).
  `realpath`로 심볼릭 링크를 편 뒤, 그 라이브 세션 `cwd` 안의 정규 파일이 아니면
  거부합니다. 반환값은 **단명 티켓**입니다 — 128비트 난수, 30분, 해당 파일의
  디렉터리로 한정, 세션이 끝나면 즉시 폐기. 이어지는
  `GET /preview/<ticket>/<relpath>`는 메인 토큰 없이 바이트를 제공합니다:
  `<iframe>`·`<img>`는 헤더를 실을 수 없고, 진짜 토큰을 URL에 넣으면 미리본
  스크립트가 `location.href`에서 그것을 읽어낼 수 있기 때문입니다. 응답은 10MB로
  제한되고 `nosniff`·`no-store`가 붙으며, HTML/SVG에는
  `Content-Security-Policy: sandbox allow-scripts allow-modals`가 추가돼
  **새 탭으로 직접 열어도** 앱 오리진의 저장소·API 권한 없이 실행됩니다(패널의
  `<iframe>`이 `allow-same-origin`을 넣지 않는 것도 같은 이유입니다). 모르는
  형식은 렌더하지 않고 `attachment`로 내려받게 합니다. **하지 않는 것**: 샌드박스는
  앱 오리진 권한을 막을 뿐 사용자가 만든 콘텐츠의 외부 네트워크 요청까지 막지는
  않습니다. 과거(비-라이브) 세션의 미리보기, 세션 `cwd` 밖 경로, 파일 워처는
  없습니다 — 목록에 잡히는 것은 구조화된 `Write`/`Edit`/`NotebookEdit` 도구로 쓴
  파일뿐입니다.
- **쓸 수 있는 파일은 `~/.claude/settings.json` 하나** (설정 → Claude Code Config,
  v1.8.3부터). `GET/PUT /api/claude-config`는 서버가 정한 이 한 경로만 읽고
  교체합니다 — 클라이언트가 다른 파일을 지정할 수 없습니다. 쓰기에도 다른 endpoint와
  같은 토큰·Origin 검증이 적용되고, JSON 객체로 파싱되는 내용만 허용하며, 직렬화된
  원자적 교체(임시 파일 + rename, 새 파일은 `0600`, 기존 권한 보존)로 반영합니다.
  불러온 뒤 파일이 바뀌었으면 덮어쓰지 않고 거부하며, 심볼릭 링크·비정규 파일도
  거부합니다. 다만 이는 실제로 권한이 넓어지는 기능입니다 — 저장한 내용은 **이후
  시작되는 모든 Claude Code 세션(이 앱 밖 포함)** 에 적용되고(권한 규칙·훅 등),
  검사하는 것은 JSON 문법뿐이지 설정 자체의 안전성이 아닙니다.
- **텔레메트리 없음. 기본값은 외부 요청 0입니다.** 서버가 스스로 바깥으로 내는
  요청은 없고, 나갈 수 있는 길은 둘뿐이며 둘 다 옵트인입니다:
  - **계정 공식 사용률 (기본 꺼짐).** 설정에서 "계정 공식 사용률 조회"를 켜면,
    서버가 Claude Code CLI가 이미 저장해 둔 `~/.claude/.credentials.json`의 OAuth
    토큰으로 `api.anthropic.com`의 사용량 메타데이터 endpoint 하나를 앱이 열려
    있는 동안 60초마다 GET합니다. 모델 호출이 아니라 과금이 없고, 돌아오는 것은
    사용률 수치뿐입니다. 토큰은 어디에도 기록되지 않고, 다른 호스트로 가지 않으며,
    그 모듈 밖으로 나가지 않습니다. **관문은 서버에 있습니다** — 옵트인 없이 들어온
    요청은 그 모듈을 호출조차 하지 않으므로, 낡은 브라우저 탭이나 직접 두드리는
    `curl`로도 조회가 일어나지 않습니다. 끄면 화면의 수치도 즉시 사라지고 요청도
    멈춥니다.

    켜기 전에 알아 두실 것: Anthropic의 Claude Code 약관은 구독 OAuth 자격증명이
    Claude Code와 Anthropic 자체 앱을 위한 것이라고 밝히고 있습니다. 서드파티 도구가
    그것을 쓰는 일은 — 사용량 숫자만 읽더라도, 본인 계정으로 본인 기기에서 하더라도 —
    그 취지 밖에 있습니다. 기본값을 꺼 둔 이유이자, 이 판단을 앱이 대신하지 않고
    사용자에게 맡기는 이유입니다. 꺼 두어도 나머지 기능은 모두 그대로 동작하며,
    공식 %(퍼센트) 자리에 로컬 대화 기록 집계가 표시됩니다.
  - **업데이트 확인 (수동).** 설정 → 업데이트에서 버튼을 누를 때만 GitHub Releases
    URL 하나(`api.github.com/repos/seokjw0727/CC-on-browser/releases/latest`)를 조회해
    릴리스 태그를 읽습니다. 함께 나가는 것은 GitHub API가 모든 요청에 요구하는 일반
    헤더 셋(`User-Agent: cc-on-browser`, `Accept`, `X-GitHub-Api-Version`)뿐이며,
    토큰·쿠키·쿼리스트링·설치 식별자는 싣지 않습니다.

  사용자의 CLI 세션 밖에서 모델을 호출하는 일은 어떤 경우에도 없습니다.
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
