# Claude Code on Browser — 설계 문서

날짜: 2026-07-06
상태: 승인 대기 (자율 모드 — /goal 지시에 따라 설계 결정을 문서화하고 진행)

## 1. 목표

CLI 기반 Claude Code를 브라우저에서 사용할 수 있게 하는 로컬 웹 앱.

- **개선된 UI**: 터미널 TUI 대신 현대적인 채팅 인터페이스 (스트리밍 markdown, 도구 실행 카드, diff 뷰, 권한 다이얼로그).
- **개선된 UX**: 세션 목록/재개, 프로젝트(cwd) 선택, 모델·권한 모드 전환, slash command 자동완성, 사용량 표시, 중단(interrupt).
- **SDK API 사용 금지**: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, api.anthropic.com 직접 호출 모두 금지. 오직 로컬에 설치된 `claude.exe`(구독 인증 완료 상태)를 자식 프로세스로 구동. 인증·과금은 전적으로 사용자의 Claude Max 구독을 따른다.

## 2. 검증된 사실 (이 머신에서 직접 프로브, CLI v2.1.201)

설계는 추측이 아니라 아래 실측에 기반한다:

1. `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio` 가 모두 유효한 플래그.
2. **초기화**: stdin으로 `{"type":"control_request","request_id":"...","request":{"subtype":"initialize"}}` 전송 → stdout으로 slash command 목록, 에이전트, 모델 목록, output style, **계정 정보(subscriptionType: Claude Max, apiProvider: firstParty)** 가 담긴 `control_response` 수신.
3. **user 턴**: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` 한 줄 JSONL 전송.
4. **권한 라우팅**: allowlist에 없는 도구 사용 시 CLI가 stdout으로
   `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Write","input":{...},"description":"...","permission_suggestions":[...],"tool_use_id":"..."}}`
   를 보냄. 우리가
   `{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"allow","updatedInput":{...}}}}`
   로 응답하면 실행됨. (deny는 `{"behavior":"deny","message":"..."}`)
   allow 응답에 `updatedPermissions`(수락한 permission_suggestions 에코)를 추가로 실을 수 있다 —
   이는 프로브 실측이 아닌 SDK PermissionResult 관례이며, 실 CLI 수용 여부는 E2E(Task 9 Step 2)에서 확인한다.
