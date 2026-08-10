// 산출물 파생(lib/artifacts.js) 단위 테스트 — 미리보기 목록의 유일한 진실 공급원.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactsOf,
  autoPreviewPath,
  baseName,
  findArtifact,
  pathKey,
  previewPathOf,
} from '../src/lib/artifacts.js';

const ok = { content: 'Created', isError: false, structured: null };
const bad = { content: 'error', isError: true, structured: null };

const write = (uid, file_path, result = ok, name = 'Write') => ({
  kind: 'tool_use', uid, name, input: { file_path }, result,
});
const prompt = (text = '만들어줘') => ({ kind: 'user-text', text });

test('previewPathOf: 성공한 파일 쓰기 도구만 경로를 준다', () => {
  assert.equal(previewPathOf(write('u1', 'C:/w/a.html')), 'C:/w/a.html');
  assert.equal(previewPathOf(write('u2', 'C:/w/a.html', null)), null, '결과 없음(실행 중)');
  assert.equal(previewPathOf(write('u3', 'C:/w/a.html', bad)), null, '실패한 쓰기');
  assert.equal(previewPathOf(write('u4', '   ')), null, '빈 경로');
  // 파일을 만들지 않는 도구는 대상이 아니다.
  assert.equal(previewPathOf({ kind: 'tool_use', uid: 'u5', name: 'Bash', input: { command: 'ls' }, result: ok }), null);
  assert.equal(previewPathOf({ kind: 'assistant-text', uid: 'u6', text: 'hi' }), null);
  // NotebookEdit만 notebook_path를 쓴다.
  assert.equal(
    previewPathOf({ kind: 'tool_use', uid: 'u7', name: 'NotebookEdit', input: { notebook_path: 'C:/w/n.ipynb' }, result: ok }),
    'C:/w/n.ipynb',
  );
});

test('artifactsOf: 최신순 · 파일당 1개 · 마지막 수정 uid를 싣는다', () => {
  const list = artifactsOf([
    write('u1', 'C:/w/a.html'),
    write('u2', 'C:/w/b.md'),
    write('u3', 'C:/w/a.html', ok, 'Edit'), // a를 다시 수정
  ]);
  assert.deepEqual(list.map((a) => a.name), ['a.html', 'b.md'], '가장 최근 수정이 앞');
  assert.equal(list.length, 2, '같은 파일은 하나로 접힌다');
  assert.equal(list[0].uid, 'u3', '자동 새로고침 트리거는 마지막 수정 uid');
});

test('artifactsOf: 대소문자 정책은 인자로 받고, 표시 경로는 원본을 보존한다', () => {
  const msgs = [write('u1', 'C:/W/A.html'), write('u2', 'c:/w/a.html', ok, 'Edit')];
  const win = artifactsOf(msgs, { caseInsensitive: true });
  assert.equal(win.length, 1, 'win32에서는 같은 파일');
  assert.equal(win[0].path, 'c:/w/a.html', '최신 원본 철자를 그대로 유지');

  const posix = artifactsOf(msgs);
  assert.equal(posix.length, 2, '대소문자를 구분하는 곳에서는 별개 파일');
});

