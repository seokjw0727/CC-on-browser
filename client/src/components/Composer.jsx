// 컴포저(레퍼런스 충실) — 입력, 하단 컨트롤(모델 피커 + 노력 수준 진행 바 + 전송),
// 그 아래 상태줄(컨텍스트·5h/7d 사용량·연결). 레포 pill은 없어졌고(새 세션은 사이드바),
// 권한 모드 셀렉트는 입력 상자 안쪽 우측 상단에 겹쳐 둔다(PermissionModeBar.jsx —
// 메인 우측 상단에 떠 있던 것을 사용자 요청으로 입력창 안으로 들였다).
// 설정 변경(모델·노력)은 채팅 기록 대신 토스트로 알린다.
// 턴별 토큰(입/출력)은 상태줄이 아니라 채팅에 usage 아이템으로 표시(reduce-cli-event).
// Enter 전송/Shift+Enter 개행, `/` 커맨드 드롭다운, Esc/버튼 interrupt,
// 클립보드 사진·파일 붙여넣기 → 파일 경로 삽입.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveSession } from '../lib/store.jsx';
import { searchFiles, clipboardFiles, uploadPasteFile } from '../lib/api.js';
import { insertPaths, dataUrlToBase64 } from '../lib/paste-paths.js';
import { reduceCliEvent } from '../lib/reduce-cli-event.js';
import { openSubagents } from '../lib/subagents.js';
import { clawdSignals, runningSessionCount } from '../lib/clawd.js';
import { fmtTok, fmtReset, contextWindowFor, hasDisplayableCtx } from '../lib/format.js';
import { familyOf, buildModelOptions } from '../lib/model-catalog.js';
import {
  DEFAULT_EFFORT,
  EFFORT_HELP,
  effortLabel,
  visibleEffortLevels,
  effortIndexFromRatio,
  effortRatioFromIndex,
  nextEffortIndex,
} from '../lib/effort.js';
import ActiveModes from './ActiveModes.jsx';
import Icon from './Icon.jsx';
import PermissionModeBar from './PermissionModeBar.jsx';
import RunningWork from './RunningWork.jsx';
import WorktreeButton from './WorktreeButton.jsx';
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
    // 선택된 항목(메뉴형) 또는 슬라이더(노력 수준형)로 포커스를 옮긴다.
    const opener = document.activeElement;
    wrapRef.current?.querySelector('[aria-checked="true"], [role="slider"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      // 팝오버 안에 포커스를 둔 채로 닫혔다면(Esc·선택) 열기 전 위치로 되돌린다 —
      // 키보드 사용자가 포커스를 잃고 문서 처음으로 튕기지 않도록.
      if (
        opener instanceof HTMLElement
        && opener.isConnected
        && wrapRef.current?.contains(document.activeElement)
      ) {
        opener.focus();
      }
    };
  }, [open]);
  return { open, setOpen, wrapRef };
}

// 메뉴 내 화살표 키 이동 (ARIA menu 관례)
function menuArrowNav(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll('.mm-item')];
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
        <Icon name="chevron-down" size={10} className="mm-caret" />
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
                {sel && <Icon name="check" className="mm-check" />}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

// ----- 노력 수준 피커 — 드래그 슬라이더 (변경은 런타임 채널로 즉시 적용) -----
// EFFORT_LEVELS/DEFAULT_EFFORT/effortLabel/desc·좌표 헬퍼는 lib/effort.js가 단일 출처.
// 좌표계: 트랙 안쪽의 .effort-rail이 0~100% 공간이고 도트·핸들·채움이 모두 그 비율을
// 쓴다(포인터 → 인덱스 환산도 rail 사각형 기준 — 양끝 핸들이 트랙을 넘지 않게).

// 키 반복(누른 채 유지)이나 연속 드래그가 매번 CLI 왕복을 만들지 않도록 커밋을 모은다.
// 폴백(구버전 CLI = 세션 재시작) 경로에서는 이 합침이 특히 중요하다.
const EFFORT_COMMIT_DEBOUNCE_MS = 180;

