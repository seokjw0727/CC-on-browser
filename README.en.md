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

- **Streaming markdown chat** — renders partial messages (`--include-partial-messages`) in real time, revealed smoothly by a per-frame pacer (typewriter-style, respects reduced-motion) instead of raw delta chunks. Code highlighting (highlight.js) + XSS sanitization (DOMPurify).
- **Tool execution cards** — Bash, Edit, Write, Read, Grep and other tool calls rendered as input/result cards; long results collapse.
- **Thinking blocks** — extended-thinking streams shown as separate, collapsible blocks.
- **Permission dialog** — `can_use_tool` requests pop up as a modal for allow/deny. Suggestions are labeled by their actual effect, never vague wording like "always allow". New sessions default to **bypassPermissions** (run everything without prompts) — change it anytime in the new-session modal or the composer; the dialog kicks in under confirmation-based modes. Modes are shown with Korean labels and per-mode colors: default (neutral), acceptEdits (blue), plan (green), bypassPermissions (red).
- **Session resume** — resume past sessions of the current project; the transcript is preloaded and continued (`--resume`).
- **Working-directory picker** — type or paste a path in the new-session modal, then click-select from the folder tree underneath.
- **Statusline** — circular gauges for session context (vs the model's window — 200k, or 1M for `[1m]` models) and your account's official
  5-hour / 7-day usage (%) — the same numbers as the `/usage` panel; local transcript aggregates in tooltips.
  Context is taken from the latest per-API-call usage (input + cache) — the turn-aggregated `result.usage`
  is not used, as it inflates with every tool round-trip.
  Per-turn token usage lands in the chat as a small CLI-style tail (`↑ 12 ↓ 345 tok · 5.3s`) instead of the statusline.
- **Runtime controls** — a claude.ai-style model picker (Haiku 4.5 / Sonnet 5 / Opus 4.8 / Fable 5, with
  versions and descriptions) and an effort-level progress bar (low–max; `--effort` is spawn-only, so changing
  it restarts the session into the same conversation — via `--resume` when the conversation exists on disk,
  or as a fresh start before the first turn), permission-mode switching, `/` slash-command autocomplete,
  turn interrupt (Esc). Setting-change confirmations and errors show as **transient toasts** — they never
  pollute the chat history.
- **Composer-centric UI** — no top bar; repo, permission mode, model, send, and usage fold into the composer. Light/dark themes, zero external font/image dependencies (brand assets are self-contained SVGs — safe under a local CSP).
- **A living mascot (CLAW'D)** — the composer's bottom-right hosts CLAW'D transcribed from the official
  art embedded in the Claude Code CLI itself (orange body rgb(215,119,87), black eyes, quadrant pixels),
  reacting to session state (mood vocabulary is a scaled-down port of
  [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)'s state mapping): blinking with
  **cursor-following eyes** while idle, a thought bubble (three dots) while the model generates, glancing
  left/right while tools run, claws-up juggling while a subagent (Task) runs, claws-up hopping (the
  official arms-up pose) while a permission prompt waits, cheering when a turn completes (dizzy on error —
  except turns you interrupted yourself),
  falling asleep with zzz after 60s of user inactivity (waking on input), and dozing when there is no
  session or the connection drops. Click it for a poke; four rapid pokes make it dizzy (easter egg). All
  done with self-contained SVG frame swaps + CSS (`prefers-reduced-motion` respected, zero external images).

## Requirements

- Windows / macOS / Linux + Node.js 22 or later
- [Claude Code CLI](https://claude.com/claude-code) installed and **logged in** (run `claude` → `/login`)
  - The app reuses the CLI's auth state as-is. If the CLI is not logged in, session start fails.

## Install / Run

### Option A — install the package (no build needed)

Grab `cc-on-browser-<version>.tgz` from [GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) and install it globally:

```sh
npm install -g ./cc-on-browser-1.1.1.tgz
cc-on-browser                # opens your browser; server runs in the background (default port 8787)
cc-on-browser --port 9000    # pick a port (-p); see --help for all options
cc-on-browser --no-open      # plain foreground console server, no browser (Ctrl+C to stop)
```

### Option B — run from source

```sh
git clone https://github.com/seokjw0727/CC-on-browser.git
cd CC-on-browser
npm run install:all   # install root (server) and client/ dependencies
npm run build         # client → client/dist
npm start             # = node bin/cc-on-browser.mjs
```

By default the command prints the access URL, **opens your default browser, and keeps the server
running in the background with no console window**. Once every browser tab is closed, the server
shuts itself down after a ~10-second grace period (page reloads reconnect well within it), so there
is nothing to stop manually.

```
Claude Code on Browser v1.1.1 — http://127.0.0.1:8787/#token=<random-token>
Opening your browser... The server runs in the background (127.0.0.1 only)
and stops automatically once every tab is closed. (--no-open for a foreground server)
```

Prefer watching the logs? Use `--no-open` — no browser is launched and the process stays in the
foreground like a regular server: open the printed URL (token included) yourself and stop it with
`Ctrl+C`. If the `claude` CLI cannot be found, a warning with install/PATH guidance is printed
(the server still starts, but sessions will fail).

**CLI path resolution order**: the `CLAUDE_WEB_CLI_PATH` environment variable (if set) → `claude` on the
OS `PATH` (`claude.exe` on Windows). If `claude` is on your PATH no extra setup is needed; if it lives
somewhere unusual, point `CLAUDE_WEB_CLI_PATH` at the absolute path.

### Subscription-free demo (fake CLI)

You can bring up the whole stack with a fake CLI that mimics the protocol instead of the real one:

```sh
node scripts/dev-fake.mjs                       # echo scenario (default port 8788)
node scripts/dev-fake.mjs --scenario permission # permission-dialog scenario (works in any shell)
node scripts/dev-fake.mjs --scenario question   # AskUserQuestion (question-dialog) scenario
```

If you prefer environment variables: POSIX shells use `FAKE_SCENARIO=permission node scripts/dev-fake.mjs`,
PowerShell uses `$env:FAKE_SCENARIO='permission'; node scripts/dev-fake.mjs`.

Tests also run exclusively against the fake CLI, so they never consume your subscription: `npm test`

## How to use

1. **Open the app** — by default the browser opens automatically. To connect manually (`--no-open`,
   or from another browser), open the URL printed at startup (`http://127.0.0.1:8787/#token=…`)
   as-is. A token-less address fails authentication.
2. **Start a new session** — click **새 세션** (new session) in the sidebar. In the modal, type/paste
   a working directory or click one from the folder tree / recent projects, optionally change the
   model and permission mode, then start (the effort level is adjusted from the composer after the
   session starts — see step 6). Defaults: your account's default model + bypassPermissions.
3. **Chat** — **Enter** sends, **Shift+Enter** inserts a newline. Responses stream as markdown, tool
   calls render as input/result cards, extended thinking as collapsible blocks. Interrupt a running
   turn with **Esc** or the stop button.
4. **Slash commands** — type `/` in the composer for an autocomplete dropdown (pick with Tab/Enter).
   Commands like `/compact` are passed through to the CLI.
5. **Permission prompts** — under confirmation-based permission modes, a dialog pops up before a tool
   runs; choose allow/deny. Switch the permission mode anytime from the composer. When Claude asks
   you something via **AskUserQuestion**, a question dialog (options, free-text input, skip) appears
   instead of the permission dialog.
6. **Model & effort changes** — switch models mid-conversation from the composer's model picker.
   Changing the effort level restarts the session into the same conversation (`--effort` is
   spawn-only — via `--resume` when the conversation exists on disk, or as a fresh start before the
   first turn).
7. **Resume sessions** — expand a project in the sidebar and click a past session to preload its
   transcript and continue. Conversations live in the CLI's `~/.claude` transcripts, so they survive
   server restarts.
8. **Reading the statusline** — the CTX gauge shows the current session's context usage against the
   model's window (200k, or 1M for `[1m]` models); the other gauges show your account's official
   5-hour / 7-day usage (%). Per-turn tokens appear as a small CLI-style tail in the chat
   (`↑ 12 ↓ 345 tok · 5.3s`).
9. **Shut down** — close every browser tab and the server exits on its own about 10 seconds later
   (in `--no-open` foreground mode, `Ctrl+C` in the terminal). Conversations remain in the CLI
   transcripts and can be resumed after the next start.

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
             [--resume <id>] [--model <m>] [--permission-mode <mode>] [--effort <level>]
             (cwd = selected project)
```

- Tool permission requests (`can_use_tool`) reach the server over stdio; the browser's permission dialog
  decides allow/deny and the answer is written back to the CLI.
- The spawned CLI loads your hooks, skills, and settings as usual — the browser UI is a front end to your
  real CLI environment.
- All knowledge of the undocumented CLI protocol is isolated in a single module: `server/src/claude-session.js`.

## Project layout

```
bin/cc-on-browser.mjs  CLI entry point — arg parsing & preflight checks, then a background server + browser launch;
                       auto-shutdown once every browser (WS client) is gone (npm start / global install)
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
  components/        Sidebar · Composer · ChatView · Message · ToolCard · ThinkingBlock · PermissionDialog · QuestionDialog · Toasts · Clawd · Brand
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
