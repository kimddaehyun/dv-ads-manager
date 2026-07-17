import { describe, it, expect } from "vitest";
import {
  roasBand, roasPct, YELLOW_FLOOR_RATIO,
  flattenKeywords, extractCandidates, COST_FLOOR,
  pickRankTargets, LOW_RANK_FLOOR, SKEW_RATIO, AD_IMP_FLOOR, LOW_CTR_PCT,
  type BriefProductDelta,
} from "./brief-rules";
import { ZERO_METRICS, type ReportMetrics } from "@/features/report/report-data";
import { type KeywordGroup } from "@/features/report/report-variable";
import { type NamedMetrics } from "@/features/report/report-fill";

describe("roasPct", () => {
  it("매출/비용 x 100", () => {
    expect(roasPct({ ...ZERO_METRICS, cost: 100_000, revenue: 620_000 })).toBeCloseTo(620);
  });

  it("비용 0이면 0 — 0으로 나누기 방지", () => {
    expect(roasPct({ ...ZERO_METRICS, cost: 0, revenue: 50_000 })).toBe(0);
  });
});

describe("roasBand", () => {
  // 목표 800% 기준. 노랑 하한 = 800 x 0.75 = 600.
  // 근거: 임유엽 AE 보고 로그 — 초록 "800% 이상 상향" / 노랑 "600%대 유지" / 무색 "목표 미달 하향".
  it("목표 이상이면 green", () => {
    expect(roasBand(900, 800)).toBe("green");
  });

  it("목표와 정확히 같으면 green — 경계 포함", () => {
    expect(roasBand(800, 800)).toBe("green");
  });

  it("목표 미만 노랑 하한 이상이면 yellow", () => {
    expect(roasBand(700, 800)).toBe("yellow");
  });

  it("노랑 하한과 정확히 같으면 yellow — 경계 포함", () => {
    // 이 경계가 어긋나면 유지해야 할 키워드가 "하향" 후보로 광고주에게 나간다.
    expect(roasBand(600, 800)).toBe("yellow");
  });

  it("노랑 하한 바로 아래면 none", () => {
    expect(roasBand(599, 800)).toBe("none");
  });

  it("0이면 none", () => {
    expect(roasBand(0, 800)).toBe("none");
  });

  it("목표가 0 이하면 판정 불가 — none", () => {
    expect(roasBand(500, 0)).toBe("none");
  });

  it("YELLOW_FLOOR_RATIO는 0.75", () => {
    expect(YELLOW_FLOOR_RATIO).toBe(0.75);
  });
});

// 테스트 픽스처 헬퍼 — cost/conv/revenue만 지정하면 나머지는 0.
function m(cost: number, purchaseConv: number, revenue: number): ReportMetrics {
  return { ...ZERO_METRICS, cost, purchaseConv, revenue };
}

const GROUPS: KeywordGroup[] = [
  {
    campaign: "[DV] 대나무",
    group: "1. 기본 상품명",
    keywords: [
      // 비용 1.2만, 전환 0 → zeroConvKeyword
      { keyword: "대나무돗자리", metrics: m(12_000, 0, 0) },
      // 비용 5만, ROAS 900% (목표 800 초과) → green, 후보 아님(순위는 Task 7)
      { keyword: "대나무자리", metrics: m(50_000, 5, 450_000) },
      // 비용 5만, ROAS 700% → yellow → belowTarget 후보 아님 (유지 대상)
      { keyword: "여름돗자리", metrics: m(50_000, 4, 350_000) },
      // 비용 5만, ROAS 400% → none → belowTargetKeyword
      { keyword: "돗자리추천", metrics: m(50_000, 2, 200_000) },
      // 비용 5천(임계 미만), 전환 0 → 후보 아님
      { keyword: "소액키워드", metrics: m(5_000, 0, 0) },
    ],
  },
];

describe("flattenKeywords", () => {
  it("그룹 계층을 평탄화하고 캠페인/그룹을 각 행에 붙인다", () => {
    const rows = flattenKeywords(GROUPS);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      keyword: "대나무돗자리",
      campaign: "[DV] 대나무",
      group: "1. 기본 상품명",
    });
  });
});

