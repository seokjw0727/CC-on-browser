// 컴포저(레퍼런스 충실) — 상단 pill 행(레포·권한모드), 입력, 하단 컨트롤(모델 피커 +
// 노력 수준 진행 바 + 전송), 그 아래 상태줄(컨텍스트·5h/7d 사용량·연결·테마).
// 상단 바를 대체한다. 설정 변경(모델·권한 모드·노력)은 채팅 기록 대신 토스트로 알린다.
// 턴별 토큰(입/출력)은 상태줄이 아니라 채팅에 usage 아이템으로 표시(reduce-cli-event).
// Enter 전송/Shift+Enter 개행, `/` 커맨드 드롭다운, Esc/버튼 interrupt.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { fmtTok, shortPath } from '../lib/format.js';
import { MODES, MODE_LABEL, MODE_CLASS } from '../lib/permission-modes.js';
import Clawd from './Clawd.jsx';
import './interact.css';

const MAX_HEIGHT_PX = 200;

const CONN_LABEL = { connecting: '연결 중', open: '연결됨', closed: '연결 끊김' };

const CONTEXT_WINDOW = 200_000; // Claude 표준 컨텍스트 창(200k tok) 기준 사용률
function usageWindowTitle(label, b) {
  return (
    `${label} — 입력 ${b.inputTokens.toLocaleString()}` +
    ` · 출력 ${b.outputTokens.toLocaleString()}` +
    ` · 캐시읽기 ${b.cacheReadTokens.toLocaleString()}` +
    ` · 캐시생성 ${b.cacheCreationTokens.toLocaleString()} tok` +
    ' (로컬 트랜스크립트 집계)'
  );
}
// 7일 창 리셋처럼 하루를 넘기는 시각은 날짜까지 보여준다.
function fmtReset(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString()
      : d.toLocaleString();
  } catch {
    return null;
  }
}
function quotaTitle(label, q, local) {
  const reset = fmtReset(q.resetsAt);
  return (
    `${label} 사용률 ${Math.round(q.utilization)}% — 계정 공식 수치(/usage와 동일)` +
    (reset ? ` · ${reset} 리셋` : '') +
    (local ? ` · 로컬 집계 참고 ${fmtTok(local.totalTokens)} tok` : '')
  );
}

// 텍스트(label)를 둘러싼 원형 게이지 — 사용률 pct(0~100)만큼 링이 채워진다.
function RingStat({ label, pct, title }) {
  const R = 9;
  const C = 2 * Math.PI * R;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const cls = clamped >= 95 ? ' danger' : clamped >= 80 ? ' warn' : '';
  return (
    <span
      className={`meta-item ring-stat${cls}`}
      title={title}
      role="img"
      aria-label={`${label} ${Math.round(clamped)}%`}
    >
      <svg className="ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle className="ring-track" cx="12" cy="12" r={R} />
        <circle
          className="ring-fill"
          cx="12"
          cy="12"
          r={R}
          strokeDasharray={`${(clamped / 100) * C} ${C}`}
        />
        <text className="ring-label" x="12" y="12">{label}</text>
      </svg>
      <span className="ring-pct">{Math.round(clamped)}%</span>
    </span>
  );
}
// ----- 공용 팝오버 동작 — 바깥 클릭/Esc 닫기, 열릴 때 선택 항목으로 포커스 -----
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrapRef.current?.querySelector('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, wrapRef };
}

// 메뉴 내 화살표 키 이동 (ARIA menu 관례)
function menuArrowNav(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll('.mm-item, .effort-seg')];
  const idx = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown'
    ? items[Math.min(idx + 1, items.length - 1)]
    : items[Math.max(idx - 1, 0)];
  next?.focus();
}

