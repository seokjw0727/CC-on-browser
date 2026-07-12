# Claude Code on Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 `claude.exe`(구독 인증)를 stream-json 모드로 구동하는 Node 브리지 서버 + 브라우저 채팅 SPA.

**Architecture:** Node(ESM) 서버가 claude.exe를 자식 프로세스로 spawn하고 stdin/stdout JSONL로 통신, WebSocket으로 브라우저에 중계. 브라우저는 Vite+React SPA. 미문서 CLI 프로토콜 지식은 `server/src/claude-session.js` 한 파일에 격리.

**Tech Stack:** Node 24 (ESM, node:test), ws, Vite + React 18, marked + DOMPurify + highlight.js.

**Note on granularity:** UI 컴포넌트 태스크는 완전한 JSX 대신 정밀한 계약(파일, props, 동작, 수용 기준)으로 기술한다. 프로토콜/서버 코어는 완전한 코드를 제공한다. 구현자는 각 태스크의 Interfaces 블록만으로 이웃 태스크와 맞물릴 수 있어야 한다.

## Global Constraints

- **SDK 금지**: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, api.anthropic.com 호출 금지. 유일한 AI 접점은 `C:\Users\<user>\.local\bin\claude.exe` 자식 프로세스 (환경변수 `CLAUDE_WEB_CLI_PATH`로 오버라이드 가능).
- 서버 바인드: `127.0.0.1` 전용. 기본 포트 8787 (`--port`/`PORT`로 변경).
- 모든 서버 코드 ESM(`"type":"module"`), Node 내장 모듈 + `ws`만 사용.
- 클라이언트 런타임 의존성: react, react-dom, marked, dompurify, highlight.js만.
- 테스트는 실제 claude.exe를 호출하지 않는다 (구독 소모 금지). 가짜 CLI(`server/test/fake-cli.mjs`) 사용. 실 CLI 검증은 최종 E2E에서 수동 1회.
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 검증된 CLI 프로토콜 (v2.1.201 실측 — 이대로 구현)

spawn: `claude.exe -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio [--model <m>] [--permission-mode <mode>] [--effort <level>] [--resume <sessionId>]`, cwd = 사용자가 고른 프로젝트 디렉터리. (--effort는 2026-07-10 추가 — spawn 전용, 런타임 변경 채널 없음.) stdio 전부 pipe. 메시지는 한 줄당 JSON 하나(JSONL), `\n` 종결.

**서버 → CLI (stdin):**
```json
{"type":"control_request","request_id":"init_1","request":{"subtype":"initialize"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"control_response","response":{"subtype":"success","request_id":"<그대로 에코>","response":{"behavior":"allow","updatedInput":{...},"updatedPermissions":[...]}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<...>","response":{"behavior":"deny","message":"사유"}}}
{"type":"control_request","request_id":"int_1","request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"m_1","request":{"subtype":"set_model","model":"sonnet"}}
{"type":"control_request","request_id":"pm_1","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
{"type":"control_request","request_id":"tk_1","request":{"subtype":"set_max_thinking_tokens","max_thinking_tokens":10000}}
```
(interrupt/set_model/set_permission_mode 서브타입은 SDK 관례 — E2E에서 확인 전까지 **선택 기능으로 취급**: control_response가 error이거나 30s 타임아웃이면 해당 기능만 비활성 안내(toast)하고 턴 흐름·세션은 유지한다. 핵심 계약(user 턴, can_use_tool)과 결합하지 않는다. set_max_thinking_tokens(2026-07-10 추가, null=기본/0=끔/양수=예산)는 CLI v2.1.205 바이너리의 내부 클라이언트에서 실측한 서브타입 — 같은 선택-기능 정책을 적용한다.)

(allow 응답의 `updatedPermissions`(수락한 `permission_suggestions` 배열을 그대로 에코 — "항상 허용" 류 영구 규칙 저장용)도 SDK PermissionResult 관례 — 프로브 기록에는 없으며 Task 9 Step 2 실 CLI E2E에서 확인. 미수용이어도 allow/deny 핵심 흐름과 결합하지 않는다.)

