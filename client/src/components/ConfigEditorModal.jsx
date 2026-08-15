// Claude Code Config 편집기 — ~/.claude/settings.json을 폼(일반·플러그인)과
// 원문(JSON) 세 탭으로 편집하는 모달.
//
// 설정 모달(FootModal)의 **형제**로 렌더된다(중첩 금지: 두 포커스 트랩이 서로
// 간섭하지 않게 — 새 세션 모달 ↔ 삭제 확인 모달과 같은 패턴). 아래 레이어를 inert로
// 잠그는 일은 부모(Sidebar)가 맡는다.
//
// 단일 소스는 **원문 문자열 text 하나**다. 폼 컨트롤은 자기 상태를 따로 들지 않고
// claude-settings-form.js로 "지금 원문을 파싱 → 해당 leaf만 고침 → 재직렬화"만 한다.
// 그래서 탭을 오가도 두 화면이 어긋날 수가 없다. 예외는 env 행뿐이다(빈 키·중복 키는
// 객체로 왕복할 수 없어, 유효해지기 전까지 로컬 draft에 머문다).
//
// 저장 규칙:
//  · JSON 탭에서만 고쳤다면 원문 그대로 보낸다(들여쓰기·키 순서 보존). 폼을 거치면
//    2-space로 재직렬화된다 — 값과 키 순서는 유지된다.
//  · 저장 전에 클라이언트에서 먼저 JSON.parse로 검증한다(서버도 다시 검증한다).
//  · 기준선(mtimeMs)은 로드 시각의 것이고, 저장에 성공하면 응답의 새 값으로 갈아
//    끼운다 — 그러지 않으면 두 번째 저장이 자기 자신과 충돌한다.
//  · 409(다른 곳에서 수정됨)는 덮어쓰지 않고 "다시 불러오기"를 안내한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchClaudeConfig, fetchClaudePlugins, saveClaudeConfig } from '../lib/api.js';
import {
  KNOWN_FIELDS,
  UNSET,
  UNSET_OPTION,
  formReady,
  optionsWithCurrent,
  patchEnvRows,
  patchField,
  readEnabledPlugins,
  readEnvRows,
  readField,
  removePluginEntry,
  setPluginEnabled,
  unknownTopKeys,
  validateEnvRows,
} from '../lib/claude-settings-form.js';
import { MODE_CLASS } from '../lib/permission-modes.js';
import TrustModeWarning from './TrustModeWarning.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';

const TABS = [
  { id: 'general', label: '일반' },
  { id: 'plugins', label: '플러그인' },
  { id: 'json', label: 'JSON' },
];

// 폼으로 다룰 수 없는 값을 만났을 때의 공통 안내 — 값은 절대 건드리지 않는다.
function BlockedNote({ children = '이 항목은 폼으로 다룰 수 없는 형태입니다 — JSON 탭에서 편집하세요.' }) {
  return <span className="dim cfg-blocked">{children}</span>;
}

// ----- 일반 탭 -----

const isTrustMode = (field, value) =>
  field.id === 'permissionsDefaultMode' && value === 'bypassPermissions';

