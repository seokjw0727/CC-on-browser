// lifecycle.js — 데몬 수명 정책 상태기계. bin(cc-on-browser.mjs)이 사용한다.
// 설계: .certify/design/2026-07-19-lid-close-session-survival.html §3.
//
// 핵심 구분: "의도적 탭 닫힘"(클라이언트 pagehide → WS 'bye' 신호)과
// "연결 유실"(노트북 리드 닫힘·절전·탭 freeze·브라우저 크래시).
//   · 의도적 닫힘으로 클라이언트가 0이 되면 → 기존 계약대로 짧은 유예 후 종료.
//   · 연결 유실이면 → 살아있는 CLI 세션이 있는 한 종료하지 않고 재접속을 기다린다
//     (리드 닫힘이 세션을 죽이던 돌연사 수정). 세션이 없으면 긴 유예 후 종료.
//
// 타이머 규율: 상태당 원샷 deadline 타이머 하나만 소유하고, 발화 시점에 현재
// 상태(count·세션·bye)를 재확인한다. 예정보다 LATE_SLOP 이상 늦은 발화는 절전
// 관통(프로세스 동결 후 재개)으로 보고 즉시 종료하지 않고 유예를 재앵커한다 —
// 잠금 화면에서 브라우저 탭이 아직 frozen인 시간을 확보하기 위해서다.

// 브라우저 종료 판정 유예 — 새로고침 재연결(ws.js 백오프 최대 5초)보다 넉넉하게.
export const IDLE_EXIT_GRACE_MS = 10_000;
// 기동 후 브라우저가 끝내 접속하지 않으면 고아 서버로 남지 않게 종료.
export const FIRST_CONNECT_GRACE_MS = 90_000;
// 연결 유실 + 살아있는 세션 없음 — Modern Standby에서 서버는 계속 돌므로,
// 세션 없는 리드 닫힘도 점심시간급 이석은 살아남도록 여유를 둔다.
export const SILENT_NO_SESSION_GRACE_MS = 30 * 60_000;
// 연결 유실 + 살아있는 세션 있음 — 세션 종료를 관측하기 위한 체인 폴링 간격.
export const SESSION_RECHECK_MS = 60_000;
// count 0 도달 시점 기준, 이 시간 내의 bye-close가 있어야 "의도적 닫힘"으로 판정.
export const BYE_RECENT_MS = 15_000;
// 타이머가 이보다 늦게 발화하면 절전 관통으로 간주하고 유예를 재앵커한다.
export const LATE_SLOP_MS = 30_000;

/**
 * @param {object} opts
 * @param {() => boolean} opts.hasLiveSessions exited 아닌 CLI 세션 존재 여부
 * @param {() => void} opts.shutdown 종료 실행(1회만 호출됨)
 * 나머지는 정책 수치·시계·타이머 주입(테스트용). 기본값은 위 상수.
 * @returns {{ onClientCountChange(count: number, meta?: {bye?: boolean}): void, dispose(): void }}
 *
 * 계약: onClientCountChange는 서버가 WS 연결/종료 때마다 호출한다.
 * 종료(close) 보고에만 meta 객체가 실리고({bye}), 연결(open) 보고는 meta 없이 온다 —
 * 이 구분으로 "신규 연결"에서만 bye 집계(episode)를 리셋한다.
 */
