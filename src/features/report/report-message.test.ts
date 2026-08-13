/**
 * F-Report 문구 재료 조립(`buildSummaryPayload`) 단위 테스트.
 *
 * AI 출력 자체는 검증할 수 없으므로, **AI에게 무엇을 주는가**를 잠근다.
 * 저효율 문턱(계정 규모 비례)·매체 분기·이전 기간 케이스 분리·성별 격차 가드가 대상.
 */

import { describe, expect, it } from "vitest";
import { buildSummaryPayload } from "./report-message";
import { type ReportData } from "./report-build";
import { type ReportMetrics } from "./report-data";

const RANGE = { since: "2026-07-14", until: "2026-08-12" };

function met(o: Partial<ReportMetrics> = {}): ReportMetrics {
  return { impressions: 0, clicks: 0, cost: 0, purchaseConv: 0, revenue: 0, directConv: 0, indirectConv: 0, ...o };
}

/** 전환 0 저효율 행 — 비용만 주면 된다. */
const zero = (cost: number) => met({ cost, clicks: 10, impressions: 100 });

interface Fixture {
  totalCost?: number;
  prevTotalCost?: number;
  keywords?: { keyword: string; metrics: ReportMetrics }[];
  groups?: { type: string; group: string; metrics: ReportMetrics }[];
  byGender?: { label: string; metrics: ReportMetrics }[];
}

function makeData(f: Fixture = {}): ReportData {
  const model = {
    totalCurrent: met({ cost: f.totalCost ?? 1_000_000, revenue: 3_000_000, purchaseConv: 20 }),
    totalPrev: met({ cost: f.prevTotalCost ?? 900_000, revenue: 2_500_000, purchaseConv: 18 }),
    displayCurrent: met(),
    byGender: f.byGender ?? [],
  };
  return {
    model,
    searchTypes: [],
    displayData: { total: met(), byType: [], byCampaign: [] },
    campGroups: (f.groups ?? []).map((g) => ({
      type: g.type,
      rows: [{ campaign: "캠페인A", group: g.group, metrics: g.metrics }],
    })),
    plKeywords: [{ campaign: "캠페인A", group: "그룹1", keywords: f.keywords ?? [] }],
    shKeywords: [],
    shProducts: [],
    shProductAdRows: [],
    shProductInfo: new Map(),
  } as unknown as ReportData;
}

const build = (f: Fixture = {}, prev?: Map<string, ReportMetrics> | null) =>
  buildSummaryPayload("테스트업체", makeData(f), RANGE, prev);

const names = (lines: string[]) => lines.join("\n");

describe("저효율 금액 문턱 - 계정 규모 비례", () => {
  const kw = (cost: number) => [{ keyword: "원피스", metrics: zero(cost) }];

  it("소액 계정(총 30만원)은 하한 5천원이 적용된다", () => {
    // 30만 x 1.5% = 4,500 → 하한 5,000
    expect(names(build({ totalCost: 300_000, keywords: kw(6_000) }).lowKeywordLines)).toContain("원피스");
    expect(build({ totalCost: 300_000, keywords: kw(4_000) }).lowKeywordLines).toEqual([]);
  });

  it("큰 계정(총 1,000만원)은 문턱이 15만원으로 올라 소액 키워드가 빠진다", () => {
    expect(build({ totalCost: 10_000_000, keywords: kw(6_000) }).lowKeywordLines).toEqual([]);
    expect(names(build({ totalCost: 10_000_000, keywords: kw(160_000) }).lowKeywordLines)).toContain("원피스");
  });

  it("초대형 계정도 상한 20만원을 넘지 않는다", () => {
    // 1억 x 1.5% = 150만 → 상한 20만
    expect(names(build({ totalCost: 100_000_000, keywords: kw(250_000) }).lowKeywordLines)).toContain("원피스");
    expect(build({ totalCost: 100_000_000, keywords: kw(190_000) }).lowKeywordLines).toEqual([]);
  });

  it("총광고비가 0이면 기본 5천원", () => {
    expect(names(build({ totalCost: 0, keywords: kw(6_000) }).lowKeywordLines)).toContain("원피스");
  });
});

