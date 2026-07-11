// CLI stdout 메시지(payload) -> SessionState 순수 환원 함수 (Task 7).
// 서버가 `event`로 중계하는 CLI 메시지(계획서 "검증된 CLI 프로토콜" 절)를
// 렌더 가능한 message 아이템 목록으로 조립한다. 입력 상태는 절대 변형하지 않는다.
//
// message 아이템 종류(kind):
//   user-text      { text }
//   assistant-text { msgId, blockIndex, text, streaming }
//   thinking       { msgId, blockIndex, thinking, streaming, redacted? }
//   tool_use       { msgId, blockIndex, toolUseId, name, input|null, inputJson,
//                    result: {content, isError, structured}|null, streaming, parentToolUseId }
// assistant-text/thinking/tool_use 아이템은 assistant 이벤트로 확정되면 confirmed:true.
//   notice         { text }           (system/notification)
//   usage          { inTok, outTok, durationMs } (턴 종료 시 토큰 사용량 — CLI풍 표시)
//   error          { text }           (레거시 렌더 호환용 — 신규 에러는 store가 토스트로 표시)
//   raw            { payload }        (미지의 타입 보존)
//
// user 이벤트 분류(실 CLI v2.1.206 실측): isReplay:true(설정 변경 에코·히스토리 재전송)는
// 채팅에 추가하지 않고, 비-replay <local-command-stdout|stderr> 문자열(슬래시 커맨드 출력)은
// 태그를 벗겨 notice로 렌더한다. result.is_error도 채팅 대신 store가 토스트로 알린다.
//
// session.streaming = { msgId: string|null, blocks: { [contentBlockIndex]: uid } }

let uidSeq = 0;
const nextUid = () => `m${++uidSeq}`;

function normStreaming(s) {
  return s && typeof s === 'object' && s.blocks ? s : { msgId: null, blocks: {} };
}

function append(session, item) {
  return {
    ...session,
    messages: [...session.messages, { uid: nextUid(), ...item }],
  };
}

