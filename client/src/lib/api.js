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
 * 유일한 소비처는 새 세션 모달의 "지난 세션" 목록으로, 20(기본)/50("더 보기")을
 * 명시 전달한다. limit 생략 시 서버 기본 12.
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
 * 결과물 미리보기 티켓 발급 — 반환된 url은 인증 없이 열 수 있는 단명 capability라
 * iframe/img에 그대로 실을 수 있다(메인 토큰은 URL에 절대 싣지 않는다).
 * 실패 시 err.status: 403(세션 작업 디렉터리 밖) / 404(없는 파일·세션 아님) /
 * 415(정규 파일 아님).
 * @returns {Promise<{ticket: string, url: string, name: string}>}
 */
export const fetchPreviewTicket = (key, absPath) =>
  get(`/api/preview-ticket?key=${encodeURIComponent(key)}&path=${encodeURIComponent(absPath)}`);

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

/**
 * Claude Code 사용자 설정(~/.claude/settings.json) 원문 로드 — 설정 → Config 편집기.
 * 파일이 없으면 exists=false, content는 '{}' 기준선.
 * @returns {Promise<{exists: boolean, content: string, mtimeMs: number|null, path: string}>}
 */
export const fetchClaudeConfig = () => get('/api/claude-config');

/**
 * 설정 저장 — expectedMtimeMs는 마지막으로 읽은 시각(없던 파일이면 null).
 * 실패 시 err.status로 구분: 400(잘못된 JSON·형식) / 409(다른 곳에서 수정됨) / 500(파일 오류).
 * @returns {Promise<{ok: true, mtimeMs: number}>} 새 기준선 mtime
 */
export const saveClaudeConfig = ({ content, expectedMtimeMs = null }) =>
  request('/api/claude-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, expectedMtimeMs }),
  });

/**
 * 설치된 플러그인 목록(읽기 전용) — Config 편집기의 "플러그인" 탭이 켬/끔 목록을
 * 그릴 때 쓴다. 켬/끔 상태 자체는 settings.json의 enabledPlugins에 있다.
 * 파일이 없으면 exists=false + 빈 목록(정상), 손상 파일은 400.
 * @returns {Promise<{path: string, exists: boolean, plugins: [{
 *   key, name, marketplace, installs: [{scope, projectPath, version, lastUpdated}]
 * }]}>}
 */
export const fetchClaudePlugins = () => get('/api/claude-plugins');

/**
 * OS 클립보드에 담긴 파일들의 절대경로 — 탐색기에서 복사한 파일을 붙여넣을 때 사본이
 * 아니라 원본 경로를 그대로 쓰기 위한 조회다(파일 내용이 아니라 경로 목록만 읽는다).
 * 브라우저 paste에 파일이 실려 있을 때만 호출한다. 스크린샷 비트맵·비Windows는 빈 배열.
 * GET이 아닌 POST인 이유: OS 클립보드를 건드리는 부수효과성 조회라 캐시·프리페치 대상이
 * 되면 안 된다.
 * @returns {Promise<{paths: string[]}>}
 */
export const clipboardFiles = () => request('/api/clipboard-files', { method: 'POST' });

/**
 * 디스크에 원본이 없는 붙여넣기(스크린샷 등)를 서버 임시 폴더에 저장하고 그 절대경로를
 * 돌려받는다. data는 원시 base64 — dataUrlToBase64로 data: URL 헤더를 떼고 넘긴다.
 * 실패 시 err.status: 400(이름·형식) / 413(크기 상한 초과) / 500(저장 실패).
 * @returns {Promise<{path: string}>}
 */
export const uploadPasteFile = (name, data) =>
  request('/api/paste-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
