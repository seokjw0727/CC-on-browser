// Claude Code 설정 원문(~/.claude/settings.json) draft — Config 편집기와 설정 모달의
// 플러그인 탭이 나눠 쓴다. 두 화면이 각자 fetch/mtime 기준선/409 처리를 따로 구현하면
// 한쪽만 기준선을 갈아 끼우는 식으로 조용히 어긋난다.
//
// 훅이 소유하는 것: 원문 text·기준선(baseline)·mtime 기준선·클라이언트 JSON 검증·
// 저장·409 안내·설치 플러그인 목록(로딩/오류 포함).
// 훅이 소유하지 **않는** 것: env 행 draft(플러그인 탭에는 없는 개념이라 Config
// 편집기에 남긴다)와 "저장하지 않고 닫기" 확인(모달마다 규칙이 다르다).
//
// 반환 함수가 useCallback으로 고정돼 있는 이유: 플러그인 탭이 "탭에 들어올 때 다시
// 읽는다"는 효과의 의존성으로 이 함수들을 쓴다. 매 렌더 새 함수가 되면 재조회 →
// setState → 재렌더가 무한히 돈다. load/loadPlugins/apply/editText/save는 의존성이
// 비어 있고(옵션은 optsRef로 본다), reload·reloadIfClean은 그 안정된 함수들만
// 의존한다 — 둘 다 렌더 사이에 신원이 바뀌지 않는다. setError만 raw setter로
// 그대로 내보내는데, React가 setState 신원을 보장하므로 같은 성질을 갖는다.
// 응답·실패 형상 정리(순수 함수)는 claude-config-io.js에 있다 — 이 파일은 api.js를
// 거쳐 store.jsx(.jsx)를 끌어오므로 node --test로 로드할 수 없기 때문이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchClaudeConfig, fetchClaudePlugins, saveClaudeConfig } from './api.js';
import {
  SAVED_NOTICE,
  jsonSyntaxIssue,
  normalizeConfigResponse,
  normalizePluginList,
  saveFailure,
} from './claude-config-io.js';

/**
 * @param {{notify?: Function, auto?: boolean, onLoadStart?: Function}} options
 *   auto=false면 마운트 시 자동 로드하지 않는다(플러그인 탭은 탭에 들어올 때 읽는다).
 */
