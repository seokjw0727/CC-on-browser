// usage.js — ~/.claude/projects 트랜스크립트 로컬 집계 (최근 5시간/7일 토큰 사용량).
// Anthropic 공식 쿼터 수치가 아니라 로컬 세션 기록(assistant 엔트리의 message.usage)
// 합산이다. resume 시 이전 대화가 새 세션 파일에 복제될 수 있으므로
// requestId+message.id 쌍으로 중복을 제거한다.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    entries: 0,
  };
}

function addUsage(bucket, usage) {
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  bucket.inputTokens += inTok;
  bucket.outputTokens += outTok;
  bucket.cacheReadTokens += cacheRead;
  bucket.cacheCreationTokens += cacheCreate;
  bucket.totalTokens += inTok + outTok + cacheRead + cacheCreate;
  bucket.entries += 1;
}

export async function aggregateUsage(projectsRoot = DEFAULT_PROJECTS_ROOT, now = Date.now()) {
  const fiveHour = emptyBucket();
  const sevenDay = emptyBucket();
  const seen = new Set();

  let projectDirs;
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { now, fiveHour, sevenDay };
    throw err;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, dirEntry.name);
    let files;
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue; // 접근 불가 디렉터리는 집계에서 제외
    }
    for (const fileEntry of files) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, fileEntry.name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > SEVEN_DAYS_MS) continue; // 7일 밖 파일은 열지 않는다
      let text;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const rawLine of text.split('\n')) {
        if (!rawLine || !rawLine.includes('"usage"')) continue; // 파싱 전 사전 필터
        let obj;
        try {
          obj = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (obj?.type !== 'assistant') continue;
        const usage = obj.message?.usage;
        if (!usage || typeof usage !== 'object') continue;
        const ts = Date.parse(obj.timestamp ?? '');
        if (!Number.isFinite(ts) || ts > now) continue;
        const age = now - ts;
        if (age > SEVEN_DAYS_MS) continue;
        if (obj.requestId && obj.message?.id) {
          const key = `${obj.requestId}|${obj.message.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        addUsage(sevenDay, usage);
        if (age <= FIVE_HOURS_MS) addUsage(fiveHour, usage);
      }
    }
  }
  return { now, fiveHour, sevenDay };
}
