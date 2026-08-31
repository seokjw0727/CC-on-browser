// 사용량 한도 알림 — 5시간/7일 창이 한도에 걸리거나 다시 풀릴 때 브라우저 알림을 띄운다.
//
// 데이터는 이미 도는 60초 /api/usage 폴링의 공식 사용률(quota)뿐이다. 새 요청도,
// 서버 변경도, CLI 호출도 없다 — 이 기능은 토큰을 한 톨도 쓰지 않는다.
//
// 이 파일은 두 층으로 나뉜다.
//   ① 전이 판정(detectLimitTransitions)은 순수 함수다. 브라우저 전역이 없는
//      node --test에서도 그대로 돌아간다.
//   ② Notification·localStorage를 만지는 층은 전부 scope/storage 주입을 받고
//      가드로 감싼다. 지원하지 않는 브라우저·차단된 저장소에서 조용히 접힌다.
import { fmtReset } from './format.js';
import { readPref, writePref } from './preferences.js';

export const LIMIT_NOTIFY_KEY = 'ccob-limit-notify';

// 공식 사용률이 이 값에 닿으면 "한도 체결"로 본다. /usage 패널과 같은 기준.
export const LIMIT_THRESHOLD = 100;

// 판정 순서 = 알림이 나가는 순서.
// name은 알림 제목용(짧게), label은 본문용 — Sidebar 통계의 행 이름과 같은 말을 쓴다.
export const LIMIT_WINDOWS = [
  { key: 'fiveHour', name: '5시간', label: '5시간 창' },
  { key: 'sevenDay', name: '7일', label: '7일 창' },
];

/**
 * 한 창의 사용률 — 값이 없거나 수가 아니면 null(= 판정 불가).
 *
 * Number()로 강제 변환하지 않는다. Number(null)·Number('')·Number([])는 전부 0이라,
 * 값이 **없는** 창이 "0%"로 둔갑해 있지도 않은 해제 알림을 띄운다(테스트가 잡은 실제
 * 버그). 서버는 이미 quota.js에서 수치를 검증해 보내므로, 여기서 숫자가 아닌 것이
 * 왔다면 그건 값이 아니라 부재다.
 */
function utilizationOf(w) {
  const u = w?.utilization;
  return typeof u === 'number' && Number.isFinite(u) ? u : null;
}

/**
 * 직전 quota와 새 quota를 견줘 창별 임계 전이만 뽑는다.
 *
 * 넘기는 것은 **reducer가 병합한 뒤의** quota여야 한다(store-reducer의 set-usage).
 * 조회가 창 하나만 실패해도 서버는 그 창을 빼고 보내므로, 병합 전 원본을 보면
 * 빠진 창이 "해제"로, 다음 폴링에 "체결"로 오인된다.
 *
 * 판정 불가(둘 중 한쪽이라도 값이 없음)는 전이가 아니라 기준선이다 — 조용히 건너뛴다.
 * 앱을 켠 직후 첫 값도 마찬가지다(호출측이 prev=null로 넘긴다). 그러지 않으면
 * 이미 한도에 걸린 상태로 새로고침할 때마다 같은 알림이 다시 뜬다.
 */
export function detectLimitTransitions(prevQuota, nextQuota) {
  const out = [];
  for (const { key, name, label } of LIMIT_WINDOWS) {
    const prev = utilizationOf(prevQuota?.[key]);
    const next = utilizationOf(nextQuota?.[key]);
    if (prev === null || next === null) continue;
    const wasHit = prev >= LIMIT_THRESHOLD;
    const isHit = next >= LIMIT_THRESHOLD;
    if (wasHit === isHit) continue;
    out.push({
      window: key,
      name,
      label,
      kind: isHit ? 'hit' : 'release',
      utilization: next,
      resetsAt: nextQuota?.[key]?.resetsAt ?? null,
    });
  }
  return out;
}

/**
 * 전이 하나를 알림 내용으로.
 *
 * tag는 **창마다 하나**다(방향을 넣지 않는다). 알림 센터는 기록장이 아니라 지금 상태를
 * 보여 주는 자리라서, 해제 알림이 직전 체결 알림을 밀어내는 편이 옳다 — 방향까지 갈라
 * 두면 이미 풀린 창의 "한도 도달"이 "해제" 옆에 그대로 남아 거짓말을 한다.
 * 덤으로 탭이 여럿이거나 같은 전이가 겹쳐 잡혀도 알림 하나로 접힌다.
 *
 * 창 이름은 제목에 넣는다. 본문은 OS·설정에 따라 잘리거나 접히지만 제목은 거의 항상
 * 보이는데, 두 창이 한꺼번에 걸리면 제목이 같아서는 무엇이 걸렸는지 알 수 없다.
 */
