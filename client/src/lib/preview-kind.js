// 확장자 → 미리보기 종류 분류. PreviewPanel의 렌더 분기와 "턴 종료 자동 열기"의
// 주 산출물 우선순위가 **같은 분류를 공유**하도록 컴포넌트에서 떼어낸 순수 모듈이다
// (설계도 2026-08-10-auto-open-preview-on-turn-end §2). 둘이 각자 확장자 목록을
// 들고 있으면 svg·avif 같은 형식이 "패널은 이미지로 그리는데 자동 선택은 기타로
// 취급"하는 식으로 조용히 어긋난다.
//
// artifacts.js가 이 모듈을 쓰므로 여기서는 artifacts.js를 import하지 않는다(순환 방지)
// — extOf가 baseName을 빌리지 않고 스스로 경로를 다루는 이유다. React/CSS 의존도 없어
// node --test에서 그대로 불러올 수 있다.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const HTML_EXTS = new Set(['html', 'htm']);
const MD_EXTS = new Set(['md', 'markdown']);
// 텍스트로 열어도 되는 확장자. 여기 없고 위 분류에도 없으면 바이너리로 보고 다운로드.
const TEXT_EXTS = new Set([
  'txt', 'log', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonl',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'csv', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'cs', 'sh', 'sql', 'ipynb', 'svg',
]);

/**
 * 경로의 확장자(소문자). 확장자가 없거나 dotfile(.gitignore)이면 ''.
 * 디렉터리 이름에 점이 있어도(C:/w.dir/file) 파일명 쪽 점만 본다.
 */
export function extOf(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dot = s.lastIndexOf('.');
  // dot > slash + 1 — 점이 파일명 안에 있고(구분자보다 뒤) 첫 글자가 아닐 때만 확장자다.
  return dot > slash + 1 ? s.slice(dot + 1).toLowerCase() : '';
}

/** 미리보기 종류 — 렌더 분기와 "무엇을 fetch할지"를 함께 정한다. */
export function previewKind(p) {
  const ext = extOf(p);
  if (HTML_EXTS.has(ext)) return 'html';
  if (MD_EXTS.has(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  // svg는 이미지로도 텍스트로도 볼 수 있다 — 그림으로 보는 쪽이 기대에 맞다.
  if (IMAGE_EXTS.has(ext) || ext === 'svg') return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

// 자동 열기가 한 턴의 여러 산출물 중 "주 산출물"을 고르는 순서. 사람이 눈으로 확인하고
// 싶어 하는 결과물(완성된 문서)일수록 앞이다 — html을 만들며 함께 쓴 css/js는 부속이다.
const KIND_RANK = { html: 0, markdown: 1, image: 2, pdf: 2, text: 3, binary: 4 };

/** 주 산출물 정렬용 순위(작을수록 우선). 모르는 종류는 맨 뒤. */
export function previewRank(p) {
  return KIND_RANK[previewKind(p)] ?? 9;
}