**CLI → 서버 (stdout), type별:**
- `control_response`: initialize 응답. `response.response`에 `commands[]`, `models[]`(value/displayName/description), `account{email,subscriptionType}`, `output_style`.
- `control_request`: `request.subtype==="can_use_tool"`, `request`에 `tool_name`, `display_name`, `input`, `description?`, `permission_suggestions?[]`, `tool_use_id`, `requires_user_interaction?`(AskUserQuestion류 질문 요청에만 true — 2026-07-12 실측, 아래 절). 최상위 `request_id`를 에코해 응답.
- `system`: subtype `init`(session_id, cwd, tools[], model...), `status`, `thinking_tokens`(estimated_tokens), `hook_started`/`hook_response`, `notification`.
- `stream_event`: `event`가 Anthropic 스트림 이벤트(`content_block_start`/`content_block_delta`(delta.type: text_delta|thinking_delta|input_json_delta)/`content_block_stop`/`message_start`/`message_delta`). `parent_tool_use_id` 있을 수 있음(서브에이전트).
- `assistant`: 완성된 content block 배열(`thinking`|`text`|`tool_use`). 같은 message id로 여러 번 올 수 있음(블록 단위 — id+content로 병합).
- `user`: `message.content[]`에 `tool_result`(tool_use_id, content, is_error) — 도구 실행 결과. `tool_use_result`에 구조화 결과.
- `rate_limit_event`: `rate_limit_info{status,resetsAt,rateLimitType}`.
- `result`: 턴 종료. `subtype:"success"|...`, `result`(최종 텍스트), `session_id`, `total_cost_usd`, `usage{input_tokens,output_tokens,...}`, `num_turns`, `duration_ms`, `is_error`.
- 멀티턴: result 후 같은 stdin에 다음 user 메시지. 세션 종료는 stdin.end().

**2026-07-10 v2.1.206 handshake 프로브 추가 실측 (유저 메시지 미전송 — 토큰 소모 0):**
- `system/init`은 **첫 user 메시지 전에는 오지 않는다** (initialize 응답·hook 이벤트만 도착). 무턴 세션은
  `~/.claude/projects`에 **트랜스크립트(jsonl)를 만들지 않는다** → 그런 세션 id로 `--resume`하면 stderr
  `No conversation found with session ID: …` + `result/error_during_execution` 후 exit 1.
  ⇒ 클라이언트는 **완결 턴 ≥1(result 관측) 또는 재개로 시작한 세션만** `--resume` 대상으로 삼는다(hasCompletedTurn 게이트).
- `set_model` 성공 시 CLI가 `user` 이벤트(`message.content`가 문자열 `<local-command-stdout>Set model to …</local-command-stdout>`,
  `isReplay:true`)를 함께 방출한다 — 대화가 아니므로 클라이언트가 채팅에서 걸러낸다.
- `set_permission_mode` 성공 시 `system/status`(`status:null`, `permissionMode:<새 모드>`) 이벤트 동반.
  4개 모드(default/acceptEdits/plan/bypassPermissions) 전부 런타임 전환 성공, spawn `--permission-mode bypassPermissions`도 정상.
- 실존 세션 `--resume`은 과거 대화를 **replay하지 않는다**(isReplay 이벤트 0) — 메모리 이월(preloadMessages)과 중복되지 않음.

**2026-07-11 [1m](1M 컨텍스트) 모델 보고 형상 실측 (`--model opus[1m]` 1턴 캡처):**
- initialize `models[]` 카탈로그는 fake-cli 픽스처와 완전 일치. `[1m]` 접미사가 실리는 필드는
  행마다 다르다: `default`→resolvedModel에만(`claude-opus-4-8[1m]`), `claude-fable-5[1m]`→value에만
  (resolvedModel은 `claude-fable-5`).
- `system/init.model` = **별칭을 해석한 id, 접미사 유지** — `opus[1m]` 스폰 → `"claude-opus-4-8[1m]"`.
- `assistant message.model` = **접미사 탈락 bare id** — `"claude-opus-4-8"`. ⇒ 클라이언트는 init 값을
  assistant 값으로 덮지 않는다(base 동일 시 유지, 다르면 모델 전환으로 채택 — reduce-cli-event.js).