5. **멀티턴**: `result` 수신 후 같은 프로세스 stdin에 다음 user 메시지를 보내면 같은 session_id로 이어짐. 프로세스 재spawn 불필요.
6. **스트림 이벤트**: `stream_event`(text_delta 등), `system/thinking_tokens`, `system/status`, `rate_limit_event`, tool_result가 담긴 `user` 메시지, 최종 `result`(usage, total_cost_usd, num_turns) 수신.
7. 스폰된 CLI는 사용자의 훅·스킬·설정을 그대로 로드 → 브라우저 UI는 사용자의 실제 CLI 환경의 전면부가 된다.
8. 세션 파일: `~/.claude/projects/<cwd를 -로 인코딩한 경로>/<session_id>.jsonl`. `--resume <id>`로 재개(이전 메시지 재전송 금지).
9. (2026-07-10 추가, CLI v2.1.205 **바이너리 문자열 분석** — 런타임 프로브 아님) control_request 서브타입 `set_max_thinking_tokens`(`max_thinking_tokens`: null=기본/0=끔/양수=예산, CLI 내부 클라이언트가 동일 채널 사용) 확인 — 서버 계층에 setThinking으로 구현(현 UI는 미노출). `rate_limit_event`의 rate_limit_info에는 사용률 %가 없음(status/resetsAt/rateLimitType뿐)도 transcript 실측으로 확인.
10. (2026-07-10 추가, 동일 바이너리 분석) `--effort <level>`(low|medium|high|xhigh|max, 기본 high)은 **spawn 전용** — 런타임 변경 서브타입이 없고 apply_flag_settings 문맥에 "can't change server effort" 문자열 존재. 따라서 노력 수준 변경 UI는 stop → `--resume`+`--effort` 재스폰(대화 이월)으로 구현.
11. (2026-07-10 추가, CLI v2.1.206 **handshake 런타임 프로브** — 유저 메시지 미전송, 토큰 소모 0) `system/init`은 첫 user 메시지 전에는 방출되지 않고, **무턴 세션은 트랜스크립트(jsonl)를 만들지 않는다** — 그 id로 `--resume`하면 stderr "No conversation found" + exit 1. ⇒ 노력 변경 재시작은 **완결 턴 ≥1 또는 재개로 시작한 세션만** `--resume`을 붙인다(클라이언트 hasCompletedTurn 게이트, 그 외에는 새로 시작 — 잃을 서버측 맥락 없음). 실존 세션 `--resume`은 과거 대화를 replay하지 않음(이월 메시지와 중복 없음).
12. (동일 프로브) `set_model` 성공 시 `<local-command-stdout>…</local-command-stdout>` 문자열 content의 `user` 이벤트(`isReplay:true`)가 동반된다 — 클라이언트 리듀서가 채팅에서 걸러내고 설정 변경 확인은 토스트로 표시. `set_permission_mode`는 4개 모드 전부 런타임 전환 성공(`system/status`에 새 permissionMode 동반), spawn `--permission-mode bypassPermissions`도 정상.
13. (2026-07-10 추가, CLI v2.1.206 **바이너리 문자열 분석**) CLAW'D 마스코트의 공식 자산이 바이너리에 내장돼 있다: 테마 색 `clawd_body: rgb(215,119,87)` / `clawd_background: 검정`, 3행 쿼드런트 블록 아트(` ▐▛███▜▌` / `▝▜█████▛▘` / `  ▘▘ ▝▝`), 포즈 4종(default / look-left / look-right / arms-up — 눈 블록 `▛███▜`→`▟███▟`→`▙███▙`과 팔 블록 차이). 웹 마스코트(client/src/lib/clawd.js)는 이 아트의 쿼드런트 전사(18×5, 1픽셀=쿼드런트 1:2 종횡비)다. 채팅의 턴별 토큰 꼬리표(usage 아이템)는 `result.usage.input_tokens/output_tokens` + `duration_ms`에서 취한다(토큰 0이면 생략).

주의: stream-json 제어 프로토콜은 공식 미문서 인터페이스다. CLI 업데이트로 형식이 바뀔 수 있으므로 프로토콜 계층을 한 모듈로 격리하고, 알 수 없는 메시지는 무시가 아닌 "raw 이벤트"로 UI에 전달할 수 있게 설계한다.

## 3. 검토한 접근 방식

### A. PTY + xterm.js (터미널 미러링)
node-pty(ConPTY)로 대화형 CLI를 그대로 브라우저 터미널에 표시.
- 장점: 완전한 기능 충실도(모든 TUI 기능 동작).
- 단점: "브라우저 속 터미널"일 뿐 **개선된 UI/UX라는 목표를 달성하지 못함**. Windows 네이티브 빌드 의존성(node-gyp) 취약. TUI 리렌더링 아티팩트.

### B. Headless stream-json 브리지 + 커스텀 채팅 UI ★ 채택
Node 서버가 `claude.exe`를 stream-json 모드로 spawn, WebSocket으로 브라우저와 중계. 브라우저는 전용 채팅 UI.
- 장점: 목표(개선된 UI/UX)에 정합. 프로브로 전 구간 검증 완료. 외부 네이티브 의존성 없음. SDK 미사용.
- 단점: 미문서 프로토콜 의존(§2 주의로 완화), 대화형 전용 기능 일부는 자체 구현 필요(자동완성 등 — initialize 응답으로 해결).

### C. B + PTY 터미널 탭 (하이브리드)
- 판단: v1 범위 밖. B의 아키텍처가 확장을 막지 않으므로 YAGNI로 보류.

## 4. 아키텍처