function updateByUid(session, uid, fn) {
  let hit = false;
  const messages = session.messages.map((m) => {
    if (m.uid !== uid) return m;
    hit = true;
    return fn(m);
  });
  return hit ? { ...session, messages } : session;
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

// 'awaiting-permission'(store가 관리)과 'exited'는 CLI 이벤트로 덮어쓰지 않는다.
function setStatus(session, status) {
  if (session.status === 'exited') return session;
  if (session.status === 'awaiting-permission' && status !== 'idle') return session;
  if (session.status === status) return session;
  return { ...session, status };
}

function adoptSessionId(session, payload) {
  if (!session.sessionId && typeof payload.session_id === 'string') {
    return { ...session, sessionId: payload.session_id };
  }
  return session;
}

function hasOpenTool(session) {
  return session.messages.some(
    (m) => m.kind === 'tool_use' && !m.streaming && m.result == null,
  );
}

// ----- stream_event -----

function newBlockItem(block, msgId, blockIndex, parentToolUseId) {
  const base = { msgId, blockIndex, streaming: true, parentToolUseId };
  switch (block.type) {
    case 'text':
      return { kind: 'assistant-text', text: block.text || '', ...base };
    case 'thinking':
      return { kind: 'thinking', thinking: block.thinking || '', ...base };
    case 'redacted_thinking':
      return { kind: 'thinking', thinking: '[편집된 사고 과정]', redacted: true, ...base };
    case 'tool_use':
      return {
        kind: 'tool_use',
        toolUseId: block.id ?? null,
        name: block.name ?? null,
        input:
          block.input && Object.keys(block.input).length > 0 ? block.input : null,
        inputJson: '',
        result: null,
        ...base,
      };
    default:
      return null;
  }
}

function reduceStreamEvent(session, payload) {
  const ev = payload.event || {};
  const parent = payload.parent_tool_use_id ?? null;
  const streaming = normStreaming(session.streaming);

  switch (ev.type) {
    case 'message_start': {
      const next = {
        ...session,
        streaming: { msgId: ev.message?.id ?? null, blocks: {} },
      };
      return setStatus(next, 'thinking');
    }

    case 'content_block_start': {
      const index = ev.index ?? 0;
      const item = newBlockItem(ev.content_block || {}, streaming.msgId, index, parent);
      if (!item) return session;
      let next = append(session, item);
      const uid = next.messages[next.messages.length - 1].uid;
      next = {
        ...next,
        streaming: {
          msgId: streaming.msgId,
          blocks: { ...streaming.blocks, [index]: uid },
        },
      };
      return setStatus(next, 'thinking');
    }

    case 'content_block_delta': {
      const delta = ev.delta || {};
      const index = ev.index ?? 0;
      let next = session;
      let uid = streaming.blocks[index];
      if (uid == null) {
        // content_block_start 없이 delta가 먼저 오는 경우(fake-cli 등) — 타입 추론으로 생성
        const type =
          delta.type === 'thinking_delta' || delta.type === 'signature_delta'
            ? 'thinking'
            : delta.type === 'input_json_delta'
              ? 'tool_use'
              : 'text';
        const item = newBlockItem({ type }, streaming.msgId, index, parent);
        next = append(next, item);
        uid = next.messages[next.messages.length - 1].uid;
        next = {
          ...next,
          streaming: {
            msgId: streaming.msgId,
            blocks: { ...streaming.blocks, [index]: uid },
          },
        };
      }
      next = updateByUid(next, uid, (m) => {
        switch (delta.type) {
          case 'text_delta':
            return { ...m, text: (m.text || '') + (delta.text || '') };
          case 'thinking_delta':
            return { ...m, thinking: (m.thinking || '') + (delta.thinking || '') };
          case 'input_json_delta':
            return { ...m, inputJson: (m.inputJson || '') + (delta.partial_json || '') };
          default:
            return m; // signature_delta 등 무시
        }
      });
      return setStatus(next, 'thinking');
    }

    case 'content_block_stop': {
      const index = ev.index ?? 0;
      const uid = streaming.blocks[index];
      if (uid == null) return session;
      let next = updateByUid(session, uid, (m) => {
        const done = { ...m, streaming: false };
        if (m.kind === 'tool_use' && m.input == null && m.inputJson) {
          try {
            done.input = JSON.parse(m.inputJson);
          } catch {
            /* 불완전 JSON — inputJson 원문 유지 */
          }
        }
        return done;
      });
      const blocks = { ...streaming.blocks };
      delete blocks[index];
      next = { ...next, streaming: { msgId: streaming.msgId, blocks } };
      return hasOpenTool(next) ? setStatus(next, 'tool') : next;
    }

    case 'message_stop':
      return { ...session, streaming: { msgId: null, blocks: {} } };

    case 'message_delta':
      return session; // stop_reason/usage — result에서 집계

    default:
      return session;
  }
}

// ----- assistant (확정 블록 병합) -----

function confirmedFields(block) {
  switch (block.type) {
    case 'text':
      return { text: block.text ?? '' };
    case 'thinking':
      return { thinking: block.thinking ?? '' };
    case 'redacted_thinking':
      return { thinking: '[편집된 사고 과정]', redacted: true };
    case 'tool_use':
      return {
        toolUseId: block.id ?? null,
        name: block.name ?? null,
        input: block.input ?? null,
      };
    default:
      return {};
  }
}

// text/thinking 블록의 비교용 본문 (id+content 병합의 "content")
function itemContent(kind, fields) {
  return kind === 'assistant-text' ? (fields.text ?? '') : (fields.thinking ?? '');
}

function confirmBlock(session, block, msgId, blockIndex, parent) {
  const kind =
    block.type === 'text'
      ? 'assistant-text'
      : block.type === 'thinking' || block.type === 'redacted_thinking'
        ? 'thinking'
        : block.type === 'tool_use'
          ? 'tool_use'
          : null;
  if (!kind) return append(session, { kind: 'raw', payload: block });

  const msgs = session.messages;
  const confirmed = confirmedFields(block);
  // msgId 호환: 스트리밍 조립분은 msgId를 모를 수 있음(message_start 미수신)
  const compat = (m) =>
    m.kind === kind && (m.msgId == null || msgId == null || m.msgId === msgId);

  // assistant 이벤트는 같은 message id로 블록 단위로 여러 번 올 수 있고, 그때
  // content 배열 index(항상 0)는 스트리밍 블록 index와 어긋난다 → id+content로 병합.
  let idx = -1;
  if (kind === 'tool_use') {
    if (block.id != null) {
      idx = findLastIndex(msgs, (m) => m.kind === 'tool_use' && m.toolUseId === block.id);
    }
    if (idx < 0) {
      idx = findLastIndex(msgs, (m) => compat(m) && !m.confirmed && m.blockIndex === blockIndex);
    }
  } else {
    const text = itemContent(kind, confirmed);
    // 멱등: 동일 내용으로 이미 확정된 블록(중복 assistant 이벤트)
    idx = findLastIndex(msgs, (m) => compat(m) && m.confirmed && itemContent(kind, m) === text);
    // id+content 병합: 미확정 스트리밍 조립분의 내용은 확정 내용의 접두사
    if (idx < 0) {
      idx = findLastIndex(msgs, (m) => compat(m) && !m.confirmed && text.startsWith(itemContent(kind, m)));
    }
    // 예비: 내용이 어긋난 드문 경우 블록 index로
    if (idx < 0) {
      idx = findLastIndex(msgs, (m) => compat(m) && !m.confirmed && m.blockIndex === blockIndex);
    }
  }

  if (idx < 0) {
    return append(session, {
      kind,
      msgId,
      blockIndex,
      streaming: false,
      confirmed: true,
      parentToolUseId: parent,
      ...(kind === 'tool_use' ? { inputJson: '', result: null } : {}),
      ...confirmed,
    });
  }

  const messages = msgs.slice();
  const prev = messages[idx];
  messages[idx] = {
    ...prev,
    ...confirmed,
    msgId: msgId ?? prev.msgId,
    streaming: false,
    confirmed: true,
  };

  // streaming.blocks에 남아 있는 해당 uid 매핑 제거
  const streaming = normStreaming(session.streaming);
  const blocks = { ...streaming.blocks };
  for (const k of Object.keys(blocks)) {
    if (blocks[k] === prev.uid) delete blocks[k];
  }
  return { ...session, messages, streaming: { msgId: streaming.msgId, blocks } };
}

function reduceAssistant(session, payload) {
  const msg = payload.message || {};
  const msgId = msg.id ?? null;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const parent = payload.parent_tool_use_id ?? null;
  let next = session;
  content.forEach((block, i) => {
    next = confirmBlock(next, block, msgId, i, parent);
  });

  // 컨텍스트 크기(CTX%) 추적: assistant 이벤트의 호출별 usage에서 입력+캐시가
  // 곧 그 호출 시점의 컨텍스트다 — 마지막 호출 값이 권위. result.usage는 턴 내
  // 모든 API 호출(도구 왕복마다 1회)의 합산이라 컨텍스트로 쓰면 호출 수에 비례해
  // 인플레된다(실측: 9회 호출 턴에서 489,886 = 245%, 실제는 63,270 = 31.6%).
  // 서브에이전트 트래픽은 본선 컨텍스트가 아니므로 제외
  // (라이브: parent_tool_use_id, 재개 트랜스크립트: isSidechain).
  const u = msg.usage;
  if (u && typeof u === 'object' && parent == null && !payload.isSidechain) {
    const ctx =
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    if (ctx > 0) {
      next = {
        ...next,
        ctxFromCalls: true,
        usage: { ...next.usage, contextTokens: ctx },
      };
    }
  }

  // 본선 assistant의 message.model이 곧 세션의 실사용 모델 — init 없는 재개
  // 트랜스크립트 리플레이에서 모델(→CTX 분모)을 복원하는 유일한 출처. 라이브에선
  // init과 같은 값일 것으로 기대(미검증 — 실 [1m] 세션의 init·assistant 캡처 필요).
  // 서브에이전트 모델은 제외(위 게이트와 동일).
  if (parent == null && !payload.isSidechain && typeof msg.model === 'string' && msg.model) {
    next = next.model === msg.model ? next : { ...next, model: msg.model };
  }

  return setStatus(next, hasOpenTool(next) ? 'tool' : 'thinking');
}

// ----- user (tool_result / 과거 대화 프리로드의 사용자 텍스트) -----

function attachToolResult(session, item, structured) {
  const idx = findLastIndex(
    session.messages,
    (m) => m.kind === 'tool_use' && m.toolUseId === item.tool_use_id,
  );
  if (idx < 0) {
    return append(session, { kind: 'raw', payload: { type: 'orphan_tool_result', ...item } });
  }
  const messages = session.messages.slice();
  messages[idx] = {
    ...messages[idx],
    streaming: false,
    result: {
      content: item.content,
      isError: !!item.is_error,
      structured: structured ?? null,
    },
  };
  return { ...session, messages };
}

function reduceUser(session, payload) {
  const msg = payload.message || {};
  const content = msg.content;
  let next = adoptSessionId(session, payload);

  // isReplay:true = CLI가 자기 히스토리를 되쏘는 이벤트(설정 변경 에코, 향후 resume replay
  // 가능성) — 대화가 아니고 preload와 중복될 수 있으므로 채팅에 추가하지 않는다(파일 헤더 참조).
  if (payload.isReplay) return next;
  if (typeof content === 'string') {
    // 비-replay 로컬 커맨드 출력(슬래시 커맨드 결과 등)은 삼키지 않고 notice로 보여준다.
    if (/^<local-command-(stdout|stderr)>/.test(content)) {
      const text = content.replace(/<\/?local-command-(stdout|stderr)>/g, '').trim();
      return text ? append(next, { kind: 'notice', text }) : next;
    }
    return append(next, { kind: 'user-text', text: content });
  }
  if (!Array.isArray(content)) return next;

  for (const item of content) {
    if (item && item.type === 'tool_result') {
      next = attachToolResult(next, item, payload.tool_use_result);
    } else if (item && item.type === 'text') {
      next = append(next, { kind: 'user-text', text: item.text ?? '' });
    } else {
      next = append(next, { kind: 'raw', payload: item });
    }
  }
  if (next.status === 'tool' && !hasOpenTool(next)) {
    next = setStatus(next, 'thinking');
  }
  return next;
}

// ----- system / result / rate_limit -----

function reduceSystem(session, payload) {
  switch (payload.subtype) {
    case 'init':
      return {
        ...session,
        sessionId: payload.session_id ?? session.sessionId,
        model: payload.model ?? session.model,
        cwd: payload.cwd ?? session.cwd,
        tools: payload.tools ?? session.tools,
      };
    case 'status':
      return {
        ...session,
        statusText: typeof payload.status === 'string' ? payload.status : null,
        // set_permission_mode 성공 시 CLI가 새 permissionMode를 실어 보낸다(v2.1.206 실측)
        // — 낙관적 UI 갱신과 어긋나면 CLI 쪽이 권위다.
        permissionMode:
          typeof payload.permissionMode === 'string'
            ? payload.permissionMode
            : session.permissionMode,
      };
    case 'thinking_tokens':
      return { ...session, thinkingTokens: payload.estimated_tokens ?? null };
    case 'hook_started':
    case 'hook_response':
      return session; // 렌더 불필요(일시 상태)
    case 'notification':
      return append(session, {
        kind: 'notice',
        text: String(payload.message ?? payload.notification ?? ''),
      });
    default:
      return append(session, { kind: 'raw', payload });
  }
}

function reduceResult(session, payload) {
  let next = adoptSessionId(session, payload);

  // 남은 스트리밍 블록 정리(비정상 종료 대비)
  if (next.messages.some((m) => m.streaming)) {
    next = {
      ...next,
      messages: next.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    };
  }

  // 결과가 끝내 안 온 열린 tool_use는 턴 종료가 합성 결과로 닫는다(프로토콜상
  // tool_result는 항상 result보다 먼저다). 안 닫으면 인터럽트/크래시 고아가
  // hasOpenTool(status)·openSubagentCount(마스코트 juggle)·ToolCard("실행 중" 칩)를
  // 영구 오염시킨다 (DA #24).
  if (next.messages.some((m) => m.kind === 'tool_use' && m.result == null)) {
    next = {
      ...next,
      messages: next.messages.map((m) =>
        m.kind === 'tool_use' && m.result == null
          ? { ...m, result: { content: '(중단됨 — 결과 미수신)', isError: true, structured: null } }
          : m,
      ),
    };
  }

  const usage = payload.usage || {};
  next = {
    ...next,
    streaming: { msgId: null, blocks: {} },
    thinkingTokens: null,
    usage: {
      ...next.usage,
      // total_cost_usd는 세션 누적치 — 그대로 채택
      cost:
        typeof payload.total_cost_usd === 'number'
          ? payload.total_cost_usd
          : next.usage.cost,
      inTok: (next.usage.inTok || 0) + (usage.input_tokens || 0),
      outTok: (next.usage.outTok || 0) + (usage.output_tokens || 0),
      // 컨텍스트 크기는 reduceAssistant가 호출별 usage로 추적한다(그쪽 주석 참조 —
      // result.usage는 턴 합산이라 인플레). 여기서는 호출별 usage를 한 번도 못 본
      // 세션(fake-cli 등 usage 없는 assistant)의 폴백으로만 쓴다 — 단일 호출 턴은
      // 합산==마지막 호출이라 그 경우엔 정확하다.
      contextTokens: session.ctxFromCalls
        ? next.usage.contextTokens
        : (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) ||
          next.usage.contextTokens ||
          0,
    },
    lastResult: {
      subtype: payload.subtype ?? null,
      isError: !!payload.is_error,
      durationMs: payload.duration_ms ?? null,
      numTurns: payload.num_turns ?? null,
    },
    // 완결 턴 ≥1 = CLI가 트랜스크립트를 디스크에 남겼다는 뜻 — --resume 재시작 가능
    // (무턴 세션은 jsonl이 없어 --resume이 실패한다 — v2.1.206 실측).
    // is_error 결과라도 num_turns>0이면 유저 턴이 접수·기록된 것이므로 게이트를 연다
    // (resume 실패류 error_during_execution은 num_turns:0 — 실측 — 이라 계속 닫힌다).
    hasCompletedTurn:
      next.hasCompletedTurn || !payload.is_error || (payload.num_turns ?? 0) > 0,
  };

  // is_error 결과는 채팅에 남기지 않는다 — store('event' 처리)가 토스트로 알린다.

  // 턴별 토큰 사용량을 CLI풍으로 채팅에 남긴다(상태줄 대신). 토큰이 0인 결과
  // (설정 변경·resume 실패류 등 모델 미호출)는 소음이라 남기지 않는다.
  // is_error라도 토큰>0이면 남긴다 — 인터럽트/실패 턴도 소모량은 사실이고,
  // 에러 자체는 store가 토스트로 알린다(중복 아님).
  const turnIn = usage.input_tokens || 0;
  const turnOut = usage.output_tokens || 0;
  if (turnIn + turnOut > 0) {
    next = append(next, {
      kind: 'usage',
      inTok: turnIn,
      outTok: turnOut,
      durationMs: payload.duration_ms ?? null,
    });
  }

  return { ...next, status: next.status === 'exited' ? 'exited' : 'idle' };
}

// ----- 진입점 -----

export function reduceCliEvent(session, payload) {
  if (!payload || typeof payload !== 'object') return session;
  switch (payload.type) {
    case 'stream_event':
      return reduceStreamEvent(adoptSessionId(session, payload), payload);
    case 'assistant':
      return reduceAssistant(adoptSessionId(session, payload), payload);
    case 'user':
      return reduceUser(session, payload);
    case 'system':
      return reduceSystem(session, payload);
    case 'result':
      return reduceResult(session, payload);
    case 'rate_limit_event':
      // 상시 표시부는 제거됨(2026-07-10) — 이벤트를 raw로 채팅에 흘리지 않기 위해
      // 계속 접수하고, 상태는 향후 임계 알림(토스트) 용도로 보존한다.
      return { ...session, rateLimit: payload.rate_limit_info ?? null };
    case 'control_request':
    case 'control_response':
      return session; // 서버가 처리(권한 요청은 별도 WS 타입으로 도착)
    default:
      return append(session, { kind: 'raw', payload });
  }
}
