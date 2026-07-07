# Claude Code on Browser

CLI 기반 Claude Code를 브라우저에서 쓰는 **로컬 전용** 웹 앱.
터미널 TUI 대신 스트리밍 마크다운 채팅, 도구 실행 카드, 권한 다이얼로그, 세션 재개 UI를 제공합니다.

**SDK/API를 사용하지 않습니다.** `@anthropic-ai/sdk`, `claude-agent-sdk`, api.anthropic.com 직접 호출 없이,
로컬에 설치된 `claude` CLI를 자식 프로세스로 구동합니다. 인증과 과금은 전적으로 사용자의
Claude 구독(예: Claude Max)을 따르며, API 키가 필요 없습니다.

## 요구사항

- Windows / macOS / Linux + Node.js 20 이상
- [Claude Code CLI](https://claude.com/claude-code) 설치 및 **로그인 완료** (`claude` 실행 → `/login`)
  - 이 앱은 CLI의 인증 상태를 그대로 사용합니다. CLI에서 로그인돼 있지 않으면 세션 시작이 실패합니다.

## 설치 / 빌드 / 실행

```sh
npm run install:all   # server/, client/ 의존성 설치
npm run build         # client → client/dist
npm start             # 서버 기동 (기본 포트 8787, PORT 또는 --port 로 변경)
```

기동하면 콘솔에 접속 URL이 출력됩니다:

```
Claude Code on Browser: http://127.0.0.1:8787/#token=<랜덤토큰>
```

이 URL(토큰 포함)로 브라우저에서 접속하세요. `claude` 실행 파일 경로가 PATH에 없다면
`CLAUDE_WEB_CLI_PATH` 환경변수로 지정할 수 있습니다.

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
   ├─ REST: /api/bootstrap /api/projects /api/sessions /api/transcript /api/browse
   └─ SessionHub ── ClaudeSession (세션당 CLI 프로세스 1개, 이벤트 링버퍼 리플레이)
         │  spawn (stdio pipe, JSONL)
         ▼
      claude -p --input-format stream-json --output-format stream-json
             --verbose --include-partial-messages --permission-prompt-tool stdio
             [--resume <id>] [--model <m>] [--permission-mode <mode>]  (cwd = 선택한 프로젝트)
```

- 도구 권한 요청(`can_use_tool`)은 stdio로 서버에 전달되고, 브라우저의 권한 다이얼로그에서
  허용/거부를 결정해 CLI에 회신합니다.
- 스폰된 CLI는 사용자의 훅·스킬·설정을 그대로 로드합니다 — 브라우저 UI는 실제 CLI 환경의 전면부입니다.
- 미문서 CLI 프로토콜 지식은 `server/src/claude-session.js` 한 모듈에 격리돼 있습니다.

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
