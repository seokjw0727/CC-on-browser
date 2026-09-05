// shortcut.mjs — `cc-on-browser --shortcut` 구현. Windows 전용.
//
// 왜: npm이 만든 cc-on-browser.cmd 를 Win+R·탐색기에서 실행하면 cmd.exe 콘솔이 먼저
// 생겨 1~3초 깜빡인다(이미 만들어진 그 창은 Node가 숨길 수 없다). 그래서 콘솔을 아예
// 만들지 않는 실행 경로를 바로가기로 제공한다:
//   .lnk → wscript.exe //nologo "<bin>\cc-on-browser-silent.vbs" "<node.exe 절대경로>"
// wscript.exe 는 GUI 서브시스템이라 콘솔이 없고, .vbs 가 node 를 창 숨김으로 띄운다.
//
// node.exe 경로는 PATH 조회에 맡기지 않고 --shortcut 을 실행한 그 프로세스의
// process.execPath 를 .lnk 인수에 박는다 — 사용자의 PATH가 바뀌어도 그대로 동작한다.
// (Node를 재설치해 경로가 바뀌면 --shortcut 을 다시 실행하면 된다.)
//
// 바로가기 생성은 PowerShell의 WScript.Shell COM(CreateShortcut)으로 한다. .lnk 포맷을
// 직접 쓰지 않는 유일한 표준 경로다. 대상 폴더는 하드코딩하지 않고 셸 폴더 API로
// 해석한다 — 바탕화면이 OneDrive로 리다이렉트된 환경에서도 맞아야 하기 때문이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SHORTCUT_NAME = 'CC on Browser';
/**
 * v1.11.5까지 쓰던 바로가기 이름. 이 이름의 .lnk가 남아 있으면 새로 만든 뒤 지운다 —
 * 개명 후 --shortcut을 다시 실행한 사용자의 바탕화면에 같은 일을 하는 바로가기가 둘
 * 남지 않게 하려는 것이다. 우리가 만든 것(인수에 우리 .vbs 경로가 있는 것)만 건드린다.
 */
export const LEGACY_SHORTCUT_NAME = 'Claude Code on Browser';
/** 바로가기를 놓는 위치 — 하나만 성공해도 부분 성공으로 보고한다. */
export const SHORTCUT_TARGETS = ['Desktop', 'StartMenu'];

/**
 * .lnk의 Arguments 문자열. wscript는 공백 있는 경로를 따옴표로 구분해 받는다.
 * 순수 함수로 분리해 실제 바로가기를 만들지 않고도 회귀 테스트한다.
 */
export function buildShortcutArguments({ vbsPath, nodeExe }) {
  return `//nologo "${vbsPath}" "${nodeExe}"`;
}

/** 비-Windows 안내 — 콘솔 깜빡임은 Windows 셸 shim 고유 문제다. */
export function unsupportedMessage(platform) {
  return (
    `--shortcut is Windows-only (detected: ${platform}).\n`
    + 'On macOS/Linux there is no console window to hide: launching cc-on-browser\n'
    + 'from a terminal keeps the server in the background already.'
  );
}