function EffortPicker({ session, options, disabled, onSelect }) {
  const { open, setOpen, wrapRef } = usePopover();
  const fam = familyOf(session.model);
  const opt = fam ? options.find((o) => o.family === fam.family) : null;
  // CLI 항목이 supportsEffort를 명시하지 않은 모델(예: Haiku)은 비활성; 정보가 없으면 허용
  const supports = opt?.cliEntry ? !!opt.cliEntry.supportsEffort : true;
  // 모델이 지원 목록을 보고하면 그걸로 거른다. UI 티어(ultracode)는 목록에 없지만
  // xhigh + 플래그로 나가므로, 그 모델이 xhigh를 지원할 때만 노출한다 — 지원하지 않는
  // 수준을 보내지 않기 위한 조건이다(codex 지적). 목록 자체를 보고하지 않는 모델은
  // 판단 근거가 없으니 전부 노출한다(기존 동작).
  const cur = session.effort ?? DEFAULT_EFFORT;
  // 표시 목록 계산(지원 목록 필터 + 현재 값 보존)은 lib/effort.js가 단일 출처다 —
  // 순수 함수라 node --test로 직접 검증한다(왜 현재 값을 남기는지는 그쪽 주석).
  const levels = visibleEffortLevels(opt?.cliEntry?.supportedEffortLevels, cur);
  const curIdx = levels.findIndex((l) => l.value === cur);
  // 그래도 -1이면 EFFORT_LEVELS 자체에 없는 미지의 값이다(방어) — 위치를 특정할 수 없으니
  // 기본값 자리에 두되, 라벨은 원값을 그대로 보여 준다(없는 값을 '낮음'이라 말하지 않는다).
  const anchorIdx = curIdx >= 0
    ? curIdx
    : Math.max(0, levels.findIndex((l) => l.value === DEFAULT_EFFORT));
  // 조작 중(그리고 커밋 결과가 돌아오기 전까지)의 표시값 — 성공하면 cur가 따라오고,
  // 실패하면 onSelect가 끝나는 시점에 놓아 실제값으로 되돌아간다.
  const [previewIdx, setPreviewIdx] = useState(null);
  const shownIdx = previewIdx == null ? anchorIdx : Math.min(previewIdx, levels.length - 1);
  const shown = levels[shownIdx] ?? levels[anchorIdx];
  const shownLabel = previewIdx == null && curIdx < 0 ? effortLabel(cur) : (shown?.label ?? cur);
  const ultraActive = !!shown?.ultra;
  const railRef = useRef(null);
  const commitTimerRef = useRef(null);
  // 커밋 세대 — 겹친 커밋 중 **마지막** 것만 미리보기를 놓는다. 세지 않으면 먼저 끝난
  // 요청이 뒤이은 선택의 표시를 걷어내 잘못된 값이 잠시 보인다(codex 지적).
  const commitSeqRef = useRef(0);
  const locked = disabled || !supports;

  useEffect(() => () => clearTimeout(commitTimerRef.current), []);

  // 세션 탭이 바뀌면 이전 세션을 향한 대기 커밋과 미리보기를 버린다 — 안 그러면 옛 탭의
  // 선택이 새 탭에 보이거나, 디바운스 타이머가 옛 세션에 적용된다(codex 지적).
  useEffect(() => {
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitSeqRef.current += 1;
    setPreviewIdx(null);
  }, [session.key]);

  const commit = (idx, { immediate = false } = {}) => {
    const value = levels[idx]?.value;
    if (!value) return;
    setPreviewIdx(idx);
    clearTimeout(commitTimerRef.current);
    const seq = ++commitSeqRef.current;
    const run = async () => {
      commitTimerRef.current = null;
      if (value === (session.effort ?? DEFAULT_EFFORT)) {
        if (seq === commitSeqRef.current) setPreviewIdx(null);
        return;
      }
      await onSelect(value);
      // 그 사이 더 최신 커밋이 시작됐다면 그쪽이 표시의 주인이다.
      if (seq === commitSeqRef.current) setPreviewIdx(null);
    };
    if (immediate) run();
    else commitTimerRef.current = setTimeout(run, EFFORT_COMMIT_DEBOUNCE_MS);
  };

  const idxFromPointer = (e) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return effortIndexFromRatio((e.clientX - rect.left) / rect.width, levels.length);
  };

  const onPointerDown = (e) => {
    if (locked || e.button !== 0) return;
    const idx = idxFromPointer(e);
    if (idx == null) return;
    // 포인터를 캡처해 트랙을 벗어난 드래그도 계속 따라온다.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    setPreviewIdx(idx);
  };
  const onPointerMove = (e) => {
    if (locked || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    const idx = idxFromPointer(e);
    if (idx != null) setPreviewIdx(idx);
  };
  const onPointerUp = (e) => {
    if (locked || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const idx = idxFromPointer(e) ?? previewIdx;
    // 놓는 순간 확정 — 드래그 중에는 보내지 않는다(중간값마다 왕복하지 않도록).
    if (idx != null) commit(idx, { immediate: true });
  };
  // 취소된 제스처(터치/펜 이탈, 브라우저 개입)는 확정하지 않고 실제값으로 되돌린다 —
  // 없으면 미리보기가 커밋되지 않은 값으로 남아 붙는다(codex 지적).
  const onPointerCancel = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    commitSeqRef.current += 1;
    setPreviewIdx(null);
  };
  const onKeyDown = (e) => {
    if (locked) return;
    const next = nextEffortIndex(e.key, shownIdx, levels.length);
    if (next == null) return;
    e.preventDefault();
    if (next !== shownIdx) commit(next);
  };

  return (
    <span className="model-menu-wrap" ref={wrapRef}>
      {/* 미지원 사유 툴팁이 보여야 하므로 disabled 대신 aria-disabled + 클릭 가드 */}
      <button
        type="button"
        className={`pill model-menu-btn${ultraActive ? ' effort-ultra' : ''}`}
        aria-disabled={locked}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={supports ? '노력 수준 (변경 즉시 적용)' : '이 모델은 노력 수준을 지원하지 않습니다'}
        onClick={() => {
          if (locked) return;
          setOpen((o) => !o);
        }}
      >
        <span className="effort-bar mini" aria-hidden="true">
          {levels.map((l, i) => (
            <span
              key={l.value}
              className={`effort-seg-vis${i <= shownIdx ? ' fill' : ''}${l.ultra ? ' ultra' : ''}`}
            />
          ))}
        </span>
        <span className="truncate">
          {ultraActive ? <><Icon name="bolt" className="ico-accent" /> {shownLabel}</> : `노력 ${shownLabel}`}
        </span>
        <Icon name="chevron-down" size={10} className="mm-caret" />
      </button>
      {open && (
        <div className="mm-menu effort-menu" role="dialog" aria-label="노력 수준">
          <div className="effort-head">
            <span className={`effort-title${ultraActive ? ' ultra' : ''}`}>
              {ultraActive ? <><Icon name="bolt" className="ico-accent" /> {shownLabel}</> : `노력 ${shownLabel}`}
            </span>
            {/* 도움말 — 전역 [data-tip] 툴팁 레이어가 hover/포커스에 띄운다 */}
            <button
              type="button"
              className="effort-help"
              data-tip={EFFORT_HELP}
              aria-label={`노력 수준 도움말 — ${EFFORT_HELP}`}
            >
              ?
            </button>
          </div>
          <div className="effort-ends" aria-hidden="true">
            <span>더 빠르게</span>
            <span>더 스마트하게</span>
          </div>
          <div
            className={`effort-slider${ultraActive ? ' ultra' : ''}`}
            role="slider"
            tabIndex={locked ? -1 : 0}
            aria-label="노력 수준"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={levels.length - 1}
            aria-valuenow={shownIdx}
            aria-valuetext={shownLabel}
            aria-disabled={locked || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={onKeyDown}
          >
            <span className="effort-rail" ref={railRef}>
              <span
                className="effort-fill"
                style={{ width: `${effortRatioFromIndex(shownIdx, levels.length) * 100}%` }}
              />
              {levels.map((l, i) => (
                <span
                  key={l.value}
                  className={`effort-dot${i <= shownIdx ? ' fill' : ''}${l.ultra ? ' ultra' : ''}`}
                  style={{ left: `${effortRatioFromIndex(i, levels.length) * 100}%` }}
                  data-tip={`${l.label} — ${l.desc}`}
                />
              ))}
              <span
                className="effort-thumb"
                style={{ left: `${effortRatioFromIndex(shownIdx, levels.length) * 100}%` }}
              />
            </span>
          </div>
          <div className="mm-desc dim effort-note">{shown?.desc}</div>
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
  const {
    state, dispatch, send, startSession, stopSession, setEffort, setModel, getState, notify, jumpTo,
  } = useStore();
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
  // 마스코트의 나머지 상태(sweep/carry/notify/happy)를 여는 파생 신호.
  // 압축·worktree·notice를 각각 훑으면 배열을 세 번 더 도는 셈이라 한 번의 순회로 모은다.
  // useMemo는 messages가 스트리밍 델타마다 새 배열이 돼 사실상 매번 다시 도는데(참조가
  // 바뀐다 — codex 지적), 그 배열 자체가 방금 선형 복사된 것이라 같은 차수 안의 상수
  // 비용이다. 여기서 줄이는 건 "세 번"을 "한 번"으로 만드는 부분이고, 그 아래로 더
  // 내리려면 리듀서에 카운터를 심어야 해서 비용이 실측되기 전엔 하지 않는다.
  const signals = useMemo(() => clawdSignals(session?.messages), [session?.messages]);
  // 동시 실행 세션 수(레퍼런스 working 1/2/3+ 티어) — 활성 세션만이 아니라 전체가 근거다.
  const sessionsRunning = useMemo(() => runningSessionCount(state.sessions), [state.sessions]);

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

  // 모델 변경은 **전송 성공이 아니라 CLI의 수용**을 기다린다. 예전에는 소켓 write가
  // 성공하면 곧바로 피커를 바꿨는데, CLI가 그 모델을 거부해도(인식 불가 id·조직 제한·
  // consent 미승인) 화면만 새 모델로 남아 실제 세션과 어긋났다 — 사용자에겐 "바꿨는데
  // 적용이 안 된다"로 보인 증상의 절반이다. 이제 표시 갱신은 modelSet 방송을 받은
  // 리듀서 한 곳에서만 일어나고, 여기서는 결론을 말로 알린다.
  // 변경 확인은 채팅 기록이 아니라 토스트로(CLI의 로컬 커맨드 에코는 reduce-cli-event가
  // 채팅에서 걸러낸다).
  const changeModel = async (model) => {
    if (!session || !model) return;
    const key = session.key;
    const opt = modelOptions.find((o) => o.value === model);
    const label = opt ? `Claude ${opt.name} ${opt.version}` : model;
    // 이 요청을 보내기 직전의 스폰 계보 — 아래 'unknown' 처리가 "그 사이 다른 변경이
    // 성공했는가"를 판정하는 기준이다(겹친 변경에서 늦게 끝난 요청이 최신 계보를
    // 지우지 않도록 — codex 지적).
    const spawnBefore = getState().sessions.get(key)?.spawnModel ?? null;
    const outcome = await setModel(key, model);
    // 왕복을 기다리는 동안 이 세션이 사라졌으면(닫힘·재시작 대체) 조용히 접는다 —
    // 지금 보고 있는 다른 대화에 남의 세션 소식을 띄우지 않기 위해.
    if (!getState().sessions.has(key)) return;
    if (outcome === 'applied') {
      notify(`모델 변경: ${label}`);
    } else if (outcome === 'unsent') {
      notify(`모델을 바꾸지 못했습니다: ${label} — 서버와 연결이 끊겼습니다`, 'error');
    } else if (outcome === 'unknown') {
      // 적용됐는지 모른다 = **스폰 계보를 더는 신뢰할 수 없다**. 구버전 데몬은 ack 없이도
      // set_model을 CLI에 전달하므로 이미 바뀌었을 수 있는데, 그때 옛 spawnModel을 그대로
      // 두면 이후 노력 수준 폴백 재시작이 `--model <옛 모델>`로 되살려 사용자가 버린
      // 모델로 되돌아간다 — 이번 수정이 없애려던 "입력 없이 바뀐다" 증상 그대로다.
      // null은 "계보 모름"이라 재시작이 --model을 생략하고, --resume이면 트랜스크립트의
      // 실제 모델로 이어진다. 표시(model)는 건드리지 않는다 — 그쪽은 CLI 보고가 고친다.
      // 단, 기다리는 동안 **다른 변경이 성공했다면** 그쪽 계보가 최신이자 검증된 값이다 —
      // 그걸 이 늦은 타임아웃이 지우면 안 된다(연타 시 A 대기 중 B 성공 → A 타임아웃).
      dispatch({
        type: 'update-session',
        key,
        fn: (s) => (s.spawnModel === spawnBefore ? { ...s, spawnModel: null } : s),
      });
      // 'refused'는 서버가 사유를 담은 error 프레임을 이미 토스트로 띄웠다 —
      // 여기서 덧붙이면 같은 실패가 두 번 뜬다. 'unknown'만 우리가 알린다.
      notify(
        `모델 변경이 적용됐는지 확인하지 못했습니다: ${label}`
        + ' — 데몬이 구버전이면 이미 적용됐을 수 있습니다. 다음 응답의 모델 표시를 확인해 주세요',
        'error',
      );
    }
  };
  // 권한 모드 변경 로직은 PermissionModeBar.jsx가 스토어에서 직접 읽어 처리한다 —
  // 위치만 이 컴포넌트 안(입력 상자 우측 상단)이고, 상태·전송은 여기로 오지 않는다.
  // effort 변경은 **런타임 채널이 우선**이다 — CLI v2.1.233 실측: apply_flag_settings
  // 제어 요청으로 실행 중 세션의 노력 수준을 바꿀 수 있어(store.setEffort → 서버
  // setEffort) 재시작이 필요 없다. 표시 갱신은 서버의 effortSet 방송이 한다.
  // 이 채널을 모르는 구버전 CLI에서는 요청이 거부되거나 응답이 없으므로, 그때만
  // 예전 방식(같은 대화로 재시작)으로 폴백한다 — restartWithEffort 참조.
  const changeEffort = async (effort) => {
    if (!session || state.conn !== 'open') return;
    const label = effortLabel(effort);
    const applied = await setEffort(session.key, effort);
    if (applied) {
      notify(`노력 수준 변경: ${label}`);
      return;
    }
    restartWithEffort(effort, label);
  };
  // 폴백: 기존 프로세스 정지 → --effort 재스폰, 메시지는 메모리에서 이월
  // (preloadMessages), 새 탭이 옛 탭을 대체(replaceKey).
  // --resume은 트랜스크립트가 실제로 존재할 때만 붙인다: 완결 턴 ≥1 또는 재개로
  // 시작한 세션. 무턴 세션은 jsonl이 없어 --resume이 "No conversation found"로
  // 실패한다(실 CLI v2.1.206 실측) — 이때는 그냥 새로 시작해도 잃을 서버측 맥락이 없다.
  const restartWithEffort = (effort, label) => {
    // ack를 기다린 뒤라 이 컴포넌트 클로저의 state·session은 낡았을 수 있다 —
    // 재시작은 메시지를 통째로 이월하므로 반드시 **현재** 스냅샷으로 판단·이월한다
    // (낡은 사본으로 하면 대기 중에 온 응답이 사라진다).
    const now = getState();
    const cur = now.sessions.get(session.key);
    if (!cur || now.conn !== 'open') return;
    // 늦은 성공 레이스: 서버의 제어 요청 한도(30s)가 우리 ack 대기(5s)보다 길어,
    // 타임아웃 뒤에 성공 방송이 도착할 수 있다. 이미 반영됐다면 재시작하지 않는다.
    if ((cur.effort ?? DEFAULT_EFFORT) === effort) return;
    // 재시작은 진행 중인 턴을 파괴하므로 idle에서만. 연타(pendingStarts) 가드는
    // 고아 세션 방지. 런타임 변경이 되는 CLI에서는 이 제약이 아예 걸리지 않는다.
    if (cur.status !== 'idle' || now.pendingStarts.size > 0) {
      notify(
        `노력 수준을 바꾸지 못했습니다: 이 CLI 버전은 세션 재시작이 필요합니다`
        + ` — 진행 중인 턴이 끝난 뒤 다시 시도해 주세요`,
        'error',
      );
      return;
    }
    const resumeId = cur.sessionId ?? cur.resumeSourceId;
    const canResume = cur.hasCompletedTurn && resumeId != null;
    // 재시작이 실제로 일어나는 자리에서만 알린다 — 조용히 재시작하면 사용자에겐
    // "노력 수준을 바꿨더니 세션이 새로 떴다"로만 보인다. 흔한 원인 둘: 구버전 CLI,
    // 그리고 구버전 데몬이 새 메시지를 unknown message type으로 튕기는 버전 스큐
    // (그 경우 사이드바 하단에 상시 경고가 함께 떠 있다).
    notify(`런타임 변경이 안 돼 세션을 재시작합니다 — 노력 수준: ${label}`);
    stopSession(cur.key);
    startSession({
      cwd: cur.cwd,
      // 스폰 --model은 검증된 계보(spawnModel: 시작 인자·set_model 성공값)만 —
      // session.model엔 init/assistant가 보고한 해석 id(구식·[1m] 접미사 탈락 가능)도
      // 들어오는데, 그걸 스폰 인자로 넘기면 1M 세션의 무언 다운그레이드나 스폰 실패가
      // 된다(Sidebar 재개와 동일 불변식). null이면 --model 생략(CLI가 결정 — 재개는
      // 트랜스크립트의 모델로 이어진다). 표시는 preloadModel로 잇는다.
      model: cur.spawnModel,
      preloadModel: cur.model,
      permissionMode: cur.permissionMode,
      effort,
      resumeSessionId: canResume ? resumeId : null,
      preloadMessages: cur.messages,
      // 같은 대화로 이어가는 경우(resume)에만 usage·컨텍스트 계보를 이월한다 —
      // 새 대화로 시작하면 서버측 컨텍스트가 비어 있으므로 옛 CTX%는 오표시.
      preloadSessionId: canResume ? resumeId : null,
      preloadUsage: canResume ? cur.usage : null,
      preloadCtxFromCalls: canResume ? cur.ctxFromCalls : false,
      // 사용자가 붙여 둔 세션 이름은 재시작 이유(노력 수준 변경)와 무관하게 이어진다 —
      // 같은 탭을 대체하는 재시작이라 이름이 사라지면 사용자에겐 세션이 바뀐 것처럼 보인다.
      preloadCustomTitle: cur.customTitle,
      // 열려 있던 미리보기도 이월한다 — 메시지가 그대로 넘어오므로 산출물 목록은
      // 저절로 복원되는데, 선택만 잃으면 패널이 혼자 닫혀 재시작이 티가 난다.
      preloadPreview: cur.preview,
      replaceKey: cur.key,
    });
    // 문구는 실제 동작과 일치시킨다 — resume이 아닐 때 "같은 대화"라고 말하지 않는다.
    notify(
      canResume
        ? `노력 수준 변경: ${label} — 이 CLI는 런타임 변경을 지원하지 않아 같은 대화로 재시작합니다`
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
            <Icon name="undo" className="ir-ico" />
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
              <Icon name="retry" /> 재시도
            </button>
            <button
              type="button"
              className="ir-btn"
              onClick={editInterrupted}
              data-tip="프롬프트를 입력창으로 불러와 고쳐서 보냅니다"
            >
              <Icon name="edit" /> 수정
            </button>
            <button
              type="button"
              className="ir-btn ghost"
              onClick={dismissInterrupted}
              data-tip="복구 바 닫기"
              aria-label="복구 바 닫기"
            >
              <Icon name="close" />
            </button>
          </div>
        )}

        {/* 입력 — 권한 모드 셀렉트는 이 상자 **안쪽** 우측 상단에 겹쳐 둔다.
            기준을 .composer-shell이 아니라 .composer-input으로 잡는 이유: 셸 맨 위에는
            GOAL 배지(ActiveModes)와 인터럽트 복구 바가 조건부로 들어와, 셸 기준으로
            띄우면 그것들 위에 얹혀 서로를 가린다. 입력 영역 기준이면 항상 첫 줄 옆이다.
            글자가 셀렉트 밑으로 흐르지 않게 textarea가 우측 여백을 비워 둔다(interact.css). */}
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
          {/* 절대 배치라 화면 위치는 소스 순서와 무관하다 — 그래서 **탭 순서**가 좋은
              쪽으로 둔다: 입력창이 먼저, 그다음 권한 모드(그다음이 하단 모델·전송).
              셀렉트가 앞에 있으면 컴포저에 처음 탭으로 들어올 때 입력창을 지나친다.
              세션이 없을 때 숨기는 판단은 컴포넌트 자신이 한다(스토어를 직접 읽는다) —
              여기서 한 번 더 걸면 같은 규칙이 두 곳에 생겨 한쪽만 바뀔 수 있다. */}
          <PermissionModeBar />
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
                  // 진행 중 턴에도 열어 둔다 — 변경이 런타임 채널로 나가 재시작이 없으므로
                  // 진행분을 파괴하지 않는다. 재시작이 필요한 구버전 CLI에서만
                  // restartWithEffort가 idle을 요구하며 거절한다.
                  disabled={!live || state.conn !== 'open'}
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
              <Icon name="stop" size={15} />
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
              <Icon name="arrow-up" size={15} />
            </button>
          )}
        </div>

      </div>

      {/* worktree 브랜치 칩 — 입력 상자 **바로 아래**의 독립 버튼(사이드바 하단
          네 버튼 중 하나였던 것을 떼어 왔다). 여기가 셸 밖·RunningWork 앞인 이유는
          "입력창 아래"라는 자리가 조건부로 흔들리면 안 되기 때문이다: 셸 안에 두면
          입력 상자 테두리 안으로 들어가고, RunningWork 뒤에 두면 작업이 돌 때만
          한 칸 밀려난다. 데이터·여닫음은 전부 자기가 처리하므로 props가 없다
          (PermissionModeBar와 같은 규약). */}
      <WorktreeButton />

      {/* 실행 중 작업 도크 — 입력창 박스 **밖**의 독립 카드(.composer-shell의 형제).
          셸 안에 있던 시절엔 도크에 포커스만 가도 .composer-shell:focus-within이 입력창
          테두리를 물들였고, 상세를 펼치면 입력 박스가 통째로 늘어났다. 셸 **뒤**여야
          한다 — .composer-mascot이 .composer-dock의 위쪽 모서리에 붙어 있어서, 앞에
          두면 마스코트 발이 입력창이 아니라 이 스트립을 딛는다. */}
      {session && (
        <RunningWork
          session={session}
          conn={state.conn}
          onJump={(uid) => jumpTo(session.key, uid)}
        />
      )}

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
        /* 세션이 바뀌면 마스코트를 새로 마운트한다 — effect로 지우는 방식은 새 세션의
           첫 렌더에 이전 세션의 happy/error/notify가 한 프레임 새어 나온다(codex 지적).
           remount는 기준선(notice·압축 완료 수)까지 새 세션 값으로 다시 잡는 효과도 있다. */
        key={state.activeKey ?? 'none'}
        className="composer-mascot"
        scale={5}
        status={session?.status ?? 'none'}
        conn={state.conn}
        sessionKey={state.activeKey ?? null}
        lastResult={session?.lastResult ?? null}
        interrupted={session?.interruptRequested ?? false}
        subagents={subagentList.length}
        compacting={signals.compacting}
        carrying={signals.carrying}
        noticeCount={signals.notices}
        compactionsDone={signals.compactionsDone}
        toolErrors={signals.toolErrors}
        sessionsRunning={sessionsRunning}
      />
    </div>
  );
}