- `result.modelUsage`는 접미사 유지 해석 id를 키로, 값에 **`contextWindow`(1M 모델에서 1000000)를
  직접 싣는다** — `{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
  webSearchRequests, costUSD, contextWindow, maxOutputTokens}`. ⇒ CTX 분모의 1차 출처는 이 값이고,
  문자열+카탈로그 양방향·base 매칭(client/src/lib/format.js `contextWindowFor`)은 첫 result 전·재개
  직후의 폴백이다.

**2026-07-12 AskUserQuestion 실측 (v2.1.207, haiku 1턴 프로브 — 질문/권한 구분):**
- AskUserQuestion도 **같은 `can_use_tool` 채널**로 온다. 차이는 (a) `tool_name:"AskUserQuestion"`,
  (b) `requires_user_interaction:true` 필드(일반 권한 요청엔 없음), (c) `input.questions[]`
  (`{question, header, options:[{label, description}], multiSelect}`, 1–4개, 옵션 ≤4),
  (d) `permission_suggestions` 없음. ⇒ 이것은 권한 상승이 아니라 "사용자에게 묻기" — 클라이언트는
  `isQuestionRequest`(toolName+input 형상)로 분기해 QuestionDialog를 띄운다.
- **답변 응답**: 표준 permission 채널 그대로 `behavior:"allow"` +
  `updatedInput:{...원본 input, answers:{"<질문 텍스트>":"<답변 문자열>"}}`.
  CLI가 tool_result 텍스트를 합성한다(`Your questions have been answered: "…"="…". …`,
  `tool_use_result`에 `{questions, answers}` 구조화 결과 동반). multiSelect 답변은 라벨을
  `", "`로 조인, 자유 입력은 라벨 대신 원문 문자열(TUI 바이너리 동작 미러).
- **건너뛰기**: `behavior:"allow"` + `answers:{}` → 비-오류 tool_result
  `"The user did not answer the questions."` (deny는 오류 tool_result라 건너뛰기엔 쓰지 않는다).
  자유 응답 전용 최상위 `response?` 필드(문자열)도 스키마에 존재 —
  `"The user responded: …"`로 합성된다(현 UI는 질문별 answers만 사용).

## WS 프로토콜 (서버 ↔ 브라우저, 이 스키마가 계약)

연결: `ws://127.0.0.1:<port>/ws?token=<token>`. token 불일치/Origin 불일치 시 즉시 close.

**클라이언트 → 서버:**
```json
{"type":"start","startId":"cl_1","cwd":"C:\\path","model":"opus","permissionMode":"default","effort":null,"resumeSessionId":null}  // effort: low|medium|high|xhigh|max|null — spawn 전용 --effort (2026-07-10 추가)
{"type":"send","key":"s_1","text":"사용자 입력"}
{"type":"permission","key":"s_1","requestId":"<uuid>","behavior":"allow","updatedInput":{},"updatedPermissions":[],"message":null}
{"type":"interrupt","key":"s_1"}
{"type":"setModel","key":"s_1","model":"sonnet"}
{"type":"setPermissionMode","key":"s_1","mode":"acceptEdits"}
{"type":"setThinking","key":"s_1","maxThinkingTokens":10000}  // null=CLI 기본, 0=끔 (2026-07-10 추가)
{"type":"attach","key":"s_1","afterSeq":42}
{"type":"stop","key":"s_1"}
```

**서버 → 클라이언트:**
```json
{"type":"started","startId":"cl_1","key":"s_1","initInfo":{"commands":[],"models":[],"account":{},"output_style":"default"}}
{"type":"event","key":"s_1","seq":1,"payload":{"...CLI stdout 메시지 원본..."}}
{"type":"permission_request","key":"s_1","requestId":"<uuid>","toolName":"Write","displayName":"Write","input":{},"description":"...","suggestions":[],"toolUseId":"...","requiresUserInteraction":false}  // AskUserQuestion류 질문이면 true (2026-07-12 추가)
{"type":"permission_resolved","key":"s_1","requestId":"<uuid>"}
{"type":"exit","key":"s_1","code":0}
{"type":"error","key":"s_1","message":"...","startId":null}
```
`seq`는 세션별 단조 증가. 서버는 세션당 최근 1000개 이벤트 링버퍼 유지, `attach.afterSeq` 이후 리플레이.

