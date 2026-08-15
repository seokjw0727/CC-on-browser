// claude-settings-form.js — settings.json **원문 텍스트**와 폼 컨트롤 사이의 유일한 변환기.
//
// 왜 원문이 단일 소스인가:
//   Config 편집기는 탭이 셋(일반 폼 / 플러그인 / JSON 원문)인데, 각 탭이 자기만의
//   상태를 들고 있으면 "폼에서 고친 뒤 JSON 탭으로 가면 사라지는" 종류의 버그가
//   구조적으로 생긴다. 그래서 화면 상태는 원문 문자열 하나뿐이고, 폼 조작은
//   전부 "현재 원문을 파싱 → 해당 leaf만 바꿈 → 다시 직렬화"로 처리한다.
//
// 보존 규칙:
//  · 폼이 모르는 키(hooks·statusLine·extraKnownMarketplaces …)는 손대지 않는다.
//  · 중첩 필드는 leaf만 바꾼다 — permissions.defaultMode를 지워도 permissions.allow는 남는다.
//  · 경로 중간이 객체가 아니면(예: "permissions": "x") 덮어쓰지 않고 거부한다.
//    남의 데이터를 폼이 조용히 날리는 것보다, 그 필드만 JSON 탭으로 미루는 편이 낫다.
//  · UNSET은 false·빈 문자열과 다르다 — 키 자체를 지운다(= "설정 안 함").
//
// 한계(수용하는 경계): JSON.parse→stringify 왕복이므로 들여쓰기·줄바꿈 스타일은
// 2-space로 정규화되고, 2⁵³을 넘는 정수 정밀도·중복 키·-0은 보존되지 않는다.
// settings.json의 실제 값 범위에서는 나타나지 않는 극단이고, 원문 그대로 저장하고
// 싶으면 JSON 탭만 쓰면 된다.
import { PERMISSION_MODES } from './permission-modes.js';

/** "이 키를 지운다"를 나타내는 sentinel — null·false·''와 구분된다. */
export const UNSET = Symbol('unset');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 키를 대입이 아니라 **정의**로 넣는다. `obj.__proto__ = v`는 프로퍼티를 만들지 않고
// 프로토타입 설정자를 부르기 때문에, 그런 이름의 env 변수·플러그인 키가 조용히
// 사라진다(저장은 성공하는데 값만 없다). 키는 불투명 식별자라는 약속을 지키려면
// 이름이 무엇이든 그대로 자기 자리에 들어가야 한다.
const defineKey = (obj, key, value) => {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
};

/**
 * 원문 → {ok, value} | {ok:false, error} — 최상위 일반 객체까지 요구한다.
 * 빈 문자열도 통과시키지 않는다: 서버(claude-config.js)가 JSON 문법 오류로 거부하는
 * 입력을 폼에서만 열어 주면, 편집은 되는데 저장은 안 되는 상태가 된다.
 */
