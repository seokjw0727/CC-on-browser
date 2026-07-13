// history.js — ~/.claude/projects 세션 히스토리 조회 (projectsRoot 주입 가능)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CWD_SCAN_BYTES = 64 * 1024;
const TITLE_SCAN_BYTES = 256 * 1024;
const TITLE_MAX_LENGTH = 80;

function assertSafeName(value, label) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
}

async function readHead(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function* parsedLines(text) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // 불완전/비JSON 라인은 무시 (head 절단 포함)
    }
  }
}

function extractCwd(head) {
  for (const obj of parsedLines(head)) {
    if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
  }
  return null;
}

function extractTitle(head) {
  for (const obj of parsedLines(head)) {
    if (obj.type !== 'user' || obj.isMeta) continue;
    const content = obj.message?.content;
    let text = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const item = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
      if (item) text = item.text;
    }
    if (!text) continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<')) continue; // 커맨드 래퍼 등 스킵
    return trimmed.replace(/\s+/g, ' ').slice(0, TITLE_MAX_LENGTH);
  }
  return '';
}

async function listSessionFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.stat(path.join(dirPath, entry.name));
      files.push({ name: entry.name, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      // 스캔 중 삭제된 파일 등은 무시
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

export async function listProjects(projectsRoot = DEFAULT_PROJECTS_ROOT) {
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, entry.name);
    let sessionFiles;
    try {
      sessionFiles = await listSessionFiles(dirPath);
    } catch {
      continue; // 접근 불가 디렉터리는 목록에서 제외
    }
    let cwd = null;
    let lastModified = 0;
    if (sessionFiles.length > 0) {
      lastModified = sessionFiles[0].mtime;
      const head = await readHead(path.join(dirPath, sessionFiles[0].name), CWD_SCAN_BYTES).catch(() => '');
      cwd = extractCwd(head);
    } else {
      const stat = await fs.stat(dirPath).catch(() => null);
      lastModified = stat ? stat.mtimeMs : 0;
    }
    projects.push({
      dirName: entry.name,
      cwd,
      sessionCount: sessionFiles.length,
      lastModified,
    });
  }
  projects.sort((a, b) => b.lastModified - a.lastModified);
  return projects;
}

// 모든 프로젝트 디렉터리의 세션을 모아 mtime 내림차순 상위 N개를 반환한다(새 세션 모달의
// "최근 세션" 목록용). 상위 N개에 대해서만 head를 읽어 cwd/title을 추출한다(비용 절감).
export async function listRecentSessions(projectsRoot = DEFAULT_PROJECTS_ROOT, limit = 12) {
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const all = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, entry.name);
    let files;
    try {
      files = await listSessionFiles(dirPath);
    } catch {
      continue; // 접근 불가 디렉터리는 제외
    }
    for (const file of files) all.push({ dirName: entry.name, dirPath, file });
  }
  all.sort((a, b) => b.file.mtime - a.file.mtime);
  const sessions = [];
  for (const item of all.slice(0, limit)) {
    const head = await readHead(path.join(item.dirPath, item.file.name), TITLE_SCAN_BYTES).catch(() => '');
    sessions.push({
      dirName: item.dirName,
      cwd: extractCwd(head),
      sessionId: item.file.name.slice(0, -'.jsonl'.length),
      title: extractTitle(head),
      mtime: item.file.mtime,
    });
  }
  return sessions;
}

export async function listSessions(projectsRoot, dirName) {
  assertSafeName(dirName, 'dirName');
  const root = projectsRoot ?? DEFAULT_PROJECTS_ROOT;
  const dirPath = path.join(root, dirName);
  let sessionFiles;
  try {
    sessionFiles = await listSessionFiles(dirPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const sessions = [];
  for (const file of sessionFiles) {
    const head = await readHead(path.join(dirPath, file.name), TITLE_SCAN_BYTES).catch(() => '');
    sessions.push({
      sessionId: file.name.slice(0, -'.jsonl'.length),
      title: extractTitle(head),
      mtime: file.mtime,
      fileSize: file.size,
    });
  }
  return sessions;
}

export async function loadTranscript(projectsRoot, dirName, sessionId) {
  assertSafeName(dirName, 'dirName');
  assertSafeName(sessionId, 'sessionId');
  const root = projectsRoot ?? DEFAULT_PROJECTS_ROOT;
  const filePath = path.join(root, dirName, `${sessionId}.jsonl`);
  const text = await fs.readFile(filePath, 'utf8');
  const messages = [];
  let sawInit = false;
  for (const obj of parsedLines(text)) {
    if (obj.type === 'assistant' || obj.type === 'user' || obj.type === 'result') {
      messages.push(obj);
    } else if (obj.type === 'system' && obj.subtype === 'init' && !sawInit) {
      sawInit = true;
      messages.push(obj);
    }
  }
  return { messages };
}
