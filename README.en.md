# Claude Code on Browser

[한국어](README.md) · **English**

A **local-only** web app for using CLI-based Claude Code from your browser.
Instead of the terminal TUI, it gives you streaming markdown chat, tool-execution cards, permission dialogs, and a session-resume UI.

**No SDK, no API.** There is no `@anthropic-ai/sdk` and no `claude-agent-sdk` —
the app drives your locally installed `claude` CLI as a child process. Authentication and billing follow your
Claude subscription (e.g., Claude Max) entirely; no API key is required. One deliberate exception: the
statusline's official usage percentages come from a single usage-metadata endpoint on api.anthropic.com,
queried with the OAuth token the CLI already stores — not a model call, so it never incurs charges.

## What you get

- **Streaming markdown chat** — renders partial messages (`--include-partial-messages`) in real time. Code highlighting (highlight.js) + XSS sanitization (DOMPurify).
- **Tool execution cards** — Bash, Edit, Write, Read, Grep and other tool calls rendered as input/result cards; long results collapse.
- **Thinking blocks** — extended-thinking streams shown as separate, collapsible blocks.
- **Permission dialog** — `can_use_tool` requests pop up as a modal for allow/deny. Suggestions are labeled by their actual effect, never vague wording like "always allow".
- **Session resume** — resume past sessions of the current project; the transcript is preloaded and continued (`--resume`).
- **Working-directory picker** — type or paste a path in the new-session modal, then click-select from the folder tree underneath.
- **Statusline** — circular gauges for session context (vs the 200k window) and your account's official
  5-hour / 7-day usage (%) — the same numbers as the `/usage` panel; local transcript aggregates in tooltips.
- **Runtime controls** — a claude.ai-style model picker (Haiku 4.5 / Sonnet 5 / Opus 4.8 / Fable 5, with
  versions and descriptions) and an effort-level progress bar (low–max; `--effort` is spawn-only, so changing
  it restarts the session into the same conversation via `--resume`), permission-mode switching,
  `/` slash-command autocomplete, turn interrupt (Esc).
- **Composer-centric UI** — no top bar; repo, permission mode, model, send, and usage fold into the composer. Light/dark themes, zero external font/image dependencies (brand assets are self-contained SVGs — safe under a local CSP).

## Requirements

