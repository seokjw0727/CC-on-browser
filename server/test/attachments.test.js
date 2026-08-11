// attachments — 붙여넣기 임시 저장 · OS 클립보드 조회 · 청소의 단위 테스트.
//
// root·platform·exec를 전부 주입해 사용자의 실제 tmp 공용 디렉터리(cc-on-browser-paste)와
// OS 클립보드를 절대 건드리지 않는다. 클립보드 조회는 PowerShell을 실행하지 않고
// stdout 문자열만 흉내 낸다 — 검증 대상은 "무엇을 실행했는가"가 아니라 파싱·존재 확인·
// 실패 시 폴백이기 때문이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PASTE_BYTES,
  PASTE_DIR_PREFIX,
  cleanupStalePasteDirs,
  listClipboardFiles,
  pasteRoot,
  sanitizeFileName,
  saveClipboardFile,
} from '../src/attachments.js';

const HOUR_MS = 60 * 60 * 1000;

/** 테스트마다 격리된 가짜 paste root — 생성 후 자동 정리. */
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccob-paste-'));
  // Windows는 방금 닫은 핸들이 잠깐 남아 rmdir이 EBUSY로 튄다(preview 테스트와 같은 처방).
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return root;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('pasteRoot·상한은 계약대로 고정되어 있다', () => {
  assert.equal(pasteRoot(), path.join(os.tmpdir(), PASTE_DIR_PREFIX));
  assert.equal(MAX_PASTE_BYTES, 20 * 1024 * 1024);
});

// ---------------------------------------------------------------- sanitizeFileName

test('sanitizeFileName: 유니코드·공백은 살리고 금지문자만 걷어낸다', () => {
  assert.equal(sanitizeFileName('스크린샷 2026-08-11.png'), '스크린샷 2026-08-11.png');
  assert.equal(sanitizeFileName('a<b>c:d"e|f?g*h.png'), 'a_b_c_d_e_f_g_h.png');
  assert.equal(sanitizeFileName('line\nbreak\ttab.txt'), 'line_break_tab.txt');
});

test('sanitizeFileName: 경로 구분자는 마지막 조각만 남긴다', () => {
  assert.equal(sanitizeFileName('C:\\Users\\me\\evil.png'), 'evil.png');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('a/b\\c.txt'), 'c.txt');
});

test('sanitizeFileName: 앞뒤 공백·점은 잘라낸다', () => {
  assert.equal(sanitizeFileName('  spaced.png  '), 'spaced.png');
  assert.equal(sanitizeFileName('trailing.png.'), 'trailing.png');
  // 앞점을 걷어내는 대가로 dotfile은 앞점을 잃는다 — '.'·'..'가 이름으로 살아남지
  // 않게 하는 쪽을 택한 결과다(붙여넣기 대상이 dotfile인 경우는 사실상 없다).
  assert.equal(sanitizeFileName('.gitignore'), 'gitignore');
});

test('sanitizeFileName: 이름이 사라지면 폴백', () => {
  for (const bad of ['', '   ', '...', '..', 'foo/', undefined, null, 42, {}]) {
    assert.equal(sanitizeFileName(bad), 'pasted-file', String(bad));
  }
});

test('sanitizeFileName: Windows 예약명은 확장자가 붙어도 접두어로 피한다', () => {
  for (const name of ['CON', 'con', 'nul', 'AUX', 'PRN', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.equal(sanitizeFileName(name), `_${name}`);
  }
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('con.txt.png'), '_con.txt.png');
  // 예약명처럼 생겼을 뿐인 이름은 건드리지 않는다
  assert.equal(sanitizeFileName('COM0.txt'), 'COM0.txt');
  assert.equal(sanitizeFileName('console.log'), 'console.log');
});

test('sanitizeFileName: 길이 상한은 문자 수·바이트 수 둘 다로 지키고 확장자를 남긴다', () => {
  const long = sanitizeFileName(`${'가'.repeat(300)}.png`);
  assert.ok(long.endsWith('.png'));
  assert.ok(long.length <= 120);
  // 문자 수만 재면 한글 120자 = 360바이트라 POSIX NAME_MAX(255바이트)를 넘겨
  // Linux·macOS에서 ENAMETOOLONG으로 저장이 실패한다
  assert.ok(Buffer.byteLength(long) <= 200, `${Buffer.byteLength(long)} bytes`);
  // ASCII 이름은 문자 수 상한이 그대로 걸린다
  assert.equal(sanitizeFileName('x'.repeat(500)).length, 120);
  // 바이트로 자를 때 서로게이트 쌍을 반토막 내지 않는다(짝을 잃으면 왕복에서 U+FFFD가 된다)
  const emoji = sanitizeFileName(`${'🙂'.repeat(200)}.png`);
  assert.equal(Buffer.from(emoji, 'utf8').toString('utf8'), emoji);
  assert.ok(Buffer.byteLength(emoji) <= 200);
  // 짧은 이름은 손대지 않는다
  assert.equal(sanitizeFileName('a.png'), 'a.png');
});

