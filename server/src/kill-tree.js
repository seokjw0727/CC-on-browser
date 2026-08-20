// kill-tree.js — 우리가 spawn한 자식과 그 **자식 트리**를 함께 종료한다.
// 원격 제어(remote-control.js)와 CLI 세션(claude-session.js)이 공유한다.
//
// 왜 공유하는가: 두 곳 모두 같은 문제를 푼다 — 우리가 띄운 자식 밑에 손자(셸·MCP
// 서버 등)가 달릴 수 있고, 데몬이 내려가기 전에 그 트리째 정리하지 않으면 고아가
// 남는다. 한쪽에만 트리 종료가 있으면 다른 쪽에서 같은 버그가 되살아난다.
//
// 플랫폼 차이: win32는 프로세스 그룹 시그널이 없어 taskkill /T로 트리를 열거해
// 죽이고, POSIX는 detached로 띄운 자식의 프로세스 그룹(-pid)에 시그널을 보낸다.
import { spawn } from 'node:child_process';

/**
 * 기본 트리 종료. win32는 taskkill /T, POSIX는 프로세스 그룹 시그널.
 * @param {number} pid 대상(우리가 spawn한 직속 자식)의 pid
 * @param {{platform: string, force: boolean}} opts force=false는 POSIX에서 SIGTERM
 * @returns {Promise<void>} best-effort — 실패해도 reject하지 않는다(호출측의 종료를 막지 않기 위해)
 */
export function killTree(pid, { platform, force }) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      let child;
      try {
        child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        resolve();
        return;
      }
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      return;
    }
    // detached로 띄웠으므로 -pid가 프로세스 그룹 전체다.
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* 이미 죽음 */
      }
    }
    resolve();
  });
}