describe("광고그룹 저효율 - 매체 분기", () => {
  const groups = [
    { type: "파워링크", group: "PL그룹", metrics: zero(50_000) },
    { type: "쇼핑검색광고", group: "SH그룹", metrics: zero(40_000) },
    { type: "플레이스", group: "PLC그룹", metrics: zero(30_000) },
    { type: "파워컨텐츠", group: "PC그룹", metrics: zero(20_000) },
    { type: "브랜드검색/신제품검색", group: "BR그룹", metrics: zero(60_000) },
  ];

  it("파워링크와 쇼핑검색은 주력 묶음으로 간다", () => {
    const out = names(build({ groups }).lowGroupLines);
    expect(out).toContain("PL그룹");
    expect(out).toContain("SH그룹");
    expect(out).not.toContain("PLC그룹");
  });

  it("플레이스와 파워컨텐츠는 보조 묶음으로 간다", () => {
    const out = names(build({ groups }).lowSubGroupLines);
    expect(out).toContain("PLC그룹");
    expect(out).toContain("PC그룹");
    expect(out).not.toContain("PL그룹");
  });

  it("브랜드검색/신제품검색은 어느 묶음에도 안 들어간다", () => {
    const p = build({ groups });
    expect(names([...p.lowGroupLines, ...p.lowSubGroupLines])).not.toContain("BR그룹");
  });
});

describe("키워드 저효율 - 이전 기간 케이스 분리", () => {
  const keywords = [
    { keyword: "계속나쁨", metrics: zero(30_000) },
    { keyword: "이번만나쁨", metrics: zero(25_000) },
    { keyword: "새검색어", metrics: zero(20_000) },
  ];
  const prev = new Map<string, ReportMetrics>([
    ["계속나쁨", zero(28_000)], // 문턱 이상 쓰고 전환 0 → 두 기간 모두 부진
    ["이번만나쁨", met({ cost: 20_000, purchaseConv: 3, revenue: 300_000 })],
  ]);

  it("두 기간 모두 전환이 없으면 Both로", () => {
    const p = build({ keywords }, prev);
    expect(names(p.lowKeywordBothLines)).toContain("계속나쁨");
    expect(names(p.lowKeywordBothLines)).not.toContain("이번만나쁨");
  });

  it("이전 기간에 전환이 있었으면 Recent로", () => {
    expect(names(build({ keywords }, prev).lowKeywordRecentLines)).toContain("이번만나쁨");
  });

  it("이전 기간에 없던 검색어는 Recent로 보내고 집행 없음을 명시한다", () => {
    const out = names(build({ keywords }, prev).lowKeywordRecentLines);
    expect(out).toContain("새검색어");
    expect(out).toContain("이전 기간 집행 없음");
  });

  it("케이스를 나눴으면 기존 단일 묶음은 비운다(프롬프트 중복 방지)", () => {
    expect(build({ keywords }, prev).lowKeywordLines).toEqual([]);
  });

  it("이전 기간 조회 실패(null)면 기존 단일 묶음으로 폴백한다", () => {
    const p = build({ keywords }, null);
    expect(names(p.lowKeywordLines)).toContain("계속나쁨");
    expect(p.lowKeywordBothLines).toEqual([]);
    expect(p.lowKeywordRecentLines).toEqual([]);
  });

  it("이전 기간에 문턱 미만으로만 썼으면 두 기간 부진으로 보지 않는다", () => {
    const thin = new Map<string, ReportMetrics>([["계속나쁨", zero(1_000)]]);
    const p = build({ keywords: [keywords[0]] }, thin);
    expect(p.lowKeywordBothLines).toEqual([]);
    expect(names(p.lowKeywordRecentLines)).toContain("계속나쁨");
  });

  it("이전 기간 금액은 이전 기간 문턱으로 잰다(계정 규모가 기간 사이에 변한 경우)", () => {
    // 이번 총 1,000만원(문턱 15만) vs 이전 총 30만원(문턱 5천).
    // 이전 1만원은 그 기간 기준으로는 유의미한 금액이므로 "두 기간 모두 부진"이 맞다.
    const kw = [{ keyword: "계속나쁨", metrics: zero(200_000) }];
    const prevSmall = new Map<string, ReportMetrics>([["계속나쁨", zero(10_000)]]);
    const p = build({ totalCost: 10_000_000, prevTotalCost: 300_000, keywords: kw }, prevSmall);
    expect(names(p.lowKeywordBothLines)).toContain("계속나쁨");
    expect(p.lowKeywordRecentLines).toEqual([]);
  });
});