export function parseSettings(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON 문법 오류: ${err.message}` };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: 'settings.json의 최상위는 객체({ … })여야 합니다.' };
  }
  return { ok: true, value };
}

/** 폼 탭을 열 수 있는가 — 서버의 저장 조건(유효 JSON + 최상위 객체)과 같은 기준. */
export function formReady(text) {
  return parseSettings(text).ok;
}

/** 객체 → 원문. 2-space 들여쓰기 + 끝 개행(사람이 여는 파일이고 git diff도 깔끔하다). */
export function serializeSettings(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 경로(['permissions','defaultMode'])의 현재 값.
 * @returns {{ok: true, value: any}|{ok: false, reason: 'invalid'|'blocked'}}
 *   blocked = 경로 중간이 객체가 아니라 폼으로 다룰 수 없음(JSON 탭에서 편집).
 */
export function readField(text, path) {
  const parsed = parseSettings(text);
  if (!parsed.ok) return { ok: false, reason: 'invalid' };
  let node = parsed.value;
  for (let i = 0; i < path.length - 1; i += 1) {
    const next = node[path[i]];
    if (next === undefined) return { ok: true, value: undefined }; // 아직 없음 = 설정 안 함
    if (!isPlainObject(next)) return { ok: false, reason: 'blocked' };
    node = next;
  }
  return { ok: true, value: node[path[path.length - 1]] };
}

/**
 * 경로의 leaf만 바꾼(또는 지운) 새 원문.
 * 바꿀 것이 없으면(이미 없는 키를 지우려는 경우) 원문을 **그대로** 돌려준다 —
 * 아무것도 안 바꾸면서 파일 전체를 재포맷하지 않기 위해서다.
 * @param {any|typeof UNSET} value UNSET이면 키를 지운다.
 * @returns {{ok: true, text: string}|{ok: false, reason: 'invalid'|'blocked'}}
 */
export function patchField(text, path, value) {
  const parsed = parseSettings(text);
  if (!parsed.ok) return { ok: false, reason: 'invalid' };
  // 최상위부터 leaf 직전까지 필요한 만큼만 얕은 복사 — 나머지 가지는 그대로 공유한다.
  const root = { ...parsed.value };
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = node[key];
    if (next === undefined) {
      // 지우려는데 부모가 아예 없다 — 이미 원하는 상태다(빈 객체를 새로 만들지 않는다).
      if (value === UNSET) return { ok: true, text };
      defineKey(node, key, {});
    } else if (isPlainObject(next)) {
      defineKey(node, key, { ...next });
    } else {
      return { ok: false, reason: 'blocked' };
    }
    node = node[key];
  }
  const leaf = path[path.length - 1];
  if (value === UNSET) {
    // 없는 키를 지우는 건 아무 일도 아니다 — 원문을 그대로 둔다. 이 조기 반환이
    // 없으면 "원래부터 비어 있던 부모"까지 아래 정리에 휩쓸려 사라진다.
    if (!Object.prototype.hasOwnProperty.call(node, leaf)) return { ok: true, text };
    delete node[leaf];
    // 방금 우리가 비운 껍데기만 함께 정리한다 — 폼을 만졌다는 이유로
    // "permissions": {} 같은 흔적이 파일에 쌓이지 않게.
    if (path.length > 1) pruneEmptyParents(root, path);
  } else {
    defineKey(node, leaf, value);
  }
  return { ok: true, text: serializeSettings(root) };
}

// path의 부모들을 뒤에서부터 훑어 "우리가 방금 비운" 빈 객체만 지운다.
// (호출 시점에 leaf 삭제가 실제로 일어났음이 보장된다 — 위 hasOwnProperty 관문 참조.)
function pruneEmptyParents(root, path) {
  const chain = [root];
  for (let i = 0; i < path.length - 1; i += 1) {
    const next = chain[chain.length - 1][path[i]];
    if (!isPlainObject(next)) return;
    chain.push(next);
  }
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    if (Object.keys(chain[i]).length > 0) return;
    delete chain[i - 1][path[i - 1]];
  }
}

// ----- 폼에 노출하는 필드 목록 -----
//
// 여기 없는 키는 폼이 건드리지 않는다(값도 순서도 그대로 남는다). 새 필드를 늘릴
// 자리는 여기 한 곳이며, UI는 이 표를 그대로 훑어 그린다.
//
// kind: 'text' | 'select' | 'boolean'(3-way: 기본값/켬/끔)
// hint: 필드 아래에 붙는 회색 설명. 이 앱이 스폰 인자로 덮어쓰는 값은 그 사실을 적는다.
export const KNOWN_FIELDS = [
  {
    id: 'model',
    path: ['model'],
    kind: 'text',
    label: '모델',
    placeholder: '예: sonnet, opus, claude-sonnet-5',
    hint: 'CLI가 세션을 시작할 때 쓰는 기본 모델입니다. 이 앱에서 새 세션을 시작할 때는 새 세션 모달에서 고른 모델이 이 값을 덮습니다(모달에서 "(기본 모델)"을 고르면 이 값이 쓰입니다). 비우면 항목을 지웁니다.',
  },
  {
    id: 'permissionsDefaultMode',
    path: ['permissions', 'defaultMode'],
    kind: 'select',
    label: '기본 권한 모드',
    options: PERMISSION_MODES,
    hint: '이 앱은 세션을 시작할 때 항상 권한 모드를 함께 넘기므로, 이 값은 CLI를 직접 실행할 때 적용됩니다. permissions의 allow·deny 등 다른 항목은 건드리지 않습니다.',
  },
  {
    id: 'effortLevel',
    path: ['effortLevel'],
    kind: 'select',
    label: '기본 사고 강도 (effort)',
    options: [
      { value: 'low', label: 'low — 빠르게' },
      { value: 'medium', label: 'medium — 보통' },
      { value: 'high', label: 'high — 깊게' },
    ],
  },
  {
    id: 'autoUpdatesChannel',
    path: ['autoUpdatesChannel'],
    kind: 'select',
    label: '자동 업데이트 채널',
    options: [
      { value: 'stable', label: 'stable — 안정판' },
      { value: 'latest', label: 'latest — 최신판' },
    ],
  },
  {
    id: 'includeCoAuthoredBy',
    path: ['includeCoAuthoredBy'],
    kind: 'boolean',
    label: '커밋에 Co-Authored-By 넣기',
  },
  {
    id: 'skipDangerousModePermissionPrompt',
    path: ['skipDangerousModePermissionPrompt'],
    kind: 'boolean',
    label: '신뢰모드 진입 확인 건너뛰기',
    hint: '⚠ 켜면 확인 없이 전부 실행하는 모드로 바로 들어갑니다.',
  },
  {
    id: 'inputNeededNotifEnabled',
    path: ['inputNeededNotifEnabled'],
    kind: 'boolean',
    label: '입력이 필요할 때 알림',
  },
  {
    id: 'agentPushNotifEnabled',
    path: ['agentPushNotifEnabled'],
    kind: 'boolean',
    label: '에이전트 작업 완료 알림',
  },
];

// 폼이 소유한 최상위 키 — "그 외 항목"(읽기 전용 안내) 목록을 만들 때 뺀다.
// env·enabledPlugins는 전용 UI가 따로 있으므로 여기 포함한다.
export const FORM_OWNED_TOP_KEYS = new Set([
  ...KNOWN_FIELDS.map((f) => f.path[0]),
  'env',
  'enabledPlugins',
]);

/**
 * select가 실제로 보여 줄 선택지 — 파일에 우리가 모르는 값이 들어 있으면
 * 그 값을 옵션으로 덧붙인다. 모른다고 조용히 다른 값으로 바꿔 저장하면
 * 사용자의 설정을 폼이 훔치는 셈이다.
 */
export function optionsWithCurrent(options, current) {
  if (typeof current !== 'string') return options;
  if (options.some((o) => o.value === current)) return options;
  // 빈 문자열도 "설정 안 함"과 엄연히 다른 값이다 — 옵션으로 보이게 해서,
  // 사용자가 고르지 않는 한 파일에 그대로 남게 한다.
  const label = current === '' ? '(빈 문자열) — 현재 값' : `${current} (현재 값)`;
  return [...options, { value: current, label }];
}

// select에서 "(설정 안 함)"이 쓸 값. 빈 문자열을 쓰면 `"effortLevel": ""`처럼 실제로
// 빈 문자열이 들어 있는 파일과 구분되지 않는다(고르지도 않았는데 키가 지워진다).
export const UNSET_OPTION = ' unset';

/** 폼이 다루지 않는 최상위 키들 — "JSON 탭에서 편집" 안내용. */
export function unknownTopKeys(text) {
  const parsed = parseSettings(text);
  if (!parsed.ok) return [];
  return Object.keys(parsed.value).filter((k) => !FORM_OWNED_TOP_KEYS.has(k)).sort();
}

// ----- env (문자열 key-value) -----

/**
 * env를 폼 행으로. 값이 문자열이 아닌 항목이 하나라도 있으면 폼으로 다룰 수 없다
 * (저장하면 타입이 바뀐다) — blocked로 알리고 JSON 탭으로 미룬다.
 * @returns {{ok: true, rows: Array<{key: string, value: string}>}|{ok:false, reason}}
 */
export function readEnvRows(text) {
  const field = readField(text, ['env']);
  if (!field.ok) return field;
  const env = field.value;
  if (env === undefined) return { ok: true, rows: [] };
  if (!isPlainObject(env)) return { ok: false, reason: 'blocked' };
  const rows = Object.entries(env).map(([key, value]) => ({ key, value }));
  if (rows.some((r) => typeof r.value !== 'string')) return { ok: false, reason: 'blocked' };
  return { ok: true, rows };
}

/**
 * 편집 중인 행들의 검증 — 화면이 저장을 막을 근거이자, 커밋 가능 여부 판정.
 * 빈 키·중복 키는 객체로 왕복할 수 없다(하나로 뭉개지거나 사라진다).
 * @returns {string|null} 오류 문구(없으면 null)
 */
export function validateEnvRows(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = String(row.key ?? '');
    // 이름은 손대지 않고 그대로 쓴다(trim 금지) — 값만 고쳤는데 " A "가 "A"로
    // 조용히 바뀌면, 보존하겠다고 한 남의 키를 폼이 이름부터 갈아 치우는 셈이다.
    // 다만 공백뿐인 이름은 실수가 확실하므로 막는다.
    if (!key.trim()) return '환경 변수 이름이 비어 있는 줄이 있습니다.';
    if (seen.has(key)) return `환경 변수 이름이 중복됩니다: ${key}`;
    // 값은 문자열만 — CLI가 읽는 env는 문자열 맵이고, 숫자가 섞이면 폼이 타입을
    // 바꿔 저장하는 셈이 된다(읽기에서 blocked로 막는 것과 같은 이유).
    if (typeof row.value !== 'string') return `환경 변수 값은 문자열이어야 합니다: ${key}`;
    seen.add(key);
  }
  return null;
}

/**
 * 행들을 원문에 반영. 행이 하나도 없으면 env 키 자체를 지운다.
 * 검증을 통과하지 못한 행 집합은 커밋하지 않는다(호출측이 먼저 validate).
 */
export function patchEnvRows(text, rows) {
  if (validateEnvRows(rows)) return { ok: false, reason: 'invalid' };
  if (rows.length === 0) return patchField(text, ['env'], UNSET);
  const env = {};
  for (const row of rows) defineKey(env, row.key, row.value);
  return patchField(text, ['env'], env);
}

// ----- enabledPlugins -----

/**
 * 설정에 기록된 플러그인 켬/끔.
 * @returns {{ok: true, map: Record<string, boolean>}|{ok: false, reason}}
 *   값이 boolean이 아닌 항목이 있으면 blocked — 토글로 뭉개지 않는다.
 */
export function readEnabledPlugins(text) {
  const field = readField(text, ['enabledPlugins']);
  if (!field.ok) return field;
  const value = field.value;
  if (value === undefined) return { ok: true, map: {} };
  if (!isPlainObject(value)) return { ok: false, reason: 'blocked' };
  if (Object.values(value).some((v) => typeof v !== 'boolean')) {
    return { ok: false, reason: 'blocked' };
  }
  return { ok: true, map: { ...value } };
}

/** 켬/끔 설정 — key는 불투명 식별자("name@marketplace")라 그대로 쓴다. */
export function setPluginEnabled(text, key, enabled) {
  return patchField(text, ['enabledPlugins', key], !!enabled);
}

/** 항목 제거 — false로 두는 것("끔")과 다르다. 설정에서 아예 사라진다. */
export function removePluginEntry(text, key) {
  return patchField(text, ['enabledPlugins', key], UNSET);
}