// ---------------------------------------------------------------- saveClipboardFile

test('saveClipboardFile: 랜덤 디렉터리에 저장하고 절대경로를 돌려준다', async (t) => {
  const root = tmpRoot(t);
  const first = await saveClipboardFile({ name: '스크린샷 1.png', data: b64('hello') }, { root });

  assert.ok(path.isAbsolute(first.path));
  assert.equal(path.basename(first.path), '스크린샷 1.png');
  assert.equal(path.dirname(path.dirname(first.path)), root); // root/<랜덤>/<이름>
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'hello');

  // 같은 이름을 다시 붙여넣어도 앞의 파일을 덮어쓰지 않는다(디렉터리가 매번 다르다)
  const second = await saveClipboardFile({ name: '스크린샷 1.png', data: b64('world') }, { root });
  assert.notEqual(path.dirname(first.path), path.dirname(second.path));
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'hello');
  assert.equal(fs.readFileSync(second.path, 'utf8'), 'world');
});

test('saveClipboardFile: 저장할 때도 이름을 깎는다', async (t) => {
  const root = tmpRoot(t);
  const saved = await saveClipboardFile({ name: 'C:\\tmp\\a:b\nc.png', data: b64('x') }, { root });
  assert.equal(path.basename(saved.path), 'a_b_c.png');
  assert.equal(path.dirname(path.dirname(saved.path)), root);
});

test('saveClipboardFile: 정규 base64가 아니면 EBADBODY (디스크에 아무것도 남기지 않는다)', async (t) => {
  const root = tmpRoot(t);
  // 'A'는 디코드하면 0바이트, 'AA AA'·'not base64!!'는 알파벳 밖 문자가 조용히 버려진다 —
  // 왕복 비교가 없으면 전부 "성공"으로 통과해 버리는 입력들이다.
  for (const data of ['not base64!!', 'AAAA=AAA', 'A', 'AA AA', '한글', 123, null, undefined, {}]) {
    await assert.rejects(
      saveClipboardFile({ name: 'x.png', data }, { root }),
      (err) => err.code === 'EBADBODY',
      String(data),
    );
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('saveClipboardFile: 20MB 상한 — 넘으면 EPAYLOAD, 정확히 상한이면 통과', async (t) => {
  const root = tmpRoot(t);
  await assert.rejects(
    saveClipboardFile({ name: 'big.bin', data: Buffer.alloc(MAX_PASTE_BYTES + 1).toString('base64') }, { root }),
    (err) => err.code === 'EPAYLOAD',
  );
  assert.deepEqual(fs.readdirSync(root), [], '거부된 업로드는 디렉터리도 만들지 않는다');

  const edge = await saveClipboardFile(
    { name: 'edge.bin', data: Buffer.alloc(MAX_PASTE_BYTES).toString('base64') },
    { root },
  );
  assert.equal(fs.statSync(edge.path).size, MAX_PASTE_BYTES);
});

// ---------------------------------------------------------------- listClipboardFiles

test('listClipboardFiles: Windows가 아니면 실행기를 부르지도 않는다', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return '["C:\\\\x.png"]';
  };
  assert.deepEqual(await listClipboardFiles({ platform: 'darwin', exec }), []);
  assert.deepEqual(await listClipboardFiles({ platform: 'linux', exec }), []);
  assert.equal(calls, 0);
});

test('listClipboardFiles: JSON을 파싱해 존재하는 경로만 순서대로 남긴다', async (t) => {
  const root = tmpRoot(t);
  const a = path.join(root, 'a.png');
  const b = path.join(root, '한글 문서.pdf');
  const gone = path.join(root, 'gone.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');

  const exec = async () => JSON.stringify([a, gone, b]);
  assert.deepEqual(await listClipboardFiles({ platform: 'win32', exec }), [a, b]);
});

test('listClipboardFiles: 경로 문자열을 정규화하지 않고 그대로 돌려준다', async (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.png'), 'a');
  // path.join은 '..'를 접어 버리므로 일부러 접지 않은 표기를 만든다. stat은 통과하지만
  // 어딘가에서 정규화하면 문자열이 달라진다 — 대소문자·UNC 보존을 지키는지 보는 대리 검사.
  const quirky = [root, 'sub', '..', 'a.png'].join(path.sep);

  const got = await listClipboardFiles({ platform: 'win32', exec: async () => JSON.stringify([quirky]) });
  assert.deepEqual(got, [quirky]);
});

test('listClipboardFiles: 실행 실패·비JSON·배열 아님은 모두 빈 목록(throw 금지)', async () => {
  const cases = [
    async () => { throw new Error('powershell not found'); },
    async () => 'Get-Clipboard : 명령을 찾을 수 없습니다',
    async () => '',
    async () => 'null',
    async () => '{"a":1}',
    async () => '[1,2,3]',
  ];
  for (const exec of cases) {
    assert.deepEqual(await listClipboardFiles({ platform: 'win32', exec }), []);
  }
});

test('listClipboardFiles: BOM·{stdout} 형태·단일 문자열 출력도 받아 준다', async (t) => {
  const root = tmpRoot(t);
  const a = path.join(root, 'a.png');
  fs.writeFileSync(a, 'a');
  const json = JSON.stringify([a]);
  // 소스에 보이지 않는 문자를 두지 않으려고 코드포인트로 만든다.
  const bom = String.fromCharCode(0xfeff);

  assert.deepEqual(await listClipboardFiles({ platform: 'win32', exec: async () => bom + json }), [a]);
  assert.deepEqual(await listClipboardFiles({ platform: 'win32', exec: async () => ({ stdout: json }) }), [a]);
  assert.deepEqual(await listClipboardFiles({ platform: 'win32', exec: async () => JSON.stringify(a) }), [a]);
});

// ---------------------------------------------------------------- cleanupStalePasteDirs

/** dir의 mtime을 ms만큼 과거로 돌리고, 파일시스템에 실제로 기록된 값을 돌려준다. */
function ageDir(dir, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(dir, when, when);
  return fs.statSync(dir).mtimeMs;
}

function makePasteDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'shot.png'), name);
  return dir;
}

