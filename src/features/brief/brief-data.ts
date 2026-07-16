/**
 * F-Brief 데이터 — F-Report의 collectReportData를 재사용하고 엑셀만 건너뛴다.
 *
 * 요약 문구(인사/3지표/전기 대비)는 **AI를 거치지 않는다** — 코드가 문자열로 조립한다.
 * 물어본 적이 없으므로 AI가 이 숫자를 틀릴 확률은 0이다(설계 §3 1겹).
 */

import { collectReportData, type ReportData, type ReportTarget } from "@/features/report/report-build";
import { rangeText, type DateRange } from "@/features/report/report-period";
import { type ReportMetrics } from "@/features/report/report-data";
import { type BriefTableSpec } from "./brief-rules";
import { roasPct } from "./brief-rules";

export interface BriefData extends ReportData {
  range: DateRange;
  advertiserName: string;
}

export async function collectBriefData(target: ReportTarget, range: DateRange): Promise<BriefData> {
  // 담당자/작성일은 엑셀 표지 전용이라 문구엔 안 쓰인다. 빈 값으로 넘긴다.
  const data = await collectReportData(target, range, { authorName: "", createdDate: "" });
  return { ...data, range, advertiserName: target.name };
}

/** 기간 일수. "지난 30일 동안" 같은 표현에 쓴다. */
function dayCount(range: DateRange): number {
  const a = new Date(range.since).getTime();
  const b = new Date(range.until).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function won(n: number): string {
  return `${Math.round(n).toLocaleString()}원`;
}

/** 억/만 단위 반올림 — "약 34만 원 감소" 같은 표현용. 보고 로그의 관행. */
function approxWon(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `약 ${(abs / 100_000_000).toFixed(1)}억 원`;
  if (abs >= 10_000) return `약 ${Math.round(abs / 10_000).toLocaleString()}만 원`;
  return `약 ${Math.round(abs).toLocaleString()}원`;
}

/**
 * 요약 블록 — 인사 + 기간/범위 + 3지표 + 전기 대비.
 * 보고 로그 5건이 전부 이 형태다. AI 미경유(설계 §3 1겹).
 */
export function buildSummaryText(data: BriefData): string {
  const cur = data.model.totalCurrent;
  const prev = data.model.totalPrev;
  const scope = data.model.hasDisplay ? "검색광고, GFA 포함" : "검색광고";
  const curRoas = roasPct(cur);
  const prevRoas = roasPct(prev);

  const lines = [
    "안녕하세요:)",
    "",
    `지난 ${dayCount(data.range)}일 동안 ${scope}`,
    "",
    `▶광고비 : ${won(cur.cost)}`,
    `▶전환매출액 : ${won(cur.revenue)}`,
    `▶광고수익률 : ${curRoas.toFixed(2)}%로 집계되었습니다.`,
  ];

  // 전기 데이터가 전무하면 비교 문장을 만들지 않는다(신규 계정 등).
  if (prev.cost > 0) {
    const diff = cur.revenue - prev.revenue;
    const dir = diff >= 0 ? "증가" : "감소";
    const roasDir = curRoas >= prevRoas ? "상승" : "하락";
    lines.push(
      "",
      `지난 동기간 대비 매출은 ${approxWon(diff)} ${dir}하였으며, 수익률 또한 ` +
        `${prevRoas.toFixed(0)}% > ${curRoas.toFixed(0)}%로 ${roasDir}하는 추세를 보였습니다.`,
    );
  }

  return lines.join("\n");
}

/** 요약 표 — 문구 ①에 딸리는 사진. */
export function buildSummarySpec(data: BriefData): BriefTableSpec {
  const rows = ([
    ["설정 기간", data.model.totalCurrent],
    ["이전 기간", data.model.totalPrev],
  ] as Array<[string, ReportMetrics]>).map(([label, m]) => ({
    cells: [
      label,
      m.impressions.toLocaleString(),
      m.clicks.toLocaleString(),
      won(m.cost),
      String(m.purchaseConv),
      won(m.revenue),
      `${roasPct(m).toFixed(0)}%`,
    ],
  }));
  return {
    title: `${data.advertiserName} · ${rangeText(data.range)}`,
    columns: ["구분", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows,
  };
}

// Task 10의 brief.ts가 totals를 만들 때 같은 형식을 써야 검산이 안 어긋난다(두 곳 포맷 금지).
export { won, approxWon };
