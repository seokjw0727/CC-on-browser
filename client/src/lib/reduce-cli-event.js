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
//   command        { name, args }     (슬래시 커맨드 호출 — /help 등, 커맨드 칩으로 렌더)
//   command-output { text, isError }  (로컬 커맨드 출력 — <local-command-stdout|stderr>)
//   compaction     { state:'running'|'done', trigger?, preTokens?, postTokens?, durationMs? }
//                                     (/compact 진행/완료 카드 — 진행바 + 토큰 감소량)
//   compaction-summary { text }       (압축 요약 사용자 메시지 — 접이식으로 보존)
//   cleared        {}                 (/clear — 컨텍스트 초기화 구분선)
//   error          { text }           (레거시 렌더 호환용 — 신규 에러는 store가 토스트로 표시)
//   raw            { payload }        (미지의 타입 보존)
//
// user 이벤트 분류(실 CLI v2.1.206 실측): isReplay:true(설정 변경 에코·히스토리 재전송)는
// 채팅에 추가하지 않고, 비-replay <local-command-stdout|stderr> 문자열(슬래시 커맨드 출력)은
// 태그를 벗겨 notice로 렌더한다. result.is_error도 채팅 대신 store가 토스트로 알린다.
//
// session.streaming = { msgId: string|null, blocks: { [contentBlockIndex]: uid } }

// CLI가 "모델을 호출하지 않고 스스로 만든" assistant 메시지에 싣는 모델 센티널.
// 실측(2026-07-30, 실 CLI v2.1.220): /clear 직후 CLI는 정상 모델을 담은 system/init을
// 먼저 보내고, 이어서 message.model='<synthetic>' + content '(no content)'인 더미
// assistant를 보낸다. 이 값을 진짜 모델로 수확하면 session.model이 오염돼 모델 피커가
// 미선택("모델")으로 풀리고 contextWindow까지 리셋된다 — 그래서 수확에서 배제한다.
// 미래 모델 id를 잘못 거르지 않도록 화이트리스트(claude-* 등)나 패턴이 아니라 실측된
// 이 센티널 값만 정확 비교로 막는다. 이 모듈 밖에서 참조할 곳이 없어 export하지 않는다.
const SYNTHETIC_MODEL = '<synthetic>';
const SYNTHETIC_PLACEHOLDER_TEXT = '(no content)';

// 그 더미 assistant인가 — 모델이 센티널이고 본문이 '(no content)' 텍스트 한 덩어리인
// 조합만. 그냥 렌더하면 초기화 구분선 바로 아래에 빈 어시스턴트 말풍선이 남는다.
// 센티널이어도 실제 안내 문구를 담고 오는 경우(로그인 요구 등)는 보여줘야 하므로
// 조합을 정확히 확인한다. 본선/서브에이전트 구분은 두지 않는다 — 어느 쪽이든 정보가 없다.
function isSyntheticPlaceholder(msg) {
  if (!msg || msg.model !== SYNTHETIC_MODEL) return false;
  const content = msg.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const only = content[0];
  return (
    !!only &&
    only.type === 'text' &&
    String(only.text ?? '').trim() === SYNTHETIC_PLACEHOLDER_TEXT
  );
}

let uidSeq = 0;
const nextUid = () => `m${++uidSeq}`;

function normStreaming(s) {
  return s && typeof s === 'object' && s.blocks ? s : { msgId: null, blocks: {} };
}

/**
 * 이벤트의 표시 시각(ms). CLI가 실어 보내는 건 최상위 payload.timestamp뿐이고
 * (payload.message.timestamp가 아니다 — usage.js:100·history.js도 같은 자리를 읽는다),
 * assistant 이벤트에만 붙는다. 없으면 주입된 시계로 대체한다.
 * 재개 트랜스크립트는 항목마다 timestamp가 있어 그대로 복원된다.
 */
function eventAt(payload, now) {
  const t = Date.parse(payload?.timestamp ?? '');
  return Number.isFinite(t) ? t : now;
}

/** at은 명시 인자로만 받는다 — 모듈 전역 "현재 시각"은 순수성·재진입성을 깬다. */
function append(session, item, at) {
  return {
    ...session,
    messages: [...session.messages, { uid: nextUid(), ...(at != null ? { at } : {}), ...item }],
  };
}

