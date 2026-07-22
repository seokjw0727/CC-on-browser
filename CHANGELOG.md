# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Full bilingual (EN/KO) release notes live on the
[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) page.

## [1.6.0] - 2026-07-21

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
- **Trust mode (`bypassPermissions`) is now start-only.** Sessions spawned in any
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

[1.5.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/seokjw0727/CC-on-browser/releases/tag/v1.0.0