// KNOWN_FIELDS 한 줄. 값을 읽지 못하거나(blocked) 타입이 다르면 컨트롤 대신 안내를 낸다.
function FieldRow({ field, text, disabled, onPatch }) {
  const read = readField(text, field.path);
  const current = read.ok ? read.value : undefined;
  const blocked =
    !read.ok
    || (current !== undefined
      && ((field.kind === 'boolean' && typeof current !== 'boolean')
        || (field.kind !== 'boolean' && typeof current !== 'string')));

  const set = (value) => onPatch(field.path, value);

  let control = null;
  if (blocked) {
    control = <BlockedNote />;
  } else if (field.kind === 'text') {
    control = (
      <input
        type="text"
        className="cfg-input"
        id={`cfg-${field.id}`}
        value={current ?? ''}
        disabled={disabled}
        placeholder={field.placeholder}
        spellCheck={false}
        autoComplete="off"
        // 비우는 것 = 항목 삭제. ''를 그대로 저장하면 CLI가 빈 모델명을 읽는다.
        onChange={(e) => set(e.target.value === '' ? UNSET : e.target.value)}
      />
    );
  } else if (field.kind === 'boolean') {
    // 3-way — "기본값"(키 없음)은 false와 다르다(CLI 기본 동작에 맡긴다는 뜻).
    control = (
      <select
        className="cfg-select"
        id={`cfg-${field.id}`}
        value={current === undefined ? UNSET_OPTION : String(current)}
        disabled={disabled}
        onChange={(e) => set(e.target.value === UNSET_OPTION ? UNSET : e.target.value === 'true')}
      >
        <option value={UNSET_OPTION}>(기본값)</option>
        <option value="true">켬</option>
        <option value="false">끔</option>
      </select>
    );
  } else {
    const options = optionsWithCurrent(field.options, current);
    const isMode = field.id === 'permissionsDefaultMode';
    control = (
      <select
        className={`cfg-select ${(isMode && MODE_CLASS[current]) || ''}`.trim()}
        id={`cfg-${field.id}`}
        value={current === undefined ? UNSET_OPTION : current}
        disabled={disabled}
        onChange={(e) => set(e.target.value === UNSET_OPTION ? UNSET : e.target.value)}
      >
        <option value={UNSET_OPTION}>(설정 안 함)</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="cfg-field">
      <div className="cfg-field-head">
        <label className="cfg-label" htmlFor={blocked ? undefined : `cfg-${field.id}`}>
          {field.label}
        </label>
        {control}
      </div>
      {field.hint && <div className="dim cfg-hint">{field.hint}</div>}
      {isTrustMode(field, current) && <TrustModeWarning />}
    </div>
  );
}

// env 편집 — 유일하게 로컬 draft를 두는 자리. 빈 키·중복 키는 객체로 왕복할 수
// 없어서(하나로 뭉개지거나 사라진다) 유효해지기 전까지 원문에 커밋하지 않는다.
function EnvEditor({ rows, error, disabled, blocked, onChange }) {
  // 마지막 줄을 지우면 방금 누른 ✕가 통째로 사라진다 — 포커스를 "+ 추가"로 옮겨
  // <body>로 떨어지는 것을 막는다(가운데 줄은 아래 줄의 ✕가 같은 자리를 잇는다).
  const addRef = useRef(null);
  if (blocked) {
    return (
      <div className="cfg-field">
        <div className="cfg-label">환경 변수 (env)</div>
        <BlockedNote>env에 문자열이 아닌 값이 있습니다 — JSON 탭에서 편집하세요.</BlockedNote>
      </div>
    );
  }
  const setRow = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="cfg-field">
      <div className="cfg-field-head">
        <span className="cfg-label" id="cfg-env-label">환경 변수 (env)</span>
        <button
          type="button"
          ref={addRef}
          className="cfg-row-btn"
          disabled={disabled}
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        >
          + 추가
        </button>
      </div>
      <div className="cfg-env-rows" role="group" aria-labelledby="cfg-env-label">
        {rows.length === 0 && <span className="dim cfg-hint">설정된 환경 변수가 없습니다.</span>}
        {rows.map((row, i) => (
          // 행 순서가 곧 정체성이다 — 키를 key로 쓰면 이름을 고치는 순간 입력이
          // 리마운트돼 커서를 잃는다.
          // eslint-disable-next-line react/no-array-index-key
          <div className="cfg-env-row" key={i}>
            <input
              type="text"
              className="cfg-input cfg-env-key"
              value={row.key}
              disabled={disabled}
              aria-label={`환경 변수 ${i + 1} 이름`}
              placeholder="NAME"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            <input
              type="text"
              className="cfg-input"
              value={row.value}
              disabled={disabled}
              aria-label={`환경 변수 ${i + 1} 값`}
              placeholder="value"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRow(i, { value: e.target.value })}
            />
            <button
              type="button"
              className="cfg-row-btn"
              disabled={disabled}
              aria-label={`환경 변수 삭제: ${row.key || `${i + 1}번째 줄`}`}
              data-tip="이 줄 삭제"
              onClick={() => {
                onChange(rows.filter((_, idx) => idx !== i));
                if (i === rows.length - 1) addRef.current?.focus?.();
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {error && <div className="sidebar-error" role="alert">{error}</div>}
    </div>
  );
}

function GeneralTab({ text, disabled, envRows, envError, onPatch, onEnvChange }) {
  const env = readEnvRows(text);
  const others = unknownTopKeys(text);
  return (
    <div className="cfg-form">
      {KNOWN_FIELDS.map((field) => (
        <FieldRow key={field.id} field={field} text={text} disabled={disabled} onPatch={onPatch} />
      ))}
      <EnvEditor
        rows={envRows}
        error={envError}
        disabled={disabled}
        blocked={!env.ok}
        onChange={onEnvChange}
      />
      {others.length > 0 && (
        <div className="cfg-field">
          <span className="cfg-label">그 외 항목</span>
          <div className="dim cfg-hint">
            {others.map((k) => <code key={k} className="cfg-key">{k}</code>)}
            {' '}— 폼으로 다루지 않는 항목입니다. 값은 그대로 보존되며, 고치려면 JSON 탭을 쓰세요.
          </div>
        </div>
      )}
    </div>
  );
}

// ----- 플러그인 탭 -----

const scopeLabel = (install) => {
  const scope = install.scope === 'user' ? '사용자' : install.scope === 'project' ? '프로젝트' : install.scope || '';
  return [scope, install.version ? `v${install.version}` : null].filter(Boolean).join(' ');
};

function PluginRow({ row, disabled, onToggle, onRemove }) {
  const { key, name, marketplace, installed, installs, enabled } = row;
  const on = enabled === true;
  // 상태는 셋이다: 설정 없음(키 없음) / 켬 / 끔. 스위치는 둘만 표현할 수 있어,
  // "설정 없음"인 행에는 스위치 대신 켬·끔 두 버튼을 둔다 — 그러지 않으면 명시적
  // "끔"을 만들려고 켰다 껐다 두 번 눌러야 하고, 보조기술에도 끔과 똑같이 읽힌다.
  const unset = enabled === undefined;
  return (
    <div className="cfg-plugin-row">
      <span className="cfg-plugin-main">
        <span className="cfg-plugin-name truncate">
          {name}
          {marketplace && <span className="dim cfg-plugin-market"> @{marketplace}</span>}
        </span>
        <span className="dim cfg-plugin-sub truncate">
          {!installed && <span className="cfg-badge">미설치</span>}
          {installs.map((install, i) => {
            const label = scopeLabel(install);
            return label ? (
              // eslint-disable-next-line react/no-array-index-key
              <span key={i} className="cfg-badge scope" data-tip={install.projectPath || undefined}>
                {label}
              </span>
            ) : null;
          })}
          {installs.length === 0
            && (installed ? '설치 정보 없음' : '설정에만 남아 있는 항목입니다')}
        </span>
      </span>
      {unset ? (
        <span className="cfg-plugin-choice" role="group" aria-label={`플러그인 설정: ${key} (현재: 설정 없음)`}>
          <span className="cfg-plugin-state dim" aria-hidden="true">설정 없음</span>
          <button
            type="button"
            className="cfg-row-btn"
            disabled={disabled}
            aria-label={`켜기: ${key}`}
            onClick={() => onToggle(key, true)}
          >
            켜기
          </button>
          <button
            type="button"
            className="cfg-row-btn"
            disabled={disabled}
            aria-label={`끄기: ${key}`}
            onClick={() => onToggle(key, false)}
          >
            끄기
          </button>
        </span>
      ) : (
        <>
          <span className="cfg-plugin-state dim" aria-hidden="true">{on ? '켬' : '끔'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`switch${on ? ' on' : ''}`}
            disabled={disabled}
            aria-label={`플러그인 사용: ${key}`}
            data-tip={on ? '끄기' : '켜기'}
            onClick={() => onToggle(key, !on)}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cfg-row-btn"
            disabled={disabled}
            aria-label={`설정에서 항목 제거: ${key}`}
            data-tip="설정에서 이 항목을 제거(켬/끔 기록 삭제)"
            onClick={() => onRemove(key)}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

function PluginsTab({ text, disabled, plugins, pluginsError, pluginsLoading, onReloadPlugins, onToggle, onRemove, headingRef }) {
  const enabled = readEnabledPlugins(text);
  const rows = useMemo(() => {
    if (!enabled.ok) return [];
    const byKey = new Map();
    for (const p of plugins) {
      byKey.set(p.key, { ...p, installed: true, enabled: enabled.map[p.key] });
    }
    // 설정에만 남은 항목(제거된 플러그인의 찌꺼기)도 보여 줘야 정리할 수 있다.
    for (const key of Object.keys(enabled.map)) {
      if (byKey.has(key)) continue;
      const at = key.lastIndexOf('@');
      byKey.set(key, {
        key,
        name: at > 0 ? key.slice(0, at) : key,
        marketplace: at > 0 ? key.slice(at + 1) : '',
        installs: [],
        installed: false,
        enabled: enabled.map[key],
      });
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, text, enabled.ok]);

  if (!enabled.ok) {
    return (
      <div className="cfg-form">
        <BlockedNote>
          enabledPlugins가 "이름: 켬/끔" 형태가 아닙니다 — 값을 덮어쓰지 않았습니다. JSON 탭에서 편집하세요.
        </BlockedNote>
      </div>
    );
  }

  return (
    <div className="cfg-form">
      <div className="dim cfg-hint">
        켬/끔과 항목 정리만 여기서 합니다. 설치·삭제·업데이트는 터미널에서{' '}
        <code className="cfg-key">claude plugin</code> 명령으로 하세요.
      </div>
      {/* 목록 조회는 설정 로드와 독립이다 — 실패해도 켬/끔 편집은 계속된다. */}
      <div role="status">
        {pluginsLoading && <span className="dim cfg-hint">설치 목록을 불러오는 중…</span>}
        {pluginsError && (
          <span className="past-note past-note-error">
            <span className="dim">설치 목록을 불러오지 못했습니다({pluginsError}) — 설정에 기록된 항목만 보입니다.</span>
            <button type="button" className="past-retry" disabled={disabled} onClick={onReloadPlugins}>
              다시 시도
            </button>
          </span>
        )}
      </div>
      <div className="cfg-plugin-list" role="group" aria-labelledby="cfg-plugins-heading">
        <span className="dim cfg-label" id="cfg-plugins-heading" tabIndex={-1} ref={headingRef}>
          플러그인 {rows.length > 0 ? `(${rows.length})` : ''}
        </span>
        {rows.length === 0 && !pluginsLoading && (
          <span className="dim cfg-hint">설치되었거나 설정에 기록된 플러그인이 없습니다.</span>
        )}
        {rows.map((row) => (
          <PluginRow
            key={row.key}
            row={row}
            disabled={disabled}
            onToggle={onToggle}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}

// ----- 모달 본체 -----

export default function ConfigEditorModal({ presenceStatus, restoreRef, onClose, notify }) {
  const dialogRef = useFocusTrap(true, undefined, restoreRef);
  const [tab, setTab] = useState('general');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState(''); // 마지막으로 로드/저장한 내용
  const [mtimeMs, setMtimeMs] = useState(null); // 저장에 쓸 기준선
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null); // 인라인 오류(JSON 문법·저장 실패)
  const [conflict, setConflict] = useState(false);
  // env 편집 draft — null이면 원문에서 그대로 파생한다(편집 중이 아님).
  const [envDraft, setEnvDraft] = useState(null);
  // 설치 플러그인 목록 — 설정과 별개의 요청이라 실패해도 편집을 막지 않는다.
  const [plugins, setPlugins] = useState([]);
  const [pluginsError, setPluginsError] = useState(null);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  // 요청 세대 — 닫혔다 다시 열리거나 "다시 불러오기"를 누른 뒤 늦게 도착한 응답이
  // 현재 편집 내용을 덮어쓰지 못하게 한다.
  const genRef = useRef(0);
  const pluginGenRef = useRef(0);
  const aliveRef = useRef(true);
  const tabRefs = useRef(new Map()); // 탭 버튼 — 화살표 이동 시 포커스를 옮길 대상
  const pluginsHeadingRef = useRef(null); // 행이 사라졌을 때의 포커스 착지점
  const jsonRef = useRef(null); // 원문 편집기 — "JSON 탭으로 이동"의 착지점
  const [focusJson, setFocusJson] = useState(false);
  // StrictMode(개발)는 마운트 직후 정리→재설정을 한 번 흉내 낸다. 정리에서 false로만
  // 두면 그 뒤의 응답이 전부 폐기돼 "불러오는 중…"에서 멈춘다 — 설정에서 다시 켠다.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  // 저장하지 않은 변경이 있는 채로 닫으려 했는가 — 한 번 더 확인받는다.
  const [confirmingClose, setConfirmingClose] = useState(false);

  const load = async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    setConflict(false);
    setEnvDraft(null); // 새로 받은 내용이 진실이다 — 편집 중이던 행은 버린다
    try {
      const res = await fetchClaudeConfig();
      if (!aliveRef.current || genRef.current !== gen) return;
      setPath(res.path || '');
      setText(res.content ?? '{}');
      setBaseline(res.content ?? '{}');
      setMtimeMs(res.mtimeMs ?? null);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      setLoadError(String(err.message ?? err));
    } finally {
      if (aliveRef.current && genRef.current === gen) setLoading(false);
    }
  };

  const loadPlugins = async () => {
    const gen = ++pluginGenRef.current;
    setPluginsLoading(true);
    setPluginsError(null);
    try {
      const res = await fetchClaudePlugins();
      if (!aliveRef.current || pluginGenRef.current !== gen) return;
      setPlugins(Array.isArray(res.plugins) ? res.plugins : []);
    } catch (err) {
      if (!aliveRef.current || pluginGenRef.current !== gen) return;
      setPluginsError(String(err.message ?? err));
    } finally {
      if (aliveRef.current && pluginGenRef.current === gen) setPluginsLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadPlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = formReady(text);
  // 편집 중인 env 행 — draft가 있으면 그쪽이 화면의 진실이다.
  const envFromText = readEnvRows(text);
  const envRows = envDraft ?? (envFromText.ok ? envFromText.rows : []);
  const envError = envDraft ? validateEnvRows(envDraft) : null;
  // 아직 원문에 반영되지 못한 env 행도 "저장하지 않은 편집"이다 — 이것까지 세지
  // 않으면 방금 친 줄이 확인 없이 사라진다.
  const dirty = text !== baseline || !!envError;

  // 폼 조작의 공통 출구 — 실패(blocked/invalid)는 값을 건드리지 않고 문구로 알린다.
  const applyPatch = (result, blockedMessage) => {
    if (result.ok) {
      setText(result.text);
      setError(null);
      // 내용을 고치는 순간 이전 결과(충돌·닫기 확인)는 더 이상 유효하지 않다
      setConflict(false);
      setConfirmingClose(false);
      return true;
    }
    setError(
      result.reason === 'invalid'
        ? 'JSON이 올바르지 않아 폼으로 고칠 수 없습니다 — JSON 탭에서 먼저 고치세요.'
        : blockedMessage ?? '이 항목은 폼으로 다룰 수 없는 형태입니다 — JSON 탭에서 편집하세요.',
    );
    return false;
  };

  const patchOne = (fieldPath, value) => applyPatch(patchField(text, fieldPath, value));

  // env는 유효할 때만 원문에 반영한다 — 그 전까지는 draft에만 존재한다.
  const changeEnv = (rows) => {
    setEnvDraft(rows);
    // 커밋되지 않는 편집이라도 "방금 손댔다"는 사실은 같다 — 닫기 확인을 되돌린다.
    setConfirmingClose(false);
    if (validateEnvRows(rows)) return;
    applyPatch(patchEnvRows(text, rows));
  };

  const togglePlugin = (key, enabled) => applyPatch(setPluginEnabled(text, key, enabled));

  const removePlugin = (key) => {
    // 설치되지 않은 항목은 제거하면 행 자체가 사라진다 — 포커스가 <body>로 떨어지지
    // 않게 목록 제목으로 옮겨 둔다(지난 세션 삭제와 같은 처리).
    const willVanish = !plugins.some((p) => p.key === key);
    if (applyPatch(removePluginEntry(text, key)) && willVanish) {
      pluginsHeadingRef.current?.focus?.();
    }
  };

  const save = async () => {
    if (saving || !dirty) return;
    if (envError) {
      setError(`환경 변수를 먼저 고쳐 주세요: ${envError}`);
      return;
    }
    try {
      JSON.parse(text);
    } catch (err) {
      setError(`JSON 문법 오류: ${err.message}`);
      return;
    }
    const gen = genRef.current;
    const sent = text; // 저장 중 편집이 들어와도 기준선은 "보낸 내용"이어야 한다
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const res = await saveClaudeConfig({ content: sent, expectedMtimeMs: mtimeMs });
      if (!aliveRef.current || genRef.current !== gen) return;
      // 새 기준선으로 갈아 끼운다 — 모달을 열어 둔 채 이어서 저장할 수 있게.
      setMtimeMs(res.mtimeMs ?? null);
      setBaseline(sent);
      setConflict(false);
      setConfirmingClose(false); // 저장했으니 "저장하지 않은 변경" 경고는 유효하지 않다
      notify?.('Claude Code 설정을 저장했습니다. 이후 시작되는 세션부터 적용됩니다.');
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      if (err?.status === 409) {
        setConflict(true);
        setError('다른 곳에서 파일이 바뀌었습니다. 덮어쓰지 않았습니다 — 다시 불러온 뒤 편집하세요.');
      } else {
        setError(String(err.message ?? err));
      }
    } finally {
      if (aliveRef.current && genRef.current === gen) setSaving(false);
    }
  };

  // 저장 중에는 닫기를 막는다 — 진행 중 사라지면 결과를 알 수 없다.
  // 저장하지 않은 편집이 있으면 첫 시도는 경고만 띄우고 닫지 않는다(Esc·배경 클릭·✕
  // 어느 쪽으로 왔든 동일) — 편집 내용을 통째로 잃는 사고를 막는다.
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  // 탭 이동 — WAI-ARIA 탭 패턴(←·→·Home·End). 포커스와 선택이 함께 움직인다.
  // 저장 중에는 탭도 잠근다(값 컨트롤만 잠그면 진행 중인 저장의 대상이 화면에서
  // 바뀐다). disabled 대신 aria-disabled인 이유는 포커스가 <body>로 떨어지지 않게.
  const goTab = (id) => {
    if (saving) return;
    setTab(id);
    tabRefs.current.get(id)?.focus?.();
  };
  const onTabKeyDown = (e) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step) {
      e.preventDefault();
      goTab(TABS[(i + step + TABS.length) % TABS.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goTab(TABS[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      goTab(TABS[TABS.length - 1].id);
    }
  };

  // "JSON 탭으로 이동" 버튼은 눌리는 순간 사라진다 — 포커스를 원문 편집기로 넘긴다.
  const jumpToJson = () => {
    setTab('json');
    setFocusJson(true);
  };
  useEffect(() => {
    if (tab === 'json' && focusJson) {
      jsonRef.current?.focus?.();
      setFocusJson(false);
    }
  }, [tab, focusJson]);

  const busy = saving || loading || !!loadError;

  return (
    <div
      className={`modal-overlay config-overlay${presenceStatus === 'closing' ? ' closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          requestClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Claude Code Config 편집"
      >
        <div className="modal-title">
          Claude Code Config
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            disabled={saving}
            aria-label="닫기"
            data-tip="닫기"
          >
            ✕
          </button>
        </div>

        <div className="modal-body config-body">
          <div className="config-path dim truncate" data-tip={path || undefined}>
            {path || '경로를 불러오는 중…'}
          </div>

          <div className="mode-warning">
            ⚠ 이 파일은 Claude Code CLI 전체의 설정입니다. 저장한 내용은 이 앱 밖에서
            시작되는 세션에도 적용되며, 이미 실행 중인 세션에는 반영되지 않습니다.
            폼에 없는 항목은 그대로 보존되지만, 값이 잘못됐거나 권한을 넓히는 설정은 걸러지지 않습니다.
          </div>

          {/* 비동기 상태(로딩·실패)는 시각 표시만으로 전달되지 않는다 — 라이브 영역으로. */}
          <div role="status">
            {loading && <span className="dim foot-note">불러오는 중…</span>}
            {loadError && (
              <span className="past-note past-note-error">
                <span className="dim">설정을 불러오지 못했습니다: {loadError}</span>
                <button type="button" className="past-retry" onClick={load}>
                  다시 시도
                </button>
              </span>
            )}
          </div>

          {!loading && !loadError && (
            <>
              <div className="cfg-tabs seg" role="tablist" aria-label="설정 편집 방식">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`cfg-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls={`cfg-panel-${t.id}`}
                    className={tab === t.id ? 'on' : ''}
                    // 선택된 탭만 Tab 순서에 남긴다(탭 안 이동은 화살표 담당).
                    tabIndex={tab === t.id ? 0 : -1}
                    ref={(el) => {
                      if (el) tabRefs.current.set(t.id, el);
                      else tabRefs.current.delete(t.id);
                    }}
                    aria-disabled={saving || undefined}
                    onClick={() => goTab(t.id)}
                    onKeyDown={onTabKeyDown}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* 세 패널을 모두 두고 보이지 않는 쪽만 hidden으로 감춘다 — 탭의
                  aria-controls가 항상 실재하는 요소를 가리켜야 관계가 성립한다. */}
              {TABS.map((t) => (
                <div
                  key={t.id}
                  className="cfg-panel"
                  role="tabpanel"
                  id={`cfg-panel-${t.id}`}
                  aria-labelledby={`cfg-tab-${t.id}`}
                  hidden={tab !== t.id}
                  tabIndex={0}
                >
                  {/* 폼 탭은 "유효 JSON + 최상위 객체"일 때만 그린다 — 아니면 값을
                      건드리지 않고 JSON 탭으로 안내한다(서버 저장 조건과 같은 기준). */}
                  {t.id !== 'json' && !ready && (
                    <div className="cfg-form">
                      <BlockedNote>
                        지금 내용은 폼으로 다룰 수 없습니다(JSON 문법 오류이거나 최상위가 객체가
                        아닙니다). JSON 탭에서 먼저 고쳐 주세요.
                      </BlockedNote>
                      <button
                        type="button"
                        className="cfg-row-btn"
                        disabled={saving}
                        onClick={jumpToJson}
                      >
                        JSON 탭으로 이동
                      </button>
                    </div>
                  )}

                  {t.id === 'general' && ready && (
                    <GeneralTab
                      text={text}
                      disabled={saving}
                      envRows={envRows}
                      envError={envError}
                      onPatch={patchOne}
                      onEnvChange={changeEnv}
                    />
                  )}

                  {t.id === 'plugins' && ready && (
                    <PluginsTab
                      text={text}
                      disabled={saving}
                      plugins={plugins}
                      pluginsError={pluginsError}
                      pluginsLoading={pluginsLoading}
                      onReloadPlugins={loadPlugins}
                      onToggle={togglePlugin}
                      onRemove={removePlugin}
                      headingRef={pluginsHeadingRef}
                    />
                  )}

                  {t.id === 'json' && (
                    <textarea
                      ref={jsonRef}
                      className="config-text"
                      value={text}
                      disabled={saving}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="settings.json 내용"
                      onChange={(e) => {
                        setText(e.target.value);
                        // 원문을 직접 고치면 커밋되지 못한 env 행은 최신이 아니게 된다.
                        // 조용히 버리면 방금 친 줄이 소리 없이 사라지므로, 버렸다고 알린다.
                        setError(
                          envDraft && validateEnvRows(envDraft)
                            ? '원문을 직접 고쳐서, 저장되지 않은 환경 변수 줄은 버렸습니다.'
                            : null,
                        );
                        setEnvDraft(null);
                        setConflict(false);
                        setConfirmingClose(false);
                      }}
                    />
                  )}
                </div>
              ))}
            </>
          )}

          {/* 오류·충돌은 role=alert로 — 시각 표시만으로는 전달되지 않는다. */}
          {error && (
            <div className="sidebar-error" role="alert">
              {error}
              {conflict && (
                <button type="button" className="past-retry" onClick={load}>
                  다시 불러오기
                </button>
              )}
            </div>
          )}

          {confirmingClose && (
            <div className="sidebar-error" role="alert">
              저장하지 않은 변경이 있습니다. 그대로 닫으면 편집 내용이 사라집니다.
              {/* 저장 중에는 이 길도 막는다 — 진행 중인 저장의 결과를 못 보고 닫히는 건
                  ✕·Esc를 막아 둔 이유와 같다. */}
              <button type="button" className="past-retry" disabled={saving} onClick={onClose}>
                변경 버리고 닫기
              </button>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={requestClose} disabled={saving}>
            닫기
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={busy || !dirty || !!envError}
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
