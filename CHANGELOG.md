# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Full bilingual (EN/KO) release notes live on the
[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) page.

## [Unreleased]

## [1.8.0] - 2026-08-01

> Claude Code 원격 제어 연동(claude.ai·모바일 앱에서 이 레포 조종), 입력창 아래
> "실행 중" 도크, 메시지 시각 표시. 그리고 `/clear` 후 모델 선택이 풀리던 문제 수정,
> 재실행 시 실행 중인 서버 재사용, Windows 무콘솔 실행 바로가기, 입력창 배지 정리.
> (Remote Control from claude.ai and the mobile app; a running-work dock under the
> composer; message timestamps. Plus: model stays selected after `/clear`; relaunch
> reuses a live server; a console-free Windows launcher; slimmer composer badges.)

### Fixed
- **The model picker no longer clears itself after `/clear`.** Measured against
  the real CLI v2.1.220: right after `/clear` the CLI emits a correct
  `system/init` and then a dummy `assistant` message whose `message.model` is the
  literal sentinel `<synthetic>` with the body `(no content)`. The client was
  harvesting that sentinel as the session's model, so `familyOf()` found no
  family — the pill fell back to "모델" with nothing checked in the menu, and the
  measured context window was reset along with it. The sentinel is now excluded
  from model harvesting (exact match only — no model-name allowlist that could
  reject future models), and that `(no content)` placeholder no longer renders as
  an empty assistant bubble. A `<synthetic>` message that carries real text (for
  example a login prompt) is still shown.

### Added
- **Remote Control: drive this repo from claude.ai/code or the Claude mobile app.**
  A `📱 원격 제어` pill next to the repo pill starts `claude remote-control` for the
  session's directory and shows the resulting `claude.ai/code?environment=…` link,
  a copy button and a stop button. Measured against the real CLI v2.1.220: the
  `--remote-control` flag is silently ignored in `-p`/stream-json mode, and
  `claude daemon remote-control` is unavailable on Windows, so the server manages
  the process directly — one child per canonical directory, tree-terminated on
  stop. The browser only ever sends a session key; the server resolves the
  directory from its own session ledger, so no client-supplied path can open a
  remote control. **While Remote Control is on, closing the browser no longer
  shuts the app down** — that is the point of the feature — so remember to turn it
  off; the popover says so. See SECURITY.md for what the feature exposes.
- **A "실행 중" dock under the composer shows running shells and subagents.**
  Background shells, background agents and in-flight foreground `Bash`/`Task`
  calls are listed under the input; clicking one scrolls the transcript to that
  card and highlights it briefly. The running list comes from the CLI's own
  `background_tasks_changed` snapshot rather than guesswork over tool-result text,
  so items appear and disappear exactly when the CLI says they do, and a resumed
  conversation never shows ghosts of tools that stopped long ago.
- **Messages carry a small `HH:MM` timestamp.** User messages and assistant
  answers only — tool cards and thinking blocks stay uncluttered. The time comes
  from the CLI event itself, so a resumed conversation shows when things actually
  happened rather than when it was reopened; hovering shows the full date.
- **Re-running `cc-on-browser` while a server is already up now just opens a new
  tab.** The background daemon outlives the browser for a while (about 10 seconds
  after every tab is deliberately closed, longer when the connection was merely
  lost to sleep, longer still while CLI sessions are alive), and re-running during
  that window used to die with `Port 8787 is already in use` — from a shortcut or
  Win+R that looked like nothing happened at all. The daemon now records its port,
  token, pid and version in `~/.cc-on-browser/instance-<port>.json`; a relaunch
  authenticates against the running server with that token (and checks the port it
  reports back) and, when it is ours, opens a browser tab and exits 0 with
  `Already running (v…) on port … — opened a new browser tab.` Live CLI sessions
  survive. A foreign program on the port still produces the original error. No
  unauthenticated HTTP endpoint was added; see SECURITY.md for the trust boundary
  of the token file.