**REST (헤더 `x-auth-token` 필수):**
- `GET /api/bootstrap` → `{claudeVersion, defaultCwd, port}`
- `GET /api/projects` → `[{dirName, cwd, sessionCount, lastModified}]` (~/.claude/projects 스캔; cwd는 최신 세션 JSONL 첫 줄의 cwd 필드에서)
- `GET /api/sessions?dir=<dirName>` → `[{sessionId, title, mtime, fileSize}]` (title = 첫 user 텍스트 80자)
- `GET /api/transcript?dir=<dirName>&sessionId=<id>` → `{messages:[CLI형식 배열]}` (재개 시 과거 대화 프리로드)
- `GET /api/browse?path=<abs|빈값>` → `{path, parent, dirs:[이름]}` (빈값이면 드라이브 목록 `["C:\\", ...]`)

---

### Task 1: 저장소 스캐폴드

**Files:**
- Create: `package.json`, `.gitignore`, `server/package.json`, `client/package.json`(vite로 생성), `client/vite.config.js`
- Create: `server/src/`, `server/test/` 디렉터리

**Interfaces:**
- Produces: npm 스크립트 — 루트에서 `npm run build`(client 빌드), `npm start`(server 기동), `npm test`(server 테스트), `npm run dev:client`, `npm run install:all`.

- [x] **Step 1:** 루트 `package.json`:
```json
{
  "name": "claude-code-on-browser",
  "private": true,
  "type": "module",
  "scripts": {
    "install:all": "npm install --prefix server && npm install --prefix client",
    "build": "npm run build --prefix client",
    "start": "node server/src/server.js",
    "test": "node --test server/test/",
    "dev:client": "npm run dev --prefix client"
  }
}
```
- [x] **Step 2:** `.gitignore`: `node_modules/`, `client/dist/`, `*.local`
- [x] **Step 3:** `server/package.json`: `{"name":"server","private":true,"type":"module","dependencies":{"ws":"^8"}}` 후 `npm install --prefix server`
- [x] **Step 4:** `npm create vite@latest client -- --template react` 상당의 최소 구조를 직접 생성(client/package.json: react, react-dom, marked, dompurify, highlight.js, devDeps: vite, @vitejs/plugin-react). `client/vite.config.js`에 dev 프록시: `/api`→`http://127.0.0.1:8787`, `/ws`→ws 프록시. `npm install --prefix client`
- [x] **Step 5:** `npm run build`가 성공하는 빈 App 확인 후 커밋 `chore: scaffold server+client workspaces`

### Task 2: `server/src/jsonl.js` — JSONL 스트림 파서

**Files:**
- Create: `server/src/jsonl.js`, Test: `server/test/jsonl.test.js`

**Interfaces:**
- Produces: `createJsonlParser(onMessage: (obj)=>void, onRaw?: (line)=>void) => (chunk: Buffer|string) => void`. 불완전 라인은 버퍼링, JSON 파싱 실패 라인은 onRaw로.

- [x] **Step 1: 실패 테스트 작성** — 케이스: (a) 한 chunk에 두 메시지, (b) 메시지가 chunk 경계에서 쪼개짐, (c) 비JSON 라인은 onRaw, (d) 빈 라인 무시, (e) CRLF 허용.
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonlParser } from '../src/jsonl.js';

