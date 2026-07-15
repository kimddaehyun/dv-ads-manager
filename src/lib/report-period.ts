// F-Report 기간 프리셋 + 직전 동일기간 계산.
//
// 스크린샷(140030.png)의 프리셋: 오늘/어제/이번주/지난주/최근7일(오늘 포함·제외)/
// 이번달/지난달/최근30일(오늘 포함·제외). 증감 비교용 직전 동일기간도 여기서 계산.
//
// 모든 함수는 기준일(today)을 인자로 받아 순수하게 동작 — 테스트 가능.

export type ReportPreset =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "last7Incl"
  | "last7Excl"
  | "thisMonth"
  | "lastMonth"
  | "last30Incl"
  | "last30Excl";

export interface DateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD (inclusive)
}

export const PRESET_LABELS: Record<ReportPreset, string> = {
  today: "오늘",
  yesterday: "어제",
  thisWeek: "이번주",
  lastWeek: "지난주",
  last7Incl: "최근 7일(오늘 포함)",
  last7Excl: "최근 7일(오늘 제외)",
  thisMonth: "이번달",
  lastMonth: "지난달",
  last30Incl: "최근 30일(오늘 포함)",
  last30Excl: "최근 30일(오늘 제외)",
};

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// 월요일 시작 주의 월요일을 반환 (네이버는 월~일 주 단위).
function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const dow = (r.getDay() + 6) % 7; // 월=0 ... 일=6
  return addDays(r, -dow);
}

export function rangeForPreset(preset: ReportPreset, today: Date): DateRange {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (preset) {
    case "today":
      return { since: iso(t), until: iso(t) };
    case "yesterday": {
      const y = addDays(t, -1);
      return { since: iso(y), until: iso(y) };
    }
    case "thisWeek": {
      const s = startOfWeek(t);
      return { since: iso(s), until: iso(t) };
    }
    case "lastWeek": {
      const s = addDays(startOfWeek(t), -7);
      return { since: iso(s), until: iso(addDays(s, 6)) };
    }
    case "last7Incl":
      return { since: iso(addDays(t, -6)), until: iso(t) };
    case "last7Excl":
      return { since: iso(addDays(t, -7)), until: iso(addDays(t, -1)) };
    case "thisMonth": {
      const s = new Date(t.getFullYear(), t.getMonth(), 1);
      return { since: iso(s), until: iso(t) };
    }
    case "lastMonth": {
      const s = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const e = new Date(t.getFullYear(), t.getMonth(), 0);
      return { since: iso(s), until: iso(e) };
    }
    case "last30Incl":
      return { since: iso(addDays(t, -29)), until: iso(t) };
    case "last30Excl":
      return { since: iso(addDays(t, -30)), until: iso(addDays(t, -1)) };
  }
}

// "2026.06.01~2026.06.30" — 증감표 기간 라벨용. 표지(periodText)는 " ~ "(공백 포함)라 별개.
export function rangeText(range: DateRange): string {
  return `${range.since.replace(/-/g, ".")}~${range.until.replace(/-/g, ".")}`;
}

// 직전 동일기간 (설정 기간 → 이전 기간). 같은 일수만큼 바로 앞으로 당긴다.
export function previousRange(range: DateRange): DateRange {
  const since = new Date(range.since + "T00:00:00");
  const until = new Date(range.until + "T00:00:00");
  const days = Math.round((until.getTime() - since.getTime()) / 86400000) + 1;
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -(days - 1));
  return { since: iso(prevSince), until: iso(prevUntil) };
}