// 스트리밍 델타의 주 경로 — 대화가 길수록 이 함수가 가장 자주 불린다.
// .map은 항목마다 콜백을 부르지만 스트리밍이 건드리는 블록은 사실상 항상 끝쪽이므로,
// 뒤에서부터 찾아 slice(=단순 복사) + 인덱스 대입으로 바꾼다. 불일치 시 원본 세션을
// 그대로 돌려주는(참조 불변) 계약은 유지된다.
// 의미 차이 하나: 예전 .map은 같은 uid가 여러 개면 전부 갱신했고 이건 마지막 하나만
// 갱신한다. 현재 호출 경로에서는 관측되지 않는다 — uid는 이 모듈의 단조 증가 카운터
// (nextUid)가 발급하고, 프리로드(재개 트랜스크립트·effort 재시작)도 같은 카운터가
// 발급한 값을 그대로 들고 오기 때문이다. 다만 이건 코드가 강제하는 불변식은 아니어서
// (preloadMessages는 uid를 검증하지 않고 uidSeq를 전진시키지도 않는다) 외부에서 임의
// uid를 주입하는 경로가 생기면 함께 손봐야 한다 — codex 지적.
// 배열 복사 자체는 남으므로 CPU 상수 개선이지 O(1)이 되는 건 아니다: 실측(node,
// 400델타)으로 델타당 N=8000에서 75µs → 5.1µs이지만, 같은 조건 브라우저 측정에서
// 200델타 전체가 ~1ms라 JS 400ms대의 1%에도 못 미치는 부차적 항목이다.
function updateByUid(session, uid, fn) {
  const msgs = session.messages;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].uid === uid) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return session;
  const messages = msgs.slice();
  messages[idx] = fn(msgs[idx]);
  return { ...session, messages };
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

// CLI가 이벤트에 실어 보낸 session_id 채택. 아직 id가 없을 때는 물론이고, 재개
// 프리로드로 "원본 id"만 시딩돼 있는 동안(idConfirmed=false)에도 채택한다 — CLI가
// 말하는 id가 언제나 그 세션의 진짜 id이고, init을 놓친 경로에서도 이 이벤트가
// 최종 id를 확정해 준다(그러지 않으면 세션 이름 영속이 영영 보류에 머문다).
function adoptSessionId(session, payload) {
  if (typeof payload.session_id !== 'string' || !payload.session_id) return session;
  if (session.idConfirmed) return session;
  if (session.sessionId === payload.session_id) return { ...session, idConfirmed: true };
  return { ...session, sessionId: payload.session_id, idConfirmed: true };
}

function hasOpenTool(session) {
  return session.messages.some(
    (m) => m.kind === 'tool_use' && !m.streaming && m.result == null,
  );
}

// ----- 슬래시 커맨드 / 컨텍스트 압축(/compact) / 초기화(/clear) 헬퍼 -----