test('cleanupStalePasteDirs: 오래된 디렉터리만 지우고 개수를 돌려준다', async (t) => {
  const root = tmpRoot(t);
  const old = makePasteDir(root, 'old');
  const fresh = makePasteDir(root, 'fresh');
  ageDir(old, 25 * HOUR_MS);

  assert.equal(await cleanupStalePasteDirs({ root }), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('cleanupStalePasteDirs: 24h 경계는 지나야 지운다', async (t) => {
  const root = tmpRoot(t);
  const dir = makePasteDir(root, 'edge');
  // 기준 시각을 "기록된 mtime"에서 만든다 — mtime 정밀도가 낮은 파일시스템에서도
  // 경계가 1ms 단위로 흔들리지 않게.
  const mtime = ageDir(dir, 24 * HOUR_MS);

  assert.equal(await cleanupStalePasteDirs({ root, now: mtime + 24 * HOUR_MS }), 0);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(await cleanupStalePasteDirs({ root, now: mtime + 24 * HOUR_MS + 1 }), 1);
  assert.equal(fs.existsSync(dir), false);
});

test('cleanupStalePasteDirs: root가 없으면 0 · 디렉터리가 아닌 항목은 건드리지 않는다', async (t) => {
  const root = tmpRoot(t);
  assert.equal(await cleanupStalePasteDirs({ root: path.join(root, 'no-such') }), 0);

  const stray = path.join(root, 'stray.txt');
  fs.writeFileSync(stray, 'x');
  const when = new Date(Date.now() - 10 * 24 * HOUR_MS);
  fs.utimesSync(stray, when, when);

  assert.equal(await cleanupStalePasteDirs({ root }), 0);
  assert.equal(fs.existsSync(stray), true);
});

test('cleanupStalePasteDirs: 심볼릭 링크는 따라가지 않는다', async (t) => {
  const root = tmpRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccob-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'x');

  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (err) {
    t.skip(`symlink unavailable on this platform: ${err.code}`);
    return;
  }
  const when = new Date(Date.now() - 30 * 24 * HOUR_MS);
  try {
    fs.lutimesSync(link, when, when);
  } catch {
    // 링크 자신의 mtime을 못 바꾸는 환경이면 그대로 둔다 — 어차피 대상이 아니어야 한다.
  }

  assert.equal(await cleanupStalePasteDirs({ root }), 0);
  assert.equal(fs.existsSync(path.join(outside, 'victim.txt')), true);
});

test('root 자신이 링크면 청소도 저장도 그 아래로 들어가지 않는다', async (t) => {
  const base = tmpRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccob-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  // 청소 대상으로 딱 걸릴 나이의 남의 폴더 — 루트를 확인하지 않으면 통째로 지워진다.
  const victim = makePasteDir(outside, 'precious');
  ageDir(victim, 30 * 24 * HOUR_MS);

  // 루트 이름은 상수(os.tmpdir()/cc-on-browser-paste)라 서버가 처음 뜨기 전에 선점할 수 있다.
  const linked = path.join(base, 'linked-root');
  try {
    fs.symlinkSync(outside, linked, 'junction');
  } catch (err) {
    t.skip(`symlink unavailable on this platform: ${err.code}`);
    return;
  }

  assert.equal(await cleanupStalePasteDirs({ root: linked }), 0);
  assert.equal(fs.existsSync(path.join(victim, 'shot.png')), true, '링크 너머는 삭제 대상이 아니다');

  // 저장도 마찬가지 — mkdir이 recursive여도 링크는 순순히 따라간다.
  await assert.rejects(saveClipboardFile({ name: 'x.png', data: b64('x') }, { root: linked }));
  assert.deepEqual(fs.readdirSync(outside), ['precious'], '링크 너머에 아무것도 만들지 않는다');
});
