# CC on Browser

[한국어](README.md) · **English**

A **local-only** web app for driving your installed Claude Code CLI from a browser.
Instead of the terminal TUI, you get streaming markdown chat, tool-execution cards,
permission dialogs, and a session-resume UI.

> **Unofficial project.** Not built, endorsed or sponsored by Anthropic.
> See the [trademark notice](#trademark-notice) below.

**No SDK, no API key.** It drives your locally installed `claude` CLI as a child
process, so authentication and billing follow your Claude subscription (e.g. Claude
Max) entirely. The server makes no outbound requests of its own by default. The one
exception is the status bar's official usage percentages, which are **off by default**:
turn them on in Settings and the server fetches one api.anthropic.com usage-metadata
endpoint using the subscription OAuth token the CLI already stored — not a model call,
so it costs nothing. [SECURITY.md](SECURITY.md) spells out what leaves the machine.

## Quick start

**You need** — ① Windows / macOS / Linux with [Node.js](https://nodejs.org) 22+
② the [Claude Code CLI](https://claude.com/claude-code) installed and **logged in**
(run `claude` in a terminal → `/login`).

Download `cc-on-browser-<version>.tgz` from
[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) and install it
globally (no build required):

```sh
npm install -g ./cc-on-browser-<version>.tgz
cc-on-browser
```

It prints the access URL, **opens your default browser, and keeps the server running
in the background** with no console window. Once every tab is closed the server stops
itself about 10 seconds later — nothing to shut down manually.

```
CC on Browser v<version> — http://127.0.0.1:8787/#token=<random>
Opening your browser... The server runs in the background (127.0.0.1 only)
and stops automatically once every tab is closed. (--no-open for a foreground server)
claude CLI: 2.1.215 (Claude Code)
```

Common options:

```sh
cc-on-browser --port 9000    # pick a port (-p)
cc-on-browser --no-open      # plain foreground console server (Ctrl+C to stop)
cc-on-browser --shortcut     # (Windows) create a console-free launch shortcut
cc-on-browser --help         # all options
```

### Launching without a console window (Windows)

Running `cc-on-browser` from Win+R or by double-clicking flashes a command prompt
for 1–3 seconds. That console is created by npm's generated `cc-on-browser.cmd`
before Node even starts, so the app cannot hide it. Run this **once**:

```sh
cc-on-browser --shortcut
```

You get a **"CC on Browser"** shortcut on your Desktop and in the Start
Menu; launching from there shows **only your browser** — no console at all
(internally `wscript.exe` starts the server with a hidden window). Re-run
`--shortcut` if you reinstall Node and its path changes.

### Re-running while it is already up

The server outlives the browser for a while (about 10 seconds after you
deliberately close every tab; longer if the connection was merely lost to sleep).
Re-running `cc-on-browser` during that window no longer fails — it **opens a new
tab into the running server**, and your live CLI sessions are still there.

```
Already running (v<version>) on port 8787 — opened a new browser tab.
```

> Once the package is published to the npm registry, `npm install -g cc-on-browser`
> will work too — the Releases page will say when that is live.

## What you get

- **Streaming markdown chat** — partial messages (`--include-partial-messages`)
  rendered live, revealed smoothly by a frame-paced typewriter (respects
  reduced-motion). Code highlighting (highlight.js) + XSS sanitization (DOMPurify).
- **Tool-execution cards** — Bash/Edit/Write/Read/Grep calls shown as input/result
  cards; long results collapse.
- **Thinking blocks** — extended-thinking streams shown as separate collapsible blocks.
- **Permission dialogs** — `can_use_tool` requests appear as a modal to allow/deny;
  suggestions describe their actual effect instead of vague "always allow" wording.
  **New sessions default to the `default` permission mode** — the CLI asks before
  tool uses that need confirmation under its policy and your allow rules.
  You can switch between default/acceptEdits/plan any time in the composer;
  modes are color-coded (default/uncolored, acceptEdits/blue, plan/green, trust/red).
  **Trust mode (`bypassPermissions`) can only be selected at session start** (in the
  new-session modal) — a session started in any other mode cannot switch into trust
  mode at runtime (enforced server-side). A session started in trust mode may leave
  and return to it.
- **Session resume + past-session management** — the **new-session modal's "past
  sessions" list** (summary title · last access · transcript size; 20 by default,
  50 via "더 보기 / show more") resumes a conversation in one click (`--resume`);
  delete unneeded sessions after a confirmation (live sessions are protected).
  Resuming uses **the model and permission mode selected in that same modal** —
  leaving the model at "(기본 모델)" omits `--model`, so the session keeps whatever
  model it was using. The sidebar now lists only currently open sessions.
- **Working-directory picker** — native Windows folder dialog (plain text input on
  other platforms).
- **Status bar** — session context (vs. the model's window — 200k, or 1M for `[1m]`
  models). Enable **official account usage** in Settings (off by default) to also get
  5-hour/7-day utilization rings; with it off you get local transcript token counts
  only. Per-turn tokens appear as small chat tails (`↑ 12 ↓ 345 tok · 5.3s`), like the CLI.
- **Runtime controls** — claude.ai-style model picker and effort bar, permission-mode
  switch, `/` slash-command and `@` file-reference autocomplete, turn interrupt (Esc).
  Confirmations and errors show as **toast notifications**.
- **Composer-centric UI** — no top bar; repo, permission mode, model, send and usage
  fold into the input area. Light/dark themes, zero external font/image dependencies.
- **A living mascot (CLAW'D)** — a pixel rendition of Claude Code's mascot character,
  reacting to session state (idle blinking with cursor-tracking eyes, thinking
  bubble, tool-scan scuttle, subagent juggling, permission hop, turn cheers, zzz after
  60s idle — respects `prefers-reduced-motion`).
- **Remote Control** — **right-click a session row in the sidebar** (Shift+F10 from
  the keyboard) and pick "원격 제어 켜기" to start `claude remote-control` for that
  repository, so you can drive it from claude.ai/code and the Claude mobile app. The
  same menu reaches sessions in projects you are not currently looking at. A live row
  carries a 📱 marker, and once the connect URL arrives the menu grows an
  "claude.ai/code에서 열기" entry. **While it is on, closing the browser does not shut
  the app down** (that is the whole point) — turn it off when you are done. Read
  [SECURITY.md](SECURITY.md) for what it exposes.
- **Running-work dock** — background shells, background agents and in-flight tools
  are listed *below* the input; click one to jump to its card in the transcript.
  The list comes from the CLI's own running-task snapshot, so it shows exactly
  what is actually running.
- **Message timestamps** — user messages and assistant answers carry a small 24h
  `HH:MM`. Resumed conversations show when things actually happened; hover for the
  full date.
- **Sleep survival** — if the connection drops from laptop-lid close or suspend, the
  server keeps live CLI sessions and reattaches automatically on wake.

## How to use

1. **Connect** — the default launch opens your browser automatically. For manual
   access, open the printed `http://127.0.0.1:8787/#token=…` URL as-is (URLs without
   the token fail authentication).
2. **Start a session** — sidebar **새 세션 (New session)** → pick the working
   directory → optionally change model/permission mode → start. Defaults are your
   account's default model + the **`default` permission mode** (asks before tool
   uses that need confirmation). The no-confirmation trust mode
   (`bypassPermissions`) is available with a warning, and **only at session
   start** — switching into it mid-session is blocked. Resuming happens in the same
   modal, so the model and permission mode selected there apply to it too (this is
   the only way to resume in trust mode). To avoid choosing every time, set a
   **default model and default permission mode under the sidebar's "설정"
   (Settings)** — they seed the new-session modal's initial selection and never
   affect already-running sessions. The model list is reported by the CLI at session
   `init`, so you must start one session before a default model can be picked.
3. **Chat** — **Enter** sends, **Shift+Enter** adds a newline. Interrupt a running
   turn with **Esc** or the stop button.
4. **Slash commands / @ file references** — typing `/` or `@` opens autocomplete
   (Tab/Enter to accept).
5. **Permissions** — in confirming modes a dialog appears before each tool run.
   When Claude asks a question (AskUserQuestion), a question dialog with options,
   free-text input and skip appears instead.
6. **Model & effort** — change mid-conversation from the composer. Effort applies
   **without restarting the session** (the CLI's runtime channel). Only CLIs that do
   not know that channel fall back to restarting onto the same conversation, and you
   get a heads-up toast before that happens.
7. **Resume & delete** — open **새 세션 (New session)** and click a past session to
   resume it (with the model/mode selected above); the trash button deletes it (live
   sessions are protected). Transcripts live in `~/.claude`, so history survives
   server restarts.
8. **Quit** — close every tab and the server stops ~10s later (`--no-open`: Ctrl+C).
   **Running CLI sessions end with it**: the server waits until the session process
   and its children (shells, MCP servers) are really gone before it exits. To leave a
   long task running while closing the browser, turn remote control on first.
   Suspend/lid-close is not treated as quitting.

## Troubleshooting

| Symptom | Cause · fix |
| --- | --- |
| `WARNING: claude CLI not found` | CLI not installed or not on PATH. [Install it](https://claude.com/claude-code), check `claude` runs in a terminal, or set `CLAUDE_WEB_CLI_PATH` to its absolute path. |
| Sessions fail to start | CLI not logged in — run `claude`, then `/login`. |
| Remote control fails with `Workspace not trusted` | You have not accepted that folder's trust dialog yet. Run `claude` once in that directory and accept it, then turn remote control back on (the app will not accept it for you — that is a security decision). |
| A console window flashes on launch | That window comes from npm's `.cmd` shim. Use the shortcut created by `cc-on-browser --shortcut` and no console appears ([see above](#launching-without-a-console-window-windows)). |
| `Port 8787 is already in use` | Another program owns that port, or one of our own instances is there but **could not be recognized** (older version, missing or corrupt instance file). When it is recognized you get a new tab instead of an error — otherwise pick another port: `cc-on-browser --port 9000`. |
| Changing effort restarts the session, or `unknown message type: setEffort` | An **older background server** from before the upgrade is still running, so the new UI is paired with an old server (the sidebar shows a version warning at the bottom). Close every session and re-run the app — the launcher replaces an idle stale server automatically. |
| 401 / blank page | You opened a URL without the token — use the full printed `#token=` URL. |
| Browser does not open | Run with `--no-open` and open the printed URL yourself; the `BROWSER` env var selects which browser to launch. |
| Server stops (or doesn't) unexpectedly | All tabs closed = auto-stop after ~10s (by design). Connection loss (suspend) waits as long as a session is alive (30-min grace when none). |
| Odd behavior after a CLI update | See [Protocol warning](#protocol-warning) — please file an issue with your CLI version. |

**Environment variables**: `PORT` (=`--port`) · `BROWSER` (command used to open the
URL) · `CLAUDE_WEB_CLI_PATH` (absolute path to the CLI). CLI resolution order:
`CLAUDE_WEB_CLI_PATH` → `claude` on the OS `PATH` (`claude.exe` on Windows).

## Run from source / development

```sh
git clone https://github.com/seokjw0727/CC-on-browser.git
cd CC-on-browser
npm run install:all   # install root (server) + client/ dependencies
npm run build         # client → client/dist
npm start             # = node bin/cc-on-browser.mjs
```

### Subscription-free demo (fake CLI)

Bring up the whole stack against a protocol-mimicking fake CLI:

```sh
node scripts/dev-fake.mjs                       # echo scenario (default port 8788)
node scripts/dev-fake.mjs --scenario permission # permission-dialog scenario
node scripts/dev-fake.mjs --scenario question   # AskUserQuestion dialog scenario
```

### Tests

Everything runs against the fake CLI only — no subscription usage:

```sh
npm test              # server & client unit/integration (node --test)
npm run build && npx playwright install chromium
npm run test:e2e      # browser E2E (Playwright — session start, streaming, permission round-trip)
```

## Architecture

```
Browser (SPA: Vite + React)
   │  WebSocket + REST (127.0.0.1, token auth, Origin checks)
   ▼
Node server (server/src/server.js — http + ws)
   ├─ static: serves client/dist
   ├─ REST: /api/bootstrap /api/projects /api/sessions /api/transcript /api/browse /api/usage
   └─ SessionHub ── ClaudeSession (one CLI process per session, ring-buffer replay)
         │  spawn (stdio pipe, JSONL)
         ▼
      claude -p --input-format stream-json --output-format stream-json
             --verbose --include-partial-messages --permission-prompt-tool stdio
             [--resume <id>] [--model <m>] [--permission-mode <mode>] [--effort <level>]
             (cwd = the selected project)
```

- Tool permission requests (`can_use_tool`) reach the server over stdio; the
  browser's permission dialog decides allow/deny and replies to the CLI.
- The spawned CLI loads your hooks, skills and settings as usual — the browser UI is
  a front-end to your real CLI environment.
- All undocumented-protocol knowledge is isolated in `server/src/claude-session.js`.

## Project layout

```
bin/cc-on-browser.mjs  CLI entry — arg parsing & pre-checks, background server + browser launch
bin/shortcut.mjs       --shortcut (Windows) — creates a console-free .lnk
bin/cc-on-browser-silent.vbs  the launcher that shortcut invokes (wscript = no console)
server/src/
  server.js          HTTP (REST + static) + WebSocket hub. 127.0.0.1-only, token/Origin auth
  session-hub.js     session registry — key↔ClaudeSession, event broadcast/replay
  claude-session.js  wraps one CLI child process — stream-json I/O, protocol isolation
  lifecycle.js       daemon lifetime state machine — tab close vs. sleep, idle shutdown
  instance-file.js   ~/.cc-on-browser/instance-<port>.json — recognises our own daemon
  history.js         reads ~/.claude projects/sessions/transcripts (resume & delete)
  cli-session-names.js  caches the session names the CLI assigns
  usage.js           local transcript aggregation — 5h/7d reference numbers (/api/usage)
  quota.js           official account utilization (5h/7d %) — opt-in; only then is api.anthropic.com called
  fs-api.js          directory listing, filename search, native folder picker — file contents never served
  preview-api.js     artifact preview tickets & serving (scoped to the session cwd)
  attachments.js     paste attachments — clipboard file paths, bitmap temp storage
  git-api.js         branch/worktree info, worktree create & remove
  remote-control.js  manages the `claude remote-control` process (opt-in feature)
  claude-config.js   reads and atomically replaces ~/.claude/settings.json
  claude-plugins.js  lists installed plugins
  kill-tree.js       terminates a session process and its children
  jsonl.js           line-oriented JSON parser
client/src/
  App.jsx            shell layout & theme
  lib/               store.jsx (state) · ws.js (auto-reconnect) · reduce-cli-event.js · markdown.js · api.js · clawd.js (mascot data)
  components/        Sidebar · Composer · ChatView · Message · ToolCard · ThinkingBlock · PermissionDialog · QuestionDialog · Toasts · Clawd · Brand · PreviewPanel · WorktreePanel
  fonts/             bundled fonts (Pretendard · Monoplex KR) — licenses in client/public/licenses/
scripts/dev-fake.mjs subscription-free demo launcher (fake CLI)
server/test/         fake-CLI-based unit/integration tests (never runs the real claude)
client/test/         pure-logic unit tests (node --test)
e2e/                 Playwright browser E2E (fake CLI stack)
docs/specs/          archived design snapshot
```

## Security

This app drives a CLI that can access your filesystem and shell. **Never expose it
remotely**, never share the token URL — please read the threat model and notes in
[SECURITY.md](SECURITY.md). Report vulnerabilities privately (see SECURITY.md), not
via public issues.

## CLI compatibility

The stream-json control protocol (including `--permission-prompt-tool stdio`) is an
**officially undocumented interface**. The protocol was **probed and verified against
Claude Code CLI v2.1.201**, and the app is **confirmed working up to v2.1.215**. CLI
updates may change the format; unknown messages are never dropped — they surface in
the UI as raw events.

<a id="protocol-warning"></a>If you suspect a protocol change, re-verify against §2
(observed CLI behaviour) of
[`docs/specs/2026-07-06-claude-code-on-browser-design.md`](docs/specs/2026-07-06-claude-code-on-browser-design.md).

## Limitations (out of v1 scope)

Image attachments, subagent tree visualization, MCP server management UI, PTY
terminal tabs, multi-browser concurrent session sync, remote (non-localhost) access.

## Trademark notice

"Claude", "Claude Code" and "Anthropic" are trademarks of Anthropic, PBC, and Clawd is
Anthropic's mascot character. **This project is not affiliated with Anthropic, and was
not built, endorsed or sponsored by them.** Those names are used only to state, factually,
what this app does: it is a local web UI that runs the Claude Code CLI you installed
yourself. This project's own name is **CC on Browser**.

## Changelog · License

[CHANGELOG.md](CHANGELOG.md) · [MIT](LICENSE)

The bundled fonts (Pretendard, Monoplex KR) and libraries (React, marked, DOMPurify,
highlight.js, ws) keep their own licenses — full notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