// 기간 내 날짜 목록 (일자별 시트 행 생성용).
export function eachDay(range: DateRange): Date[] {
  const out: Date[] = [];
  let d = new Date(range.since + "T00:00:00");
  const end = new Date(range.until + "T00:00:00");
  while (d.getTime() <= end.getTime()) {
    out.push(new Date(d));
    d = addDays(d, 1);
  }
  return out;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// "06/15 (월)" 형식 — 양식 일자별 라벨과 동일.
export function dayLabel(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}/${day} (${WEEKDAYS[d.getDay()]})`;
}

// advanced-report ymd 값("2026.06.22.") → "YYYY-MM-DD" 매칭 키.
export function ymdToIso(ymd: string): string {
  const m = ymd.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ymd;
}

// ── 브랜드검색 계약 일할 계산(proration) ──
//
// 브랜드검색/신제품검색은 계약(구좌) 기반이라 소진비용(salesAmt)이 0이다. 비용은 계약금액
// (contractAmt)을 리포트 기간에 실제 집행(노출)된 일수만큼만 안분해 잡는다.
//   1일 단가 = contractAmt ÷ 총 계약일수(contractStartDt~contractEndDt)
//   비용     = 1일 단가 × (리포트 기간 ∩ 실집행 기간)의 일수
//
// 날짜 필드는 모두 UTC ISO("2026-07-07T15:00:00.000Z"). KST(+9h) 기준 day-number로 환산해
// 계산한다. 종료 경계는 배타적(exclusive): contractEndDt의 KST 날짜는 "마지막 집행일의 다음 날"
// (multi-account의 D-day 계산 computeMinDday와 동일 규칙). exposureEndDt/cancelTm도 동일.
// 기간 내 중단/종료(취소·노출종료)는 실집행 끝을 그만큼 앞당겨 반영한다.

export interface ProrationContract {
  contractAmt: number;
  contractStartDt?: string;
  contractEndDt?: string;
  exposureStartDt?: string; // 실제 노출 시작 (있으면 시작을 늦춤)
  exposureEndDt?: string;   // 실제 노출 종료 (있으면 끝을 앞당김)
  cancelTm?: string;        // 취소 시각 (있으면 끝을 앞당김)
}

// UTC ISO → KST 기준 day-number (epoch부터의 일수). +9h 후 UTC 날짜로 환산해 호스트 TZ 무관.
function kstDayNum(utcIso: string): number {
  return Math.floor((new Date(utcIso).getTime() + 9 * 3600 * 1000) / 86400000);
}
// "YYYY-MM-DD"(KST 캘린더 날짜) → day-number.
function isoDayNum(isoDate: string): number {
  return Math.floor(new Date(isoDate + "T00:00:00Z").getTime() / 86400000);
}

// 계약 1건의 리포트 기간 내 일할 비용. 겹치는 집행일 없으면 0.
export function proratedContractAmount(c: ProrationContract, range: DateRange): number {
  const amt = c.contractAmt || 0;
  if (amt <= 0) return 0;
  if (!c.contractStartDt || !c.contractEndDt) return 0; // 일할 불가(정상 응답엔 항상 존재)
  const cStart = kstDayNum(c.contractStartDt); // 첫 집행일 (포함)
  const cEnd = kstDayNum(c.contractEndDt);     // 종료 경계 (배타)
  const totalDays = cEnd - cStart;
  if (!Number.isFinite(totalDays) || totalDays <= 0) return 0;

  // 실집행 구간을 노출/취소로 좁힌다.
  let aStart = cStart;
  let aEnd = cEnd;
  if (c.exposureStartDt) { const v = kstDayNum(c.exposureStartDt); if (Number.isFinite(v)) aStart = Math.max(aStart, v); }
  if (c.exposureEndDt) { const v = kstDayNum(c.exposureEndDt); if (Number.isFinite(v)) aEnd = Math.min(aEnd, v); }
  if (c.cancelTm) { const v = kstDayNum(c.cancelTm); if (Number.isFinite(v)) aEnd = Math.min(aEnd, v); }

  // 리포트 기간 [since, until](둘 다 포함) → 배타 끝 +1.
  const rStart = isoDayNum(range.since);
  const rEnd = isoDayNum(range.until) + 1;
  const overlap = Math.max(0, Math.min(aEnd, rEnd) - Math.max(aStart, rStart));
  if (overlap <= 0) return 0;
  return Math.round((amt / totalDays) * overlap);
}

export interface ProratedBrand {
  total: number; // 일할 비용 합계
  byAdgroup: Map<string, number>; // 광고그룹ID → 일할 비용
}

// 계약 목록(광고그룹ID 포함)을 한 리포트 기간으로 일할 집계. PC/모바일이 별도 계약 행이라도
// 광고그룹별로 합산된다.
export function proratedBrand(
  contracts: Array<ProrationContract & { adgroupId: string }>,
  range: DateRange,
): ProratedBrand {
  const byAdgroup = new Map<string, number>();
  let total = 0;
  for (const c of contracts) {
    const amt = proratedContractAmount(c, range);
    if (amt <= 0) continue;
    byAdgroup.set(c.adgroupId, (byAdgroup.get(c.adgroupId) ?? 0) + amt);
    total += amt;
  }
  return { total, byAdgroup };
}