describe("extractCandidates", () => {
  const base = { keywords: GROUPS, placements: [] as NamedMetrics[], targetRoas: 800 };

  it("COST_FLOOR는 1만원", () => {
    expect(COST_FLOOR).toBe(10_000);
  });

  it("비용 임계 이상 + 전환 0 → zeroConvKeyword", () => {
    const c = extractCandidates(base).find((x) => x.kind === "zeroConvKeyword");
    expect(c).toBeDefined();
    expect(c!.facts.keywords).toBe("대나무돗자리");
    expect(c!.facts.count).toBe(1);
  });

  it("비용 임계 미만은 전환 0이어도 후보에서 제외", () => {
    const c = extractCandidates(base).find((x) => x.kind === "zeroConvKeyword");
    expect(String(c!.facts.keywords)).not.toContain("소액키워드");
  });

  it("노랑 구간 키워드는 belowTargetKeyword에 안 들어간다", () => {
    // 이게 깨지면 유지해야 할 키워드에 "하향하겠습니다"가 광고주에게 나간다.
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(c).toBeDefined();
    expect(String(c!.facts.keywords)).not.toContain("여름돗자리");
    expect(String(c!.facts.keywords)).toContain("돗자리추천");
  });

  it("전환 0 키워드는 belowTargetKeyword와 중복되지 않는다", () => {
    // 전환 0이면 ROAS도 0이라 none 구간에 자동으로 떨어진다. 그건 이미 별도 후보다.
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(String(c!.facts.keywords)).not.toContain("대나무돗자리");
  });

  it("목표 ROAS 미설정이면 분류 후보를 만들지 않는다", () => {
    const cands = extractCandidates({ ...base, targetRoas: undefined });
    expect(cands.find((x) => x.kind === "belowTargetKeyword")).toBeUndefined();
    // 목표와 무관한 후보는 그대로 나온다.
    expect(cands.find((x) => x.kind === "zeroConvKeyword")).toBeDefined();
  });

  it("지면 비용 임계 이상 + 전환 0 → zeroConvPlacement", () => {
    const placements: NamedMetrics[] = [
      { label: "네이버 메인", metrics: m(31_000, 0, 0) },
      { label: "네이버 검색", metrics: m(80_000, 10, 800_000) },
      { label: "기타", metrics: m(500, 0, 0) },
    ];
    const c = extractCandidates({ ...base, placements }).find((x) => x.kind === "zeroConvPlacement");
    expect(c!.facts.placements).toBe("네이버 메인");
  });

  it("후보의 표는 kind가 결정한다 — 행에 band가 칠해진다", () => {
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(c!.table.rows.some((r) => r.band === "none")).toBe(true);
  });

  it("기본 선택은 전부 해제 — AE선택 모드의 시작 상태", () => {
    expect(extractCandidates(base).every((c) => c.selected === false)).toBe(true);
  });

  it("후보가 없으면 빈 배열", () => {
    expect(extractCandidates({ keywords: [], placements: [], targetRoas: 800 })).toEqual([]);
  });
});

describe("pickRankTargets", () => {
  it("LOW_RANK_FLOOR는 6", () => {
    expect(LOW_RANK_FLOOR).toBe(6);
  });

  it("비용 임계 이상 + green 구간만 순위 조회 대상 — 수백 회 호출 방지", () => {
    const targets = pickRankTargets(flattenKeywords(GROUPS), 800);
    expect(targets.map((t) => t.keyword)).toEqual(["대나무자리"]); // ROAS 900% = green
  });

  it("목표 미설정이면 대상 없음 — green 판정이 불가능하다", () => {
    expect(pickRankTargets(flattenKeywords(GROUPS), undefined)).toEqual([]);
  });
});