- Windows / macOS / Linux + Node.js 22 or later
- [Claude Code CLI](https://claude.com/claude-code) installed and **logged in** (run `claude` → `/login`)
  - The app reuses the CLI's auth state as-is. If the CLI is not logged in, session start fails.

## Install / Run

### Option A — install the package (no build needed)

Grab `cc-on-browser-<version>.tgz` from [GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) and install it globally:

```sh
npm install -g ./cc-on-browser-1.0.0.tgz
cc-on-browser                # default port 8787 (the PORT env var works too)
cc-on-browser --port 9000    # pick a port (-p); see --help for all options
```

### Option B — run from source

```sh
git clone https://github.com/seokjw0727/CC-on-browser.git
cd CC-on-browser
npm run install:all   # install root (server) and client/ dependencies
npm run build         # client → client/dist
npm start             # = node bin/cc-on-browser.mjs
```

On startup the console prints the access URL:

```
Claude Code on Browser v1.0.0 — http://127.0.0.1:8787/#token=<random-token>
```

Open that URL (token included) in your browser. If the `claude` CLI cannot be found, a warning with
install/PATH guidance is printed (the server still starts, but sessions will fail).

**CLI path resolution order**: the `CLAUDE_WEB_CLI_PATH` environment variable (if set) → `claude` on the
OS `PATH` (`claude.exe` on Windows). If `claude` is on your PATH no extra setup is needed; if it lives
somewhere unusual, point `CLAUDE_WEB_CLI_PATH` at the absolute path.

### Subscription-free demo (fake CLI)

You can bring up the whole stack with a fake CLI that mimics the protocol instead of the real one:

```sh
node scripts/dev-fake.mjs                       # echo scenario (default port 8788)
node scripts/dev-fake.mjs --scenario permission # permission-dialog scenario (works in any shell)
```

If you prefer environment variables: POSIX shells use `FAKE_SCENARIO=permission node scripts/dev-fake.mjs`,
PowerShell uses `$env:FAKE_SCENARIO='permission'; node scripts/dev-fake.mjs`.

Tests also run exclusively against the fake CLI, so they never consume your subscription: `npm test`

## Architecture

```
Browser (SPA: Vite + React)
   │  WebSocket + REST (127.0.0.1, token auth, Origin validation)
   ▼
Node server (server/src/server.js — http + ws)
   ├─ static: serves client/dist
   ├─ REST: /api/bootstrap /api/projects /api/sessions /api/transcript /api/browse /api/usage
   └─ SessionHub ── ClaudeSession (one CLI process per session, ring-buffer event replay)
         │  spawn (stdio pipe, JSONL)
         ▼
      claude -p --input-format stream-json --output-format stream-json
             --verbose --include-partial-messages --permission-prompt-tool stdio
             [--resume <id>] [--model <m>] [--permission-mode <mode>]  (cwd = selected project)
```

- Tool permission requests (`can_use_tool`) reach the server over stdio; the browser's permission dialog
  decides allow/deny and the answer is written back to the CLI.
- The spawned CLI loads your hooks, skills, and settings as usual — the browser UI is a front end to your
  real CLI environment.
- All knowledge of the undocumented CLI protocol is isolated in a single module: `server/src/claude-session.js`.

## Project layout

```
bin/cc-on-browser.mjs  CLI entry point — arg parsing & preflight checks, then starts the server (npm start / global install)
server/src/
  server.js          HTTP (REST + static) + WebSocket hub. 127.0.0.1-only, token/Origin auth
  session-hub.js     Session registry — key↔ClaudeSession, event broadcast/replay relay
  claude-session.js  Wraps one CLI child process — stream-json I/O, undocumented protocol isolated here
  history.js         Reads ~/.claude projects/sessions/transcripts (for session resume)
  usage.js           Local aggregation over ~/.claude transcripts — 5h/7d reference (/api/usage)
  quota.js           Official account usage (5h/7d %) — uses the CLI's OAuth token; the only api.anthropic.com touchpoint
  fs-api.js          Directory listing (/api/browse) — never serves file contents
  jsonl.js           Line-delimited JSON parser
client/src/
  App.jsx            Shell layout & theme owner
  lib/               store.jsx (state) · ws.js (auto-reconnect) · reduce-cli-event.js (CLI events→state) · markdown.js · api.js
  components/        Sidebar · Composer · ChatView · Message · ToolCard · ThinkingBlock · PermissionDialog · Brand
scripts/dev-fake.mjs Subscription-free demo launcher (fake CLI)
server/test/         Integration/unit tests against the fake CLI (never runs the real claude)
docs/superpowers/    Spec & plan documents
```

## Security notes

- The server binds to `127.0.0.1` only. **Never expose it remotely** (port forwarding, reverse proxies) —
  this app drives a CLI that can access your filesystem and shell.
- A random token generated at startup is delivered via the URL fragment (`#token=`). Do not share that URL.
  The WebSocket re-sends it as the `?token=` query and REST as the `x-auth-token` header; the Origin header
  is validated as well.
- The filesystem API (`/api/browse`) lists directories only. File-content access goes through CLI tools and
  the permission dialog.

## Limitations (out of v1 scope)

Image attachments, subagent tree visualization, MCP server management UI, PTY terminal tabs,
multi-browser concurrent-client sync, remote (non-localhost) access.

## Protocol warning

The stream-json control protocol (including `--permission-prompt-tool stdio`) is an **officially
undocumented interface** (verified empirically against CLI v2.1.201). CLI updates may change the format;
unknown messages are never dropped — they surface in the UI as raw events. If you suspect a protocol change,
re-verify with the probe procedure in `docs/superpowers/specs/2026-07-06-claude-code-on-browser-design.md`.

## License

[MIT](LICENSE)
