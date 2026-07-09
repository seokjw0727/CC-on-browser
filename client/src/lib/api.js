// REST API 클라이언트 — 모든 요청에 x-auth-token 헤더 (계획서 "WS 프로토콜 > REST" 절).
import { getToken } from './store.jsx';

async function get(path) {
  const res = await fetch(path, { headers: { 'x-auth-token': getToken() } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* JSON 아님 — 상태 코드로 대체 */
    }
    throw new Error(message);
  }
  return res.json();
}

/** @returns {Promise<{claudeVersion, defaultCwd, port}>} */
export const fetchBootstrap = () => get('/api/bootstrap');

/** @returns {Promise<[{dirName, cwd, sessionCount, lastModified}]>} */
export const fetchProjects = () => get('/api/projects');

/** @returns {Promise<[{sessionId, title, mtime, fileSize}]>} */
export const fetchSessions = (dirName) =>
  get(`/api/sessions?dir=${encodeURIComponent(dirName)}`);

/** @returns {Promise<{messages: object[]}>} */
export const fetchTranscript = (dirName, sessionId) =>
  get(
    `/api/transcript?dir=${encodeURIComponent(dirName)}&sessionId=${encodeURIComponent(sessionId)}`,
  );

/** @returns {Promise<{path, parent, dirs: string[]}>} 빈 문자열이면 드라이브 목록 */
export const browseDirs = (absPath = '') =>
  get(`/api/browse?path=${encodeURIComponent(absPath)}`);

/**
 * @returns {Promise<{now, fiveHour, sevenDay, quota}>}
 * 로컬 트랜스크립트 집계(5h/7d) + 계정 공식 사용률 quota({fiveHour,sevenDay} — 실패 시 null)
 */
export const fetchUsage = () => get('/api/usage');
