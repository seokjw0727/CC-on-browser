// instance-file — 데몬 신원 파일의 왕복·무효 판정·소유권 기반 삭제 단위 테스트.
// homeDir를 주입해 사용자의 실제 ~/.cc-on-browser 를 절대 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  instanceDir,
  instancePath,
  readInstanceFile,
  writeInstanceFile,
  clearInstanceFile,
} from '../src/instance-file.js';

/** 테스트마다 격리된 가짜 홈 — 생성 후 자동 정리. */
function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccob-inst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('write→read 왕복: 기록한 신원이 그대로 돌아온다', (t) => {
  const home = tmpHome(t);
  assert.equal(
    writeInstanceFile({ port: 8787, token: 'abc123', pid: 4242, version: '1.8.0' }, home),
    true,
  );
  assert.deepEqual(readInstanceFile(8787, home), {
    port: 8787,
    token: 'abc123',
    pid: 4242,
    version: '1.8.0',
  });
  // 파일은 홈 하위 .cc-on-browser/instance-<port>.json 에 놓인다.
  assert.equal(instancePath(8787, home), path.join(instanceDir(home), 'instance-8787.json'));
  assert.ok(fs.existsSync(instancePath(8787, home)));
});

test('발행 성공 후 tmp 파일이 남지 않는다', (t) => {
  const home = tmpHome(t);
  writeInstanceFile({ port: 8787, token: 'abc123', version: '1.8.0' }, home);
  const leftovers = fs.readdirSync(instanceDir(home)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// 위 테스트는 구현이 최종 파일에 직접 써도 통과한다 — tmp→rename 경로를 실제로
// 태우는지는 rename만 실패시켜서 본다: 최종 경로에 디렉터리를 두면 writeFileSync(tmp)는
// 성공하고 renameSync만 실패한다. 그때 false를 주면서 tmp를 남기지 않아야 한다.
test('tmp 작성 후 rename이 실패하면 false + tmp 정리 (tmp→rename 경로 확인)', (t) => {
  const home = tmpHome(t);
  const file = instancePath(8787, home);
  fs.mkdirSync(file, { recursive: true }); // 최종 경로를 디렉터리로 선점 → rename 실패

  assert.equal(writeInstanceFile({ port: 8787, token: 'abc', version: '1.8.0' }, home), false);
  const leftovers = fs.readdirSync(instanceDir(home)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'rename 실패 경로에서도 토큰 담긴 tmp를 남기지 않는다');
});

test('오래된 잔여 tmp는 다음 발행 때 쓸려 나간다', (t) => {
  const home = tmpHome(t);
  const dir = instanceDir(home);
  fs.mkdirSync(dir, { recursive: true });
  // 강제 종료로 남은 것처럼 오래된 mtime의 tmp를 심는다.
  const stale = `${instancePath(8787, home)}.99999.tmp`;
  fs.writeFileSync(stale, '{"token":"leaked"}');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(stale, old, old);
  // 진행 중인 남의 tmp는 건드리지 않아야 한다(방금 만든 것).
  const fresh = `${instancePath(8787, home)}.88888.tmp`;
  fs.writeFileSync(fresh, '{"token":"inflight"}');

  assert.equal(writeInstanceFile({ port: 8787, token: 'mine', version: '1.8.0' }, home), true);
  assert.equal(fs.existsSync(stale), false, '오래된 tmp는 정리된다');
  assert.equal(fs.existsSync(fresh), true, '진행 중인 tmp는 보존된다');
});

test('port 0(랜덤)은 기록·조회 모두 비활성 — 파일 키가 성립하지 않는다', (t) => {
  const home = tmpHome(t);
  assert.equal(instancePath(0, home), null);
  assert.equal(writeInstanceFile({ port: 0, token: 'abc', version: '1.8.0' }, home), false);
  assert.equal(readInstanceFile(0, home), null);
  assert.equal(clearInstanceFile({ port: 0, token: 'abc' }, home), false);
});

test('없는 파일·손상 JSON·토큰 누락·포트 불일치는 모두 신원 미확인(null)', (t) => {
  const home = tmpHome(t);
  assert.equal(readInstanceFile(8787, home), null, '없는 파일');

  fs.mkdirSync(instanceDir(home), { recursive: true });
  const file = instancePath(8787, home);

  fs.writeFileSync(file, '{ this is not json');
  assert.equal(readInstanceFile(8787, home), null, '손상 JSON');

  fs.writeFileSync(file, JSON.stringify({ port: 8787, pid: 1 }));
  assert.equal(readInstanceFile(8787, home), null, '토큰 누락');

  fs.writeFileSync(file, JSON.stringify({ port: 9999, token: 'abc' }));
  assert.equal(readInstanceFile(8787, home), null, '기록된 포트가 조회 포트와 다름');

  fs.writeFileSync(file, JSON.stringify(['not', 'an', 'object']));
  assert.equal(readInstanceFile(8787, home), null, '객체가 아님');
});

test('pid·version이 없는 파일도 토큰만 유효하면 읽힌다(구버전 호환)', (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(instanceDir(home), { recursive: true });
  fs.writeFileSync(instancePath(8787, home), JSON.stringify({ port: 8787, token: 'abc' }));
  assert.deepEqual(readInstanceFile(8787, home), {
    port: 8787,
    token: 'abc',
    pid: null,
    version: null,
  });
});

// pid가 기록되지 않은 파일은 토큰만으로 소유권을 판정한다 — 구버전 데몬이 남긴
// 파일을 새 데몬이 정리할 수 있어야 한다(문서화된 조건과 실제 동작 일치 확인).
test('pid 없는 레코드는 토큰만 일치하면 삭제된다', (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(instanceDir(home), { recursive: true });
  fs.writeFileSync(instancePath(8787, home), JSON.stringify({ port: 8787, token: 'abc' }));
  assert.equal(clearInstanceFile({ port: 8787, token: 'nope', pid: 1 }, home), false);
  assert.equal(clearInstanceFile({ port: 8787, token: 'abc', pid: 1 }, home), true);
  assert.equal(fs.existsSync(instancePath(8787, home)), false);
});

test('삭제는 소유권 기반 — 내 토큰/pid일 때만 지운다', (t) => {
  const home = tmpHome(t);
  writeInstanceFile({ port: 8787, token: 'mine', pid: 111, version: '1.8.0' }, home);

  assert.equal(clearInstanceFile({ port: 8787, token: 'other', pid: 111 }, home), false, '남의 토큰');
  assert.ok(fs.existsSync(instancePath(8787, home)), '토큰이 다르면 파일이 남는다');

  assert.equal(clearInstanceFile({ port: 8787, token: 'mine', pid: 222 }, home), false, '남의 pid');
  assert.ok(fs.existsSync(instancePath(8787, home)), 'pid가 다르면 파일이 남는다');

  assert.equal(clearInstanceFile({ port: 8787, token: 'mine', pid: 111 }, home), true);
  assert.equal(fs.existsSync(instancePath(8787, home)), false);
  // 이미 없는 파일을 다시 지우려 해도 예외 없이 false.
  assert.equal(clearInstanceFile({ port: 8787, token: 'mine', pid: 111 }, home), false);
});

// 종료 중인 데몬 A가 후임 B의 파일을 지우지 않는지 — listener 해제 순서 규율의 근거.
test('후임 데몬이 같은 포트 파일을 덮어썼으면 구 데몬은 그것을 지우지 않는다', (t) => {
  const home = tmpHome(t);
  writeInstanceFile({ port: 8787, token: 'old', pid: 111, version: '1.7.1' }, home);
  // 후임 B가 발행 — 같은 경로를 원자적으로 갈아치운다.
  writeInstanceFile({ port: 8787, token: 'new', pid: 222, version: '1.8.0' }, home);

  assert.equal(clearInstanceFile({ port: 8787, token: 'old', pid: 111 }, home), false);
  assert.deepEqual(readInstanceFile(8787, home), {
    port: 8787,
    token: 'new',
    pid: 222,
    version: '1.8.0',
  });
});

test('write는 실패해도 예외를 던지지 않는다(신원 파일은 기동을 막지 않는다)', (t) => {
  const home = tmpHome(t);
  // 디렉터리 자리에 파일을 두어 mkdir을 실패시킨다.
  fs.writeFileSync(instanceDir(home), 'not a directory');
  assert.equal(writeInstanceFile({ port: 8787, token: 'abc', version: '1.8.0' }, home), false);
});
