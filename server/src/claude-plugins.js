// claude-plugins.js — 설치된 Claude Code 플러그인 목록 **읽기 전용** 조회.
//
// 설정 편집기의 "플러그인" 탭이 쓸 재료다. 이 모듈은 절대 쓰지 않는다 —
// 켬/끔은 settings.json의 enabledPlugins이고, 그 저장은 claude-config.js가 맡는다.
// 설치·제거·업데이트는 `claude plugin` CLI의 몫이라 여기서는 다루지 않는다.
//
// 읽는 파일은 하나뿐이다: ~/.claude/plugins/installed_plugins.json (v2)
//   { "version": 2, "plugins": { "<name>@<marketplace>": [ {scope, projectPath,
//     installPath, version, installedAt, lastUpdated, gitCommitSha}, ... ] } }
// known_marketplaces.json은 읽지 않는다 — 마켓플레이스 이름은 이미 키 안에 있고,
// 그 파일까지 필수로 만들면 표시할 것도 없이 실패 지점만 하나 늘어난다.
//
// 규칙:
//  · 파일이 없으면 빈 목록이다(플러그인을 한 번도 설치하지 않은 사용자가 정상 상태).
//  · 손상된 JSON·모르는 스키마 버전은 EINVALIDPLUGINS로 **구분해서** 알린다 —
//    조용히 빈 목록으로 뭉개면 사용자는 "플러그인이 없다"고 오해한다.
//  · 키(`name@marketplace`)는 **불투명 식별자**다. 설정에 쓸 때는 절대 재조립하지
//    않고 그대로 쓰며, 표시용 분리만 마지막 '@'에서 한다(스코프드 이름 대비).
//  · 한 키에 설치 레코드가 여럿일 수 있다(user/project/local, 프로젝트별로 여러 개).
//    합치지 않고 installs[] 그대로 넘긴다 — 스코프마다 버전이 다를 수 있고, 어느
//    하나를 "대표"로 고르면 나머지가 화면에서 사라진다.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 기본 대상 — 사용자 전역 플러그인 디렉터리. */
export function defaultPluginsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'plugins');
}

// 우리가 읽는 방법을 아는 스키마 버전. 미래 버전을 아는 척 파싱하면 엉뚱한 목록을
// 보여 주게 되므로, 모르면 모른다고 한다.
const SUPPORTED_VERSION = 2;

function invalidError(message) {
  const err = new Error(message);
  err.code = 'EINVALIDPLUGINS';
  return err;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 표시용 분리 — 마지막 '@'가 마켓플레이스 구분자다(@scope/name@market 대비). */
export function splitPluginKey(key) {
  const at = key.lastIndexOf('@');
  // 맨 앞의 '@'는 스코프드 이름의 시작이지 구분자가 아니다.
  if (at <= 0) return { name: key, marketplace: '' };
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

// 설치 레코드 하나 — 화면에 쓰는 필드만 문자열로 정규화한다(installPath·gitCommitSha는
// 내보내지 않는다: 로컬 경로·커밋 해시를 브라우저까지 흘릴 이유가 없다).
// 객체가 아닌 항목은 조용히 버리지 않는다 — 스키마 위반은 알려야 한다(아래 참조).
function toInstall(raw) {
  if (!isPlainObject(raw)) throw invalidError('installed_plugins.json has a non-object install record');
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    scope: str(raw.scope),
    projectPath: str(raw.projectPath),
    version: str(raw.version),
    lastUpdated: str(raw.lastUpdated),
  };
}

/**
 * 설치된 플러그인 목록.
 * @returns {Promise<{path: string, exists: boolean, plugins: Array<{
 *   key: string, name: string, marketplace: string,
 *   installs: Array<{scope, projectPath, version, lastUpdated}>
 * }>}>}
 * @throws code=EINVALIDPLUGINS(손상 JSON·모르는 버전·형식 불일치)
 */
export async function listInstalledPlugins(pluginsDir = defaultPluginsDir()) {
  const file = path.join(pluginsDir, 'installed_plugins.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    // 없음은 정상이다. 그 외(권한·IO)는 그대로 올려 보내 라우트가 500으로 분류한다.
    if (err?.code === 'ENOENT') return { path: file, exists: false, plugins: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalidError(`invalid JSON in installed_plugins.json: ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw invalidError('installed_plugins.json must contain a JSON object');
  if (parsed.version !== SUPPORTED_VERSION) {
    throw invalidError(`unsupported installed_plugins.json version: ${JSON.stringify(parsed.version)}`);
  }
  if (!isPlainObject(parsed.plugins)) throw invalidError('installed_plugins.json has no plugins object');

  // 키 순서는 파일 그대로 두지 않고 이름 기준으로 정렬한다 — 목록이 매번 같은
  // 순서로 보여야 토글을 누르는 자리가 흔들리지 않는다.
  const plugins = Object.entries(parsed.plugins).map(([key, value]) => {
    // v2에서 값은 반드시 설치 레코드 배열이다. 다른 모양이면 우리가 아는 스키마가
    // 아니므로 빈 목록으로 뭉개지 않고 알린다 — 조용히 버리면 사용자는 목록에서
    // 사라진 플러그인을 "제거됐다"고 오해한다. 목록 조회가 실패해도 플러그인 탭은
    // enabledPlugins만으로 계속 동작한다(설계도 §3).
    if (!Array.isArray(value)) {
      throw invalidError(`installed_plugins.json entry is not an array: ${key}`);
    }
    const { name, marketplace } = splitPluginKey(key);
    return { key, name, marketplace, installs: value.map(toInstall) };
  });
  plugins.sort((a, b) => a.key.localeCompare(b.key));
  return { path: file, exists: true, plugins };
}
