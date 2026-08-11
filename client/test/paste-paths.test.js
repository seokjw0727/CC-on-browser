// 붙여넣기 경로 삽입 규칙(lib/paste-paths.js) 단위 테스트.
// 계약: ① 공백·따옴표가 든 경로는 "…"로 감싸되 경로 글자는 하나도 바꾸지 않는다,
//       ② 캐럿 위치에 넣되 앞뒤 토큰과 붙지 않게 공백 경계를 만든다,
//       ③ data: URL은 원시 base64로 벗겨 서버 계약({name, data})에 맞춘다.
// 이 규칙은 e2e로는 "경로가 그럴싸해 보인다"까지만 확인돼서, 앞 단어와 한 칸 붙는 류의
// 어긋남은 여기서만 잡힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotePath, insertPaths, dataUrlToBase64 } from '../src/lib/paste-paths.js';

test('quotePath: 공백이 든 경로만 감싼다', () => {
  // 공백 없는 경로는 그대로 — 불필요한 따옴표는 프롬프트만 지저분해진다
  assert.equal(quotePath('C:\\Users\\me\\shot.png'), 'C:\\Users\\me\\shot.png');
  assert.equal(
    quotePath('C:\\Users\\me\\내 문서\\보고서.pdf'),
    '"C:\\Users\\me\\내 문서\\보고서.pdf"',
  );
  // 한글은 공백이 아니다 — 멀쩡한 경로를 감쌀 이유가 없다
  assert.equal(quotePath('C:\\작업\\한글파일.png'), 'C:\\작업\\한글파일.png');
});

test('quotePath: 파일명 안의 큰따옴표는 지우지 않고 감싸기만 한다', () => {
  // 셸 이스케이프가 아니라 프롬프트 텍스트다 — 글자를 지우면 실제 파일과 어긋난다
  assert.equal(quotePath('C:\\a\\say"hi".txt'), '"C:\\a\\say"hi".txt"');
});

test('quotePath: 빈 값·비문자열은 빈 문자열', () => {
  assert.equal(quotePath(''), '');
  assert.equal(quotePath(null), '');
  assert.equal(quotePath(undefined), '');
  assert.equal(quotePath(42), '');
});

test('insertPaths: 캐럿 중간에 넣으면 앞 단어와 붙지 않는다', () => {
  const r = insertPaths('이거 봐줘', 2, ['C:\\a.png']);
  assert.equal(r.text, '이거 C:\\a.png 봐줘');
  // 뒤에 이미 있던 공백을 종료 공백으로 재사용하고 캐럿은 그 뒤로 넘어간다
  assert.equal(r.caret, 12);
  assert.equal(r.text.slice(r.caret), '봐줘');
});

test('insertPaths: 앞이 공백이거나 문자열 시작이면 공백을 덧대지 않는다', () => {
  const head = insertPaths('설명', 0, ['a.txt']);
  assert.equal(head.text, 'a.txt 설명');
  assert.equal(head.caret, 6);

  const afterSpace = insertPaths('봐줘 ', 3, ['a.txt']);
  assert.equal(afterSpace.text, '봐줘 a.txt ');
  assert.equal(afterSpace.caret, afterSpace.text.length, '끝에 붙였으면 캐럿도 맨 끝');
});

test('insertPaths: 여러 경로는 공백으로 잇고 공백 든 경로만 감싼다', () => {
  const r = insertPaths('', 0, ['C:\\a b.png', 'C:\\c.txt']);
  assert.equal(r.text, '"C:\\a b.png" C:\\c.txt ');
  assert.equal(r.caret, r.text.length);
});

test('insertPaths: 줄바꿈 앞에서는 캐럿이 다음 줄로 튀지 않는다', () => {
  // 캐럿은 개행 앞에 두되(다음 줄로 튀면 어디에 쓰는지 놓친다) 종료 공백은 넣는다 —
  // 없으면 이어서 친 글자가 경로 끝에 붙어(x를) 없는 파일을 가리키게 된다
  const r = insertPaths('a\nb', 1, ['x']);
  assert.equal(r.text, 'a x \nb');
  assert.equal(r.caret, 4, '캐럿은 종료 공백 뒤·개행 앞(첫 줄 끝)에 남는다');

  // 줄 시작(앞이 개행)이면 앞 공백도 붙이지 않는다
  const lineHead = insertPaths('a\nb', 2, ['x']);
  assert.equal(lineHead.text, 'a\nx b');
  assert.equal(lineHead.caret, 4);
});

test('insertPaths: 캐럿은 [0, text.length]로 클램프한다', () => {
  // 업로드가 끝나는 사이 입력창이 짧아지면 캐럿이 문자열 밖을 가리킬 수 있다
  const over = insertPaths('abc', 99, ['x']);
  assert.deepEqual(over, { text: 'abc x ', caret: 6 });

  const under = insertPaths('abc', -5, ['x']);
  assert.deepEqual(under, { text: 'x abc', caret: 2 });

  // 숫자가 아니면 끝에 붙인다 — 엉뚱한 위치를 찍느니 맨 뒤가 안전하다
  assert.deepEqual(insertPaths('abc', NaN, ['x']), { text: 'abc x ', caret: 6 });
  assert.deepEqual(insertPaths('abc', undefined, ['x']), { text: 'abc x ', caret: 6 });
});

test('insertPaths: 넣을 경로가 없으면 텍스트도 캐럿도 그대로', () => {
  assert.deepEqual(insertPaths('abc', 1, []), { text: 'abc', caret: 1 });
  // 빈 이름만 온 경우도 공백 한 칸을 남기지 않는다
  assert.deepEqual(insertPaths('abc', 1, ['', null]), { text: 'abc', caret: 1 });
  assert.deepEqual(insertPaths('abc', 1, undefined), { text: 'abc', caret: 1 });
  // 이때도 캐럿 클램프는 유효하다(호출측이 그대로 setSelectionRange에 넘긴다)
  assert.deepEqual(insertPaths('abc', 9, []), { text: 'abc', caret: 3 });
});

test('dataUrlToBase64: data: URL은 헤더를 떼고 원시 base64는 그대로', () => {
  assert.equal(dataUrlToBase64('data:image/png;base64,iVBORw0KGgo='), 'iVBORw0KGgo=');
  assert.equal(dataUrlToBase64('iVBORw0KGgo='), 'iVBORw0KGgo=');
  assert.equal(dataUrlToBase64('data:image/png;base64,'), '', '본문이 비면 빈 문자열');
});

test('dataUrlToBase64: 줄바꿈·공백은 양쪽 다 지운다', () => {
  assert.equal(dataUrlToBase64('data:image/png;base64,iVBO\nRw0K Ggo='), 'iVBORw0KGgo=');
  assert.equal(dataUrlToBase64('  iVBO\r\nRw0KGgo=  '), 'iVBORw0KGgo=');
});

test('dataUrlToBase64: 자를 곳이 없거나 문자열이 아니면 안전하게 폴백', () => {
  // 콤마가 없으면 헤더도 없다고 보고 통째로 넘긴다(본문을 날리지 않는다)
  assert.equal(dataUrlToBase64('data:image/png'), 'data:image/png');
  assert.equal(dataUrlToBase64(null), '');
  assert.equal(dataUrlToBase64(undefined), '');
});
