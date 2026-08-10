// 세션 산출물(미리보기 대상) 파생 — 대화 메시지에서 "Claude가 실제로 쓴 파일"을 뽑는다.
//
// 별도 상태로 쌓지 않고 messages에서 파생하는 이유: 재개(트랜스크립트 preload)와
// effort 재시작이 messages를 통째로 이월하므로, 파생이면 목록이 저절로 따라오고
// 두 벌의 진실이 생기지 않는다. 리듀서에 새 필드를 얹으면 그 모든 이월 경로마다
// 시딩을 배선해야 하고 하나라도 빠지면 목록이 조용히 비게 된다.
//
// 자동 감지 범위는 구조화된 파일 쓰기 도구뿐이다 — Bash 등으로 만든 파일은 잡히지
// 않는다(설계도 §1 "제외" 참조).
import { previewRank } from './preview-kind.js';

// 도구 이름 → 경로가 실린 입력 필드. NotebookEdit만 notebook_path를 쓴다.
const PATH_FIELD_BY_TOOL = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** 미리보기를 지원하는 도구인가 — ToolCard가 버튼 노출을 판단할 때도 쓴다. */
export function previewPathOf(item) {
  if (!item || item.kind !== 'tool_use') return null;
  const field = PATH_FIELD_BY_TOOL[item.name];
  if (!field) return null;
  const raw = item.input?.[field];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  // 성공한 결과가 있는 카드만 — 실행 전(권한 대기)·실패한 쓰기는 열 파일이 없다.
  if (!item.result || item.result.isError) return null;
  return raw;
}

/** 중복 판정용 키. 표시·서버 요청에는 절대 쓰지 않는다(원본 철자를 보존해야 한다). */
export function pathKey(p, { caseInsensitive = false } = {}) {
  const unified = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? unified.toLowerCase() : unified;
}

/** 경로에서 파일명만. 표시용(구분자 혼용 대비). */
export function baseName(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * 대화 메시지에서 산출물 목록을 만든다. 최신 수정이 앞에 온다.
 *
 * @param {object[]} messages 세션 messages
 * @param {{caseInsensitive?: boolean}} [opts] win32면 caseInsensitive=true — 같은 파일을
 *   다른 대소문자로 쓴 두 도구 호출이 두 항목으로 갈라지지 않게 한다. 플랫폼 판정을
 *   인자로 받는 이유: 이 모듈은 순수 함수로 두고 window/bootstrap을 읽지 않기 위함.
 * @returns {Array<{path: string, name: string, key: string, uid: string|null, index: number}>}
 *   path=최신 원본 철자, uid=마지막으로 이 파일을 쓴 메시지 uid(자동 새로고침 트리거).
 */
export function artifactsOf(messages, { caseInsensitive = false } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const byKey = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    const p = previewPathOf(item);
    if (!p) continue;
    const key = pathKey(p, { caseInsensitive });
    // 같은 파일을 여러 번 썼으면 마지막 것이 이긴다 — 철자·uid 모두 최신으로.
    byKey.set(key, { path: p, name: baseName(p), key, uid: item.uid ?? null, index: i });
  }
  // 최신 수정 순(뒤에 쓰인 것이 위)
  return [...byKey.values()].sort((a, b) => b.index - a.index);
}

/** 목록에서 경로로 항목 찾기 — 선택 유지·자동 새로고침 판정에 쓴다. */
export function findArtifact(list, targetPath, { caseInsensitive = false } = {}) {
  if (!targetPath) return null;
  const key = pathKey(targetPath, { caseInsensitive });
  return (list ?? []).find((a) => a.key === key) ?? null;
}

// 사용자 턴의 시작을 알리는 메시지 종류 — 마지막 사용자 발화 이후가 "이번 턴"이다.
// 'cleared'는 /clear의 전용 구분선(커맨드 칩과 같은 자리의 사용자 행위).
const TURN_BOUNDARY_KINDS = new Set(['user-text', 'command', 'cleared']);

/**
 * 턴이 성공적으로 끝났을 때 자동으로 열 산출물 경로 — 없으면 null(호출측은 상태를
 * 그대로 둔다). 목록(artifactsOf)이 아니라 **이번 턴에 새로 쓴 것**만 본다.
 *
 * 판정 순서:
 *   ① 경계 = 마지막 비-preload 사용자 턴 메시지. 없으면 null — 재개 직후 도착한
 *      뜬금없는 result가 옛 히스토리의 파일을 열어 버리는 것을 막는다.
 *   ② 경계 이후의 성공한 쓰기만 후보. preload 항목은 제외(디스크 히스토리는 지금
 *      막 만든 결과물이 아니다).
 *   ③ 지금 열려서 보고 있는 파일(openPath)이 후보에 있으면 그대로 둔다 — 사용자의
 *      선택을 뺏지 않는다(재수정 반영은 기존 자동 새로고침이 맡는다).
 *   ④ 아니면 주 산출물: previewKind 우선순위(html > md > 이미지·pdf > 텍스트 > 기타),
 *      동순위는 마지막에 쓴 것.
 *
 * @param {object[]} messages 세션 messages
 * @param {{openPath?: string|null}} [opts] openPath는 **패널이 실제로 열려 있을 때만**
 *   넘긴다 — 닫힌 패널에 남아 있는 마지막 선택이 주 산출물 판정을 가로채면 안 된다.
 * @returns {string|null} 원본 철자의 절대경로
 */
export function autoPreviewPath(messages, { openPath = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && !m.preloaded && TURN_BOUNDARY_KINDS.has(m.kind)) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return null;

  // 뒤에서 앞으로 훑으므로 먼저 만난 것이 더 최신 — 같은 순위면 이 순서가 그대로
  // "동순위는 최신" 규칙이 된다(별도 정렬 불필요).
  const openKey = openPath ? pathKey(openPath) : null;
  let best = null;
  let bestRank = Infinity;
  for (let i = messages.length - 1; i > boundary; i -= 1) {
    const m = messages[i];
    if (!m || m.preloaded) continue;
    const p = previewPathOf(m);
    if (!p) continue;
    // 보던 파일이 이번 턴에도 쓰였다 → 선택 유지(우선순위보다 먼저 이긴다).
    // 대소문자는 접지 않는다 — Linux에서 A.html과 a.html은 다른 파일이고, win32에서
    // 철자만 바뀐 경우는 "최신 철자로 전환"이 되어 어느 쪽도 해롭지 않다.
    if (openKey && pathKey(p) === openKey) return openPath;
    const rank = previewRank(p);
    if (rank < bestRank) {
      best = p;
      bestRank = rank;
    }
  }
  return best;
}