export function notificationPayload(t) {
  const pct = Math.round(t.utilization);
  const tag = `ccob-limit-${t.window}`;
  if (t.kind === 'hit') {
    const reset = fmtReset(t.resetsAt);
    return {
      title: `${t.name} 사용량 한도 도달`,
      body: reset
        ? `${t.label}을 다 썼습니다 (${pct}%). ${reset}에 초기화됩니다.`
        : `${t.label}을 다 썼습니다 (${pct}%).`,
      tag,
    };
  }
  return {
    title: `${t.name} 사용량 한도 해제`,
    body: `${t.label}이 다시 열렸습니다 (${pct}%).`,
    tag,
  };
}

/** Notification API가 있는가 — 없으면 설정 토글도 비활성으로 둔다. */
export function notificationsSupported(scope = globalThis) {
  try {
    return typeof scope?.Notification === 'function';
  } catch {
    return false;
  }
}

/** 현재 권한. 미지원 브라우저는 'unsupported' — 'denied'와 구분해 문구를 가른다. */
export function notificationPermission(scope = globalThis) {
  if (!notificationsSupported(scope)) return 'unsupported';
  try {
    return scope.Notification.permission ?? 'default';
  } catch {
    return 'unsupported';
  }
}

/**
 * 권한 요청 — 반드시 사용자 제스처(토글 클릭) 안에서 부른다. 브라우저는 제스처 밖의
 * 요청을 그냥 거절한다. 이미 granted/denied면 다시 묻지 않는다(다시 물어도 안 뜬다).
 */
export async function requestNotificationPermission(scope = globalThis) {
  if (!notificationsSupported(scope)) return 'unsupported';
  const N = scope.Notification;
  const current = notificationPermission(scope);
  if (current === 'granted' || current === 'denied') return current;
  // 구형 구현(사파리 ≤15)은 Promise 없이 콜백으로만 답한다. 호출은 **한 번**만 하고
  // 두 경로를 함께 받는다 — 나눠 부르면 브라우저가 권한 창을 두 번 띄운다.
  // 표준 구현도 넘겨준 콜백을 그대로 불러 주므로 이 한 번으로 양쪽이 덮인다.
  return new Promise((resolve) => {
    let settled = false;
    const settle = (p) => {
      if (settled) return;
      settled = true;
      resolve(p || notificationPermission(scope));
    };
    let returned;
    try {
      returned = N.requestPermission(settle);
    } catch {
      settle();
      return;
    }
    // Promise를 준 표준 구현은 그걸로 끝낸다. 아무것도 돌려주지 않았다면 콜백 전용
    // 구현이라는 뜻이므로 **기다린다** — 여기서 곧장 settle하면 사용자가 권한 창에
    // 답하기도 전에 'default'로 확정해 버려 구형 지원이 말뿐이 된다.
    if (returned && typeof returned.then === 'function') returned.then(settle, () => settle());
  });
}

// storage를 넘기지 않으면 readPref/writePref의 기본값(localStorage)이 그대로 걸린다 —
// 기본 매개변수는 undefined일 때 발동하므로 여기서 따로 갈라 줄 필요가 없다.

/** 설정에 저장된 켬/끔 — 기본값은 꺼짐이다(알림은 사용자가 먼저 요청해야 한다). */
export function limitNotifyEnabled(storage) {
  return readPref(LIMIT_NOTIFY_KEY, storage) === '1';
}

/** 켬/끔 저장. 끄면 키를 지운다(writePref의 빈 문자열 = 삭제). */
export function setLimitNotifyEnabled(on, storage) {
  return writePref(LIMIT_NOTIFY_KEY, on ? '1' : '', storage);
}

/**
 * 알림 한 건 발송. 관문이 셋(설정 켬 · API 지원 · 권한 granted)이고 하나라도 어긋나면
 * 아무 일도 없었던 듯 false를 준다 — 알림은 부수 효과라 실패가 화면을 깨선 안 된다.
 */
export function sendLimitNotification(t, { scope = globalThis, storage } = {}) {
  if (!limitNotifyEnabled(storage)) return false;
  if (notificationPermission(scope) !== 'granted') return false;
  const { title, body, tag } = notificationPayload(t);
  try {
    new scope.Notification(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}

/**
 * 감지 + 발송을 묶은 호출측 진입점(App.jsx의 폴링 감시 effect가 쓴다).
 * 반환값은 실제로 띄운 전이 목록 — 테스트가 관문 동작을 그대로 확인할 수 있다.
 */
export function notifyLimitTransitions(prevQuota, nextQuota, opts = {}) {
  const sent = [];
  for (const t of detectLimitTransitions(prevQuota, nextQuota)) {
    if (sendLimitNotification(t, opts)) sent.push(t);
  }
  return sent;
}