describe("extractCandidates - highRoasLowRank", () => {
  const withRank = (): KeywordGroup[] => [{
    campaign: "C", group: "G",
    keywords: [{ keyword: "고효율", metrics: m(50_000, 5, 450_000) }],
  }];

  it("green + 저순위면 후보", () => {
    const rows = flattenKeywords(withRank());
    rows[0].rank = 8;
    const c = extractCandidates({ keywords: [], placements: [], targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank");
    expect(c).toBeDefined();
    expect(c!.facts.keywords).toBe("고효율");
    // 표에 추정순위 열이 붙는다.
    expect(c!.table.columns).toContain("추정순위");
    expect(c!.table.rows[0].cells).toContain("8위");
  });

  it("green이어도 순위가 높으면 후보 아님", () => {
    const rows = flattenKeywords(withRank());
    rows[0].rank = 2;
    expect(extractCandidates({ keywords: [], placements: [], targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });

  it("순위를 못 얻었으면 후보 아님 — 자격증명 미등록 시 조용히 스킵", () => {
    const rows = flattenKeywords(withRank());
    expect(extractCandidates({ keywords: [], placements: [], targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });

  it("목표 미설정이면 rankedRows가 있어도 후보 아님", () => {
    const rows = flattenKeywords(withRank());
    rows[0].rank = 8;
    expect(extractCandidates({ keywords: [], placements: [], rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });
});

describe("extractCandidates - belowTargetGroup", () => {
  const base = { placements: [] as NamedMetrics[], targetRoas: 800 };

  it("그룹 집계 ROAS가 none이어야만 후보 — 초록·노랑·무색이 섞여도 합산이 기준", () => {
    // 그룹 합산: 비용 10만, 매출 85만 → ROAS 850% = green → 후보 아님.
    // 안에 none 키워드(400%)가 섞여 있어도 그룹 후보는 만들지 않는다(키워드 후보가 개별로 다룬다).
    const mixed: KeywordGroup[] = [{
      campaign: "C", group: "섞인그룹",
      keywords: [
        { keyword: "좋음", metrics: m(50_000, 6, 650_000) },   // 1300% green
        { keyword: "나쁨", metrics: m(50_000, 2, 200_000) },   // 400% none
      ],
    }];
    expect(extractCandidates({ ...base, keywords: mixed })
      .find((x) => x.kind === "belowTargetGroup")).toBeUndefined();
  });

  it("그룹 집계 ROAS none + 비용 임계 이상 → 후보", () => {
    // 합산: 비용 6만, 매출 24만 → 400% = none.
    const bad: KeywordGroup[] = [{
      campaign: "[DV] 대나무", group: "2. 세부",
      keywords: [
        { keyword: "a", metrics: m(30_000, 1, 120_000) },
        { keyword: "b", metrics: m(30_000, 1, 120_000) },
      ],
    }];
    const c = extractCandidates({ ...base, keywords: bad })
      .find((x) => x.kind === "belowTargetGroup");
    expect(c).toBeDefined();
    expect(String(c!.facts.groups)).toContain("2. 세부");
    expect(c!.facts.count).toBe(1);
    // 그룹 후보는 요약 — 키워드 나열이 아니라 그룹 단위 표.
    expect(c!.table.columns[0]).toBe("광고그룹");
  });

  it("그룹 합산 비용이 임계 미만이면 제외", () => {
    const small: KeywordGroup[] = [{
      campaign: "C", group: "소액그룹",
      keywords: [{ keyword: "a", metrics: m(9_000, 1, 10_000) }],
    }];
    expect(extractCandidates({ ...base, keywords: small })
      .find((x) => x.kind === "belowTargetGroup")).toBeUndefined();
  });

  it("목표 미설정이면 후보를 만들지 않는다", () => {
    const bad: KeywordGroup[] = [{
      campaign: "C", group: "G",
      keywords: [{ keyword: "a", metrics: m(60_000, 2, 240_000) }],
    }];
    expect(extractCandidates({ keywords: bad, placements: [] })
      .find((x) => x.kind === "belowTargetGroup")).toBeUndefined();
  });

  it("그룹 합산 전환 0이면 후보 아님 — zeroConvKeyword와 중복 방지", () => {
    const allZero: KeywordGroup[] = [{
      campaign: "C", group: "전환없는그룹",
      keywords: [
        { keyword: "a", metrics: m(30_000, 0, 0) },
        { keyword: "b", metrics: m(30_000, 0, 0) },
      ],
    }];
    expect(extractCandidates({ ...base, keywords: allZero })
      .find((x) => x.kind === "belowTargetGroup")).toBeUndefined();
  });

  it("이름이 같은 그룹이 배열에 두 번 오면(파워링크/쇼핑) 지표를 합치지 않는다", () => {
    // 각각은 green(1300%)인데 합치면 계산이 달라질 수 있다 — 항목별로 따로 판정.
    const dup: KeywordGroup[] = [
      { campaign: "C", group: "기본", keywords: [{ keyword: "a", metrics: m(30_000, 3, 390_000) }] },
      { campaign: "C", group: "기본", keywords: [{ keyword: "b", metrics: m(30_000, 1, 120_000) }] }, // 400% none
    ];
    const c = extractCandidates({ ...base, keywords: dup })
      .find((x) => x.kind === "belowTargetGroup");
    // 두 번째 항목만 none → 후보 1개. 합쳐졌다면 (60_000, 510_000) = 850% green으로 사라진다.
    expect(c).toBeDefined();
    expect(c!.facts.count).toBe(1);
  });

  it("같은 그룹명이 다른 캠페인에 있어도 따로 집계한다", () => {
    // 캠페인A의 "기본"은 none, 캠페인B의 "기본"은 green — A만 후보.
    const two: KeywordGroup[] = [
      { campaign: "A", group: "기본", keywords: [{ keyword: "a", metrics: m(60_000, 2, 240_000) }] },
      { campaign: "B", group: "기본", keywords: [{ keyword: "b", metrics: m(60_000, 8, 600_000) }] },
    ];
    const c = extractCandidates({ ...base, keywords: two })
      .find((x) => x.kind === "belowTargetGroup");
    expect(c!.facts.count).toBe(1);
    expect(String(c!.facts.groups)).toContain("A");
    expect(String(c!.facts.groups)).not.toContain("B");
  });
});

describe("extractCandidates - lowRoasPlacement", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  const placements: NamedMetrics[] = [
    // 비용 임계 이상 + 전환>0 + ROAS 400% = none → 후보
    { label: "쇼핑 검색탭", metrics: m(40_000, 2, 160_000) },
    // 전환 0 → zeroConvPlacement 몫 — 여기 중복 금지
    { label: "네이버 메인", metrics: m(31_000, 0, 0) },
    // green → 후보 아님
    { label: "네이버 검색", metrics: m(80_000, 10, 800_000) },
    // yellow(700%) → 유지 대상, 후보 아님
    { label: "파트너", metrics: m(20_000, 2, 140_000) },
    // none이지만 비용 임계 미만 → 제외
    { label: "기타", metrics: m(5_000, 1, 5_000) },
  ];

  it("전환은 있으나 none 구간인 지면만 후보 — 전환 0/노랑/임계 미만 제외", () => {
    const c = extractCandidates({ ...base, placements })
      .find((x) => x.kind === "lowRoasPlacement");
    expect(c).toBeDefined();
    expect(c!.facts.placements).toBe("쇼핑 검색탭");
    expect(c!.facts.count).toBe(1);
  });

  it("zeroConvPlacement와 중복되지 않는다", () => {
    const cands = extractCandidates({ ...base, placements });
    const zero = cands.find((x) => x.kind === "zeroConvPlacement");
    const low = cands.find((x) => x.kind === "lowRoasPlacement");
    expect(zero!.facts.placements).toBe("네이버 메인");
    expect(String(low!.facts.placements)).not.toContain("네이버 메인");
  });

  it("목표 미설정이면 후보를 만들지 않는다 — zeroConvPlacement는 그대로", () => {
    const cands = extractCandidates({ keywords: [], placements });
    expect(cands.find((x) => x.kind === "lowRoasPlacement")).toBeUndefined();
    expect(cands.find((x) => x.kind === "zeroConvPlacement")).toBeDefined();
  });
});

describe("extractCandidates - genderBidSkew / ageBidSkew", () => {
  const base = { keywords: [] as KeywordGroup[], placements: [] as NamedMetrics[], targetRoas: 800 };

  it("SKEW_RATIO는 1.5", () => {
    expect(SKEW_RATIO).toBe(1.5);
  });

  it("성별 ROAS 격차 1.5배 이상 + 양쪽 비용 임계 이상 → genderBidSkew", () => {
    // 남성 900% vs 여성 400% (2.25배) — 남성 상향/여성 하향 제안.
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(50_000, 2, 200_000) },
    ];
    const c = extractCandidates({ ...base, byGender }).find((x) => x.kind === "genderBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.좋은쪽).toBe("남성");
    expect(c!.facts.나쁜쪽).toBe("여성");
  });

  it("격차가 임계 바로 아래면 후보 아님", () => {
    // 600% vs 449% → 449 x 1.5 = 673.5 > 600 → 미달.
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(100_000, 6, 600_000) },
      { label: "여성", metrics: m(100_000, 4, 449_000) },
    ];
    expect(extractCandidates({ ...base, byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("격차가 정확히 1.5배면 후보 — 경계 포함", () => {
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(100_000, 6, 600_000) },
      { label: "여성", metrics: m(100_000, 4, 400_000) },
    ];
    expect(extractCandidates({ ...base, byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeDefined();
  });

  it("한쪽 비용이 문턱 미만이면 후보 아님 — 잡음 방지", () => {
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(5_000, 0, 0) },
    ];
    expect(extractCandidates({ ...base, byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("'알 수 없음' 세그먼트는 비교에서 제외 — 가중치를 걸 수 없는 대상", () => {
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(50_000, 5, 440_000) },
      { label: "알 수 없음", metrics: m(50_000, 1, 50_000) },
    ];
    expect(extractCandidates({ ...base, byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("목표 ROAS 미설정이어도 동작 — 격차는 상대 비교라 목표가 필요 없다", () => {
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(50_000, 2, 200_000) },
    ];
    expect(extractCandidates({ keywords: [], placements: [], byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeDefined();
  });

  it("연령 버킷 간 격차 → ageBidSkew (최고 vs 최저)", () => {
    const byAge: NamedMetrics[] = [
      { label: "25세 ~ 29세", metrics: m(30_000, 3, 270_000) }, // 900%
      { label: "30세 ~ 34세", metrics: m(30_000, 2, 210_000) }, // 700%
      { label: "50세 ~ 54세", metrics: m(30_000, 1, 90_000) },  // 300%
      { label: "기타", metrics: m(2_000, 0, 0) },                // 문턱 미만 → 비교 제외
    ];
    const c = extractCandidates({ ...base, byAge }).find((x) => x.kind === "ageBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.좋은쪽).toBe("25세 ~ 29세");
    expect(c!.facts.나쁜쪽).toBe("50세 ~ 54세");
    // 문턱 미만 버킷이 최저로 잡히면 안 된다.
    expect(c!.facts.나쁜쪽).not.toBe("기타");
  });

  it("양쪽 다 매출 0이면 후보 아님 — 0% vs 0%는 격차가 아니다", () => {
    const byGender: NamedMetrics[] = [
      { label: "남성", metrics: m(50_000, 0, 0) },
      { label: "여성", metrics: m(50_000, 0, 0) },
    ];
    expect(extractCandidates({ ...base, byGender })
      .find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("비교 가능한 세그먼트가 2개 미만이면 후보 아님", () => {
    const byAge: NamedMetrics[] = [
      { label: "25세 ~ 29세", metrics: m(30_000, 3, 270_000) },
    ];
    expect(extractCandidates({ ...base, byAge })
      .find((x) => x.kind === "ageBidSkew")).toBeUndefined();
  });
});

describe("extractCandidates - deviceBidSkew", () => {
  const base = { keywords: [] as KeywordGroup[], placements: [] as NamedMetrics[], targetRoas: 800 };

  it("PC/모바일 ROAS 격차 1.5배 이상 → deviceBidSkew", () => {
    // 모바일 900% vs PC 400% (2.25배)
    const byDevice: NamedMetrics[] = [
      { label: "PC", metrics: m(50_000, 2, 200_000) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ];
    const c = extractCandidates({ ...base, byDevice }).find((x) => x.kind === "deviceBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.좋은쪽).toBe("모바일");
    expect(c!.facts.나쁜쪽).toBe("PC");
  });

  it("격차 미달이면 후보 아님", () => {
    const byDevice: NamedMetrics[] = [
      { label: "PC", metrics: m(50_000, 5, 400_000) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ];
    expect(extractCandidates({ ...base, byDevice })
      .find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });

  it("한쪽 비용 문턱 미만이면 후보 아님", () => {
    const byDevice: NamedMetrics[] = [
      { label: "PC", metrics: m(3_000, 0, 0) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ];
    expect(extractCandidates({ ...base, byDevice })
      .find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });
});

describe("extractCandidates - lowCtrAd", () => {
  const base = { keywords: [] as KeywordGroup[], placements: [] as NamedMetrics[], targetRoas: 800 };
  // 노출/클릭 지정 헬퍼
  const ad = (label: string, impressions: number, clicks: number): NamedMetrics =>
    ({ label, metrics: { ...ZERO_METRICS, impressions, clicks, cost: 20_000 } });

  it("AD_IMP_FLOOR는 1000, LOW_CTR_PCT는 0.5", () => {
    expect(AD_IMP_FLOOR).toBe(1_000);
    expect(LOW_CTR_PCT).toBe(0.5);
  });

  it("노출 임계 이상 + 클릭률 0.5% 미만 소재만 후보", () => {
    const plAds = [
      ad("문구A", 5_000, 10),  // 0.2% → 후보
      ad("문구B", 5_000, 100), // 2.0% → 제외
      ad("문구C", 500, 0),     // 노출 미달 → 제외
    ];
    const c = extractCandidates({ ...base, plAds }).find((x) => x.kind === "lowCtrAd");
    expect(c).toBeDefined();
    expect(c!.facts.ads).toBe("문구A");
    expect(c!.facts.count).toBe(1);
  });

  it("클릭률이 정확히 0.5%면 후보 아님 — 미만만", () => {
    const plAds = [ad("경계", 10_000, 50)]; // 0.5%
    expect(extractCandidates({ ...base, plAds })
      .find((x) => x.kind === "lowCtrAd")).toBeUndefined();
  });

  it("표에 클릭률 열이 있다 — 낮다는 근거가 표에 보여야 한다", () => {
    const plAds = [ad("문구A", 5_000, 10)];
    const c = extractCandidates({ ...base, plAds }).find((x) => x.kind === "lowCtrAd");
    expect(c!.table.columns).toContain("클릭률");
  });

  it("소재 데이터가 없으면 후보 없음", () => {
    expect(extractCandidates(base).find((x) => x.kind === "lowCtrAd")).toBeUndefined();
  });
});

describe("extractCandidates - productConvDrop", () => {
  const products: BriefProductDelta[] = [
    // 전환 5 → 0, 매출 -340,000 → 후보
    { label: "온열 찜질기", cur: m(80_000, 0, 0), prev: m(75_000, 5, 340_000) },
    // 전환 유지 → 후보 아님
    { label: "대나무 돗자리", cur: m(50_000, 4, 300_000), prev: m(50_000, 4, 310_000) },
    // 전환 증가 → 후보 아님
    { label: "17MM", cur: m(60_000, 8, 500_000), prev: m(60_000, 3, 200_000) },
    // 전환 감소하나 매출 낙폭이 임계 미만 → 후보 아님 (소음)
    { label: "소품", cur: m(20_000, 1, 30_000), prev: m(20_000, 2, 35_000) },
  ];
  const base = { keywords: [] as KeywordGroup[], placements: [] as NamedMetrics[], targetRoas: 800 };

  it("전환이 줄고 매출 낙폭이 임계 이상인 상품만", () => {
    const c = extractCandidates({ ...base, products }).find((x) => x.kind === "productConvDrop");
    expect(c).toBeDefined();
    expect(c!.facts.products).toBe("온열 찜질기");
  });

  it("매출 낙폭이 임계 미만이면 제외 — 소음 방지", () => {
    const c = extractCandidates({ ...base, products }).find((x) => x.kind === "productConvDrop");
    expect(String(c!.facts.products)).not.toContain("소품");
  });

  it("표에 전기/현재를 나란히 — 비교가 문장의 근거다", () => {
    const c = extractCandidates({ ...base, products }).find((x) => x.kind === "productConvDrop");
    expect(c!.table.columns).toContain("이전 구매완료");
  });

  it("상품 데이터가 없으면 후보 없음", () => {
    expect(extractCandidates(base).find((x) => x.kind === "productConvDrop")).toBeUndefined();
  });
});
