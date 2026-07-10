// 스트리밍 텍스트의 부드러운 표시 페이서 (순수 함수 — rAF 프레임마다 호출).
//
// CLI는 text_delta를 수백 자 덩어리로 몰아 보내므로 delta 단위로 그대로 그리면
// 텍스트가 덜컥덜컥 나타난다. 대신 "지금까지 도착한 전체 텍스트(target)"와
// "화면에 드러낸 글자 수(shown)"를 분리하고, 매 프레임 남은 분량(backlog)의
// 시간 비례 몫만큼 전진시켜 타자기처럼 매끄럽게 드러낸다.
//  - backlog 비례라 유입 속도에 자동 적응: 빨리 오면 빨리, 멈추면 최소 속도로.
//  - 경과 시간(dt) 기반이라 주사율(60/144Hz)이나 rAF 스로틀링과 무관하게
//    같은 속도로 보인다 (프레임 수 기반이면 144Hz에서 2.4배 빨라진다 — 실측).
//  - streaming이 끝나면(false) 더 짧은 시정수로 빠르게 수렴한다.
//  - backlog가 MAX_LAG를 넘으면 초과분은 건너뛴다 — 체감 지연과 프레임당
//    마크다운 재파싱 비용의 상한.
// 표시 단위는 JS 코드 유닛이며, 서로게이트 쌍(이모지 등) 중간에서는 끊지 않는다.

/** 표시 지연 상한(코드 유닛) — 이보다 뒤처지면 초과분은 즉시 건너뛴다. */
export const MAX_LAG = 4000;

// 지수 수렴 시정수: 매 dt마다 backlog의 (dt/τ)만큼 전진 → backlog가 τ ms에
// 걸쳐 1/e 수준으로 준다. dt ≥ τ면 한 번에 전부 드러난다(장기 스로틀링 복귀).
const STREAM_TAU_MS = 400; // 스트리밍 중 등가 지연
const FLUSH_TAU_MS = 130; // 스트림 종료 후 잔여분 수렴
// 최소 전진 속도(코드 유닛/초) — backlog가 작을 때 꼬리를 질질 끌지 않기
const STREAM_MIN_CPS = 60;
const FLUSH_MIN_CPS = 240;

/**
 * 다음 프레임에 드러낼 글자 수를 계산한다.
 * @param {number} shown 현재 드러난 코드 유닛 수
 * @param {string} text 지금까지 도착한 전체 텍스트
 * @param {boolean} streaming 블록이 아직 스트리밍 중인지
 * @param {number} [dtMs] 직전 프레임 이후 경과 ms (기본 60Hz 한 프레임)
 * @returns {number} 다음 shown 값 (shown < text.length 이면 항상 전진)
 */
export function nextShown(shown, text, streaming, dtMs = 16.7) {
  const target = text.length;
  if (shown >= target) return target;

  let from = shown;
  let backlog = target - from;
  if (backlog > MAX_LAG) {
    from = target - MAX_LAG;
    backlog = MAX_LAG;
  }

  const dt = Math.max(1, dtMs);
  const frac = Math.min(1, dt / (streaming ? STREAM_TAU_MS : FLUSH_TAU_MS));
  const minStep = Math.ceil(((streaming ? STREAM_MIN_CPS : FLUSH_MIN_CPS) * dt) / 1000);
  const step = Math.max(1, minStep, Math.ceil(backlog * frac));
  let next = Math.min(target, from + step);

  // 서로게이트 쌍 중간이면 한 칸 더 — 잘린 이모지(�)가 한 프레임 비치는 것 방지
  if (next < target) {
    const code = text.charCodeAt(next - 1);
    if (code >= 0xd800 && code <= 0xdbff) next += 1;
  }
  return next;
}