- **`cc-on-browser --shortcut` (Windows): launch with no console window at all.**
  Running the command from Win+R or Explorer flashes a command prompt for 1–3
  seconds, because npm's generated `cc-on-browser.cmd` creates that console before
  Node can run — nothing in the app can hide it. The new flag creates a
  "Claude Code on Browser" shortcut on the Desktop and in the Start Menu that goes
  through `wscript.exe` (a GUI-subsystem host, so no console exists) and starts the
  server with a hidden window: only the browser appears. Partial success is
  reported per location, and the command runs before every server-related preflight
  so unrelated setup problems cannot block it.

### Changed
- **The running-subagent panel moved below the input and became the work dock.**
  It used to sit above the input and only appear while a turn was in flight, which
  hid exactly the long-running background work it should have shown. Items are now
  clickable.
- **The composer no longer shows the `⚡ 울트라코드` and `🔓 권한 상승` badges.**
  The effort picker and the permission-mode select already show that state, so the
  badges were duplicate signage. The options themselves are untouched.
- **The active-goal badge is now just `GOAL`.** The full goal text moved into the
  tooltip (hover, and keyboard focus for anyone without a mouse) instead of taking
  up a line above the input.

## [1.7.1] - 2026-07-29

> `/clear`·`/compact` 직후 상태줄 CTX가 다음 턴까지 옛 값으로 남던 문제 수정.
> (Stale CTX after `/clear` and `/compact`.)

### Fixed
- **The CTX status-line value now updates immediately after `/clear` and `/compact`.**
  Both are local CLI commands that make no model call, so no authoritative
  per-call `assistant` usage arrives to refresh the context size, and any `result`
  that follows is absent, empty, or a turn aggregate unusable as a context
  measurement. The status line therefore kept showing the pre-command number until
  the next real turn (e.g. still reading 117k right after a compaction down to
  3,171). `/clear` now resets it to 0 and
  `/compact` adopts the `postTokens` the CLI already reports on its
  `compact_boundary` event, so the number matches the compaction card. Automatic
  compaction goes through the same event and is covered too. Other commands are
  deliberately untouched: the CLI gives no authoritative context-token signal for
  them, so nothing is guessed.

### Changed
- **The CTX ring stays visible at 0%** instead of disappearing. Display is now
  decided by a flag (`usage.ctxDisplayable`) rather than by `contextTokens > 0`,
  which could not tell "context was cleared" apart from "no turn has run yet".
  A freshly started session with no turns still shows no ring. The ring's tooltip
  now reads "마지막 API 호출·압축/초기화 기준" — the old wording claimed the value
  always came from the last API call, which stopped being true.
- **Resumed sessions now show compaction cards in their history.** The server's
  transcript reader used to discard every `system` event except the first `init`,
  which threw away the `compact_boundary` lines. They are now passed through, so
  resuming a session that ended right after a compaction restores the correct CTX
  — and, as a side effect, the compaction completion cards that were previously
  missing from resumed history are rendered.

## [1.7.0] - 2026-07-28

> 긴 대화 성능·메모리 개선 — 메시지 창(윈도잉) · 렌더 메모이제이션 · 대량 유입 시 하단 고정 수정.
> (Long-conversation performance & memory: message windowing, render memoization,
> bottom-following fix.)

### Changed
- **BEHAVIOR — by default the chat keeps only the most recent 200 messages in the page.**
  Older messages are one click away ("이전 메시지 N개 더 보기" / "모두 불러오기"),
  and expanding preserves your reading position. The trade-off: messages outside
  the window are absent from the page, so **Ctrl+F, select-all/copy, printing and
  screen-reader browsing do not reach them** until you load them. An expansion
  sticks until you press "↓ 최신으로" or switch sessions. Scrolling up freezes the
  top of the window so incoming messages cannot shift what you are reading.
- **Model picker fallback updated for Claude Opus 5** (`claude-opus-5`, released
  2026-07). The Opus family's fallback display version is now `5` (was `4.8`);
  the catalog helpers (`MODEL_FAMILIES` / `parseVersion` / `familyOf` /
  `buildModelOptions`) moved from `Composer.jsx` into
  `client/src/lib/model-catalog.js` so they can be regression-tested with
  `node --test`. This only affects the fallback label shown when the CLI
  catalog has no matching Opus entry or its `resolvedModel` cannot be parsed;
  when the catalog does match, both the version shown and the value sent to the
  CLI still come from it. The picker's family list itself is hard-coded and
  unchanged — all four families are always offered.