// PowerShell 스크립트 — 결과를 대상마다 한 줄 JSON으로 내보낸다(ConvertTo-Json의
// -AsArray는 PowerShell 7+ 전용이라, 5.1에서도 안전하게 파싱되도록 줄 단위로 낸다).
function psScript({ vbsPath, nodeExe, version }) {
  const args = buildShortcutArguments({ vbsPath, nodeExe });
  // PowerShell 단일 인용 문자열 안에서 '는 ''로 이스케이프한다.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `$ErrorActionPreference = 'Stop'
$wsh = New-Object -ComObject WScript.Shell
$name = ${q(`${SHORTCUT_NAME}.lnk`)}
$legacyName = ${q(`${LEGACY_SHORTCUT_NAME}.lnk`)}
$vbsPath = ${q(vbsPath)}
$targets = @(
  @{ name = 'Desktop';   dir = [Environment]::GetFolderPath('Desktop') },
  @{ name = 'StartMenu'; dir = [Environment]::GetFolderPath('Programs') }
)
foreach ($t in $targets) {
  $out = @{ name = $t.name; ok = $false; path = ''; error = ''; removedLegacy = '' }
  try {
    if ([string]::IsNullOrEmpty($t.dir) -or -not (Test-Path -LiteralPath $t.dir)) {
      throw 'shell folder not found'
    }
    $lnk = Join-Path $t.dir $name
    $sc = $wsh.CreateShortcut($lnk)
    $sc.TargetPath = (Join-Path $env:WINDIR 'System32\\wscript.exe')
    $sc.Arguments = ${q(args)}
    $sc.WorkingDirectory = $HOME
    $sc.IconLocation = ${q(`${nodeExe},0`)}
    $sc.Description = ${q(`${SHORTCUT_NAME} v${version} (no console window)`)}
    $sc.Save()
    $out.ok = $true
    $out.path = $lnk
    # 개명 전 이름의 바로가기 정리. 인수에 우리 .vbs 경로가 들어 있는 것만 지운다 —
    # 우연히 같은 이름을 쓰는 남의 바로가기를 지우지 않기 위해서다. 실패는 삼킨다:
    # 정리는 부가 작업이라, 여기서 던지면 이미 성공한 생성이 실패로 보고된다.
    try {
      $legacy = Join-Path $t.dir $legacyName
      if ((Test-Path -LiteralPath $legacy) -and ($legacy -ne $lnk)) {
        $old = $wsh.CreateShortcut($legacy)
        if ($old.Arguments -and $old.Arguments.Contains($vbsPath)) {
          Remove-Item -LiteralPath $legacy -Force
          $out.removedLegacy = $legacy
        }
      }
    } catch { }
  } catch {
    $out.error = $_.Exception.Message
  }
  $out | ConvertTo-Json -Compress
}
# Windows Script Host가 정책으로 꺼져 있으면 .lnk는 만들어져도 클릭이 실패한다.
# 정책은 기기 전체(HKLM)와 사용자별(HKCU) 양쪽에 있을 수 있어 둘 다 본다 — 어느 쪽이든
# 0이면 비활성이다(codex 지적: HKLM만 보면 사용자별 차단을 놓친다).
$wshEnabled = $true
foreach ($hive in @('HKLM:', 'HKCU:')) {
  try {
    $v = Get-ItemProperty -LiteralPath ($hive + '\\SOFTWARE\\Microsoft\\Windows Script Host\\Settings') -Name Enabled -ErrorAction Stop
    if ([int]$v.Enabled -eq 0) { $wshEnabled = $false }
  } catch { }
}
@{ name = 'WshEnabled'; ok = $wshEnabled; path = ''; error = '' } | ConvertTo-Json -Compress
`;
}

/** PowerShell을 임시 .ps1로 실행 — -Command 인라인보다 인용 규칙이 단순하고 안전하다. */
function runPowerShell(script, { spawnFn = spawn, tmpdir = os.tmpdir() } = {}) {
  const file = path.join(tmpdir, `ccob-shortcut-${process.pid}.ps1`);
  // BOM을 붙여 PowerShell 5.1이 비-ASCII(한글 설명 문자열)를 UTF-8로 읽게 한다.
  fs.writeFileSync(file, `﻿${script}`, 'utf8');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (err) {
      try { fs.unlinkSync(file); } catch { /* noop */ }
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const finish = (code) => {
      try { fs.unlinkSync(file); } catch { /* noop */ }
      resolve({ code, stdout, stderr });
    };
    child.on('error', (err) => { stderr += String(err?.message ?? err); finish(-1); });
    child.on('close', finish);
  });
}

/** 한 줄 JSON들을 파싱 — 파싱 불가한 줄(경고 등)은 조용히 버린다. */
export function parseShortcutOutput(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.name === 'string') out.push(o);
    } catch { /* JSON이 아니면 버린다 */ }
  }
  return out;
}

/**
 * 바로가기 생성 실행. 성공 0 / 전부 실패 1을 돌려준다(부분 성공은 0 + 경고 출력).
 * @param {object} o
 * @param {string} o.pkgRoot 패키지 루트(bin/의 부모)
 * @param {string} o.version package.json 버전 — .lnk 설명에 남는다
 * @param {string} [o.platform] 테스트 주입
 * @param {string} [o.nodeExe] 테스트 주입
 * @param {(...a:any[])=>any} [o.spawnFn] 테스트 주입
 * @param {(...a:any[])=>void} [o.log] 테스트 주입
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function runShortcutCommand({
  pkgRoot,
  version,
  platform = process.platform,
  nodeExe = process.execPath,
  spawnFn = spawn,
  tmpdir = os.tmpdir(),
  log = console.log,
  logError = console.error,
} = {}) {
  if (platform !== 'win32') {
    logError(unsupportedMessage(platform));
    return 1;
  }
  const vbsPath = path.join(pkgRoot, 'bin', 'cc-on-browser-silent.vbs');
  if (!fs.existsSync(vbsPath)) {
    logError(`Launcher script not found:\n  ${vbsPath}\nReinstall the package and try again.`);
    return 1;
  }

  const { code, stdout, stderr } = await runPowerShell(
    psScript({ vbsPath, nodeExe, version }),
    { spawnFn, tmpdir },
  );
  const parsed = parseShortcutOutput(stdout);
  const wsh = parsed.find((r) => r.name === 'WshEnabled');
  const reported = new Map(
    parsed.filter((r) => SHORTCUT_TARGETS.includes(r.name)).map((r) => [r.name, r]),
  );
  // PowerShell이 중간에 죽으면 뒤쪽 대상의 결과 줄이 아예 안 나온다. "보고되지 않은
  // 대상"을 성공으로 오해하지 않도록 실패로 합성한다(codex 지적) — 그러면 부분 성공도
  // 정직하게 보고된다.
  const processError = stderr.trim() || (code !== 0 ? `powershell.exe exited with code ${code}` : '');
  const results = SHORTCUT_TARGETS.map(
    (name) => reported.get(name) ?? { name, ok: false, path: '', error: processError || 'not reported by PowerShell' },
  );

  if (!reported.size) {
    logError('Failed to create shortcuts — PowerShell produced no result.');
    if (processError) logError(processError);
    return 1;
  }

  const ok = results.filter((r) => r.ok);
  for (const r of results) {
    if (r.ok) log(`  created  ${r.name.padEnd(9)} ${r.path}`);
    else logError(`  FAILED   ${r.name.padEnd(9)} ${r.error || 'unknown error'}`);
    // 개명 전 바로가기를 치웠으면 말해 준다 — 말없이 사라지면 잃어버린 줄 안다.
    if (r.removedLegacy) log(`  removed  ${'(old name)'.padEnd(9)} ${r.removedLegacy}`);
  }
  // 일부만 성공해도 0으로 끝내되(쓸 수 있는 바로가기가 생겼다), 프로세스 오류는 남긴다.
  if (ok.length < results.length && processError) logError(processError);
  if (!ok.length) {
    logError('No shortcut could be created.');
    return 1;
  }
  log('');
  log(`Launch "${SHORTCUT_NAME}" from there and only your browser will appear —`);
  log('no console window. (Typing `cc-on-browser` in Win+R still shows one, because');
  log("npm's .cmd shim creates that console before Node can run.)");
  if (wsh && wsh.ok === false) {
    logError('');
    logError('WARNING: Windows Script Host is disabled by policy on this machine, so the');
    logError('shortcut will not run. Ask your administrator, or keep using `cc-on-browser`.');
  }
  return 0;
}