// 슬래시 커맨드 호출 에코: `<command-name>/foo</command-name> … <command-args>…</command-args>`
// (실 CLI 실측 wire format). 감싸는 caveat 블록이 앞에 붙어도 이름/인자를 뽑는다.
function parseCommandEcho(content) {
  const nameM = /<command-name>([^<]*)<\/command-name>/.exec(content);
  if (!nameM) return null;
  const argsM = /<command-args>([\s\S]*?)<\/command-args>/.exec(content);
  return { name: nameM[1].trim().replace(/^\//, ''), args: (argsM ? argsM[1] : '').trim() };
}

// 낙관 렌더(직접 전송) 아이템에 optimistic:true를 달아 두고, CLI 에코가 도착하면
// 그 미확정 항목을 "소비"(optimistic 해제)해 중복을 흡수한다. 이 짝짓기 방식은
// 창(window) 휴리스틱과 달리 "같은 커맨드를 두 번 실행"을 과잉 흡수하지 않는다
// (두 번째는 확정된 첫 칩을 건너뛰고 새 미확정 칩을 만든다). CLI가 에코를 아예
// 안 보내도 낙관 칩이 그대로 남아 렌더되므로 양쪽에서 안전하다.
function consumeOptimistic(session, pred) {
  const idx = findLastIndex(session.messages, (m) => m.optimistic && pred(m));
  if (idx < 0) return null;
  const messages = session.messages.slice();
  messages[idx] = { ...messages[idx], optimistic: false };
  return { ...session, messages };
}

// 커맨드 호출을 아이템으로 반영 — /clear는 전용 초기화 구분선, 그 외는 커맨드 칩.
// /compact는 칩과 함께 진행 카드를 즉시 띄운다(느린 작업이라 즉각 피드백이 중요).
function reduceCommandInvocation(session, name, args, optimistic) {
  let next;
  if (name === 'clear') {
    const consumed = !optimistic ? consumeOptimistic(session, (m) => m.kind === 'cleared') : null;
    next = consumed || append(session, { kind: 'cleared', ...(optimistic ? { optimistic: true } : {}) });
    // /clear는 CLI 컨텍스트를 비운다 — 모델 호출이 없어 assistant/result가 오지 않으므로
    // 여기서 즉시 0으로 내리지 않으면 상태줄 CTX가 다음 턴까지 압축 전 값으로 남는다.
    // 낙관·에코 양쪽에서 쓰지만 같은 값이라 멱등(consumeOptimistic은 메시지 플래그만 해제).
    // ctxFromCalls는 건드리지 않는다: true로 강제하면 호출별 usage를 못 받는 세션
    // (result-only)이 이후 실제 턴에서도 폴백을 못 써 영구히 0에 고착된다.
    next = { ...next, usage: { ...next.usage, contextTokens: 0, ctxDisplayable: true } };
  } else {
    const matches = (m) => m.kind === 'command' && m.name === name && (m.args || '') === (args || '');
    // 에코가 낙관 칩을 확정
    next = (!optimistic && consumeOptimistic(session, matches)) || null;
    if (!next) {
      next = append(session, { kind: 'command', name, args: args || '', ...(optimistic ? { optimistic: true } : {}) });
    }
    // 진행 카드는 낙관(사용자가 방금 실행)일 때만 즉시 띄운다. 재개 트랜스크립트의
    // 에코로는 만들지 않는다 — 뒤에 완료 신호(Compacted/result)가 없는 잘린 히스토리에서
    // 무한 진행바가 남는 것을 원천 차단(라이브의 status:'compacting'은 별개 경로로 여전히
    // 진행 카드를 만든다). 멱등이라 status와 겹쳐도 중복되지 않는다.
    if (name === 'compact' && optimistic) next = startCompaction(next);
    // /goal 호출은 커맨드 칩을 남기되, 구동 중 기능 배지용 목표 상태도 함께 갱신한다.
    if (name === 'goal') next = applyGoalCommand(next, args);
  }
  // 커맨드 턴은 재시도 가능한 "plain 프롬프트"가 아니다 — 인터럽트 복구 바가 직전
  // plain 프롬프트를 stale하게 물고 오지 않도록(예: 프롬프트 완료 후 /compact를 Esc로
  // 중단) lastUserText를 비운다. 복구 바는 plain 텍스트 턴이 중단됐을 때만 의미가 있다.
  return { ...next, lastUserText: null };
}

// /goal <텍스트> = 목표 설정, /goal clear = 해제. 인자 없는 /goal(조회)은 상태를
// 건드리지 않는다. 배지 표시용 session.goal만 갱신하고 렌더는 그대로 커맨드 칩이 맡는다.
function applyGoalCommand(session, args) {
  const a = (args || '').trim();
  if (/^clear\b/i.test(a)) return { ...session, goal: null };
  if (a === '') return session;
  return { ...session, goal: a };
}

// 가장 최근 커맨드 칩의 이름 — /goal stdout 흡수를 그 명령이 방금 실행됐을 때로 한정하는 데 쓴다.
function lastCommandName(session) {
  const idx = findLastIndex(session.messages, (m) => m.kind === 'command');
  return idx >= 0 ? session.messages[idx].name : null;
}

// 프리로드된 메시지(재개/effort 재시작)에서 마지막 /goal 상태를 복원한다. 시딩은
// 리듀서를 안 태우므로, 이게 없으면 goal 배지가 재시작·재개에서 사라진다(같은 대화가
// 이어지는데도). 커맨드 칩(kind:'command', name:'goal')을 역순으로 훑어 set/clear를 판정.
export function deriveGoalFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.kind !== 'command' || m.name !== 'goal') continue;
    const a = (m.args || '').trim();
    if (/^clear\b/i.test(a)) return null; // 마지막 동작이 해제
    if (a === '') continue; // 조회 — 더 이전 설정을 계속 찾는다
    return a;
  }
  return null;
}

function findRunningCompaction(messages) {
  return findLastIndex(messages, (m) => m.kind === 'compaction' && m.state === 'running');
}

