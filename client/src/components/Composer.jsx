// 컴포저(레퍼런스 충실) — 상단 pill 행(레포·권한모드), 입력, 하단 컨트롤(모델 피커 +
// 노력 수준 진행 바 + 전송), 그 아래 상태줄(컨텍스트·5h/7d 사용량·연결).
// 상단 바를 대체한다. 설정 변경(모델·권한 모드·노력)은 채팅 기록 대신 토스트로 알린다.
// 턴별 토큰(입/출력)은 상태줄이 아니라 채팅에 usage 아이템으로 표시(reduce-cli-event).
// Enter 전송/Shift+Enter 개행, `/` 커맨드 드롭다운, Esc/버튼 interrupt,
// 클립보드 사진·파일 붙여넣기 → 파일 경로 삽입.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { searchFiles, clipboardFiles, uploadPasteFile } from '../lib/api.js';
import { insertPaths, dataUrlToBase64 } from '../lib/paste-paths.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { openSubagents } from '../lib/subagents.js';
import { fmtTok, fmtReset, shortPath, contextWindowFor, hasDisplayableCtx } from '../lib/format.js';
import { MODES, MODE_LABEL, MODE_CLASS } from '../lib/permission-modes.js';
import { familyOf, buildModelOptions } from '../lib/model-catalog.js';
import { EFFORT_LEVELS, DEFAULT_EFFORT, effortLabel, isUiEffort } from '../lib/effort.js';
import ActiveModes from './ActiveModes.jsx';
import RunningWork from './RunningWork.jsx';
import RemotePill from './RemotePill.jsx';
import Clawd from './Clawd.jsx';
import './interact.css';

const MAX_HEIGHT_PX = 200;

const CONN_LABEL = { connecting: '연결 중', open: '연결됨', closed: '연결 끊김' };

function usageWindowTitle(label, b) {
  return (
    `${label} — 입력 ${b.inputTokens.toLocaleString()}` +
    ` · 출력 ${b.outputTokens.toLocaleString()}` +
    ` · 캐시읽기 ${b.cacheReadTokens.toLocaleString()}` +
    ` · 캐시생성 ${b.cacheCreationTokens.toLocaleString()} tok` +
    ' (로컬 트랜스크립트 집계)'
  );
}
// 리셋 시각 표기는 format.js의 fmtReset 공유(사이드바 통계 섹션과 동일 표기).
function quotaTitle(label, q, local) {
  const reset = fmtReset(q.resetsAt);
  return (
    `${label} 사용률 ${Math.round(q.utilization)}% — 계정 공식 수치(/usage와 동일)` +
    (reset ? ` · ${reset} 리셋` : '') +
    (local ? ` · 로컬 집계 참고 ${fmtTok(local.totalTokens)} tok` : '')
  );
}