test('parses split chunks', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  feed('{"a":1}\n{"b"');
  feed(':2}\r\n\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});
test('non-json goes to onRaw', () => {
  const out = [], raw = [];
  const feed = createJsonlParser((m) => out.push(m), (l) => raw.push(l));
  feed('oops\n{"ok":true}\n');
  assert.deepEqual(out, [{ ok: true }]);
  assert.deepEqual(raw, ['oops']);
});
```
- [x] **Step 2:** `node --test server/test/jsonl.test.js` → FAIL 확인
- [x] **Step 3:** 구현:
```js
export function createJsonlParser(onMessage, onRaw = () => {}) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { onRaw(line); }
    }
  };
}
```
- [x] **Step 4:** 테스트 PASS 확인 → 커밋 `feat(server): jsonl stream parser`

### Task 3: 가짜 CLI + `server/src/claude-session.js`

**Files:**
- Create: `server/test/fake-cli.mjs`, `server/src/claude-session.js`, Test: `server/test/claude-session.test.js`

**Interfaces:**
- Consumes: Task 2의 `createJsonlParser`.
- Produces:
```js
class ClaudeSession extends EventEmitter {
  constructor(opts: { cliPath: string, cliArgsPrefix?: string[], cwd: string,
                      model?: string, permissionMode?: string, effort?: string, // effort 2026-07-10 추가
                      resumeSessionId?: string })
  async start(): Promise<initInfo>   // spawn + initialize 왕복, 10s 타임아웃
  sendUserText(text: string): void
  respondPermission(requestId: string, result: object): boolean // pending에 없으면 false
  async interrupt(): Promise<void>
  async setModel(model: string): Promise<void>
  async setPermissionMode(mode: string): Promise<void>
  async setMaxThinkingTokens(v: number|null): Promise<object> // set_max_thinking_tokens — v2.1.205 바이너리 실측 (2026-07-10 추가)
  stop(): void                        // stdin.end() 후 5s 내 미종료 시 kill
  sessionId: string|null              // system/init 수신 시 세팅
  // emits: 'event'(cliMessage), 'permission_request'({requestId,toolName,displayName,input,description,suggestions,toolUseId}),
  //        'exit'(code), 'raw'(line)
}
```
- can_use_tool 수신 시 pending map에 등록하고 'permission_request' emit; respondPermission이 control_response를 stdin에 기록.
- 서버가 보내는 control_request(interrupt 등)는 request_id로 Promise를 pending에 두고 CLI의 control_response(success/error)로 resolve/reject (30s 타임아웃).

- [x] **Step 1:** `fake-cli.mjs` — 프로토콜 모사. stdin JSONL 읽고: initialize→고정 initInfo 응답; user 메시지 N번째에 따라 시나리오(환경변수 `FAKE_SCENARIO`): `echo`(text_delta 3개→assistant→result), `permission`(can_use_tool 발행→allow면 tool_result user 메시지→result, deny면 바로 result), `crash`(user 수신 후 exit 3). 모든 출력 한 줄 JSON. 실측 형식(위 프로토콜 절)과 필드 동일하게.
- [x] **Step 2: 실패 테스트 작성** — (a) start()가 initInfo 반환+system/init 후 sessionId 세팅, (b) echo 시나리오: 'event' 순서에 stream_event×3, assistant, result 포함, (c) permission 시나리오: permission_request emit → respondPermission(allow) → tool_result 이벤트 → result, (d) deny → result의 도달, (e) crash: 'exit' emit + start 이후 sendUserText가 throw하지 않음, (f) 멀티턴: result 후 두 번째 sendUserText → 두 번째 result.
- [x] **Step 3:** FAIL 확인 (`node --test server/test/claude-session.test.js`)
- [x] **Step 4:** `claude-session.js` 구현. spawn 인자: `[...cliArgsPrefix, '-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio', ...(model?['--model',model]:[]), ...(permissionMode?['--permission-mode',permissionMode]:[]), ...(resumeSessionId?['--resume',resumeSessionId]:[])]`. 테스트에서는 `cliPath='node', cliArgsPrefix=[fakeCliPath]`. 실 서버에서는 `cliPath=CLAUDE_WEB_CLI_PATH || 'C:\\Users\\<user>\\.local\\bin\\claude.exe', cliArgsPrefix=[]`.
- [x] **Step 5:** PASS 확인 → 커밋 `feat(server): claude session bridge with permission routing`

### Task 4: `server/src/history.js` + `server/src/fs-api.js`

**Files:**
- Create: `server/src/history.js`, `server/src/fs-api.js`, Test: `server/test/history.test.js`, `server/test/fs-api.test.js`

**Interfaces:**
- Produces:
```js
// history.js — projectsRoot 주입 가능(기본 path.join(os.homedir(),'.claude','projects'))
listProjects(projectsRoot?) => Promise<[{dirName, cwd|null, sessionCount, lastModified}]>
listSessions(projectsRoot, dirName) => Promise<[{sessionId, title, mtime, fileSize}]>
loadTranscript(projectsRoot, dirName, sessionId) => Promise<{messages: object[]}>
// 렌더 가능 타입만 필터: assistant, user, result. system/init은 첫 1개 유지.
// fs-api.js
listDirs(absPath|'' ) => Promise<{path, parent|null, dirs: string[]}> // ''→드라이브 나열, 숨김폴더 제외, 접근불가 EPERM은 빈 배열
```
- 경로 검증: dirName/sessionId에 `..`,`/`,`\` 포함 시 throw (경로 탈출 방지).
- listDirs 경로 정책: 입력을 `path.resolve`로 정규화하고, UNC/네트워크 경로(`\\\\`로 시작)는 거부, 디렉터리가 아니면 거부, 심볼릭 링크는 따라가지 않고 이름만 나열(lstat 기준). 파일 내용은 어떤 경우에도 반환하지 않음.

- [x] **Step 1: 실패 테스트** — 임시 디렉터리에 가짜 `projects/<dir>/<uuid>.jsonl` 2개 생성(첫 줄에 `{"type":"user","cwd":"C:\\fake","message":{"role":"user","content":[{"type":"text","text":"제목이 될 텍스트"}]}}` 포함), listProjects/listSessions/loadTranscript 검증 + 경로 탈출 시 reject.
- [x] **Step 2:** FAIL 확인 → 구현 → PASS → 커밋 `feat(server): session history + directory browse APIs`

### Task 5: `server/src/session-hub.js` + `server/src/server.js`

**Files:**
- Create: `server/src/session-hub.js`, `server/src/server.js`, Test: `server/test/server.integration.test.js`

**Interfaces:**
- Consumes: Task 2–4 전부.
- Produces: `startServer({port, host:'127.0.0.1', token, cliPath, cliArgsPrefix, projectsRoot, staticDir}) => Promise<{server, port, token, close()}>`. WS/REST 스키마는 상단 "WS 프로토콜" 절 그대로. SessionHub: `Map<key, {session, ring: [{seq,payload}], nextSeq, pendingPermissions: Map}>`; key는 `s_`+증가값. 이벤트마다 ring push(1000 초과 시 shift) 후 접속 중 모든 소켓에 브로드캐스트.
- 인증: WS는 `?token=`, REST는 `x-auth-token`. Origin 헤더가 존재하면 `http://127.0.0.1:<port>`/`http://localhost:<port>`만 허용. 실패 시 401/즉시 close.
- `server.js`를 직접 실행하면(import.meta.url 비교) 토큰 생성(crypto.randomBytes(16).hex) 후 `http://127.0.0.1:<port>/#token=<token>` 콘솔 출력, staticDir=client/dist 서빙(SPA fallback → index.html).

