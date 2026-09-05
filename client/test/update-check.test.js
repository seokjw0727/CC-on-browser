// update-check 회귀 테스트 — 서버 응답 한 벌을 화면 상태로 환원하는 규칙을 고정한다.
// 판정이 서버가 아니라 여기 있는 이유: 서버는 "무엇을 알아냈는가"(latest/current/error)
// 만 보고하고, "업데이트가 있는가"는 표시 규칙이라 화면 쪽 계약이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  UPDATE_COMMAND,
  compareSemver,
  parseSemver,
  updateMessage,
  updateStatus,
} from '../src/lib/update-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('parseSemver — 세 자리 숫자와 선행 v·공백을 허용한다', () => {
  assert.deepEqual(parseSemver('1.9.5'), { major: 1, minor: 9, patch: 5 });
  assert.deepEqual(parseSemver('v1.9.5'), { major: 1, minor: 9, patch: 5 });
  assert.deepEqual(parseSemver(' 1.9.5 '), { major: 1, minor: 9, patch: 5 });
});

test('parseSemver — 프리릴리스·빌드 접미사는 떼고 본다', () => {
  assert.deepEqual(parseSemver('1.10.0-beta.2'), { major: 1, minor: 10, patch: 0 });
  assert.deepEqual(parseSemver('2.0.0+build.5'), { major: 2, minor: 0, patch: 0 });
});

test('parseSemver — 형식이 아니면 전부 null (비교 포기)', () => {
  for (const bad of [null, undefined, '', 'latest', '1.9', '1.9.x', '1.9.5.1']) {
    assert.equal(parseSemver(bad), null, `${JSON.stringify(bad)}는 비교할 수 없다`);
  }
});

test('compareSemver — 자리마다 수치로 견준다 (문자열 비교면 1.10.0 < 1.9.9가 된다)', () => {
  assert.equal(compareSemver('1.9.9', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
});

test('compareSemver — 동등·앞섬', () => {
  assert.equal(compareSemver('1.9.5', '1.9.5'), 0);
  assert.equal(compareSemver('1.9.5-beta.1', '1.9.5'), 0, '접미사는 무시한다');
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
});

test('compareSemver — 한쪽만 깨져도 null', () => {
  assert.equal(compareSemver('1.9.5', 'latest'), null);
  assert.equal(compareSemver('', '1.9.5'), null);
});

test('updateStatus — 최신이면 current(ahead=false)', () => {
  const r = updateStatus({ current: '1.9.5', latest: '1.9.5' });
  assert.equal(r.state, 'current');
  assert.equal(r.ahead, false);
  const msg = updateMessage(r);
  assert.match(msg, /1\.9\.5/);
  assert.match(msg, /최신/);
});

test('updateStatus — 낮으면 outdated + 안내 명령', () => {
  const r = updateStatus({ current: '1.9.5', latest: '1.10.0' });
  assert.equal(r.state, 'outdated');
  assert.equal(r.command, UPDATE_COMMAND);
  const msg = updateMessage(r);
  assert.match(msg, /1\.10\.0/);
  assert.match(msg, /1\.9\.5/);
});

test('updateStatus — 로컬이 더 앞서면 업데이트를 권하지 않는다 (개발 빌드)', () => {
  const r = updateStatus({ current: '2.0.0', latest: '1.9.5' });
  assert.equal(r.state, 'current', 'outdated가 되면 자기 개발 빌드에 업데이트를 권하게 된다');
  assert.equal(r.ahead, true);
});

test('updateStatus — error가 있으면 latest 유무보다 우선한다', () => {
  const a = updateStatus({ current: '1.9.5', latest: null, error: 'update check failed' });
  assert.equal(a.state, 'unknown');
  assert.equal(a.reason, 'fetch-failed');
  // 서버가 실수로 둘 다 실어 보내도 '실패'가 이긴다 — 화면이 '다시 시도'를 내줘야 한다
  const b = updateStatus({ current: '1.9.5', latest: '9.9.9', error: 'x' });
  assert.equal(b.reason, 'fetch-failed');
});

test('updateStatus — 한쪽 버전을 모르면 missing (구 데몬·번들 정의 없음)', () => {
  assert.equal(updateStatus({ current: null, latest: '1.10.0' }).reason, 'missing');
  assert.equal(updateStatus({ current: '1.9.5', latest: null }).reason, 'missing');
});

test('updateStatus — 형식을 못 읽으면 unparsable', () => {
  const r = updateStatus({ current: '1.9.5', latest: 'latest' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.reason, 'unparsable');
});

test('updateStatus — 문자열이 아닌 값을 방어한다', () => {
  const r = updateStatus({ current: 42, latest: {} });
  assert.equal(r.state, 'unknown');
  assert.equal(r.current, null);
  assert.equal(r.latest, null);
});

test('안내 명령 문구를 고정한다 (바뀌면 여기서 먼저 깨진다)', () => {
  assert.equal(UPDATE_COMMAND, 'npm i -g cc-on-browser@latest');
});

test('updateMessage — 네 갈래가 서로 다르고 undefined/null이 새지 않는다', () => {
  const msgs = [
    updateMessage(updateStatus({ current: '1.9.5', latest: '1.10.0' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: '1.9.5' })),
    updateMessage(updateStatus({ current: '2.0.0', latest: '1.9.5' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: null, error: 'x' })),
    updateMessage(updateStatus({ current: null, latest: '1.9.5' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: 'latest' })),
  ];
  assert.equal(new Set(msgs).size, msgs.length, '문구가 겹치면 사용자가 상태를 구분할 수 없다');
  for (const m of msgs) {
    assert.doesNotMatch(m, /undefined|null|NaN/, m);
  }
});

test('업데이트 확인은 자동으로 나가지 않는다 (배선 가드)', () => {
  // 이 앱에서 사용자 조작 없이 바깥으로 나가는 요청은 하나도 없어야 한다
  // (공식 사용률 조회도 설정에서 켜야 나간다 — server.js의 ?quota=1 관문).
  // UpdateTab에 useEffect 한 줄이 슬쩍 들어오면 설정 모달을 여는 것만으로 외부에
  // 신호가 나가기 시작하므로, 소스 텍스트로 못박는다(app-version.test.js 선례).
  const sidebar = readFileSync(join(__dirname, '..', 'src', 'components', 'Sidebar.jsx'), 'utf8');
  assert.match(sidebar, /fetchUpdateCheck/, '업데이트 탭이 실제로 이 API를 쓴다');
  assert.doesNotMatch(sidebar, /useEffect\([^)]*fetchUpdateCheck/s, 'useEffect 자동 조회 금지');
  const api = readFileSync(join(__dirname, '..', 'src', 'lib', 'api.js'), 'utf8');
  assert.match(api, /'\/api\/update-check'/);
});