### Added
- Regression cover for the window contract: `client/test/chat-window.test.js`
  (`node --test`) pins the window arithmetic across the default / reading-up /
  expanded states, and a new `bulk` fake-CLI scenario (hundreds of messages in one
  turn) backs five browser tests — the default 200-item window, "load earlier"
  anchoring, "load all" + focus handoff, the raw-debug toggle surviving
  memoization, and switching away to another session and back without replaying
  the entrance animation over the whole history.

### Fixed
- **Long conversations no longer freeze the UI or balloon browser memory.** Two
  causes, both measured (Chromium + CDP, 1920 messages, one streamed reply of 200
  deltas): every streaming delta re-rendered the *entire* message tree, and the
  whole conversation stayed in the DOM (a heap snapshot attributed **72% of the
  heap to DOM nodes**, 27.8 MB of 38.7 MB). `Message` is now memoized and the chat
  list renders a window of the most recent messages. Main-thread blocking during a
  streamed reply dropped from **3851 ms to 0 ms**, and the heap snapshot from
  **38.7 MB to 17.6 MB** (DOM 27.8 MB → 3.5 MB) for a session with 20 KB tool
  outputs.
- **Bulk event arrival no longer breaks bottom-following.** Replaying hundreds of
  events at once (reconnect, resume) left the view stranded far above the latest
  message: while the list was still growing, a scroll event reporting a stale
  `scrollTop` was read as "the user scrolled up", which cancelled auto-follow (and,
  with windowing, froze the window in place). The scroll handler now treats an
  event as a user scroll only when `scrollTop` actually moved away from where we
  last pinned it. Measured with 400 turns pushed in one go: **53,634 px above the
  bottom (window stuck at 1200 items) → 0 px (200 items)**.
- `updateByUid` in the event reducer walks backwards and copies with `slice`
  instead of `map` — per-delta cost at 8000 messages went from 75 µs to ~5 µs.
  (The array copy remains, so garbage volume is largely unchanged: 13.5 → 12.6 MB
  per streamed block at 4000 messages.)

## [1.6.0] - 2026-07-22

> 지난 세션 모달 통합 · 신뢰모드 시작 전용화 · 새 세션 기본값 설정 · favicon.

### Changed
- **Past-session management moved into the new-session modal.** The sidebar now
  lists only currently open sessions; the modal's "recent sessions" became a full
  "past sessions" manager (two-line rows with directory / last access / transcript
  size, per-row delete with confirmation, "show more" 20→50, loading/error/retry
  states, live-session 409 handling).