- [x] **Step 1: 실패 통합 테스트** — startServer를 fake-cli로 기동, `ws` 클라이언트로: (a) 잘못된 토큰 → close, (b) start→started(initInfo 포함), (c) send→event들 수신(seq 단조 증가)→result, (d) permission 시나리오 왕복, (e) 재접속 후 attach(afterSeq)로 리플레이, (f) REST /api/projects가 임시 projectsRoot 내용 반환, (g) Origin 위조 시 거부.
- [x] **Step 2:** FAIL → 구현 → PASS → 커밋 `feat(server): ws hub + http server with auth`

### Task 6: 클라이언트 기반 — 테마/레이아웃/WS 스토어

**Files:**
- Create: `client/src/main.jsx`, `client/src/App.jsx`, `client/src/theme.css`, `client/src/lib/ws.js`, `client/src/lib/store.jsx`, `client/index.html`

**Interfaces:**
- Produces:
  - `lib/ws.js`: `connect({token, onMessage, onStatus}) => {send(obj), close()}` — 자동 재접속(1s→5s 백오프), 재접속 시 각 세션에 attach 재전송은 store가 담당.
  - `lib/store.jsx`: React context + useReducer. 상태: `{conn:'connecting|open|closed', sessions: Map<key,SessionState>, activeKey, projects, initInfo}`. `SessionState = {key, cwd, sessionId, model, permissionMode, messages:[], streaming:{...}, pendingPermissions:[], usage:{cost,inTok,outTok}, rateLimit, status:'idle|thinking|tool|awaiting-permission|exited', lastSeq}`. 액션 디스패처가 WS 수신 메시지(`event` payload의 CLI 타입 포함)를 SessionState로 환원. **CLI 이벤트→상태 환원 로직은 `lib/reduce-cli-event.js`로 분리** (Task 7에서 구현, 여기선 파일 스텁+통과 위임만).
  - `App.jsx` 레이아웃: 좌측 Sidebar(260px, 접기 가능), 중앙 ChatView+Composer, 상단 StatusBar. CSS 변수 기반 다크(기본)/라이트 테마 토글. 토큰은 `location.hash`에서 파싱해 sessionStorage 저장.