export function useClaudeConfigDraft(options = {}) {
  // 옵션은 매 렌더 새 객체로 오지만 콜백 의존성은 []로 고정해야 한다 — ref로 최신값만 본다.
  const optsRef = useRef(options);
  optsRef.current = options;

  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState(''); // 마지막으로 로드/저장한 내용
  const [mtimeMs, setMtimeMs] = useState(null); // 저장에 쓸 기준선
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null); // 인라인 오류(JSON 문법·저장 실패)
  const [conflict, setConflict] = useState(false);
  // 설치 플러그인 목록 — 설정과 별개의 요청이라 실패해도 편집을 막지 않는다.
  const [plugins, setPlugins] = useState([]);
  const [pluginsError, setPluginsError] = useState(null);
  const [pluginsLoading, setPluginsLoading] = useState(true);

  // 요청 세대 — 닫혔다 다시 열리거나 "다시 불러오기"를 누른 뒤 늦게 도착한 응답이
  // 현재 편집 내용을 덮어쓰지 못하게 한다.
  const genRef = useRef(0);
  const pluginGenRef = useRef(0);
  const aliveRef = useRef(true);
  // 콜백이 최신 값을 읽되 의존성은 늘리지 않게 하는 미러.
  const textRef = useRef(text);
  const baseRef = useRef(baseline);
  const mtimeRef = useRef(mtimeMs);
  const savingRef = useRef(saving);
  textRef.current = text;
  baseRef.current = baseline;
  mtimeRef.current = mtimeMs;
  savingRef.current = saving;

  // StrictMode(개발)는 마운트 직후 정리→재설정을 한 번 흉내 낸다. 정리에서 false로만
  // 두면 그 뒤의 응답이 전부 폐기돼 "불러오는 중…"에서 멈춘다 — 설정에서 다시 켠다.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    setConflict(false);
    optsRef.current.onLoadStart?.(); // 새로 받은 내용이 진실이다 — 편집 중이던 행은 버린다
    try {
      const n = normalizeConfigResponse(await fetchClaudeConfig());
      if (!aliveRef.current || genRef.current !== gen) return;
      setPath(n.path);
      setText(n.text);
      setBaseline(n.text);
      setMtimeMs(n.mtimeMs);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return;
      setLoadError(String(err.message ?? err));
    } finally {
      if (aliveRef.current && genRef.current === gen) setLoading(false);
    }
  }, []);

  const loadPlugins = useCallback(async () => {
    const gen = ++pluginGenRef.current;
    setPluginsLoading(true);
    setPluginsError(null);
    try {
      const res = await fetchClaudePlugins();
      if (!aliveRef.current || pluginGenRef.current !== gen) return;
      setPlugins(normalizePluginList(res));
    } catch (err) {
      if (!aliveRef.current || pluginGenRef.current !== gen) return;
      setPluginsError(String(err.message ?? err));
    } finally {
      if (aliveRef.current && pluginGenRef.current === gen) setPluginsLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    load();
    loadPlugins();
  }, [load, loadPlugins]);

  /** 저장하지 않은 편집이 있으면 다시 읽지 않는다 — 사용자의 켬/끔을 조용히 버리지 않게. */
  const reloadIfClean = useCallback(() => {
    if (textRef.current !== baseRef.current) return false;
    reload();
    return true;
  }, [reload]);

  useEffect(() => {
    if (optsRef.current.auto !== false) reload();
  }, [reload]);

  /** 폼 조작의 공통 출구 — 실패(blocked/invalid)는 값을 건드리지 않고 문구로 알린다. */
  const apply = useCallback((result, blockedMessage) => {
    if (result.ok) {
      setText(result.text);
      setError(null);
      // 내용을 고치는 순간 이전 충돌 결과는 더 이상 유효하지 않다
      setConflict(false);
      return true;
    }
    setError(
      result.reason === 'invalid'
        ? 'JSON이 올바르지 않아 폼으로 고칠 수 없습니다 — JSON 탭에서 먼저 고치세요.'
        : blockedMessage ?? '이 항목은 폼으로 다룰 수 없는 형태입니다 — JSON 탭에서 편집하세요.',
    );
    return false;
  }, []);

  /** 원문 직접 편집(JSON 탭 textarea). */
  const editText = useCallback((next) => {
    setText(next);
    setConflict(false);
  }, []);

  /**
   * 저장. **성공하면 true** — 호출측이 자기 모달의 "저장하지 않은 변경" 경고를
   * 이 반환값으로 거둔다(그 확인 상태는 훅이 모른다).
   */
  const save = useCallback(async () => {
    if (savingRef.current || textRef.current === baseRef.current) return false;
    const issue = jsonSyntaxIssue(textRef.current);
    if (issue) {
      setError(issue);
      return false;
    }
    const gen = genRef.current;
    const sent = textRef.current; // 저장 중 편집이 들어와도 기준선은 "보낸 내용"이어야 한다
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const res = await saveClaudeConfig({ content: sent, expectedMtimeMs: mtimeRef.current });
      if (!aliveRef.current || genRef.current !== gen) return false;
      // 새 기준선으로 갈아 끼운다 — 모달을 열어 둔 채 이어서 저장할 수 있게.
      setMtimeMs(res.mtimeMs ?? null);
      setBaseline(sent);
      setConflict(false);
      optsRef.current.notify?.(SAVED_NOTICE);
      return true;
    } catch (err) {
      if (!aliveRef.current || genRef.current !== gen) return false;
      const f = saveFailure(err);
      setConflict(f.conflict);
      setError(f.message);
      return false;
    } finally {
      if (aliveRef.current && genRef.current === gen) setSaving(false);
    }
  }, []);

  return {
    path,
    text,
    baseline,
    mtimeMs,
    dirty: text !== baseline,
    loading,
    loadError,
    saving,
    error,
    conflict,
    plugins,
    pluginsLoading,
    pluginsError,
    load,
    loadPlugins,
    reload,
    reloadIfClean,
    save,
    apply,
    editText,
    setError,
  };
}