```
브라우저 (SPA: Vite + React)
   │  WebSocket (127.0.0.1, 토큰 인증, Origin 검증)
   ▼
Node 서버 (ESM, http + ws)
   ├─ static: 빌드된 SPA 서빙
   ├─ REST: 세션 목록 / 프로젝트(cwd) 목록·탐색
   └─ SessionHub: sessionKey → ClaudeSession
         │  spawn (stdio pipe)
         ▼
      claude.exe -p --input-format stream-json --output-format stream-json
                 --verbose --include-partial-messages --permission-prompt-tool stdio
                 [--resume <id>] [--model <m>] [--permission-mode <mode>] [--effort <level>]
                 (cwd = 선택한 프로젝트)
```

### 4.1 서버 모듈 (server/src/)

| 모듈 | 책임 | 의존 |
|---|---|---|
| `jsonl.js` | 스트림 → 한 줄 JSON 파싱(버퍼링, 불완전 라인 처리) | 없음 |
| `claude-session.js` | CLI 프로세스 1개의 수명 관리: spawn/kill, initialize, user 턴 전송, control_request 상관관계(pending map), interrupt, 이벤트 방출(EventEmitter) | jsonl |
| `session-hub.js` | 다중 세션 관리, WS 클라이언트 ↔ 세션 바인딩, 재접속 시 이벤트 버퍼 리플레이 | claude-session |
| `history.js` | `~/.claude/projects/*` 스캔: 프로젝트 목록, 세션 메타(제목·시각·요약) 파싱 | 없음 |
| `fs-api.js` | cwd 피커용 디렉터리 탐색(드라이브/폴더 나열, 경로 검증) | 없음 |
| `server.js` | http 서버(static+REST), ws 업그레이드, 인증(랜덤 토큰), Origin 검증 | 전부 |

**격리 원칙**: 미문서 CLI 프로토콜 지식은 `claude-session.js` 안에만 존재. UI와 WS 프로토콜은 자체 정의 메시지로 통신하고, 원본 CLI 메시지는 `{type:"cli-event", payload}`로 투명 전달해 프로토콜 변화에 유연하게 대응.

### 4.2 WS 프로토콜 (서버 ↔ 브라우저, 자체 정의)

클라이언트→서버: `start`(cwd, model, permissionMode, resumeId?), `user_message`(text), `permission_decision`(requestId, allow|deny, updatedInput?, message?), `interrupt`, `set_model`, `set_permission_mode`, `close_session`.
서버→클라이언트: `session_started`(sessionKey, initInfo), `cli-event`(CLI stdout 메시지 원본+가공), `permission_request`(requestId, toolName, input, description, suggestions), `session_exit`(code), `error`.

### 4.3 클라이언트 (client/src/)

- `ChatView`: 메시지 타임라인. text_delta 스트리밍 조립, markdown(marked)+하이라이트(highlight.js), thinking 접기 패널. 어시스턴트 텍스트는 rAF 페이서(lib/stream-pace, 시간 기반·MAX_LAG 4000·reduced-motion 존중)로 delta 덩어리를 부드럽게 드러내고, 하단 고정은 ResizeObserver(콘텐츠+스크롤포트)와 레이아웃 가드(컴포저 확장/축소로 인한 scrollTop 클램프를 사용자 스크롤로 오인하지 않음)로 유지(2026-07-10).
- `ToolCard`: tool_use/tool_result 페어 렌더. Bash(명령+출력), Edit/Write(diff/코드), Read/Grep(요약), 기타(JSON 뷰).
- `PermissionDialog`: can_use_tool 표시 — 도구명, 입력(명령/파일/diff), [허용]/[항상 허용(제안 적용)]/[거부+사유]. 응답 전까지 해당 세션 턴은 대기 상태 표시.
- `Sidebar`: 프로젝트(cwd) 선택, 새 세션, 최근 세션 목록(재개).
- `Composer`: 멀티라인 입력, Enter 전송/Shift+Enter 줄바꿈, `/` 자동완성(initialize의 commands), Esc=interrupt.
- `StatusBar`: 컨텍스트·5h/7d 사용률 게이지, 연결 상태, 테마. 모델·권한 모드는 컴포저 컨트롤로 이동, 턴별 토큰은 채팅의 usage 꼬리표로 표시(비용·rate limit 상시 표시는 제거, 2026-07-10).
- 테마: 다크 기본 + 라이트, CSS 변수.

