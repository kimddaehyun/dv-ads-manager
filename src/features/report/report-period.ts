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
// 증감표 라벨("설정 기간(07.06~07.12)")용 짧은 기간 표기 — **연도는 뺀다.**
// 연도까지 넣으면 B열이 그만큼 넓어지고, 그래프가 B~N 앵커라 그래프까지 같이 밀린다.
// 연도는 표지(periodText)에 전체 표기로 남으므로 여기선 중복이다.
// 해를 걸치는 기간(12.28~01.03)은 연도 없이도 읽히고, 정확한 기간은 표지에서 확인된다.
export function rangeText(range: DateRange): string {
  const monthDay = (iso: string) => iso.slice(5).replace("-", "."); // "2026-07-06" → "07.06"
  return `${monthDay(range.since)}~${monthDay(range.until)}`;
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