- **Resuming applies the model and permission mode selected in the modal** (leaving
  the model empty omits `--model`, keeping the session's previous model). Duplicate
  resume is guarded by an attempt-generation lock with a 15s watchdog.
- **BREAKING — Trust mode (`bypassPermissions`) is now start-only.** Sessions spawned in any
  other mode can no longer switch into trust mode mid-session (enforced server-side;
  the composer hides the option and permission-dialog escalation suggestions are
  filtered). Trust-spawned sessions may still leave and return to it.

### Added
- **Default model & default permission mode** in Settings (localStorage-persisted,
  validated against the CLI's model catalog before spawning) — they seed the
  new-session modal's initial selection. The model list becomes available after the
  first session `init`.
- **Browser tab icon** (`favicon.svg`, the brand sparkle mark).
- E2E: isolated `projectsRoot` seeding (`FAKE_PROJECTS_ROOT`) so history list /
  resume-with-arguments / deletion are tested against disposable fixtures — the
  real `~/.claude/projects` is never touched. New scenarios for modal history,
  settings defaults, resume spawn arguments, and confirmed deletion.
- Focus-trap restore targets (`useFocusTrap` third argument) so deleting a session
  from the nested confirm dialog lands focus on the list heading instead of `<body>`.

### Fixed
- `startSession` now reports WebSocket send failure to callers, so the new-session
  modal no longer closes as if a session had started while disconnected.

## [1.5.0] - 2026-07-19

> 공개 릴리스 준비 — 기본 권한 모드 안전화, 지난 세션 UX, E2E·릴리스 자동화. (First public-release-ready version.)

### Changed
- **New sessions now default to the `default` permission mode** (the CLI asks before
  tool uses that need confirmation) instead of `bypassPermissions`. The previous
  behavior is still one click away in the new-session modal / composer, with the
  warning banner kept.
- README rewritten around a quick-start flow with a troubleshooting section;
  English README fully re-synced.
- Client bundle is split into `app` + `vendor-react` / `vendor-hljs` / `vendor-md`
  chunks (same total gzip size, better cache reuse across app updates).

### Added
- **Past sessions in the sidebar**: collapsible section (state persisted), per-row
  summary title with directory, relative last-access time and transcript size, and
  a delete button with confirmation (`DELETE /api/sessions`, live sessions protected).
- **Browser E2E tests** (Playwright + the subscription-free fake CLI stack): session
  start, default-permission-mode assertion, streamed markdown rendering, and a
  permission allow/deny round-trip. Runs locally via `npm run test:e2e` and in CI.
- **Release automation** (`.github/workflows/release.yml`): tag push builds, tests,
  packs a single tarball, smoke-installs it, uploads it (with SHA-256) to the GitHub
  Release, and publishes to npm when an `NPM_TOKEN` secret is configured — with a
  dry-run rehearsal mode and a manual recovery path.
- `SECURITY.md` (threat model, hardening notes, private reporting path) and this
  `CHANGELOG.md`.
- Background (default) start mode now reports the detected `claude` CLI version, or
  a clear warning when the CLI cannot be found — previously only `--no-open` did.

### Fixed
- Running `cc-on-browser` from a shell spawned inside an app-hosted CLI session no
  longer silently enters daemon mode (daemon detection moved from an inherited
  environment variable to an internal argv flag).

### Security
- The daemon now scrubs the auth token from its environment right after startup, so
  CLI sessions (and their child shells) no longer inherit the local API bearer token.

## [1.4.0] - 2026-07-18

> 절전 세션 생존 · 서브에이전트 패널 · 커스텀 툴팁 · 사용량 잔디.

### Added
- Sleep survival: connection loss (laptop lid close, suspend) no longer shuts the
  server down; live CLI sessions are kept and the browser reattaches on wake.
- Live subagent panel above the composer while Task/Agent subagents run.
- Custom tooltip layer replacing native `title` tooltips.
- GitHub-style daily usage heatmap (12 weeks / 1 year) in the sidebar.

## [1.3.1] - 2026-07-16

### Fixed
- Native folder picker no longer opens behind the browser window.
- `/compact` summaries and CLI-injected context messages render as proper cards
  instead of giant user bubbles; ANSI escapes stripped from slash-command output.

## [1.3.0] - 2026-07-13

### Added
- New-session working directory via the native Windows folder dialog.
- "Recent sessions" (across all projects) in the new-session modal, resumable in
  one click (`GET /api/recent-sessions`).

### Fixed
- 5h/7d usage rings no longer fall back to raw token counts on transient fetch
  failures; `@` autocomplete no longer keeps stale results selectable.

## [1.2.0] - 2026-07-13

### Added
- `@` file-tag autocomplete over the session working directory (server returns
  relative paths only; file contents are never read).

### Fixed
- CLAW'D mascot no longer shows a phantom second pair of eyes while eye-tracking.

## [1.1.1] - 2026-07-11

### Fixed
- Context gauge denominator follows the model's real context window (1M-context
  models no longer show ~5× inflated usage).

## [1.1.0] - 2026-07-11

### Added
- Status bar with official 5h/7d account utilization rings and context gauge.
- claude.ai-style model & effort picker; smooth rAF-paced streaming; CLAW'D mascot
  mood system; permission-mode revamp with toast notifications.

## [1.0.0] - 2026-07-09

First distributable release — streaming markdown chat, tool cards, permission
dialogs, session resume, local-only server (127.0.0.1 + token auth) driving the
locally installed Claude Code CLI. No SDK, no API key.

[Unreleased]: https://github.com/seokjw0727/CC-on-browser/compare/v1.7.1...HEAD
[1.7.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/seokjw0727/CC-on-browser/releases/tag/v1.0.0