describe("성별 성과 - 격차 가드", () => {
  const g = (label: string, cost: number, revenue: number) => ({ label, metrics: met({ cost, revenue }) });

  it("ROAS가 1.5배 이상 벌어지면 두 줄을 보낸다", () => {
    // 남 ROAS 200%, 여 ROAS 400%
    const out = build({ byGender: [g("남성", 100_000, 200_000), g("여성", 100_000, 400_000)] }).genderLines;
    expect(out).toHaveLength(2);
    expect(names(out)).toContain("남성");
    expect(names(out)).toContain("여성");
  });

  it("격차가 작으면 보내지 않는다", () => {
    // 남 200%, 여 240% → 1.2배
    expect(build({ byGender: [g("남성", 100_000, 200_000), g("여성", 100_000, 240_000)] }).genderLines).toEqual([]);
  });

  it("한쪽 광고비가 문턱 미만이면 대조군이 없어 보내지 않는다", () => {
    expect(build({ byGender: [g("남성", 100_000, 400_000), g("여성", 1_000, 0)] }).genderLines).toEqual([]);
  });

  it("한쪽만 매출 0이면 격차로 보고 보낸다", () => {
    expect(build({ byGender: [g("남성", 100_000, 400_000), g("여성", 100_000, 0)] }).genderLines).toHaveLength(2);
  });

  it("양쪽 다 매출이 0이면 보내지 않는다", () => {
    expect(build({ byGender: [g("남성", 100_000, 0), g("여성", 100_000, 0)] }).genderLines).toEqual([]);
  });

  it("알수없음만 있으면 보내지 않는다", () => {
    expect(build({ byGender: [g("알수없음", 500_000, 2_000_000)] }).genderLines).toEqual([]);
  });

  it("성별 데이터가 없으면(검색광고 제외 리포트) 빈 배열", () => {
    expect(build({ byGender: [] }).genderLines).toEqual([]);
  });

  it("알수없음은 격차가 커도 줄에 포함하지 않는다", () => {
    const out = names(build({
      byGender: [g("남성", 100_000, 200_000), g("여성", 100_000, 400_000), g("알수없음", 100_000, 10_000)],
    }).genderLines);
    expect(out).not.toContain("알수없음");
  });
});

describe("정보성 판별용 키워드 목록", () => {
  it("광고비 상위 50개까지만 보낸다", () => {
    const keywords = Array.from({ length: 70 }, (_, i) => ({
      keyword: `키워드${i}`,
      metrics: met({ cost: (i + 1) * 1_000, revenue: 10_000, purchaseConv: 1, clicks: 5 }),
    }));
    const out = build({ keywords }).infoCandidateLines;
    expect(out).toHaveLength(50);
    expect(names(out)).toContain("키워드69"); // 광고비 1위
    expect(names(out)).not.toContain("키워드0"); // 광고비 꼴찌
  });

  it("접힌 '기타 키워드' 묶음은 실존 키워드가 아니라 제외한다", () => {
    const keywords = [
      { keyword: "기타 키워드", metrics: met({ cost: 900_000 }) },
      { keyword: "원피스", metrics: met({ cost: 10_000 }) },
    ];
    const out = names(build({ keywords }).infoCandidateLines);
    expect(out).not.toContain("기타 키워드");
    expect(out).toContain("원피스");
  });

  it("ROAS를 함께 실어 보낸다(수익 좋은 정보성은 조치를 안 붙이기 위한 재료)", () => {
    const keywords = [{ keyword: "원피스 추천", metrics: met({ cost: 10_000, revenue: 50_000, purchaseConv: 2 }) }];
    expect(names(build({ keywords }).infoCandidateLines)).toContain("ROAS 500.00%");
  });
});
