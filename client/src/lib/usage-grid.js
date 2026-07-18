// usage-grid.js — 사이드바 "돌아보기" 잔디(heatmap) 그리드 빌더 (순수 함수, DOM 무관).
// 서버 /api/usage-daily의 일별 시계열(오래된 날 → 오늘, 빈 날짜 0 버킷 포함)을
// GitHub 잔디 스타일 그리드(열 = 주, 행 = 요일·일요일 시작)로 변환한다.
// 주간 뷰 = weeks:12, 월간 뷰 = weeks:53(최근 1년) — 데이터는 한 번 받아 둘 다 파생.

/**
 * 서버의 'YYYY-MM-DD' 키를 로컬 날짜로 해석한다.
 * new Date('YYYY-MM-DD')는 UTC 자정으로 파싱돼 음수 오프셋 타임존에서 하루가
 * 밀린다 — 반드시 이 함수로만 해석할 것(설계도 §3 잔디 상세 규칙).
 */
export function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** parseDateKey의 역 — 로컬 날짜를 'YYYY-MM-DD' 키로 */
export function toDateKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

// 강도 레벨 0~4 — 0 토큰은 0, 그 외 창 내 최댓값 대비 4분위(최소 1).
// max가 0이면(전 구간 무사용) 모두 0이다.
function levelOf(total, max) {
  if (!total || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((4 * total) / max)));
}

/**
 * 잔디 그리드 빌드.
 * @param {[{date: string, totalTokens: number}]} series 서버 일별 시계열(오래된 → 오늘)
 * @param {{weeks: number}} opts 표시할 주(열) 수
 * @returns {{columns: Array<Array<null|{date, totalTokens, level}>>, monthLabels: [{col, label}], maxTotal: number}}
 *  columns[c][r] — c열(왼쪽=과거) r행(0=일요일). null = 범위 밖(미래 또는 데이터 창 밖).
 */
export function buildHeatmap(series, { weeks }) {
  const list = Array.isArray(series) ? series : [];
  if (list.length === 0 || !Number.isFinite(weeks) || weeks < 1) {
    return { columns: [], monthLabels: [], maxTotal: 0 };
  }
  const byDate = new Map(list.map((d) => [d.date, d]));
  const end = parseDateKey(list[list.length - 1].date); // 시계열 마지막 날 = 오늘
  // 마지막 열의 일요일에서 (weeks-1)주 전 일요일이 그리드 원점
  const gridStart = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() - end.getDay() - (weeks - 1) * 7,
  );

  // 창 내 최댓값 — 그리드에 실제로 실리는 셀 기준(전체 시계열이 아니라 표시 창)
  let maxTotal = 0;
  const cellAt = (offsetDays) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + offsetDays);
  for (let i = 0; i < weeks * 7; i++) {
    const day = byDate.get(toDateKey(cellAt(i)));
    if (day && day.totalTokens > maxTotal) maxTotal = day.totalTokens;
  }

  const columns = [];
  const monthLabels = [];
  let prevMonth = -1;
  for (let c = 0; c < weeks; c++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const date = cellAt(c * 7 + r);
      const day = byDate.get(toDateKey(date));
      // 미래(오늘 이후)와 데이터 창 밖은 null — CSS가 빈 칸으로 그린다
      col.push(
        day
          ? { date: day.date, totalTokens: day.totalTokens, level: levelOf(day.totalTokens, maxTotal) }
          : null,
      );
    }
    columns.push(col);
    // 월 라벨 — 열 머리(일요일)의 달이 바뀌는 열에 표기 (GitHub 관례)
    const headMonth = cellAt(c * 7).getMonth();
    if (headMonth !== prevMonth) {
      monthLabels.push({ col: c, label: `${headMonth + 1}월` });
      prevMonth = headMonth;
    }
  }
  return { columns, monthLabels, maxTotal };
}