// claude.ai 모델 피커를 본딴 카탈로그 — 표시 이름·설명은 claude.ai 서비스 문구 기준,
// 전송 value·버전은 CLI initialize의 실측 목록(value/resolvedModel)에서 취한다.
const MODEL_FAMILIES = [
  { family: 'haiku', name: 'Haiku', fallbackValue: 'haiku', fallbackVersion: '4.5', desc: '빠른 응답이 필요한 가벼운 작업에 최적' },
  { family: 'sonnet', name: 'Sonnet', fallbackValue: 'sonnet', fallbackVersion: '5', desc: '일상 업무를 위한 똑똑하고 효율적인 모델' },
  { family: 'opus', name: 'Opus', fallbackValue: 'opus', fallbackVersion: '4.8', desc: '복잡한 과제를 위한 강력한 대형 모델' },
  { family: 'fable', name: 'Fable', fallbackValue: 'claude-fable-5', fallbackVersion: '5', desc: '가장 어렵고 긴 작업을 위한 최고 성능 모델' },
];

function parseVersion(resolvedModel) {
  const m = /claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(String(resolvedModel ?? ''));
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

function familyOf(model) {
  const s = String(model ?? '').toLowerCase();
  return MODEL_FAMILIES.find((f) => s.includes(f.family)) ?? null;
}

function buildModelOptions(models) {
  return MODEL_FAMILIES.map((f) => {
    const entry = models.find(
      (m) =>
        m.value !== 'default' &&
        `${m.resolvedModel ?? ''} ${m.value ?? ''} ${m.displayName ?? ''}`.toLowerCase().includes(f.family),
    );
    return {
      ...f,
      value: entry?.value ?? f.fallbackValue,
      version: parseVersion(entry?.resolvedModel) ?? f.fallbackVersion,
      cliEntry: entry ?? null,
    };
  });
}

// ----- 모델 피커 (claude.ai식 메뉴: 이름 + 버전 + 설명 + 체크) -----
function ModelPicker({ session, options, disabled, onSelect }) {
  const { open, setOpen, wrapRef } = usePopover();
  const fam = familyOf(session.model);
  const curOpt = fam ? options.find((o) => o.family === fam.family) : null;
  const label = curOpt ? `Claude ${curOpt.name} ${curOpt.version}` : session.model || '모델';
  return (
    <span className="model-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="pill model-menu-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="모델 선택"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{label}</span>
        <span className="mm-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="mm-menu" role="menu" aria-label="모델 선택" onKeyDown={menuArrowNav}>
          <div className="mm-section">모델</div>
          {options.map((o) => {
            const sel = curOpt?.family === o.family;
            return (
              <button
                key={o.family}
                type="button"
                role="menuitemradio"
                aria-checked={sel}
                className="mm-item"
                onClick={() => {
                  onSelect(o.value);
                  setOpen(false);
                }}
              >
                <span className="mm-text">
                  <span className="mm-name">
                    Claude {o.name} <span className="mm-ver">{o.version}</span>
                  </span>
                  <span className="mm-desc dim">{o.desc}</span>
                </span>
                {sel && <span className="mm-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

// ----- 노력 수준 피커 — progress bar 형태 (--effort는 spawn 전용 → 변경 시 --resume 재시작) -----
const EFFORT_LEVELS = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '중간' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '매우 높음' },
  { value: 'max', label: '최대' },
];
const DEFAULT_EFFORT = 'high'; // CLI 기본값 (claude --help 실측: defaults to high)

function EffortPicker({ session, options, disabled, onSelect }) {
  const { open, setOpen, wrapRef } = usePopover();
  const fam = familyOf(session.model);
  const opt = fam ? options.find((o) => o.family === fam.family) : null;
  // CLI 항목이 supportsEffort를 명시하지 않은 모델(예: Haiku)은 비활성; 정보가 없으면 허용
  const supports = opt?.cliEntry ? !!opt.cliEntry.supportsEffort : true;
  const levels = opt?.cliEntry?.supportedEffortLevels?.length
    ? EFFORT_LEVELS.filter((l) => opt.cliEntry.supportedEffortLevels.includes(l.value))
    : EFFORT_LEVELS;
  const cur = session.effort ?? DEFAULT_EFFORT;
  const curIdx = Math.max(0, levels.findIndex((l) => l.value === cur));
  const curLabel = levels[curIdx]?.label ?? cur;

  return (
    <span className="model-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="pill model-menu-btn"
        disabled={disabled || !supports}
        aria-haspopup="menu"
        aria-expanded={open}
        title={supports ? '노력 수준 (변경 시 같은 대화로 재시작)' : '이 모델은 노력 수준을 지원하지 않습니다'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="effort-bar mini" aria-hidden="true">
          {levels.map((l, i) => (
            <span key={l.value} className={`effort-seg-vis${i <= curIdx ? ' fill' : ''}`} />
          ))}
        </span>
        <span className="truncate">노력 {curLabel}</span>
        <span className="mm-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="mm-menu effort-menu" role="menu" aria-label="노력 수준" onKeyDown={menuArrowNav}>
          <div className="mm-section">노력 수준</div>
          <div className="effort-track" role="group" aria-label="노력 수준 선택">
            {levels.map((l, i) => (
              <button
                key={l.value}
                type="button"
                role="menuitemradio"
                aria-checked={l.value === cur}
                aria-label={l.label}
                className={`effort-seg${i <= curIdx ? ' fill' : ''}`}
                title={l.label}
                onClick={() => {
                  if (l.value !== cur) onSelect(l.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="effort-labels">
            <span className="dim">{levels[0]?.label}</span>
            <span className="effort-cur">{curLabel}</span>
            <span className="dim">{levels[levels.length - 1]?.label}</span>
          </div>
          <div className="mm-desc dim effort-note">
            변경하면 같은 대화로 세션을 재시작합니다 (--effort는 시작 시에만 적용).
          </div>
        </div>
      )}
    </span>
  );
}

export default function Composer({ theme, onToggleTheme }) {
  const { state, dispatch, send, startSession, stopSession, notify } = useStore();
  const session = useActiveSession();
  const [text, setText] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const taRef = useRef(null);

  const busy = !!session && session.status !== 'idle' && session.status !== 'exited';
  const exited = session?.status === 'exited';
  const live = !!session && session.status !== 'exited';
  const canSend =
    !!session && session.status === 'idle' && state.conn === 'open' && text.trim() !== '';

  const models = Array.isArray(state.initInfo?.models) ? state.initInfo.models : [];
  const modelOptions = useMemo(() => buildModelOptions(models), [models]);
  const gu = state.globalUsage;
  const quota = gu?.quota;
  const ctxTokens = session?.usage?.contextTokens || 0;
  const ctxPct = (ctxTokens / CONTEXT_WINDOW) * 100;

  // ----- `/` 커맨드 드롭다운 -----
  const commands = useMemo(() => {
    const list = state.initInfo?.commands;
    if (!Array.isArray(list)) return [];
    return list
      .map((c) => (typeof c === 'string' ? { name: c, description: '' } : c))
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ ...c, name: c.name.replace(/^\//, '') }));
  }, [state.initInfo]);

  const cmdMatch = /^\/([\w:.-]*)$/.exec(text);
  const filtered = cmdMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith(cmdMatch[1].toLowerCase()))
    : [];
  const dropdownOpen = !cmdDismissed && !!cmdMatch && filtered.length > 0;

  useEffect(() => {
    setCmdDismissed(false);
    setSelIdx(0);
  }, [text]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const pickCommand = (cmd) => {
    if (!cmd) return;
    setText(`/${cmd.name} `);
    taRef.current?.focus();
  };

  const doSend = () => {
    if (!canSend) return;
    const t = text;
    const ok = send({ type: 'send', key: session.key, text: t });
    if (!ok) return;
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({
        ...reduceCliEvent(s, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        }),
        status: s.status === 'idle' ? 'thinking' : s.status,
      }),
    });
    setText('');
  };

  const doInterrupt = () => {
    if (busy) send({ type: 'interrupt', key: session.key });
  };

  // 낙관적 UI 갱신은 실제 전송이 성공했을 때만 — 끊긴 상태에서 바꾸면
  // CLI에 전달되지 않는데 UI만 바뀌어 모델/권한모드가 desync되는 것을 막는다.
  // 변경 확인은 채팅 기록이 아니라 토스트로 알린다(CLI의 로컬 커맨드 에코는
  // reduce-cli-event가 채팅에서 걸러낸다).
  const changeModel = (model) => {
    if (!session || !model) return;
    if (!send({ type: 'setModel', key: session.key, model })) return;
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, model }) });
    const opt = modelOptions.find((o) => o.value === model);
    notify(`모델 변경: ${opt ? `Claude ${opt.name} ${opt.version}` : model}`);
  };
  const changeMode = (mode) => {
    if (!session || !mode) return;
    if (!send({ type: 'setPermissionMode', key: session.key, mode })) return;
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, permissionMode: mode }) });
    notify(`권한 모드 변경: ${MODE_LABEL[mode] ?? mode}`);
  };
  // effort(--effort)는 spawn 전용 — 런타임 변경 채널이 없어(바이너리 실측) 같은
  // 대화로 재시작한다: 기존 프로세스 정지 → --effort 재스폰, 메시지는 메모리에서
  // 이월(preloadMessages), 새 탭이 옛 탭을 대체(replaceKey).
  // --resume은 트랜스크립트가 실제로 존재할 때만 붙인다: 완결 턴 ≥1 또는 재개로
  // 시작한 세션. 무턴 세션은 jsonl이 없어 --resume이 "No conversation found"로
  // 실패한다(실 CLI v2.1.206 실측) — 이때는 그냥 새로 시작해도 잃을 서버측 맥락이 없다.
  const changeEffort = (effort) => {
    // 트리거 disabled와 동일한 불변식을 여기서도 강제한다 — 팝오버가 열린 채로
    // 상태가 바뀌면(턴 시작·세션 전환) 버튼 잠금만으로는 못 막는다.
    // 연타(pendingStarts) 가드는 고아 세션 방지.
    if (
      !session ||
      state.conn !== 'open' ||
      state.pendingStarts.size > 0 ||
      session.status !== 'idle'
    ) return;
    const resumeId = session.sessionId ?? session.resumeSourceId;
    const canResume = session.hasCompletedTurn && resumeId != null;
    stopSession(session.key);
    startSession({
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      effort,
      resumeSessionId: canResume ? resumeId : null,
      preloadMessages: session.messages,
      replaceKey: session.key,
    });
    const label = EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? effort;
    // 문구는 실제 동작과 일치시킨다 — resume이 아닐 때 "같은 대화"라고 말하지 않는다.
    notify(
      canResume
        ? `노력 수준 변경: ${label} — 같은 대화로 세션을 재시작합니다`
        : `노력 수준 변경: ${label} — 완결된 턴이 없어 새 세션으로 시작합니다`,
    );
  };

  const onKeyDown = (e) => {
    if (dropdownOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickCommand(filtered[Math.min(selIdx, filtered.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      doInterrupt();
    }
  };

  const placeholder = !session
    ? '레포를 선택하면 대화를 시작할 수 있습니다'
    : exited
      ? '세션이 종료되었습니다'
      : '작업을 설명하거나 질문하세요';

  const repoLabel = session ? shortPath(session.cwd) || session.key : '레포 선택...';

  return (
    <div className="composer-dock">
      <div className="composer-shell">
        {dropdownOpen && (
          <div className="cmd-dropdown" role="listbox" id="cmd-listbox" aria-label="슬래시 커맨드">
            {filtered.map((c, i) => (
              <div
                key={c.name}
                id={`cmd-opt-${i}`}
                role="option"
                aria-selected={i === selIdx}
                className={`cmd-item${i === selIdx ? ' sel' : ''}`}
                onMouseEnter={() => setSelIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c);
                }}
              >
                <span className="cmd-name">/{c.name}</span>
                {c.description && <span className="cmd-desc">{c.description}</span>}
              </div>
            ))}
          </div>
        )}

        {/* 상단 pill 행 — 레포(cwd) + 권한 모드 */}
        <div className="composer-top">
          <button
            type="button"
            className="pill repo-pill"
            onClick={() => dispatch({ type: 'open-new-session' })}
            title={session?.cwd || '새 세션 / 레포 선택'}
          >
            <span className="pill-ico" aria-hidden="true">☁</span>
            <span className="truncate">{repoLabel}</span>
          </button>

          {session && (
            <span className="pill-select-wrap">
              <select
                aria-label="권한 모드"
                className={`pill-select ${MODE_CLASS[session.permissionMode] ?? ''}`.trim()}
                value={session.permissionMode || 'default'}
                disabled={!live || state.conn !== 'open'}
                title="권한 모드 (setPermissionMode)"
                onChange={(e) => changeMode(e.target.value)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>

        {/* 입력 */}
        <div className="composer-input">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={!session || exited}
            aria-label="메시지 입력"
            role="combobox"
            aria-multiline="true"
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-controls={dropdownOpen ? 'cmd-listbox' : undefined}
            aria-activedescendant={dropdownOpen ? `cmd-opt-${selIdx}` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        {/* 하단 컨트롤 — 모델 + 전송/중단 */}
        <div className="composer-foot">
          <div className="foot-left">
            {session && (
              <>
                <ModelPicker
                  session={session}
                  options={modelOptions}
                  disabled={!live || state.conn !== 'open'}
                  onSelect={changeModel}
                />
                <EffortPicker
                  session={session}
                  options={modelOptions}
                  // 진행 중 턴이 있으면 잠근다 — effort 변경은 재시작이라 진행분을 파괴한다.
                  // (첫 턴 전에는 --resume 없이 새로 시작하므로 sessionId 잠금은 불필요 —
                  // changeEffort의 resume 게이트 주석 참조)
                  disabled={!live || state.conn !== 'open' || session.status !== 'idle'}
                  onSelect={changeEffort}
                />
              </>
            )}
          </div>

          <span className="spacer" />

          {busy ? (
            <button
              type="button"
              className="send-btn interrupt"
              onClick={doInterrupt}
              title="현재 턴 중단 (Esc)"
              aria-label="중단"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              disabled={!canSend}
              onClick={doSend}
              title="전송 (Enter)"
              aria-label="전송"
            >
              ↑
            </button>
          )}
        </div>
      </div>

      {/* 상태줄 — 컨텍스트·5h/7d 사용량·연결·테마 */}
      <div className="composer-meta">
        {ctxTokens > 0 && (
          <RingStat
            label="CTX"
            pct={ctxPct}
            title={`현재 세션 컨텍스트(마지막 턴 기준): ${ctxTokens.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} tok (${Math.round(ctxPct)}%)`}
          />
        )}
        {quota?.fiveHour ? (
          <RingStat
            label="5h"
            pct={quota.fiveHour.utilization}
            title={quotaTitle('5시간 창', quota.fiveHour, gu?.fiveHour)}
          />
        ) : (
          gu?.fiveHour && (
            <span
              className="meta-item"
              title={`${usageWindowTitle('최근 5시간', gu.fiveHour)} — 공식 % 조회 실패(CLI 미로그인 또는 네트워크)`}
            >
              5h {fmtTok(gu.fiveHour.totalTokens)}
            </span>
          )
        )}
        {quota?.sevenDay ? (
          <RingStat
            label="7d"
            pct={quota.sevenDay.utilization}
            title={quotaTitle('7일 창', quota.sevenDay, gu?.sevenDay)}
          />
        ) : (
          gu?.sevenDay && (
            <span
              className="meta-item"
              title={`${usageWindowTitle('최근 7일', gu.sevenDay)} — 공식 % 조회 실패(CLI 미로그인 또는 네트워크)`}
            >
              7d {fmtTok(gu.sevenDay.totalTokens)}
            </span>
          )
        )}
        {busy && <span className="meta-item accent">응답 생성 중 — Esc로 중단</span>}
        {session && state.conn !== 'open' && (
          <span className="meta-item danger">연결 끊김 — 재접속 중…</span>
        )}
        <span className="spacer" />
        <span className="meta-item" title={`WebSocket: ${state.conn}`}>
          <span className={`conn-dot ${state.conn}`} /> {CONN_LABEL[state.conn] ?? state.conn}
        </span>
        <button
          type="button"
          className="meta-theme"
          onClick={onToggleTheme}
          title="테마 전환"
          aria-label="테마 전환"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>

      {/* CLAW'D — 세션 상태에 따라 움직이는 마스코트 (클릭=찌르기) */}
      <Clawd
        className="composer-mascot"
        scale={5}
        status={session?.status ?? 'none'}
        conn={state.conn}
      />
    </div>
  );
}