// 트랜스크립트(프리로드)는 camelCase(preTokens), live wire는 snake_case(pre_tokens)로
// 온다(실 CLI 실측 — 같은 이벤트인데 표기가 다르다). 양쪽 모두 수용한다.
function compactionMetaFields(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  if (typeof meta.trigger === 'string') out.trigger = meta.trigger;
  const pre = meta.preTokens ?? meta.pre_tokens;
  const post = meta.postTokens ?? meta.post_tokens;
  const dur = meta.durationMs ?? meta.duration_ms;
  if (Number.isFinite(pre)) out.preTokens = pre;
  if (Number.isFinite(post)) out.postTokens = post;
  if (Number.isFinite(dur)) out.durationMs = dur;
  return out;
}

// /compact 시작 — status:'compacting' 이벤트로 진입. 이미 진행 카드가 있으면 유지.
function startCompaction(session, trigger) {
  if (findRunningCompaction(session.messages) >= 0) return session;
  return append(session, { kind: 'compaction', state: 'running', ...(trigger ? { trigger } : {}) });
}

// /compact 완료 — compact_boundary(풍부한 메타) 또는 "Compacted" 출력(메타 없음)이
// 신호. 진행 카드를 완료로 전환하고, 시작을 못 봤으면 완료 카드를 새로 만든다.
// 여러 완료 신호가 겹쳐도(경계 이벤트 + stdout) 카드는 하나만 유지·보강한다.
function finishCompaction(session, meta) {
  const fields = compactionMetaFields(meta);
  // 압축 후 컨텍스트 크기는 경계 메타(postTokens)가 권위 — 카드뿐 아니라 상태줄 CTX에도
  // 즉시 반영한다(/compact는 모델 호출이 없어 assistant/result가 CTX를 갱신하지 않는다).
  // **아래 모든 분기가 이 base를 써야 한다** — 특히 메타 보강만 하고 조기 return하는
  // recentDuplicate 경로("stdout 먼저 → boundary 나중" 순서에서 숫자가 여기로 온다).
  // ctxFromCalls=true: 직후 이어지는 result의 턴 합산이 postTokens를 덮는 것을 막는다.
  // 0은 유효한 값(전부 압축됨)이라 받아들이고, 음수·비유한은 usage에 반영하지 않는다
  // (카드 표시는 compactionMetaFields가 정한 대로 그대로 둔다).
  const base =
    Number.isFinite(fields.postTokens) && fields.postTokens >= 0
      ? {
          ...session,
          ctxFromCalls: true,
          usage: { ...session.usage, contextTokens: fields.postTokens, ctxDisplayable: true },
        }
      : session;
  const runIdx = findRunningCompaction(base.messages);
  if (runIdx >= 0) {
    const messages = base.messages.slice();
    messages[runIdx] = { ...messages[runIdx], state: 'done', ...fields };
    return { ...base, messages };
  }
  // 진행 카드가 없다. 방금(최근 몇 메시지 이내) 완료 처리한 카드에 대한 중복 신호
  // (compact_boundary + "Compacted"가 잇달아 옴)면 메타만 보강/무시한다. 그렇지 않고
  // 오래전 완료 카드만 있거나 아예 없으면 새 완료 카드를 만든다(예: 자동 압축).
  const lastIdx = findLastIndex(base.messages, (m) => m.kind === 'compaction');
  const recentDuplicate =
    lastIdx >= 0 &&
    base.messages[lastIdx].state === 'done' &&
    lastIdx >= base.messages.length - 3;
  if (recentDuplicate) {
    if (Object.keys(fields).length === 0) return base; // 추가 정보 없는 중복 신호
    const messages = base.messages.slice();
    messages[lastIdx] = { ...messages[lastIdx], ...fields };
    return { ...base, messages };
  }
  return append(base, { kind: 'compaction', state: 'done', ...fields });
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

function reduceStreamEvent(session, payload, at) {
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
      let next = append(session, item, at);
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
        next = append(next, item, at);
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

function confirmBlock(session, block, msgId, blockIndex, parent, at) {
  const kind =
    block.type === 'text'
      ? 'assistant-text'
      : block.type === 'thinking' || block.type === 'redacted_thinking'
        ? 'thinking'
        : block.type === 'tool_use'
          ? 'tool_use'
          : null;
  if (!kind) return append(session, { kind: 'raw', payload: block }, at);

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
    }, at);
  }

  const messages = msgs.slice();
  const prev = messages[idx];
  const merged = {
    ...prev,
    ...confirmed,
    msgId: msgId ?? prev.msgId,
    streaming: false,
    confirmed: true,
    // content_block_start 시점에 찍은 잠정 시각을 확정 assistant의 실제 시각으로 덮는다.
    // 이 갱신이 없으면 스트리밍으로 온 답변은 영원히 "수신 시작 시각"으로 남는다.
    ...(at != null ? { at } : {}),
  };
  // 사고 과정 본문은 스트리밍 thinking_delta로만 도착하고, 최종 assistant 블록의
  // thinking 필드는 ''(서명만 존재)로 온다(실 CLI 실측). 확정값이 비면 스트리밍으로
  // 누적한 본문을 덮어쓰지 않고 보존한다 — 안 그러면 펼쳤을 때 내용이 사라진다.
  if (kind === 'thinking' && !confirmed.thinking && prev.thinking) {
    merged.thinking = prev.thinking;
  }
  messages[idx] = merged;

  // streaming.blocks에 남아 있는 해당 uid 매핑 제거
  const streaming = normStreaming(session.streaming);
  const blocks = { ...streaming.blocks };
  for (const k of Object.keys(blocks)) {
    if (blocks[k] === prev.uid) delete blocks[k];
  }
  return { ...session, messages, streaming: { msgId: streaming.msgId, blocks } };
}