- 수용 기준: `npm run build` 성공, dev 서버에서 빈 셸 렌더 + WS 연결 상태 표시.

- [x] **Step 1:** theme.css — CSS 변수(배경/서피스/텍스트/액센트/성공/위험/보더, 다크·라이트 두 세트), 시스템 폰트 스택, 코드용 모노 폰트.
- [x] **Step 2:** ws.js + store.jsx + App 셸 구현, 빌드 확인 → 커밋 `feat(client): app shell, theme, ws store`

### Task 7: 채팅 렌더링 — 스트리밍/마크다운/도구 카드

**Files:**
- Create: `client/src/lib/reduce-cli-event.js`, `client/src/lib/markdown.js`, `client/src/components/ChatView.jsx`, `client/src/components/Message.jsx`, `client/src/components/ToolCard.jsx`, `client/src/components/ThinkingBlock.jsx`

**Interfaces:**
- Consumes: store의 SessionState/dispatch, WS `event` payload(상단 CLI 프로토콜 절의 메시지 형식).
- Produces: `reduceCliEvent(sessionState, payload) => sessionState` 순수 함수 —
  - `stream_event.content_block_start/delta/stop`으로 진행 중 assistant 메시지 조립(text_delta는 text에, thinking_delta는 thinking에 append; input_json_delta는 tool_use input 문자열 누적).
  - `assistant` 도착 시 스트리밍 조립분을 확정 블록으로 교체(message id 기준 병합).
  - `user`의 `tool_result`는 tool_use_id로 기존 ToolCard에 결과 연결.
  - `system/init`→sessionId·model 저장, `system/status`→status, `thinking_tokens`→진행 표시, `result`→usage(cost,tokens) 갱신+status idle, `rate_limit_event`→rateLimit.
  - 미지의 타입은 `messages`에 `{kind:'raw', payload}`로 보존.
- `markdown.js`: `render(md) => sanitizedHtml` (marked + DOMPurify + highlight.js; 링크는 target=_blank rel=noopener).
- UI 동작: 자동 스크롤(사용자가 위로 스크롤하면 고정 해제, "↓ 최신으로" 버튼), ThinkingBlock은 기본 접힘(스트리밍 중엔 펄스 표시), ToolCard는 도구별 렌더 — Bash: 명령(코드)+결과(접기, 20줄 초과 시), Edit: old/new를 removed/added 색으로, Write: 파일경로+내용 코드블록, Read/Grep/Glob: 입력 요약+결과 접힘, TodoWrite/Task 등 기타: 입력 JSON 접힘. is_error면 위험색 테두리.
- 수용 기준: fake 데이터로 렌더 확인용 최소 스토리(개발 중 임시 페이지) 또는 dev 서버+fake-cli로 실제 스트림 렌더.

- [x] **Step 1:** `reduce-cli-event.js` 구현 (위 명세 전부; 이 파일은 순수 함수로 작성해 추후 테스트 가능하게)
- [x] **Step 2:** markdown.js + 컴포넌트 구현, dev로 시각 확인 → 커밋 `feat(client): streaming chat rendering + tool cards`

### Task 8: 상호작용 — 권한 다이얼로그/컴포저/사이드바/상태바

**Files:**
- Create: `client/src/components/PermissionDialog.jsx`, `client/src/components/Composer.jsx`, `client/src/components/Sidebar.jsx`, `client/src/components/StatusBar.jsx`, `client/src/lib/api.js`

