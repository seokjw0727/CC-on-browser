// 버전 스큐 판정(lib/app-version.js)의 계약을 고정한다.
//
// 이 모듈은 vite define(__APP_VERSION__)에 의존하는데, node --test에는 그 정의가
// 없다 — 그래서 여기서 검증하는 것은 "정의가 없을 때 조용히 비교를 포기한다"는
// 폴백 계약이다. 실제 값이 박히는 경로(빌드)는 vite.config.js가 소유한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_VERSION, versionSkew } from '../src/lib/app-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('define이 없는 환경에서는 APP_VERSION이 null이고 비교를 하지 않는다', () => {
  // typeof는 선언되지 않은 식별자에도 던지지 않는다 — import 자체가 성공해야 한다.
  assert.equal(APP_VERSION, null);
  // 번들 버전을 모르면 서버가 무엇을 말하든 경고를 띄우지 않는다(거짓 경보 방지).
  assert.equal(versionSkew('9.9.9'), null);
  assert.equal(versionSkew(undefined), null);
});

test('vite.config가 __APP_VERSION__을 루트 package.json 버전으로 박아 넣는다', () => {
  // 정의가 사라지면 배너는 영원히 뜨지 않으므로(APP_VERSION=null), 그 배선을
  // 텍스트로 고정한다 — 이 파일은 node --test로 import할 수 없다(vite 의존).
  const cfg = readFileSync(join(__dirname, '..', 'vite.config.js'), 'utf8');
  assert.match(cfg, /__APP_VERSION__:\s*JSON\.stringify\(version\)/);
  assert.match(cfg, /package\.json/);
});

test('스큐 판정은 서버가 version을 싣지 않는 구버전도 다룬다', async () => {
  // APP_VERSION이 null인 환경에서는 versionSkew가 늘 null이므로, 판정 규칙 자체를
  // 같은 식으로 다시 구현해 계약을 명시한다(구현이 바뀌면 이 테스트가 먼저 깨진다).
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'app-version.js'), 'utf8');
  // ① 서버 버전이 같으면 null(정상)
  assert.match(src, /serverVersion === APP_VERSION/);
  // ② 서버가 version을 안 주면 server: null로 보고한다 — 그 자체가 구버전의 증거다.
  assert.match(src, /typeof serverVersion === 'string' \? serverVersion : null/);
});
