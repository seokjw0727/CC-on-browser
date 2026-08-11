// 붙여넣은 파일의 경로를 입력창 텍스트에 끼워 넣는 규칙 — DOM 의존이 없는 순수 함수라
// node --test에서 그대로 불러온다(설계도 2026-08-11-paste-attachments §2).
// Composer.jsx 안에 두지 않은 이유: 캐럿 경계 공백과 따옴표 감싸기는 눈으로 확인하기
// 어려운 문자열 산술이라, "붙여넣었더니 앞 단어와 한 덩어리가 됐다" 류의 회귀가
// 화면상으로는 멀쩡해 보이면서 조용히 난다.
//
// 여기서 하는 감싸기는 셸 이스케이프가 아니다 — 삽입 결과는 CLI에 넘길 명령줄이 아니라
// 사람이 읽고 모델이 읽는 프롬프트 텍스트다. 그래서 경로 안의 문자를 지우거나 바꾸지 않고
// (원본 경로가 훼손되면 CLI가 그 파일을 못 찾는다) 토큰 경계만 분명히 해 준다.

/**
 * 공백이나 큰따옴표가 든 경로는 "…"로 감싼다 — 감싸지 않으면 경로 하나가 두 토큰으로
 * 읽힌다. 안의 큰따옴표는 지우지 않는다(파일명에 실제로 들어 있는 글자이므로 지우면
 * 도리어 원본과 어긋난 경로가 된다).
 * @param {string} p 절대경로
 * @returns {string} 감싼(또는 그대로인) 경로. 빈 문자열·비문자열이면 ''
 */
export function quotePath(p) {
  if (typeof p !== 'string' || p === '') return '';
  return /[\s"]/.test(p) ? `"${p}"` : p;
}

/**
 * 캐럿 위치에 경로들을 공백으로 이어 붙여 삽입한다.
 * - 앞이 문자열 시작도 공백도 아니면 공백 하나를 먼저 넣어 앞 단어와 붙는 것을 막는다.
 * - 뒤는 공백 하나로 토큰을 끝낸다. 이미 공백(스페이스·탭)이 있으면 그것을 재사용하고
 *   캐럿만 그 뒤로 넘긴다 — 이어서 타이핑해도 경로 토큰이 오염되지 않는다. 줄바꿈은
 *   재사용하지 않는다: 캐럿을 개행 뒤로 넘기면 사용자가 어디에 쓰는지 놓치는데, 개행
 *   앞에 그대로 두면 바로 타이핑한 글자가 경로 끝에 들러붙어(…a.png를) CLI가 없는
 *   파일을 찾게 된다. 그래서 줄 끝에서도 종료 공백을 새로 넣는다.
 * @param {string} text 입력창의 현재 값
 * @param {number} caret 삽입 위치 — [0, text.length]로 클램프하고, 숫자가 아니면 문자열 끝
 * @param {string[]} paths 절대경로 배열. 비어 있으면 텍스트를 건드리지 않는다
 * @returns {{text: string, caret: number}} 새 값과 삽입 뒤 캐럿(토큰을 끝내는 공백 뒤)
 */
export function insertPaths(text, caret, paths) {
  const safe = typeof text === 'string' ? text : '';
  // 업로드 왕복 사이에 입력창이 바뀌면 캐럿이 문자열 밖을 가리킬 수 있다 — 끝으로 접는다.
  const pos = Number.isFinite(caret)
    ? Math.min(Math.max(Math.trunc(caret), 0), safe.length)
    : safe.length;

  // 빈 이름·비문자열은 걸러야 join이 공백을 두 칸 남기지 않는다.
  const chunk = (Array.isArray(paths) ? paths : []).map(quotePath).filter(Boolean).join(' ');
  if (!chunk) return { text: safe, caret: pos };

  const before = safe.slice(0, pos);
  const after = safe.slice(pos);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';

  const next = after.charAt(0);
  const blank = next === ' ' || next === '\t'; // 이미 있는 공백을 종료 공백으로 재사용
  const tail = blank ? '' : ' ';

  const inserted = lead + chunk + tail;
  return {
    text: before + inserted + after,
    caret: pos + inserted.length + (blank ? 1 : 0),
  };
}

/**
 * data: URL에서 원시 base64 본문만 뽑는다. FileReader가 주는
 * 'data:image/png;base64,iVBO…'를 서버 계약(data = 원시 base64)에 맞추는 헬퍼로,
 * 이미 원시 base64면 그대로 통과시킨다. 줄바꿈·공백은 어느 쪽이든 지운다 — 섞여 있으면
 * 디코더에 따라 그대로 실패한다.
 * @param {string} s
 * @returns {string} 원시 base64(비문자열이면 '')
 */
export function dataUrlToBase64(s) {
  if (typeof s !== 'string') return '';
  const comma = s.indexOf(',');
  // 콤마가 없으면 떼어낼 헤더도 없다고 본다 — 잘못 잘라 본문을 통째로 날리는 쪽이 더 나쁘다.
  const body = comma !== -1 && /^data:/i.test(s) ? s.slice(comma + 1) : s;
  return body.replace(/\s+/g, '');
}