test('artifactsOf: 구분자가 섞여도 같은 파일로 본다', () => {
  const list = artifactsOf([
    write('u1', 'C:\\w\\a.html'),
    write('u2', 'C:/w/a.html', ok, 'Edit'),
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'a.html');
});

test('artifactsOf: 빈 입력은 빈 배열', () => {
  assert.deepEqual(artifactsOf(undefined), []);
  assert.deepEqual(artifactsOf([]), []);
  assert.deepEqual(artifactsOf([{ kind: 'user-text', uid: 'u', text: 'hi' }]), []);
});

test('findArtifact: 구분자·대소문자 차이를 넘어 선택을 찾아낸다', () => {
  const list = artifactsOf([write('u1', 'C:/w/a.html')]);
  assert.equal(findArtifact(list, 'C:\\w\\a.html')?.uid, 'u1');
  assert.equal(findArtifact(list, 'C:/W/A.HTML', { caseInsensitive: true })?.uid, undefined,
    '대소문자 무시 비교는 목록도 같은 정책으로 만들어야 한다');
  const winList = artifactsOf([write('u1', 'C:/w/a.html')], { caseInsensitive: true });
  assert.equal(findArtifact(winList, 'C:\\W\\A.HTML', { caseInsensitive: true })?.uid, 'u1');
  assert.equal(findArtifact(list, null), null);
});

// ----- autoPreviewPath: 턴 종료 자동 열기의 판정 -----

test('autoPreviewPath: 마지막 사용자 발화 이후에 쓴 것만 후보다', () => {
  const msgs = [
    prompt('첫 턴'),
    write('u1', '/w/old.html'),
    prompt('둘째 턴'),
    write('u2', '/w/new.html'),
  ];
  assert.equal(autoPreviewPath(msgs), '/w/new.html');
  // 이번 턴에 쓴 것이 없으면 null — 호출측이 상태를 그대로 두게 한다.
  assert.equal(autoPreviewPath([...msgs, prompt('셋째 턴')]), null);
  // 경계(사용자 발화)가 아예 없으면 null — 재개 직후의 뜬금없는 result 방어.
  assert.equal(autoPreviewPath([write('u1', '/w/a.html')]), null);
  assert.equal(autoPreviewPath([]), null);
  assert.equal(autoPreviewPath(undefined), null);
});

test('autoPreviewPath: 커맨드 칩·/clear 구분선도 턴 경계다', () => {
  const cmd = { kind: 'command', name: 'compact', args: '' };
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/old.md'), cmd, write('u2', '/w/new.md')]), '/w/new.md');
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/old.md'), cmd]), null);
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/old.md'), { kind: 'cleared' }]), null);
});

test('autoPreviewPath: 재개 히스토리(preloaded)는 경계도 후보도 되지 않는다', () => {
  const history = [
    { ...prompt('과거 발화'), preloaded: true },
    { ...write('u1', '/w/old.html'), preloaded: true },
  ];
  // 히스토리만 있으면 경계가 없는 것과 같다 — 옛 파일이 저절로 열리지 않는다.
  assert.equal(autoPreviewPath(history), null);
  // 라이브 발화가 붙어도 히스토리 산출물은 후보가 아니다.
  assert.equal(autoPreviewPath([...history, prompt('새 발화')]), null);
  assert.equal(
    autoPreviewPath([...history, prompt('새 발화'), write('u2', '/w/new.html')]),
    '/w/new.html',
  );
  // 경계 뒤에 preloaded 항목이 오는 것은 시딩 순서상 정상 경로는 아니지만, 후보 단계의
  // preloaded 제외가 경계 슬라이싱에 기대지 않고 스스로 서 있는지 확인한다(방어).
  assert.equal(
    autoPreviewPath([prompt('새 발화'), { ...write('u3', '/w/hist.html'), preloaded: true }]),
    null,
  );
});

test('autoPreviewPath: 실패·미완료 쓰기와 파일을 안 만드는 도구는 후보가 아니다', () => {
  const msgs = [
    prompt(),
    write('u1', '/w/failed.html', bad),
    write('u2', '/w/running.html', null),
    { kind: 'tool_use', uid: 'u3', name: 'Bash', input: { command: 'ls' }, result: ok },
  ];
  assert.equal(autoPreviewPath(msgs), null);
});

test('autoPreviewPath: 한 턴에 여러 개면 "보여줄 만한" 순서로 고른다', () => {
  // html을 만들며 함께 쓴 css/js는 부속이다 — 완성 문서(html)가 이긴다.
  assert.equal(
    autoPreviewPath([prompt(), write('u1', '/w/page.html'), write('u2', '/w/style.css')]),
    '/w/page.html',
  );
  // md > 이미지 > 텍스트 > 기타(binary) 순
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/a.txt'), write('u2', '/w/b.md')]), '/w/b.md');
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/a.txt'), write('u2', '/w/b.png')]), '/w/b.png');
  assert.equal(autoPreviewPath([prompt(), write('u1', '/w/a.bin'), write('u2', '/w/b.txt')]), '/w/b.txt');
  // 같은 순위면 마지막에 쓴 것
  assert.equal(
    autoPreviewPath([prompt(), write('u1', '/w/one.html'), write('u2', '/w/two.html')]),
    '/w/two.html',
  );
  // 같은 파일을 여러 번 고쳐도 그 파일 하나
  assert.equal(
    autoPreviewPath([prompt(), write('u1', '/w/a.html'), write('u2', '/w/a.html', ok, 'Edit')]),
    '/w/a.html',
  );
});

test('autoPreviewPath: 보고 있던 파일이 이번 턴에도 쓰였으면 선택을 뺏지 않는다', () => {
  const msgs = [prompt(), write('u1', '/w/notes.md'), write('u2', '/w/page.html')];
  // 우선순위상 html이 이기지만, 사용자가 notes.md를 보고 있으면 그대로 둔다.
  assert.equal(autoPreviewPath(msgs, { openPath: '/w/notes.md' }), '/w/notes.md');
  // 구분자만 다른 표기도 같은 파일 — 넘어온 원본 철자를 그대로 돌려준다.
  assert.equal(autoPreviewPath(msgs, { openPath: '\\w\\notes.md' }), '\\w\\notes.md');
  // 대소문자는 접지 않는다(Linux에서 다른 파일) — 주 산출물로 전환된다.
  assert.equal(autoPreviewPath(msgs, { openPath: '/w/NOTES.md' }), '/w/page.html');
  // 보던 파일이 이번 턴과 무관하면 주 산출물로 전환
  assert.equal(autoPreviewPath(msgs, { openPath: '/w/other.md' }), '/w/page.html');
});

test('pathKey · baseName', () => {
  assert.equal(pathKey('C:\\w\\a.html'), 'C:/w/a.html');
  assert.equal(pathKey('C:/w/a.html', { caseInsensitive: true }), 'c:/w/a.html');
  assert.equal(pathKey('C:/w/dir/'), 'C:/w/dir', '끝 구분자는 무시');
  assert.equal(baseName('C:\\w\\a.html'), 'a.html');
  assert.equal(baseName('/tmp/report.md'), 'report.md');
  assert.equal(baseName('noslash.txt'), 'noslash.txt');
});
