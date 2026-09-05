// update-check 회귀 테스트 — 서버 응답 한 벌을 화면 상태로 환원하는 규칙을 고정한다.
// 판정이 서버가 아니라 여기 있는 이유: 서버는 "무엇을 알아냈는가"(latest/current/error)
// 만 보고하고, "업데이트가 있는가"는 표시 규칙이라 화면 쪽 계약이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RELEASES_URL,
  compareSemver,
  parseSemver,
  updateCommand,
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

test('updateStatus — 낮으면 outdated + 받는 곳과 안내 명령', () => {
  const r = updateStatus({ current: '1.9.5', latest: '1.10.0' });
  assert.equal(r.state, 'outdated');
  // 명령은 **그 버전의** tarball을 가리켜야 한다 — 고정 문자열이면 사용자가 방금 받은
  // 파일 이름과 어긋나 그대로 붙여 넣을 수 없다.
  assert.equal(r.command, 'npm install -g ./cc-on-browser-1.10.0.tgz');
  assert.equal(r.url, RELEASES_URL);
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

test("updateStatus — 'not published'는 조회 실패와 다른 갈래다", () => {
  // 릴리스가 아직 없는 것(또는 저장소가 비공개인 것)은 네트워크 사정이 아니다.
  // 같은 fetch-failed로 접으면 화면이 '다시 시도'를 내주고, 사용자는 있지도 않은
  // 네트워크 고장을 의심하며 버튼만 다시 누르게 된다.
  const r = updateStatus({ current: '1.9.5', latest: null, error: 'not published' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.reason, 'not-published');
  const msg = updateMessage(r);
  assert.doesNotMatch(msg, /네트워크/, '네트워크를 의심하게 만들면 안 된다');
  // 두 사정을 모두 말해야 한다 — 익명 조회에는 '아직 게시 전'과 '비공개 저장소'가
  // 같은 404로 오므로, 한쪽만 적으면 나머지 절반의 사용자에게 거짓을 말하게 된다.
  assert.match(msg, /게시 전/);
  assert.match(msg, /비공개/);
});

test('not-published에는 다시 시도 버튼이 붙지 않는다 (배선 가드)', () => {
  // 다시 눌러도 달라질 것이 없는 상태에 재시도를 내주면, 사용자는 있지도 않은
  // 네트워크 고장을 의심하며 버튼만 누르게 된다. 화면 조건이 reason까지 보는지를
  // 소스 텍스트로 못박는다(이 저장소에는 컴포넌트 렌더 테스트가 없다 — 같은 방식의
  // 배선 가드가 아래 '자동으로 나가지 않는다'와 app-version.test.js에도 있다).
  const sidebar = readFileSync(join(__dirname, '..', 'src', 'components', 'Sidebar.jsx'), 'utf8');
  assert.match(
    sidebar,
    /result\.state === 'unknown' && result\.reason === 'fetch-failed'/,
    "재시도 조건이 reason을 보지 않으면 not-published에도 버튼이 붙는다",
  );
});

test('updateCommand — 릴리스 자산 이름과 같은 꼴이다', () => {
  // 릴리스 워크플로가 올리는 자산은 npm pack의 이름 규약(cc-on-browser-<버전>.tgz)을
  // 그대로 쓴다. 이 문구가 그 규약에서 벗어나면 안내가 곧 오답이 된다.
  assert.equal(updateCommand('1.11.5'), 'npm install -g ./cc-on-browser-1.11.5.tgz');
  assert.equal(RELEASES_URL, 'https://github.com/seokjw0727/CC-on-browser/releases');
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

test('updateMessage — 일곱 갈래가 서로 다르고 undefined/null이 새지 않는다', () => {
  const msgs = [
    updateMessage(updateStatus({ current: '1.9.5', latest: '1.10.0' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: '1.9.5' })),
    updateMessage(updateStatus({ current: '2.0.0', latest: '1.9.5' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: null, error: 'x' })),
    updateMessage(updateStatus({ current: '1.9.5', latest: null, error: 'not published' })),
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