export function createLifecycle({
  hasLiveSessions,
  shutdown,
  idleExitGraceMs = IDLE_EXIT_GRACE_MS,
  firstConnectGraceMs = FIRST_CONNECT_GRACE_MS,
  silentNoSessionGraceMs = SILENT_NO_SESSION_GRACE_MS,
  sessionRecheckMs = SESSION_RECHECK_MS,
  byeRecentMs = BYE_RECENT_MS,
  lateSlopMs = LATE_SLOP_MS,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof hasLiveSessions !== 'function') throw new TypeError('hasLiveSessions is required');
  if (typeof shutdown !== 'function') throw new TypeError('shutdown is required');

  let disposed = false;
  let shutdownCalled = false;
  let count = 0;
  let lastByeCloseAt = -Infinity;
  let timer = null; // 단일 타이머 소유 — 상태 전이 시 항상 교체/해제
  // 타이머 세대 토큰 — 주입된 타이머 구현이 clear 후에도 콜백을 실행하는 경우까지
  // 방어한다(취소·교체된 구세대 콜백은 무시).
  let epoch = 0;

  const terminal = () => disposed || shutdownCalled;

  const fireShutdown = () => {
    if (terminal()) return;
    shutdownCalled = true;
    clearTimer();
    shutdown();
  };

  const clearTimer = () => {
    epoch += 1;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  /** 원샷 deadline. cb는 늦은 발화 판단용 lateBy(ms)를 받는다. */
  const arm = (delayMs, cb) => {
    clearTimer();
    const myEpoch = epoch;
    const expectedAt = now() + delayMs;
    timer = setTimeoutFn(() => {
      if (terminal() || epoch !== myEpoch) return; // 구세대/종결 후 콜백 무시
      timer = null;
      cb(now() - expectedAt);
    }, delayMs);
    timer?.unref?.();
  };

  // silent zero: 세션이 있으면 체인 폴링으로 종료를 관측하고, 없으면 긴 유예.
  const enterSilent = () => {
    if (hasLiveSessions()) armSessionPoll();
    else armSilentDeadline();
  };

  const armSessionPoll = () => {
    arm(sessionRecheckMs, () => {
      if (count > 0) return; // 방어 — 재접속 시 timer는 이미 해제된다
      enterSilent(); // 세션이 모두 끝났으면 "지금"부터 30분 규칙으로 전환
    });
  };

  const armSilentDeadline = () => {
    arm(silentNoSessionGraceMs, (lateBy) => {
      if (count > 0) return;
      if (lateBy >= lateSlopMs) {
        enterSilent(); // 절전 관통 — 지금 시각 기준으로 유예 재앵커
        return;
      }
      if (hasLiveSessions()) {
        enterSilent(); // 유예 중 세션이 생김(레이스 방어) — 세션 보호 우선
        return;
      }
      fireShutdown();
    });
  };

  const armFirstConnect = () => {
    arm(firstConnectGraceMs, (lateBy) => {
      if (count > 0) return;
      if (lateBy >= lateSlopMs) {
        armFirstConnect(); // 기동 직후 절전 — 복귀 후 브라우저에 다시 기회를 준다
        return;
      }
      fireShutdown();
    });
  };

  // 생성 즉시 최초 접속 대기 시작 — bin이 서버 기동 직후 생성한다.
  armFirstConnect();

  return {
    onClientCountChange(newCount, meta) {
      if (terminal()) return;
      count = newCount;
      const isClose = meta != null; // close 보고에만 meta가 실린다(위 계약 참조)
      if (isClose && meta.bye === true) lastByeCloseAt = now();

      if (newCount > 0) {
        // 신규 연결이면 이전 닫기 episode의 bye가 나중의 silent zero를
        // 오염시키지 않도록 집계를 리셋한다. (close로 2→1이 된 경우는 보존.)
        if (!isClose) lastByeCloseAt = -Infinity;
        clearTimer();
        return;
      }

      // count 0 도달 — zeroMode를 이 시점에 확정한다.
      if (now() - lastByeCloseAt <= byeRecentMs) {
        // 의도적 닫힘: 기존 계약대로 짧은 유예 후 종료.
        arm(idleExitGraceMs, (lateBy) => {
          if (count > 0) return;
          if (lateBy >= lateSlopMs) {
            enterSilent(); // 유예 중 절전 관통 — 생존 쪽으로 폴백
            return;
          }
          fireShutdown();
        });
      } else {
        enterSilent();
      }
    },

    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