### 4.4 데이터 흐름 (한 턴)

1. Composer 전송 → WS `user_message` → 서버가 stdin에 user JSONL 기록.
2. CLI stdout: status/thinking_tokens → 상태 표시; stream_event(text_delta) → 말풍선에 누적(표시는 rAF 페이서가 부드럽게 따라잡음); assistant(tool_use) → ToolCard 생성.
3. 권한 필요 시: can_use_tool → 서버 pending 등록 → WS `permission_request` → 다이얼로그 → 결정 → control_response → 도구 실행 재개.
4. tool_result 담긴 user 메시지 → ToolCard에 결과 채움.
5. `result` → 턴 종료, 채팅에 usage 꼬리표(토큰 입/출력·소요 시간, 토큰 0이면 생략) 추가.

## 5. 에러 처리

- CLI 프로세스 사망: `session_exit` 전파, UI에 재시작(같은 session_id로 `--resume`) 버튼.
- 권한 요청 응답 전 브라우저 이탈: pending 유지(서버가 상태 보존), 재접속 시 리플레이. 서버 종료 시엔 프로세스도 종료되므로 일관성 문제 없음.
- JSONL 파싱 실패 라인: 버리지 않고 raw 텍스트 이벤트로 전달(디버그 패널에서 확인 가능).
- stdin 쓰기 실패/backpressure: 큐잉 후 drain 대기.
- WS 재접속: 세션별 이벤트 링버퍼(최근 N개)로 리플레이; 그 이전 기록은 세션 JSONL 파일에서 로드.

## 6. 보안

- 서버는 `127.0.0.1` 바인드 전용.
- 기동 시 랜덤 토큰 생성. 전달 흐름을 명시하면: 서버가 출력하는 URL의 **fragment**(`#token=...`)로 브라우저에 전달 → 클라이언트 JS가 `location.hash`에서 읽어 sessionStorage에 저장 → 이후 WS는 `?token=` 쿼리로, REST는 `x-auth-token` 헤더로 **명시적으로 재전송**하고 서버가 각각 검증한다(fragment 자체는 서버로 전송되지 않으므로). 다른 로컬 프로세스/악성 웹사이트의 DNS rebinding·CSRF 차단 목적.
- WS/HTTP 모두 Origin 헤더 검증(자기 자신만 허용).
- fs-api는 디렉터리 나열만 제공(파일 내용 접근은 CLI 도구 경유 + 권한 다이얼로그로 통제).

## 7. 테스트 전략

- **단위(node:test)**: jsonl 파서; claude-session을 **가짜 CLI**(프로토콜을 모사하는 Node 스크립트)로 구동해 initialize/멀티턴/권한 왕복/비정상 종료 검증. 실제 구독을 소모하지 않음.
- **E2E(수동+chrome-devtools MCP)**: 실제 claude.exe로 1–2턴 — 스트리밍, 권한 다이얼로그, interrupt, 재개를 브라우저에서 확인하고 스크린샷 증빙.

## 8. v1 범위 밖 (YAGNI)

이미지 첨부, 서브에이전트 트리 시각화, MCP 서버 관리 UI, PTY 터미널 탭, 다중 브라우저 클라이언트 동시 접속 동기화, 원격(비 localhost) 접근.

## 9. 자율 결정 사항 기록

/goal 자율 모드로 사용자 확인 없이 내린 결정: 접근 B 채택, Vite+React 스택, ws 라이브러리 사용, 다크 테마 기본, v1 범위 축소(§8). 이견이 있으면 이 문서 수정 후 재구현 요청 가능.