// 텍스트(label)를 둘러싼 원형 게이지 — 사용률 pct(0~100)만큼 링이 채워진다.
function RingStat({ label, pct, tip }) {
  const R = 9;
  const C = 2 * Math.PI * R;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const cls = clamped >= 95 ? ' danger' : clamped >= 80 ? ' warn' : '';
  return (
    <span
      className={`meta-item ring-stat${cls}`}
      data-tip={tip}
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

// 모델 카탈로그(MODEL_FAMILIES·parseVersion·familyOf·buildModelOptions)는
// ../lib/model-catalog.js로 분리 — node --test에서 직접 import해 회귀 테스트한다.

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
        data-tip="모델 선택"
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
// EFFORT_LEVELS/DEFAULT_EFFORT/effortLabel은 lib/effort.js가 단일 출처(spawn 매핑과 공유).

function EffortPicker({ session, options, disabled, onSelect }) {
  const { open, setOpen, wrapRef } = usePopover();
  const fam = familyOf(session.model);
  const opt = fam ? options.find((o) => o.family === fam.family) : null;
  // CLI 항목이 supportsEffort를 명시하지 않은 모델(예: Haiku)은 비활성; 정보가 없으면 허용
  const supports = opt?.cliEntry ? !!opt.cliEntry.supportsEffort : true;
  // 모델이 지원 목록을 보고하면 그걸로 거르되, UI 전용 의사 티어(ultracode)는 CLI
  // 목록에 없어도 항상 남긴다 — spawn 시 max로 매핑되므로 실제 지원과 무관하다.
  const levels = opt?.cliEntry?.supportedEffortLevels?.length
    ? EFFORT_LEVELS.filter(
        (l) => isUiEffort(l.value) || opt.cliEntry.supportedEffortLevels.includes(l.value),
      )
    : EFFORT_LEVELS;
  const cur = session.effort ?? DEFAULT_EFFORT;
  const curIdx = Math.max(0, levels.findIndex((l) => l.value === cur));
  const curLabel = levels[curIdx]?.label ?? cur;
  const ultraActive = isUiEffort(cur);

  return (
    <span className="model-menu-wrap" ref={wrapRef}>
      {/* 미지원 사유 툴팁이 보여야 하므로 disabled 대신 aria-disabled + 클릭 가드 */}
      <button
        type="button"
        className={`pill model-menu-btn${ultraActive ? ' effort-ultra' : ''}`}
        aria-disabled={disabled || !supports}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={supports ? '노력 수준 (변경 시 같은 대화로 재시작)' : '이 모델은 노력 수준을 지원하지 않습니다'}
        onClick={() => {
          if (disabled || !supports) return;
          setOpen((o) => !o);
        }}
      >
        <span className="effort-bar mini" aria-hidden="true">
          {levels.map((l, i) => (
            <span
              key={l.value}
              className={`effort-seg-vis${i <= curIdx ? ' fill' : ''}${l.ultra ? ' ultra' : ''}`}
            />
          ))}
        </span>
        <span className="truncate">{ultraActive ? `⚡ ${curLabel}` : `노력 ${curLabel}`}</span>
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
                aria-label={l.ultra ? `${l.label} (최대 노력 + 플래그십 모드)` : l.label}
                className={`effort-seg${i <= curIdx ? ' fill' : ''}${l.ultra ? ' ultra' : ''}`}
                data-tip={l.ultra ? '울트라코드 — 최대 노력으로 재시작(플래그십 모드)' : l.label}
                onClick={() => {
                  if (l.value !== cur) onSelect(l.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="effort-labels">
            <span className="dim">{levels[0]?.label}</span>
            <span className={`effort-cur${ultraActive ? ' ultra' : ''}`}>
              {ultraActive ? `⚡ ${curLabel}` : curLabel}
            </span>
            <span className="dim">{levels[levels.length - 1]?.label}</span>
          </div>
          <div className="mm-desc dim effort-note">
            {ultraActive
              ? '울트라코드는 최대 노력으로 세션을 재시작합니다(브라우저 CLI엔 별도 워크플로 채널이 없어 실효는 max 노력).'
              : '변경하면 같은 대화로 세션을 재시작합니다 (--effort는 시작 시에만 적용).'}
          </div>
        </div>
      )}
    </span>
  );
}

// ----- 클립보드 붙여넣기 헬퍼 (컴포넌트 상태에 의존하지 않는 부분) -----

// paste 이벤트에 실린 "실제 파일"만 모은다. 같은 파일이 items와 files 양쪽으로 들어오는
// 브라우저가 있는데, getAsFile()은 호출마다 새 인스턴스를 만들어 객체 동일성으로는 못
// 거른다 — 이름·크기·타입으로 접는다. lastModified는 비트맵 붙여넣기에서 "File을 만든
// 시각"으로 채워져 호출 사이에 달라질 수 있으므로 키에서 뺀다(넣으면 스크린샷 하나가
// 두 번 삽입된다).
function clipboardFileList(dt) {
  const seen = new Set();
  const files = [];
  const add = (f) => {
    if (!f) return;
    const id = `${f.name}\u0000${f.size}\u0000${f.type}`;
    if (seen.has(id)) return;
    seen.add(id);
    files.push(f);
  };
  // DataTransferItemList·FileList는 배열이 아니라 유사 배열이다.
  for (const item of Array.from(dt?.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  for (const file of Array.from(dt?.files ?? [])) add(file);
  return files;
}

// 업로드 폴백의 클라이언트 측 상한 — 서버 attachments.js의 MAX_PASTE_BYTES와 같은 값이다.
// 서버가 어차피 거부할 파일을 읽고 나서 알면 늦다: 500MB짜리 동영상 하나면 브라우저가
// 메인 스레드에서 약 667MB짜리 base64 문자열을 만들다 탭이 멈추거나 OOM으로 죽고,
// 살아남아도 본문 상한을 넘긴 요청은 서버가 413을 쓴 직후 소켓을 끊어 사용자에게는
// 이유를 알 수 없는 'Failed to fetch'만 남는다. 그래서 읽기 **전에** 크기로 거른다.
const MAX_PASTE_FILE_BYTES = 20 * 1024 * 1024;

// FileReader는 콜백 API라 순차 업로드 루프에 태우려면 Promise로 감싸야 한다.
// ArrayBuffer가 아니라 dataURL로 읽는 이유: 서버 계약이 base64 문자열이라, 바이트 →
// base64 변환을 손으로 하지 않고 브라우저 내장 인코더에 맡긴다(헤더는 dataUrlToBase64가 뗀다).
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(dataUrlToBase64(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다'));
    reader.readAsDataURL(file);
  });
}

export default function Composer() {
  const { state, dispatch, send, startSession, stopSession, notify, jumpTo } = useStore();
  const session = useActiveSession();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  // @ 파일 태그 자동완성 상태
  const [atFiles, setAtFiles] = useState([]);
  const [atSel, setAtSel] = useState(0);
  const [atLoading, setAtLoading] = useState(false);
  const [atDismissed, setAtDismissed] = useState(false);
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
  // CLI가 result.modelUsage로 직접 보고한 창 크기가 1차 출처 — 없으면(첫 결과 전·
  // 재개 직후) 카탈로그 휴리스틱으로 판별([1m]→1M, 별칭은 카탈로그 해석)
  const ctxWindow = session?.contextWindow ?? contextWindowFor(session?.model, models);
  const ctxPct = (ctxTokens / ctxWindow) * 100;
  const showCtx = hasDisplayableCtx(session?.usage);
  // 실행 중인 서브에이전트(Task/Agent 도구) 목록 — 패널 표시 + 마스코트 juggle 판정(개수)
  const subagentList = useMemo(() => openSubagents(session?.messages), [session?.messages]);

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

  // ----- `@` 파일 태그 자동완성 -----
  // 캐럿 바로 앞의 @토큰(공백/@ 없는 연속 문자)을 잡아 cwd 하위 파일을 검색한다.
  // 슬래시 커맨드와 달리 텍스트 중간에서도 동작하므로 캐럿 위치 기준으로 판정한다.
  const atToken = useMemo(() => {
    if (!session) return null;
    const before = text.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { query: m[2], start: m.index + m[1].length, end: caret };
  }, [text, caret, session]);
  const atOpen = !!atToken && !atDismissed && (atLoading || atFiles.length > 0);

  // @토큰이 활성일 때 cwd 하위 파일을 디바운스 검색한다(키 입력마다 서버 walk).
  const atQuery = atToken?.query;
  const atCwd = session?.cwd;
  useEffect(() => {
    if (atQuery == null || !atCwd) {
      setAtFiles([]);
      setAtLoading(false);
      return undefined;
    }
    let cancelled = false;
    // 질의가 바뀌면 이전 결과를 즉시 비운다 — 디바운스/네트워크 대기 동안 stale 항목이
    // 드롭다운에 남아 Enter/Tab/클릭으로 잘못 선택되는 것을 막는다(대신 "검색 중…" 표시).
    setAtFiles([]);
    setAtSel(0);
    setAtLoading(true);
    const t = setTimeout(async () => {
      try {
        const { files } = await searchFiles(atCwd, atQuery);
        if (!cancelled) {
          setAtFiles(Array.isArray(files) ? files : []);
          setAtSel(0);
        }
      } catch {
        if (!cancelled) setAtFiles([]);
      } finally {
        if (!cancelled) setAtLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [atQuery, atCwd]);

  // 새 입력이 들어오면 @드롭다운 dismiss를 해제(슬래시 드롭다운과 동일 관례).
  useEffect(() => {
    setAtDismissed(false);
  }, [atQuery]);

  // textarea 캐럿 위치 동기화 — @토큰 판정의 기준. 값 변경(onChange)뿐 아니라
  // 클릭·화살표 이동으로 캐럿만 움직일 때도 갱신해야 한다.
  const syncCaret = () => setCaret(taRef.current?.selectionStart ?? 0);

  // 선택한 파일을 @토큰 자리에 삽입한다(뒤에 공백을 붙여 토큰을 종료).
  const pickFile = (rel) => {
    if (!atToken || !rel) return;
    const insert = `@${rel} `;
    const next = text.slice(0, atToken.start) + insert + text.slice(atToken.end);
    const pos = atToken.start + insert.length;
    setText(next);
    setAtFiles([]);
    // 상태 반영 후 캐럿을 삽입 끝으로 옮긴다(제어 textarea라 rAF로 다음 프레임에).
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // ----- 클립보드 사진·파일 붙여넣기 → 경로 삽입 -----
  // 붙여넣기 처리는 서버 왕복(원본 경로 조회·임시 저장)이라 비동기인데, 끝났을 때는
  // 핸들러의 렌더 클로저가 이미 낡아 있다 — 그새 다른 세션으로 옮겨 갔을 수도 있으므로
  // "지금 열려 있는 세션"을 ref로 본다(남의 대화 입력창에 경로를 흘리지 않게).
  const sessionKeyRef = useRef(null);
  useEffect(() => {
    sessionKeyRef.current = session?.key ?? null;
  }, [session?.key]);
  // 붙여넣기 작업을 도착 순서대로 이어 붙이는 체인. 병렬로 두면 늦게 끝난 업로드가 먼저
  // 삽입되거나, 두 작업이 같은 캐럿을 기준으로 삼아 서로를 덮어쓴다.
  const pasteChainRef = useRef(Promise.resolve());

  // 삽입할 경로 확보: ① OS 클립보드의 원본 경로(탐색기에서 복사한 파일)를 먼저 보고,
  // ② 없으면 붙여넣은 바이트를 서버 임시 파일로 만들어 그 경로를 쓴다.
  const resolvePastePaths = async (files) => {
    try {
      const { paths } = await clipboardFiles();
      const found = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
      // 원본 경로를 그대로 넘겨야 Claude가 사본이 아니라 그 파일을 읽고 고칠 수 있다.
      if (found.length > 0) return found;
    } catch {
      // 조회 실패는 알리지 않는다 — 아래 업로드가 같은 결과(경로)를 만들어 낸다.
    }
    // 여기까지 왔으면 디스크에 원본이 없는 붙여넣기(스크린샷 비트맵)이거나 비Windows다.
    // 업로드는 왕복이 눈에 띄게 걸리므로 이 경로에서만, 파일 수와 무관하게 한 번 알린다.
    notify('클립보드 파일 처리 중…');
    const saved = [];
    for (const file of files) {
      if (file.size > MAX_PASTE_FILE_BYTES) {
        const mb = Math.round(MAX_PASTE_FILE_BYTES / (1024 * 1024));
        notify(`붙여넣기 실패: ${file.name || '파일'} — ${mb}MB를 넘는 파일은 붙여넣을 수 없습니다`, 'error');
        continue;
      }
      try {
        const data = await readAsBase64(file);
        const { path } = await uploadPasteFile(file.name, data);
        if (path) saved.push(path);
      } catch (err) {
        // 한 파일이 읽기·저장에 실패해도 나머지는 살린다 — 어느 파일이 빠졌는지 알린다.
        notify(`붙여넣기 실패: ${file.name || '파일'} — ${String(err.message ?? err)}`, 'error');
      }
    }
    return saved;
  };

  const insertPastedPaths = (key, paths, baseText, baseStart, baseEnd) => {
    if (sessionKeyRef.current !== key) return; // 세션이 바뀌었으면 결과를 버린다
    const el = taRef.current;
    const cur = el ? el.value : baseText;
    // 기다리는 동안 사용자가 타이핑했으면 캡처한 선택 범위는 이미 엉뚱한 자리를 가리킨다 —
    // 남이 쓴 단어 사이를 쪼개는 대신 끝에 붙인다.
    const fresh = cur === baseText;
    // 선택 영역이 있었으면 그 자리를 경로로 **대체**한다(@태그를 넣는 pickFile과 같은
    // 규약). preventDefault로 브라우저의 선택 삭제까지 막아 놨으므로, 여기서 직접
    // 걷어내지 않으면 사용자가 지우려던 글자가 경로 뒤에 그대로 남는다.
    const body = fresh ? cur.slice(0, baseStart) + cur.slice(baseEnd) : cur;
    const at = fresh ? baseStart : body.length;
    const next = insertPaths(body, at, paths);
    setText(next.text);
    // 캐럿 복원은 pickFile과 같은 rAF 패턴(제어 textarea라 값 반영 뒤라야 한다).
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const onPaste = (e) => {
    // textarea가 이미 disabled지만, 확장이 쏘는 합성 paste까지 막아 주지는 않는다.
    if (!session || exited) return;
    const dt = e.clipboardData;
    // 텍스트가 함께 실려 있으면 그건 "파일 붙여넣기"가 아니다. Office 계열은 셀 범위·표·
    // 도형을 복사할 때 텍스트와 비트맵(CF_DIB)을 같이 올리는데, 크롬은 그 비트맵을
    // image.png File로 합성해 넘긴다 — 파일 유무만 보고 가로채면 사용자가 원한 탭 구분
    // 텍스트가 통째로 사라지고 임시 png 경로만 남는다. 탐색기의 파일 복사(types가
    // ["Files"]뿐)와 웹 이미지 복사에는 text/plain이 없어 이 가드에 걸리지 않는다.
    if (Array.from(dt?.types ?? []).includes('text/plain')) return;
    const files = clipboardFileList(dt);
    // 파일이 없으면 평범한 텍스트 붙여넣기 — 손대지 않고 네이티브 동작에 맡긴다
    // (undo 스택·IME 조합·서식 정리가 전부 브라우저 몫이라 가로채면 잃을 것만 많다).
    if (files.length === 0) return;
    e.preventDefault(); // 파일이 확인된 뒤에만, 그리고 await 이전(동기 구간)에 막는다

    // clipboardData는 핸들러가 끝나면 비워지므로 필요한 것을 지금 전부 캡처한다.
    const key = session.key;
    const el = taRef.current;
    const baseText = el ? el.value : text;
    const baseStart = el?.selectionStart ?? baseText.length;
    // 끝(selectionEnd)까지 잡아 둬야 선택 영역을 대체할 수 있다 — 캐럿만 있는 평소에는
    // start와 같은 값이라 동작이 달라지지 않는다.
    const baseEnd = el?.selectionEnd ?? baseStart;

    pasteChainRef.current = pasteChainRef.current
      .then(async () => {
        const paths = await resolvePastePaths(files);
        if (paths.length > 0) insertPastedPaths(key, paths, baseText, baseStart, baseEnd);
      })
      // 한 건이 reject하면 체인이 끊겨 이후 붙여넣기가 통째로 조용히 사라진다 — 봉합한다.
      .catch((err) => notify(`붙여넣기 실패: ${String(err.message ?? err)}`, 'error'));
  };

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

  // 프롬프트 전송 코어 — doSend(입력창)와 인터럽트 복구 재시도가 공유한다.
  // 전송 가능 불변식(세션 idle·연결됨·비어있지 않음)을 스스로 강제한다.
  const submit = (t) => {
    if (!session || session.status !== 'idle' || state.conn !== 'open') return false;
    if (typeof t !== 'string' || t.trim() === '') return false;
    const ok = send({ type: 'send', key: session.key, text: t });
    if (!ok) return false;
    // 알려진 슬래시 커맨드는 커맨드 칩/초기화 구분선/압축 카드로 낙관 렌더 —
    // reduceUser의 <command-name> 경로를 태워 CLI 에코와 자연히 중복 제거된다.
    const cmd = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(t.trim());
    const known = cmd && commands.some((c) => c.name === cmd[1]);
    const userEvent = known
      ? {
          type: 'user',
          optimistic: true, // reduceUser가 CLI 에코와 짝지어 중복 흡수하도록 표시
          message: {
            role: 'user',
            content: `<command-name>/${cmd[1]}</command-name>\n<command-message>${cmd[1]}</command-message>\n<command-args>${cmd[2] ?? ''}</command-args>`,
          },
        }
      : {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        };
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({
        ...reduceCliEvent(s, userEvent),
        status: s.status === 'idle' ? 'thinking' : s.status,
        interruptRequested: false, // 새 턴 시작 — 이전 인터럽트 표시 해제
      }),
    });
    return true;
  };

  const doSend = () => {
    if (!canSend) return;
    // 입력창 비우기는 "작성-후-전송" 경로에서만 — submit(t) 코어는 전달된 문자열을
    // 보낼 뿐이라, 재시도(다른 문자열 전송)가 작성 중 draft를 지우지 않게 한다.
    if (submit(text)) setText('');
  };

  // ----- 인터럽트된 턴 복구 (Task: interrupted chat 수정) -----
  // 사용자가 Esc로 직접 중단한 턴은 is_error result로 끝나고 interruptRequested가
  // 남는다. 그 마지막 프롬프트를 그대로 재전송하거나(재시도), 입력창으로 불러와
  // 고쳐서 보낼 수 있게(수정) 복구 바를 노출한다.
  const interrupted =
    !!session &&
    session.status === 'idle' &&
    !!session.interruptRequested &&
    !!session.lastResult?.isError &&
    typeof session.lastUserText === 'string' &&
    session.lastUserText.trim() !== '';

  const retryInterrupted = () => submit(session?.lastUserText ?? '');

  const editInterrupted = () => {
    if (!session?.lastUserText) return;
    setText(session.lastUserText);
    taRef.current?.focus();
    // 편집만 — 전송은 사용자가 doSend로. 인터럽트 표시는 실제 전송 때 해제된다.
  };

  // 복구 바를 명시적으로 닫기 — 인터럽트 표시만 해제(대화 기록은 그대로).
  const dismissInterrupted = () => {
    if (!session) return;
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({ ...s, interruptRequested: false }),
    });
  };

  const doInterrupt = () => {
    if (!busy) return;
    if (!send({ type: 'interrupt', key: session.key })) return;
    // 직접 중단한 턴은 마스코트가 실패(error) 연출을 하지 않도록 표시 —
    // 다음 doSend가 해제한다 (인터럽트도 is_error result로 끝난다).
    dispatch({
      type: 'update-session',
      key: session.key,
      fn: (s) => ({ ...s, interruptRequested: true }),
    });
  };

  // 낙관적 UI 갱신은 실제 전송이 성공했을 때만 — 끊긴 상태에서 바꾸면
  // CLI에 전달되지 않는데 UI만 바뀌어 모델/권한모드가 desync되는 것을 막는다.
  // 변경 확인은 채팅 기록이 아니라 토스트로 알린다(CLI의 로컬 커맨드 에코는
  // reduce-cli-event가 채팅에서 걸러낸다).
  const changeModel = (model) => {
    if (!session || !model) return;
    if (!send({ type: 'setModel', key: session.key, model })) return;
    // contextWindow도 리셋 — 이전 모델의 result가 보고한 창은 새 모델에 무효,
    // 다음 result까지 카탈로그 휴리스틱으로 폴백한다.
    dispatch({ type: 'update-session', key: session.key, fn: (s) => ({ ...s, model, spawnModel: model, contextWindow: null }) });
    const opt = modelOptions.find((o) => o.value === model);
    notify(`모델 변경: ${opt ? `Claude ${opt.name} ${opt.version}` : model}`);
  };
  const changeMode = (mode) => {
    if (!session || !mode) return;
    // 신뢰모드는 스폰 시에만 진입 가능(서버가 권위 경계) — UI에서도 미리 막고 안내.
    // 신뢰모드로 스폰된 세션의 복귀만 허용한다.
    if (mode === 'bypassPermissions' && session.spawnPermissionMode !== 'bypassPermissions') {
      notify('신뢰모드는 세션 시작 시에만 설정할 수 있습니다', 'error');
      return;
    }
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
      // 스폰 --model은 검증된 계보(spawnModel: 시작 인자·set_model 성공값)만 —
      // session.model엔 init/assistant가 보고한 해석 id(구식·[1m] 접미사 탈락 가능)도
      // 들어오는데, 그걸 스폰 인자로 넘기면 1M 세션의 무언 다운그레이드나 스폰 실패가
      // 된다(Sidebar 재개와 동일 불변식). null이면 --model 생략(CLI가 결정 — 재개는
      // 트랜스크립트의 모델로 이어진다). 표시는 preloadModel로 잇는다.
      model: session.spawnModel,
      preloadModel: session.model,
      permissionMode: session.permissionMode,
      effort,
      resumeSessionId: canResume ? resumeId : null,
      preloadMessages: session.messages,
      // 같은 대화로 이어가는 경우(resume)에만 usage·컨텍스트 계보를 이월한다 —
      // 새 대화로 시작하면 서버측 컨텍스트가 비어 있으므로 옛 CTX%는 오표시.
      preloadSessionId: canResume ? resumeId : null,
      preloadUsage: canResume ? session.usage : null,
      preloadCtxFromCalls: canResume ? session.ctxFromCalls : false,
      // 사용자가 붙여 둔 세션 이름은 재시작 이유(노력 수준 변경)와 무관하게 이어진다 —
      // 같은 탭을 대체하는 재시작이라 이름이 사라지면 사용자에겐 세션이 바뀐 것처럼 보인다.
      preloadCustomTitle: session.customTitle,
      // 열려 있던 미리보기도 이월한다 — 메시지가 그대로 넘어오므로 산출물 목록은
      // 저절로 복원되는데, 선택만 잃으면 패널이 혼자 닫혀 재시작이 티가 난다.
      preloadPreview: session.preview,
      replaceKey: session.key,
    });
    const label = effortLabel(effort);
    // 문구는 실제 동작과 일치시킨다 — resume이 아닐 때 "같은 대화"라고 말하지 않는다.
    notify(
      canResume
        ? `노력 수준 변경: ${label} — 같은 대화로 세션을 재시작합니다`
        : `노력 수준 변경: ${label} — 완결된 턴이 없어 새 세션으로 시작합니다`,
    );
  };

  const onKeyDown = (e) => {
    if (atOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtSel((i) => Math.min(i + 1, atFiles.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtSel((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        // 드롭다운이 열린 동안엔 Enter를 삼킨다 — 검색 중(결과 아직 없음)일 때
        // 실수로 메시지가 전송되지 않도록. 결과가 있으면 선택.
        e.preventDefault();
        if (atFiles.length > 0) pickFile(atFiles[Math.min(atSel, atFiles.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtDismissed(true);
        return;
      }
    }
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

        {/* @ 파일 태그 자동완성 — cwd 하위 파일 검색 결과 */}
        {atOpen && (
          <div className="cmd-dropdown at-dropdown" role="listbox" id="at-listbox" aria-label="파일 참조">
            {atFiles.length === 0 ? (
              <div className="cmd-item dim">검색 중…</div>
            ) : (
              atFiles.map((f, i) => {
                const slash = f.lastIndexOf('/');
                const name = slash >= 0 ? f.slice(slash + 1) : f;
                const dir = slash >= 0 ? f.slice(0, slash + 1) : '';
                return (
                  <div
                    key={f}
                    role="option"
                    aria-selected={i === atSel}
                    className={`cmd-item${i === atSel ? ' sel' : ''}`}
                    onMouseEnter={() => setAtSel(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickFile(f);
                    }}
                  >
                    <span className="cmd-name">@{name}</span>
                    {dir && <span className="cmd-desc">{dir}</span>}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 활성 목표 배지 — 'GOAL' 한 단어, 목표 전문은 툴팁 (목표가 있을 때만) */}
        {session && <ActiveModes session={session} />}

        {/* 인터럽트된 턴 복구 바 — 재시도 / 수정 후 재전송 */}
        {interrupted && (
          <div className="interrupt-recover" role="status">
            <span className="ir-ico" aria-hidden="true">↺</span>
            <span className="ir-text">직전 턴이 중단되었습니다.</span>
            <span className="ir-preview dim" data-tip={session.lastUserText}>
              “{session.lastUserText.length > 40
                ? `${session.lastUserText.slice(0, 40)}…`
                : session.lastUserText}”
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="ir-btn primary"
              onClick={retryInterrupted}
              disabled={!live || state.conn !== 'open' || session.status !== 'idle'}
              data-tip="같은 프롬프트를 그대로 다시 보냅니다"
            >
              ↻ 재시도
            </button>
            <button
              type="button"
              className="ir-btn"
              onClick={editInterrupted}
              data-tip="프롬프트를 입력창으로 불러와 고쳐서 보냅니다"
            >
              ✎ 수정
            </button>
            <button
              type="button"
              className="ir-btn ghost"
              onClick={dismissInterrupted}
              data-tip="복구 바 닫기"
              aria-label="복구 바 닫기"
            >
              ✕
            </button>
          </div>
        )}

        {/* 상단 pill 행 — 레포(cwd) + 권한 모드 */}
        <div className="composer-top">
          <button
            type="button"
            className="pill repo-pill"
            onClick={() => dispatch({ type: 'open-new-session' })}
            data-tip={session?.cwd || '새 세션 / 레포 선택'}
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
                data-tip="권한 모드 (setPermissionMode)"
                onChange={(e) => changeMode(e.target.value)}
              >
                {MODES.filter(
                  (m) =>
                    m !== 'bypassPermissions' ||
                    session.spawnPermissionMode === 'bypassPermissions' ||
                    // 표시 정합성 폴백 — CLI가 현재 모드를 신뢰로 보고 중이면
                    // 옵션을 남겨 select가 빈 값으로 렌더되지 않게 한다(진입은 changeMode가 차단).
                    session.permissionMode === 'bypassPermissions',
                ).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </span>
          )}

          {/* 원격 제어 — claude.ai·모바일 앱에서 이 레포를 조종 (켜짐일 때만 눈에 띈다) */}
          <RemotePill session={session} />
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
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
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
              data-tip="현재 턴 중단 (Esc)"
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
              data-tip="전송 (Enter)"
              aria-label="전송"
            >
              ↑
            </button>
          )}
        </div>

        {/* 실행 중 작업 도크 — 입력창 **아래**. 지금 돌고 있는 셸·서브에이전트를
            모아 보여 주고, 누르면 대화 속 해당 카드로 이동한다. */}
        {session && (
          <RunningWork
            session={session}
            conn={state.conn}
            onJump={(uid) => jumpTo(session.key, uid)}
          />
        )}
      </div>

      {/* 상태줄 — 컨텍스트·5h/7d 사용량·연결 */}
      <div className="composer-meta">
        {/* 표시 여부는 값이 아니라 플래그로 — /clear 직후의 0은 "보여줄 값이 없음"이
            아니라 "비웠음"이라 링이 사라지면 안 된다(format.js hasDisplayableCtx 주석 참조) */}
        {showCtx && (
          <RingStat
            label="CTX"
            pct={ctxPct}
            tip={`현재 세션 컨텍스트(마지막 API 호출·압축/초기화 기준, 턴 중 실시간 갱신): ${ctxTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tok (${Math.round(ctxPct)}%)`}
          />
        )}
        {quota?.fiveHour ? (
          <RingStat
            label="5h"
            pct={quota.fiveHour.utilization}
            tip={quotaTitle('5시간 창', quota.fiveHour, gu?.fiveHour)}
          />
        ) : (
          gu?.fiveHour && (
            <span
              className="meta-item"
              data-tip={`${usageWindowTitle('최근 5시간', gu.fiveHour)} — 공식 % 조회 실패(CLI 미로그인 또는 네트워크)`}
            >
              5h {fmtTok(gu.fiveHour.totalTokens)}
            </span>
          )
        )}
        {quota?.sevenDay ? (
          <RingStat
            label="7d"
            pct={quota.sevenDay.utilization}
            tip={quotaTitle('7일 창', quota.sevenDay, gu?.sevenDay)}
          />
        ) : (
          gu?.sevenDay && (
            <span
              className="meta-item"
              data-tip={`${usageWindowTitle('최근 7일', gu.sevenDay)} — 공식 % 조회 실패(CLI 미로그인 또는 네트워크)`}
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
        <span className="meta-item" data-tip={`WebSocket: ${state.conn}`}>
          <span className={`conn-dot ${state.conn}`} /> {CONN_LABEL[state.conn] ?? state.conn}
        </span>
      </div>

      {/* CLAW'D — 세션 상태에 따라 움직이는 마스코트 (클릭=찌르기, 4연타=어지럼) */}
      <Clawd
        className="composer-mascot"
        scale={5}
        status={session?.status ?? 'none'}
        conn={state.conn}
        sessionKey={state.activeKey ?? null}
        lastResult={session?.lastResult ?? null}
        interrupted={session?.interruptRequested ?? false}
        subagents={subagentList.length}
      />
    </div>
  );
}
