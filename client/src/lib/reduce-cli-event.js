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
//   notice         { text }           (system/notification)
//   error          { text }           (result.is_error; store가 직접 추가하기도 함)
//   raw            { payload }        (미지의 타입 보존)
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
  let idx = -1;
  if (kind === 'tool_use' && block.id != null) {
    idx = findLastIndex(msgs, (m) => m.kind === 'tool_use' && m.toolUseId === block.id);
  }
  if (idx < 0) {
    // 같은 kind + content 블록 index, msgId가 호환(스트리밍분은 msgId를 모를 수 있음)되는
    // 가장 최근 아이템에 병합. 없으면 새로 추가.
    idx = findLastIndex(
      msgs,
      (m) =>
        m.kind === kind &&
        m.blockIndex === blockIndex &&
        (m.msgId == null || msgId == null || m.msgId === msgId),
    );
  }

  const confirmed = confirmedFields(block);
  if (idx < 0) {
    return append(session, {
      kind,
      msgId,
      blockIndex,
      streaming: false,
      parentToolUseId: parent,
      ...(kind === 'tool_use' ? { inputJson: '', result: null } : {}),
      ...confirmed,
    });
  }

  const messages = msgs.slice();
  const prev = messages[idx];
  messages[idx] = { ...prev, ...confirmed, msgId: msgId ?? prev.msgId, streaming: false };

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

  if (typeof content === 'string') {
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
    },
    lastResult: {
      subtype: payload.subtype ?? null,
      isError: !!payload.is_error,
      durationMs: payload.duration_ms ?? null,
      numTurns: payload.num_turns ?? null,
    },
  };

  if (payload.is_error) {
    next = append(next, {
      kind: 'error',
      text:
        typeof payload.result === 'string' && payload.result
          ? payload.result
          : `턴 실패 (${payload.subtype ?? 'unknown'})`,
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
      return { ...session, rateLimit: payload.rate_limit_info ?? null };
    case 'control_request':
    case 'control_response':
      return session; // 서버가 처리(권한 요청은 별도 WS 타입으로 도착)
    default:
      return append(session, { kind: 'raw', payload });
  }
}