function reduceAssistant(session, payload, at) {
  const msg = payload.message || {};
  // /clear 직후의 더미 assistant는 통째로 무시 — 렌더할 본문도, 수확할 모델·usage도
  // 없다(usage는 아예 없거나 0). status는 건드리지 않고 뒤따르는 result가 idle로 돌린다.
  if (isSyntheticPlaceholder(msg)) return session;
  const msgId = msg.id ?? null;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const parent = payload.parent_tool_use_id ?? null;
  let next = session;
  content.forEach((block, i) => {
    next = confirmBlock(next, block, msgId, i, parent, at);
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
        usage: { ...next.usage, contextTokens: ctx, ctxDisplayable: true },
      };
    }
  }

  // 본선 assistant의 message.model 수확 — init 없는 재개 트랜스크립트 복원과
  // 대역외 모델 전환(채팅 /model, CLI측 폴백) 추적의 출처. 실측(2026-07-11,
  // opus[1m] 캡처): assistant는 [1m] 접미사가 탈락한 bare id('claude-opus-4-8')를
  // 보고하고 init은 접미사를 유지('claude-opus-4-8[1m]')한다 — 그래서 **base
  // (접미사 제거)가 다를 때만 덮어쓴다**: 같은 base면 기존 값이 더 정밀([1m] 보존),
  // 다른 base면 진짜 모델 전환. 같은 base의 [1m]→비[1m] 전환만은 bare id로 구별
  // 불가(스트림 고유 모호성 — DA #22). 서브에이전트 모델과 SYNTHETIC_MODEL은 제외.
  if (
    parent == null &&
    !payload.isSidechain &&
    typeof msg.model === 'string' &&
    msg.model &&
    msg.model !== SYNTHETIC_MODEL
  ) {
    const curBase = String(next.model ?? '').replace(/\[1m\]$/, '');
    if (next.model == null) {
      next = { ...next, model: msg.model };
    } else if (curBase !== msg.model) {
      // 진짜 모델 전환 — 이전 모델의 result가 보고한 창 크기는 무효가 되므로
      // 함께 리셋한다(다음 result까지 카탈로그 휴리스틱 폴백 — codex 지적).
      next = { ...next, model: msg.model, contextWindow: null };
    }
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

// 압축 요약 user 메시지의 본문 접두(고정 문구). 트랜스크립트 프리로드에는
// isCompactSummary 플래그가 있지만 **live wire에는 없다**(실측: isSynthetic:true뿐)
// — 본문 패턴이 없으면 /compact 직후 요약 전체가 거대한 사용자 버블로 렌더된다.
const COMPACT_SUMMARY_RE = /^This session is being continued from a previous conversation/;

// CLI가 컨텍스트에 주입하는 user 이벤트의 본문 패턴 폴백 — 플래그(isMeta/isSynthetic)가
// 누락된 경로 대비. 훅 피드백("Stop hook feedback:")과 로컬 커맨드 캐빗은 사용자가
// 직접 입력할 수 없는 형식이라 오검 위험이 없다.
const INJECTED_NOISE_RE = /^(?:<local-command-caveat>|Stop hook feedback:)/;

function reduceUser(session, payload, at) {
  const msg = payload.message || {};
  const content = msg.content;
  let next = adoptSessionId(session, payload);

  // isReplay:true = CLI가 자기 히스토리를 되쏘는 이벤트(설정 변경 에코, 향후 resume replay
  // 가능성) — 대화가 아니고 preload와 중복될 수 있으므로 채팅에 추가하지 않는다(파일 헤더 참조).
  if (payload.isReplay) return next;

  if (typeof content === 'string') {
    // 슬래시 커맨드 호출 에코(<command-name>…)는 커맨드 칩/초기화 구분선으로.
    // payload.optimistic=true는 컴포저가 직접 전송 시 낙관 렌더로 만든 합성 이벤트.
    // 주입 메시지 억제(아래)보다 먼저 — caveat 블록이 에코를 감싸서 한 이벤트로 오는
    // 실측 케이스에서 커맨드 칩을 잃지 않기 위해서다(parseCommandEcho 주석 참조).
    const cmd = parseCommandEcho(content);
    if (cmd) return reduceCommandInvocation(next, cmd.name, cmd.args, payload.optimistic === true);
    // 로컬 커맨드 출력(슬래시 커맨드 결과)은 삼키지 않고 결과 블록으로 보여준다.
    // ANSI 색 이스케이프는 제거 — TUI가 기록한 세션은 "\x1b[2mCompacted (ctrl+o…)"
    // 처럼 출력 앞에 이스케이프가 붙어(실측) ^Compacted 판별이 빗나가고, 렌더 시
    // 깨진 문자로 보인다.
    const outM = /^<local-command-(stdout|stderr)>/.exec(content);
    if (outM) {
      const text = content
        .replace(/<\/?local-command-(stdout|stderr)>/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .trim();
      // "Compacted …"는 /compact 완료 신호 — 압축 카드로 흡수(별도 출력 렌더 안 함).
      if (/^Compacted\b/i.test(text)) return finishCompaction(next, null);
      // "Goal set:"/"Goal cleared" stdout은 목표 배지의 폴백 신호지만, 임의 커맨드 출력이
      // 우연히 같은 접두사로 시작하면 삼켜지므로(그 출력·오류가 사라짐) **직전 커맨드가
      // /goal이고 stdout일 때만** 흡수한다. 커맨드 에코 경로(applyGoalCommand)가 이미
      // 권위이므로 여기선 중복 출력 억제가 주목적이다. stderr은 절대 삼키지 않는다.
      if (outM[1] === 'stdout' && lastCommandName(next) === 'goal') {
        const goalSet = /^Goal set:\s*([\s\S]*)$/i.exec(text);
        if (goalSet) return { ...next, goal: goalSet[1].trim() || next.goal };
        if (/^Goal (cleared|unset)\b/i.test(text)) return { ...next, goal: null };
      }
      return text
        ? append(next, { kind: 'command-output', text, isError: outM[1] === 'stderr' })
        : next;
    }
  }

  // 단일 텍스트 본문(문자열 또는 text 블록 하나)을 뽑는다 — 주입 메시지 판별용.
  const soleText =
    typeof content === 'string'
      ? content
      : Array.isArray(content) &&
          content.length === 1 &&
          content[0]?.type === 'text' &&
          typeof content[0].text === 'string'
        ? content[0].text
        : null;
  if (soleText != null) {
    // 본문 패턴 폴백은 **문자열 본문에만** 적용한다 — 실측상 CLI 주입 이벤트(요약·
    // 넛지·캐빗·훅 피드백)는 전부 문자열 content인 반면, 사용자가 직접 친 프롬프트는
    // 컴포저·서버 모두 text 블록 배열로 보낸다(우연히 같은 접두사로 시작하는 진짜
    // 발화를 오검하지 않기 위한 경계 — codex 지적).
    const isStringBody = typeof content === 'string';
    // 압축 요약(이전 대화를 이어받는 user 메시지) — 거대한 버블 대신 접이식 요약 카드.
    if (payload.isCompactSummary || (isStringBody && COMPACT_SUMMARY_RE.test(soleText))) {
      return append(next, { kind: 'compaction-summary', text: soleText });
    }
    // CLI가 주입하는 합성/메타 user 이벤트(Stop 훅 피드백, 커맨드 캐빗, "no visible
    // output" 넛지 등)는 사용자 발화가 아니다 — TUI와 동일하게 렌더하지 않는다.
    // 실측상 트랜스크립트 프리로드는 isMeta, live wire는 isSynthetic으로 표시된다.
    if (payload.isMeta === true || payload.isSynthetic === true) return next;
    if (isStringBody && INJECTED_NOISE_RE.test(soleText)) return next;
  }

  if (typeof content === 'string') {
    // 인터럽트 복구(재시도/수정)를 위해 사용자가 보낸 프롬프트 원문을 기억한다.
    return { ...append(next, { kind: 'user-text', text: content }, at), lastUserText: content };
  }
  if (!Array.isArray(content)) return next;

  for (const item of content) {
    if (item && item.type === 'tool_result') {
      next = attachToolResult(next, item, payload.tool_use_result);
    } else if (item && item.type === 'text') {
      next = append(next, { kind: 'user-text', text: item.text ?? '' }, at);
      next = { ...next, lastUserText: item.text ?? '' };
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
        // CLI가 직접 알려 준 id = 최종 id(재개는 여기서 fork된 새 id가 온다).
        // 이 시점부터 세션 이름을 이 id로 영속해도 안전하다(store.jsx).
        idConfirmed: session.idConfirmed || typeof payload.session_id === 'string',
        model: payload.model ?? session.model,
        cwd: payload.cwd ?? session.cwd,
        tools: payload.tools ?? session.tools,
      };
    case 'status': {
      const next = {
        ...session,
        statusText: typeof payload.status === 'string' ? payload.status : null,
        // set_permission_mode 성공 시 CLI가 새 permissionMode를 실어 보낸다(v2.1.206 실측)
        // — 낙관적 UI 갱신과 어긋나면 CLI 쪽이 권위다.
        permissionMode:
          typeof payload.permissionMode === 'string'
            ? payload.permissionMode
            : session.permissionMode,
      };
      // /compact 시작 신호 — 진행 카드(진행바)를 띄운다. compact_boundary가 완료로 전환.
      return payload.status === 'compacting' ? startCompaction(next) : next;
    }

    // 컨텍스트 압축 경계 — /compact 완료. preTokens→postTokens 감소량을 완료 카드에
    // 싣는다. 메타 키는 트랜스크립트=compactMetadata, live wire=compact_metadata(실측).
    case 'compact_boundary':
      return finishCompaction(session, payload.compactMetadata ?? payload.compact_metadata);
    case 'thinking_tokens':
      return { ...session, thinkingTokens: payload.estimated_tokens ?? null };

    // ----- 백그라운드 작업(실행 중 도크) -----
    // CLI는 백그라운드 셸·에이전트를 1급 이벤트로 알려 준다(2026-07-30 실측, v2.1.220).
    // background_tasks_changed는 **현재 실행 중인 것의 전체 스냅샷**이라, 도구 결과
    // 텍스트를 정규식으로 읽어 등재/해제하는 휴리스틱이 통째로 필요 없다.
    // 스냅샷이라 재개 세션의 유령도 원천적으로 없다(새 CLI 프로세스는 빈 배열로 시작).
    case 'background_tasks_changed':
      return {
        ...session,
        backgroundTasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      };

    // task_started는 task_id ↔ tool_use_id를 이어 준다 — 도크 항목에서 대화 속 해당
    // 도구 카드로 점프하기 위한 유일한 연결 고리다. 스냅샷에는 이 정보가 없다.
    case 'task_started': {
      const id = payload.task_id;
      if (typeof id !== 'string' || !id) return session;
      return {
        ...session,
        taskToolUseIds: { ...(session.taskToolUseIds ?? {}), [id]: payload.tool_use_id ?? null },
      };
    }

    // task_updated·task_notification은 표시에 쓰지 않는다 — 무엇이 돌고 있는지는
    // 스냅샷이 권위다. 여기서 조용히 흡수해 raw로 채팅에 새지 않게만 한다.
    case 'task_updated':
    case 'task_notification':
      return session;
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

  // 안전망: 압축 진행 카드가 완료 신호(compact_boundary/stdout) 없이 턴이 끝났으면
  // 여기서 닫는다 — 영구 진행바 방지(compact_boundary는 보통 result보다 앞선다).
  // 단, 인터럽트/실패로 끝난 턴(is_error)은 "완료"가 아니라 "중단됨"으로 닫는다
  // (사용자가 78초 압축을 Esc로 중단할 수 있다 — codex 지적).
  const compRunIdx = findRunningCompaction(next.messages);
  if (compRunIdx >= 0) {
    if (payload.is_error) {
      const messages = next.messages.slice();
      messages[compRunIdx] = { ...messages[compRunIdx], state: 'canceled' };
      next = { ...next, messages };
    } else {
      next = finishCompaction(next, null);
    }
  }

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
  // 컨텍스트 크기는 reduceAssistant가 호출별 usage로 추적한다(그쪽 주석 참조 —
  // result.usage는 턴 합산이라 인플레). 여기서는 호출별 usage를 한 번도 못 본
  // 세션(fake-cli 등 usage 없는 assistant)의 폴백으로만 쓴다 — 단일 호출 턴은
  // 합산==마지막 호출이라 그 경우엔 정확하다.
  const ctxTokens = session.ctxFromCalls
    ? next.usage.contextTokens
    : (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) ||
      next.usage.contextTokens ||
      0;
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
      contextTokens: ctxTokens,
      // 이미 표시 중이면(예: /clear 직후의 의도된 0) 토큰 0인 result가 링을 도로 숨기지
      // 않도록 유지한다. 처음으로 0이 아닌 값을 얻은 result는 여기서 표시를 연다.
      ctxDisplayable: next.usage.ctxDisplayable || ctxTokens > 0,
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

  // 컨텍스트 창 크기 — result.modelUsage[<id>].contextWindow가 1차 출처(실측
  // 2026-07-11: 'claude-opus-4-8[1m]' 키에 contextWindow: 1000000). 세션 모델과
  // base가 일치하는 항목을 채택하고, 없으면 단일 항목일 때만 신뢰(서브에이전트
  // 모델이 키로 혼입될 가능성 대비). 문자열/카탈로그 휴리스틱(format.js)은 이
  // 값이 없을 때의 폴백이 된다.
  const mu = payload.modelUsage;
  if (mu && typeof mu === 'object') {
    const entries = Object.entries(mu).filter(([, v]) => Number.isFinite(v?.contextWindow));
    const strip = (v) => String(v ?? '').replace(/\[1m\]$/, '');
    // 정확 키 우선, base 일치는 유일할 때만 — 같은 base의 [1m]·비[1m] 키가
    // 공존하면 순서에 따라 오판할 수 있다(codex 지적).
    const baseHits = entries.filter(([k]) => strip(k) === strip(next.model));
    const match =
      entries.find(([k]) => k === next.model) ??
      (baseHits.length === 1 ? baseHits[0] : null);
    const chosen = match ?? (entries.length === 1 ? entries[0] : null);
    if (chosen && chosen[1].contextWindow > 0) {
      next = { ...next, contextWindow: chosen[1].contextWindow };
    }
  }

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

// 시딩(재개/effort 재시작 프리로드)용 최종 flush — 완료 신호 없이 잘린 히스토리에서
// 넘어온 'running' 압축 카드를 완료로 닫는다. 정적 뷰에 무한 진행바가 남지 않게.
export function finalizeCompactionCards(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m && m.kind === 'compaction' && m.state === 'running') {
      changed = true;
      return { ...m, state: 'done' };
    }
    return m;
  });
  return changed ? out : messages;
}

// ----- 진입점 -----

export function reduceCliEvent(session, payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return session;
  const at = eventAt(payload, now);
  switch (payload.type) {
    case 'stream_event':
      return reduceStreamEvent(adoptSessionId(session, payload), payload, at);
    case 'assistant':
      return reduceAssistant(adoptSessionId(session, payload), payload, at);
    case 'user':
      return reduceUser(session, payload, at);
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
    // 서버 허브가 CLI의 stderr·비-JSON stdout 라인을 {type:'raw', line}으로 중계한다
    // (session-hub). 이는 프로토콜 내부 노이즈(미지 구조화 이벤트)와 달리 실제 진단
    // 메시지일 수 있으므로, 숨기지 않고 눈에 띄지 않는 notice로 표시한다(조용히 삼키면
    // CLI 경고/오류가 사라진다 — codex 지적). 미지의 "구조화" 이벤트는 아래 default가
    // kind:'raw'로 담고 뷰에서 디버그 게이트로 가린다.
    case 'raw': {
      const line = typeof payload.line === 'string' ? payload.line.trim() : '';
      return line ? append(session, { kind: 'notice', text: line }) : session;
    }
    default:
      return append(session, { kind: 'raw', payload });
  }
}