**Interfaces:**
- Consumes: store, WS send 함수, REST(`lib/api.js`: bootstrap/projects/sessions/transcript/browse — `x-auth-token` 헤더).
- Produces/동작:
  - **PermissionDialog**: `permission_request` 수신 시 모달. 도구명·description·입력 렌더(ToolCard와 동일 렌더러 재사용). 버튼: [허용] `{"behavior":"allow","updatedInput":<원본 input>}`, [거부] 사유 입력란과 함께 `{"behavior":"deny","message":<사유||'사용자가 거부'>}`. suggestions 있으면 체크박스를 표시하되 **라벨은 제안의 실제 효과를 그대로 서술**(예: setMode acceptEdits → "이 세션에서 파일 편집 자동 허용", addRules → "도구 <이름> 계속 허용 (<범위>)"). 일반적인 "항상 허용" 같은 모호한 문구 금지. 체크 시에만 suggestions를 updatedPermissions로 동봉 — CLI가 제안한 것 이상으로 범위를 넓히지 않는다. 큐잉: 요청 여러 개면 순차 표시. Esc는 다이얼로그를 닫지 않음(명시적 선택 강제).
  - **Composer**: textarea 자동 높이, Enter 전송/Shift+Enter 개행, 스트리밍 중 전송 비활성 대신 큐잉 없이 disabled+안내, `/` 입력 시 initInfo.commands 필터 드롭다운(↑↓ Tab/Enter 선택 → `/name ` 삽입, 선택 후 일반 텍스트로 전송), Esc → interrupt 전송(status가 idle 아니면), 중단 버튼도 표시.
  - **Sidebar**: 상단 [새 세션] — cwd 피커 모달(browse API 트리 탐색+직접 입력+최근 프로젝트 목록), 모델 선택(initInfo.models), 권한 모드 선택(default/acceptEdits/plan/bypassPermissions 경고문구). 아래로 열린 세션 탭들(status 뱃지), 그 아래 "최근 세션"(projects→sessions, 클릭 시 transcript 프리로드 + `start{resumeSessionId}` 전송).
  - **StatusBar**: 좌측 cwd·sessionId 축약, 중앙 status 인디케이터(thinking 애니메이션/도구명/권한대기), 우측 모델 드롭다운(setModel), 권한모드 토글(setPermissionMode), 턴 비용·누적 토큰, rateLimit 경고, 연결 상태 점, 테마 토글.
- 수용 기준: fake-cli 시나리오(echo/permission)로 전 플로우가 브라우저에서 동작.

- [x] **Step 1:** api.js + Sidebar/cwd 피커 → 커밋
- [x] **Step 2:** PermissionDialog + Composer + StatusBar → 커밋 `feat(client): permission dialog, composer, sidebar, statusbar`

### Task 9: 통합 — 정적 서빙 + fake-cli 스모크 + 실 CLI E2E

**Files:**
- Modify: `server/src/server.js`(필요 시), Create: `scripts/dev-fake.mjs`(fake-cli로 전체 스택 기동)

**Interfaces:**
- Consumes: 전 태스크.

- [x] **Step 1:** `npm run build` 후 `npm start` → 브라우저(chrome-devtools MCP, Brave)에서 접속. fake-cli 모드(`scripts/dev-fake.mjs`: CLAUDE_WEB_CLI_PATH=node + prefix)로 echo/permission 시나리오 화면 확인, 스크린샷.
- [x] **Step 2:** 실 CLI로 1턴 (간단한 프롬프트 + Write 권한 다이얼로그 1회 + interrupt 1회) 확인, 스크린샷. 문제 발견 시 systematic-debugging으로 수정.
- [x] **Step 3:** 커밋 `feat: end-to-end integration`

### Task 10: README + 최종 리뷰

- [x] **Step 1:** `README.md`: 요구사항(claude CLI 로그인 완료), 설치(`npm run install:all`), 빌드/실행, 보안 주의(로컬 전용, 토큰 URL), 아키텍처 개요 다이어그램, 제한 사항(§8 YAGNI 목록), 프로토콜 미문서 경고.
- [x] **Step 2:** /code-review 수준의 자체 리뷰(워크플로 다중 에이전트) → 발견 수정 → 커밋 `docs: README` / `fix: review findings`

## Self-Review 결과

- 스펙 커버리지: §4 모듈 전부 태스크 1–8에 매핑, §5 에러 처리(exit 전파=T3/T5, 리플레이=T5, raw 보존=T2/T7), §6 보안=T5, §7 테스트=T2–T5/T9. 누락 없음.
- 타입 일관성: WS 스키마·ClaudeSession 시그니처를 상단 계약 절로 단일화, 각 태스크는 이를 참조.
- 플레이스홀더: UI 태스크는 의도적 계약 기술(문서 상단 Note 참조) — 동작·수용 기준 명시로 대체.
