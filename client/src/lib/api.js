// REST API 클라이언트 — 모든 요청에 x-auth-token 헤더 (계획서 "WS 프로토콜 > REST" 절).
import { getToken } from './store.jsx';

async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'x-auth-token': getToken(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* JSON 아님 — 상태 코드로 대체 */
    }
    const err = new Error(message);
    err.status = res.status; // 호출측이 404(이미 삭제)/409(라이브) 등을 구분
    throw err;
  }
  return res.json();
}

const get = (path) => request(path);

/** @returns {Promise<{claudeVersion, defaultCwd, port, platform}>} */
export const fetchBootstrap = () => get('/api/bootstrap');

/**
 * 네이티브 폴더 선택 대화상자를 열고 선택 경로를 반환(Windows 전용).
 * 사용자가 대화상자를 닫을 때까지 응답이 지연된다.
 * @returns {Promise<{path: string|null, canceled: boolean}>}
 */
export const pickDirectory = (initialPath = '') =>
  get(`/api/pick-directory${initialPath ? `?path=${encodeURIComponent(initialPath)}` : ''}`);

/** @returns {Promise<[{dirName, cwd, sessionCount, lastModified}]>} */
export const fetchProjects = () => get('/api/projects');

/** @returns {Promise<[{sessionId, title, mtime, fileSize}]>} */
export const fetchSessions = (dirName) =>
  get(`/api/sessions?dir=${encodeURIComponent(dirName)}`);

/**
 * @returns {Promise<Array<{dirName, cwd, sessionId, title, mtime, fileSize}>>}
 * 전 프로젝트 최근 세션. fileSize = 트랜스크립트 .jsonl 바이트(대화 크기 표시용).
 * limit 생략 시 서버 기본 12(새 세션 모달) — 사이드바 "지난 세션"만 20/50을 명시 전달.
 */
export const fetchRecentSessions = (limit) =>
  get(`/api/recent-sessions${limit ? `?limit=${limit}` : ''}`);

/**
 * 세션 히스토리 파일(.jsonl) 영구 삭제 — 되돌릴 수 없음.
 * 실패 시 err.status로 구분: 404(이미 없음) / 409(라이브 세션이 사용 중).
 */
export const deleteSessionFile = (dirName, sessionId) =>
  request(
    `/api/sessions?dir=${encodeURIComponent(dirName)}&sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );

/** @returns {Promise<{messages: object[]}>} */
export const fetchTranscript = (dirName, sessionId) =>
  get(
    `/api/transcript?dir=${encodeURIComponent(dirName)}&sessionId=${encodeURIComponent(sessionId)}`,
  );

/** @returns {Promise<{path, parent, dirs: string[]}>} 빈 문자열이면 드라이브 목록 */
export const browseDirs = (absPath = '') =>
  get(`/api/browse?path=${encodeURIComponent(absPath)}`);

/**
 * @ 파일 태그 자동완성 — cwd 하위 파일을 질의로 검색해 상대경로 목록을 반환.
 * @returns {Promise<{files: string[]}>}
 */
export const searchFiles = (cwd, q = '') =>
  get(`/api/files?cwd=${encodeURIComponent(cwd)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

/**
 * @returns {Promise<{now, fiveHour, sevenDay, quota}>}
 * 로컬 트랜스크립트 집계(5h/7d) + 계정 공식 사용률 quota({fiveHour,sevenDay} — 실패 시 null)
 */
export const fetchUsage = () => get('/api/usage');

/**
 * 사이드바 "돌아보기" 잔디용 일별 집계 — 섹션이 열릴 때 1회 호출하고
 * 주간/월간 뷰는 클라이언트에서 파생한다(토글 시 재요청 없음).
 * @returns {Promise<{now, days: [{date, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, entries}]}>}
 */
export const fetchDailyUsage = (days = 365) => get(`/api/usage-daily?days=${days}`);
