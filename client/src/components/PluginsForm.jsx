// 플러그인 켬/끔 폼 — Config 편집기의 '플러그인' 탭과 설정 모달의 '플러그인' 탭이
// 같은 컴포넌트를 쓴다. 두 벌로 두면 한쪽만 고쳐져 같은 파일을 다르게 보여 준다.
//
// 두 모달은 **동시에** 마운트될 수 있다(설정 모달 위에 편집기가 형제로 뜬다).
// 그래서 DOM id를 하드코딩하지 않고 idPrefix로 조립한다 — 겹치면 aria-labelledby가
// 남의 모달 제목을 가리키고, 행 삭제 후 포커스가 inert 서브트리로 향해 조용히 실패한다.
//
// 막힌 상태(blocked)의 안내 문구도 prop으로 받는다: "JSON 탭에서 편집하세요"는
// JSON 탭이 없는 설정 모달에서는 막다른 길이다.
import { useMemo, useRef } from 'react';
import { pluginRows } from '../lib/claude-settings-form.js';
import Icon from './Icon.jsx';

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
            <Icon name="close" />
          </button>
        </>
      )}
    </div>
  );
}

export default function PluginsForm({
  text,
  disabled,
  plugins,
  pluginsLoading,
  pluginsError,
  onReloadPlugins,
  onToggle,
  onRemove,
  idPrefix = 'cfg',
  blocked,
}) {
  const headingId = `${idPrefix}-plugins-heading`;
  const headingRef = useRef(null); // 행이 사라졌을 때의 포커스 착지점
  const derived = useMemo(() => pluginRows(text, plugins), [text, plugins]);

  // 설치되지 않은 항목은 제거하면 행 자체가 사라진다 — 포커스가 <body>로 떨어지지
  // 않게 목록 제목으로 옮겨 둔다(지난 세션 삭제와 같은 처리). onRemove는 패치 성공
  // 여부를 boolean으로 돌려줘야 한다.
  const remove = (key) => {
    const willVanish = !plugins.some((p) => p.key === key);
    if (onRemove(key) && willVanish) headingRef.current?.focus?.();
  };

  if (!derived.ok) return <div className="cfg-form">{blocked}</div>;

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
      <div className="cfg-plugin-list" role="group" aria-labelledby={headingId}>
        <span className="dim cfg-label" id={headingId} tabIndex={-1} ref={headingRef}>
          플러그인 {derived.rows.length > 0 ? `(${derived.rows.length})` : ''}
        </span>
        {derived.rows.length === 0 && !pluginsLoading && (
          <span className="dim cfg-hint">설치되었거나 설정에 기록된 플러그인이 없습니다.</span>
        )}
        {derived.rows.map((row) => (
          <PluginRow
            key={row.key}
            row={row}
            disabled={disabled}
            onToggle={onToggle}
            onRemove={remove}
          />
        ))}
      </div>
    </div>
  );
}
