import { describe, it, expect } from "vitest";
import {
  roasBand, roasPct, YELLOW_FLOOR_RATIO,
  flattenKeywords, extractCandidates, COST_FLOOR,
  pickRankTargets, LOW_RANK_FLOOR, AD_IMP_FLOOR, LOW_CTR_PCT, foldByWeekday,
  type BriefGroupData, type BriefAdRow,
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

// 그룹별 차원 데이터 헬퍼 — 모든 세그먼트 판정은 캠페인 > 그룹 단위(2026-07-20 개편).
function gd(campaign: string, group: string, i: number, dims: Partial<BriefGroupData>): BriefGroupData {
  return { campaign, group, nccCampaignId: `cmp-${i}`, nccAdgroupId: `grp-${i}`, ...dims };
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
  const base = { keywords: GROUPS, targetRoas: 800 };

  it("COST_FLOOR는 1만원", () => {
    expect(COST_FLOOR).toBe(10_000);
  });

  it("비용 임계 이상 + 전환 0 → zeroConvKeyword (그룹 scope 부착)", () => {
    const c = extractCandidates(base).find((x) => x.kind === "zeroConvKeyword");
    expect(c).toBeDefined();
    expect(c!.facts.keywords).toBe("대나무돗자리");
    expect(c!.facts.count).toBe(1);
    expect(c!.scope).toMatchObject({ campaign: "[DV] 대나무", group: "1. 기본 상품명" });
    expect(c!.facts.캠페인).toBe("[DV] 대나무");
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

  it("키워드 이슈는 그룹마다 따로 만들어진다 — 다른 그룹 데이터가 섞이지 않는다", () => {
    const two: KeywordGroup[] = [
      { campaign: "A", group: "G1", keywords: [{ keyword: "a전환없음", metrics: m(20_000, 0, 0) }] },
      { campaign: "B", group: "G2", keywords: [{ keyword: "b전환없음", metrics: m(20_000, 0, 0) }] },
    ];
    const cands = extractCandidates({ keywords: two, targetRoas: 800 })
      .filter((x) => x.kind === "zeroConvKeyword");
    expect(cands).toHaveLength(2);
    expect(cands[0].facts.keywords).toBe("a전환없음");
    expect(cands[0].scope?.campaign).toBe("A");
    expect(cands[1].facts.keywords).toBe("b전환없음");
    expect(cands[1].scope?.campaign).toBe("B");
  });

  it("지면 비용 임계 이상 + 전환 0 → zeroConvPlacement (그룹 데이터로만 판정)", () => {
    const byPlacement: NamedMetrics[] = [
      { label: "네이버 메인", metrics: m(31_000, 0, 0) },
      { label: "네이버 검색", metrics: m(80_000, 10, 800_000) },
      { label: "기타", metrics: m(500, 0, 0) },
    ];
    const c = extractCandidates({ ...base, groups: [gd("C", "G", 1, { byPlacement })] })
      .find((x) => x.kind === "zeroConvPlacement");
    expect(c!.facts.placements).toBe("네이버 메인");
    expect(c!.scope).toMatchObject({ campaign: "C", group: "G", nccAdgroupId: "grp-1" });
  });

  it("후보의 표는 kind가 결정한다 — 발화 행에 problem이 칠해진다", () => {
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(c!.table.rows.some((r) => r.problem)).toBe(true);
  });

  it("기본 선택은 전부 해제 — AE선택 모드의 시작 상태", () => {
    expect(extractCandidates(base).every((c) => c.selected === false)).toBe(true);
  });

  it("후보가 없으면 빈 배열", () => {
    expect(extractCandidates({ keywords: [], targetRoas: 800 })).toEqual([]);
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

  it("green + 저순위면 후보 (해당 그룹 scope)", () => {
    const kws = withRank();
    const rows = flattenKeywords(kws);
    rows[0].rank = 8;
    const c = extractCandidates({ keywords: kws, targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank");
    expect(c).toBeDefined();
    expect(c!.facts.keywords).toBe("고효율");
    expect(c!.scope).toMatchObject({ campaign: "C", group: "G" });
    // 표에 추정순위 열이 붙는다.
    expect(c!.table.columns).toContain("추정순위");
    expect(c!.table.rows[0].cells).toContain("8위");
  });

  it("green이어도 순위가 높으면 후보 아님", () => {
    const kws = withRank();
    const rows = flattenKeywords(kws);
    rows[0].rank = 2;
    expect(extractCandidates({ keywords: kws, targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });

  it("순위를 못 얻었으면 후보 아님 — 자격증명 미등록 시 조용히 스킵", () => {
    const kws = withRank();
    const rows = flattenKeywords(kws);
    expect(extractCandidates({ keywords: kws, targetRoas: 800, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });

  it("목표 미설정이면 rankedRows가 있어도 후보 아님", () => {
    const kws = withRank();
    const rows = flattenKeywords(kws);
    rows[0].rank = 8;
    expect(extractCandidates({ keywords: kws, rankedRows: rows })
      .find((x) => x.kind === "highRoasLowRank")).toBeUndefined();
  });
});

describe("campaignCostFloor - 캠페인 유형별 비용 문턱 (2026-07-21)", () => {
  it("캠페인별 문턱이 있으면 계정 공통 문턱 대신 그 값으로 판정한다", () => {
    // 같은 3만원 소진·전환 0이라도 문턱 5만원인 캠페인은 통과, 2만원인 캠페인만 이슈.
    const kw: KeywordGroup[] = [
      { campaign: "파워링크캠", group: "G", keywords: [{ keyword: "a", metrics: m(30_000, 0, 0) }] },
      { campaign: "플레이스캠", group: "G", keywords: [{ keyword: "b", metrics: m(30_000, 0, 0) }] },
    ];
    const floors = new Map([["파워링크캠", 50_000], ["플레이스캠", 20_000]]);
    const cands = extractCandidates({ keywords: kw, campaignCostFloor: floors })
      .filter((x) => x.kind === "zeroConvKeyword");
    expect(cands).toHaveLength(1);
    expect(cands[0].scope?.campaign).toBe("플레이스캠");
    expect(String(cands[0].facts.기준)).toContain("20,000원");
  });

  it("맵에 없는 캠페인은 계정 공통 문턱으로 폴백한다", () => {
    const kw: KeywordGroup[] = [
      { campaign: "미지정캠", group: "G", keywords: [{ keyword: "a", metrics: m(30_000, 0, 0) }] },
    ];
    const cands = extractCandidates({ keywords: kw, campaignCostFloor: new Map() })
      .filter((x) => x.kind === "zeroConvKeyword");
    expect(cands).toHaveLength(1); // 기본 COST_FLOOR(1만원) 기준으로 판정
  });
});

// belowTargetGroup(그룹 합산 미달)은 2026-07-21 폐기 — 개별 키워드 후보와 중복이라 생성 안 함.
describe("extractCandidates - belowTargetGroup 폐기", () => {
  it("그룹 합산이 미달이어도 그룹 후보는 만들지 않는다", () => {
    const bad: KeywordGroup[] = [{
      campaign: "C", group: "G",
      keywords: [{ keyword: "a", metrics: m(60_000, 2, 240_000) }],
    }];
    expect(extractCandidates({ targetRoas: 800, keywords: bad })
      .find((x) => x.kind === "belowTargetGroup")).toBeUndefined();
  });
});

describe("extractCandidates - lowRoasPlacement (그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  const byPlacement: NamedMetrics[] = [
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
  const groups = [gd("C", "G", 1, { byPlacement })];

  it("전환은 있으나 none 구간인 지면만 후보 — 전환 0/노랑/임계 미만 제외", () => {
    const c = extractCandidates({ ...base, groups })
      .find((x) => x.kind === "lowRoasPlacement");
    expect(c).toBeDefined();
    expect(c!.facts.placements).toBe("쇼핑 검색탭");
    expect(c!.facts.count).toBe(1);
    expect(c!.scope?.group).toBe("G");
  });

  it("zeroConvPlacement와 중복되지 않는다", () => {
    const cands = extractCandidates({ ...base, groups });
    const zero = cands.find((x) => x.kind === "zeroConvPlacement");
    const low = cands.find((x) => x.kind === "lowRoasPlacement");
    expect(zero!.facts.placements).toBe("네이버 메인");
    expect(String(low!.facts.placements)).not.toContain("네이버 메인");
  });

  it("목표 미설정이면 후보를 만들지 않는다 — zeroConvPlacement는 그대로", () => {
    const cands = extractCandidates({ keywords: [], groups });
    expect(cands.find((x) => x.kind === "lowRoasPlacement")).toBeUndefined();
    expect(cands.find((x) => x.kind === "zeroConvPlacement")).toBeDefined();
  });

  it("지면 이슈는 그룹마다 따로 — 다른 그룹 지면과 섞이지 않는다", () => {
    const two = [
      gd("A", "G1", 1, { byPlacement: [{ label: "네이버 메인", metrics: m(31_000, 0, 0) }] }),
      gd("B", "G2", 2, { byPlacement: [{ label: "네이버 메인", metrics: m(31_000, 0, 0) }] }),
    ];
    const cands = extractCandidates({ ...base, groups: two })
      .filter((x) => x.kind === "zeroConvPlacement");
    expect(cands).toHaveLength(2);
    expect(cands.map((c) => c.scope?.campaign)).toEqual(["A", "B"]);
  });
});

// 2026-07-21 A안 — "1등 vs 꼴찌" 상대 비교 폐기. 비용 문턱을 넘고 목표(band none)에
// 못 미치는 구간을 전부 잡는다. kind 이름은 이력 호환을 위해 유지.
describe("extractCandidates - genderBidSkew / ageBidSkew (목표 미달 구간, 그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  const withGender = (byGender: NamedMetrics[]) => ({ ...base, groups: [gd("C", "G", 1, { byGender })] });

  it("목표 미달(none) 구간만 전부 잡는다 — green 구간은 제외", () => {
    // 남성 900%(green) / 여성 400%(none) → 여성만.
    const c = extractCandidates(withGender([
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(50_000, 2, 200_000) },
    ])).find((x) => x.kind === "genderBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.구간).toBe("여성");
    expect(c!.facts.count).toBe(1);
    expect(c!.scope).toMatchObject({ campaign: "C", group: "G" });
  });

  it("yellow(유지) 구간은 잡지 않는다 — none만", () => {
    // 900%(green) vs 700%(yellow, 하한 600 이상) → 후보 없음.
    expect(extractCandidates(withGender([
      { label: "남성", metrics: m(100_000, 6, 900_000) },
      { label: "여성", metrics: m(100_000, 4, 700_000) },
    ])).find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("비용 문턱 미만 구간은 잡지 않는다 — 잡음 방지", () => {
    expect(extractCandidates(withGender([
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "여성", metrics: m(5_000, 0, 0) },
    ])).find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("'알 수 없음' 세그먼트는 제외 — 가중치를 걸 수 없는 대상", () => {
    expect(extractCandidates(withGender([
      { label: "남성", metrics: m(50_000, 5, 450_000) },
      { label: "알 수 없음", metrics: m(50_000, 1, 50_000) },
    ])).find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("목표 ROAS 미설정이면 후보를 만들지 않는다", () => {
    expect(extractCandidates({
      keywords: [],
      groups: [gd("C", "G", 1, {
        byGender: [
          { label: "남성", metrics: m(50_000, 5, 450_000) },
          { label: "여성", metrics: m(50_000, 2, 200_000) },
        ],
      })],
    }).find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("연령 버킷 → ageBidSkew, 미달 버킷만 problem 행 (문턱 미만 버킷 제외)", () => {
    const byAge: NamedMetrics[] = [
      { label: "25세 ~ 29세", metrics: m(30_000, 3, 270_000) }, // 900% green
      { label: "30세 ~ 34세", metrics: m(30_000, 2, 210_000) }, // 700% yellow
      { label: "50세 ~ 54세", metrics: m(30_000, 1, 90_000) },  // 300% none
      { label: "60세", metrics: m(2_000, 0, 0) },                // 문턱 미만 → 제외
    ];
    const c = extractCandidates({ ...base, groups: [gd("C", "G", 1, { byAge })] })
      .find((x) => x.kind === "ageBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.구간).toBe("50세 ~ 54세");
    expect(c!.table.rows.filter((r) => r.problem)).toHaveLength(1);
  });

  it("전환 0 구간은 미달 후보가 아니라 zeroConvSegment로 분리된다", () => {
    const cands = extractCandidates(withGender([
      { label: "남성", metrics: m(50_000, 0, 0) },
      { label: "여성", metrics: m(50_000, 5, 450_000) }, // 900% green — 대조군
    ]));
    expect(cands.find((x) => x.kind === "genderBidSkew")).toBeUndefined();
    const zero = cands.find((x) => x.kind === "zeroConvSegment");
    expect(zero).toBeDefined();
    expect(zero!.facts.count).toBe(1);
  });

  it("전 구간이 나쁘면(대조군 없음) 세그먼트 후보를 만들지 않는다 — 그 차원 조정으로 풀 문제가 아니다", () => {
    const cands = extractCandidates(withGender([
      { label: "남성", metrics: m(50_000, 0, 0) },
      { label: "여성", metrics: m(50_000, 0, 0) },
    ]));
    expect(cands.find((x) => x.kind === "zeroConvSegment")).toBeUndefined();
    expect(cands.find((x) => x.kind === "genderBidSkew")).toBeUndefined();
  });

  it("판정은 그룹 안에서만 — 미달 구간이 있는 그룹만 후보", () => {
    // 두 구간 모두 채운다 — 한 구간만 돌아간 그룹은 비교 대상이 없어 목표 대비 후보를 안 만든다.
    const two = [
      gd("A", "G1", 1, { byGender: [
        { label: "남성", metrics: m(50_000, 5, 450_000) },  // green
        { label: "여성", metrics: m(50_000, 5, 450_000) },  // green
      ] }),
      gd("B", "G2", 2, { byGender: [
        { label: "남성", metrics: m(50_000, 5, 450_000) },  // green
        { label: "여성", metrics: m(50_000, 2, 200_000) },  // none
      ] }),
    ];
    const cands = extractCandidates({ ...base, groups: two })
      .filter((x) => x.kind === "genderBidSkew");
    expect(cands).toHaveLength(1);
    expect(cands[0].scope).toMatchObject({ campaign: "B", group: "G2" });
  });
});

describe("extractCandidates - deviceBidSkew (목표 미달 구간, 그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  const withDevice = (byDevice: NamedMetrics[]) => ({ ...base, groups: [gd("C", "G", 1, { byDevice })] });

  it("목표 미달 기기만 잡는다", () => {
    // PC 400%(none) / 모바일 900%(green) → PC만.
    const c = extractCandidates(withDevice([
      { label: "PC", metrics: m(50_000, 2, 200_000) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ])).find((x) => x.kind === "deviceBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.구간).toBe("PC");
  });

  it("전부 목표 이상이면 후보 없음", () => {
    expect(extractCandidates(withDevice([
      { label: "PC", metrics: m(50_000, 5, 400_000) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ])).find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });

  it("미달 구간이 문턱 미만이면 후보 없음", () => {
    expect(extractCandidates(withDevice([
      { label: "PC", metrics: m(3_000, 0, 0) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ])).find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });
});

describe("extractCandidates - 세그먼트 확장: 전환0 / 상향 여지 / 클릭률 (2026-07-21)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  const withDevice = (byDevice: NamedMetrics[]) => ({ ...base, groups: [gd("C", "G", 1, { byDevice })] });

  it("전환 0 구간 → zeroConvSegment, 미달 후보와 중복되지 않는다", () => {
    const cands = extractCandidates(withDevice([
      { label: "PC", metrics: m(50_000, 0, 0) },
      { label: "모바일", metrics: m(50_000, 5, 450_000) },
    ]));
    const zero = cands.find((x) => x.kind === "zeroConvSegment");
    expect(zero).toBeDefined();
    expect(zero!.facts.구간).toBe("PC");
    expect(zero!.facts.차원).toBe("기기");
    expect(cands.find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });

  it("목표 이상 구간 → highRoasSegment, 표에서 good(초록) 행", () => {
    const cands = extractCandidates(withDevice([
      { label: "PC", metrics: m(50_000, 2, 200_000) },     // 400% none
      { label: "모바일", metrics: m(50_000, 5, 450_000) },  // 900% green
    ]));
    const good = cands.find((x) => x.kind === "highRoasSegment");
    expect(good).toBeDefined();
    expect(good!.facts.구간).toBe("모바일");
    expect(good!.table.rows.find((r) => r.good)!.cells[0]).toBe("모바일");
    // 상향 여지 표는 빨강(problem) 강조를 쓰지 않는다.
    expect(good!.table.rows.some((r) => r.problem)).toBe(false);
  });

  it("목표 미설정이면 상향 여지 후보 없음 (전환 0 후보는 그대로)", () => {
    const cands = extractCandidates({
      keywords: [],
      groups: [gd("C", "G", 1, { byDevice: [
        { label: "PC", metrics: m(50_000, 0, 0) },
        { label: "모바일", metrics: m(50_000, 5, 450_000) },
      ] })],
    });
    expect(cands.find((x) => x.kind === "highRoasSegment")).toBeUndefined();
    expect(cands.find((x) => x.kind === "zeroConvSegment")).toBeDefined();
  });

  it("한 구간만 돌아간 그룹(모바일 전용)은 목표 대비 후보를 만들지 않는다", () => {
    const cands = extractCandidates(withDevice([
      { label: "PC", metrics: { ...ZERO_METRICS } },        // 노출·비용 0 = 미운영
      { label: "모바일", metrics: m(50_000, 5, 450_000) },   // 900% green
    ]));
    expect(cands.find((x) => x.kind === "highRoasSegment")).toBeUndefined();
    expect(cands.find((x) => x.kind === "deviceBidSkew")).toBeUndefined();
  });

  it("노출 충분 + 클릭률 미만 구간 → lowCtrSegment", () => {
    const seg = (label: string, impressions: number, clicks: number): NamedMetrics =>
      ({ label, metrics: { ...ZERO_METRICS, impressions, clicks, cost: 20_000 } });
    // 클릭률 0.2% < 0.5% (노출 5000 ≥ 1000). 대조군 — 클릭률·전환 모두 건강한 시간대가 있어야 후보.
    const healthy: NamedMetrics = {
      label: "11시~12시",
      metrics: { ...ZERO_METRICS, impressions: 5_000, clicks: 200, cost: 20_000, purchaseConv: 2, revenue: 200_000 },
    };
    const c = extractCandidates({
      ...base,
      groups: [gd("C", "G", 1, { byHour: [seg("10시~11시", 5_000, 10), healthy] })],
    }).find((x) => x.kind === "lowCtrSegment");
    expect(c).toBeDefined();
    expect(c!.facts.차원).toBe("시간대");
    expect(c!.facts.구간).toBe("10시~11시");
  });

  it("노출이 임계 미만이면 클릭률 후보 없음", () => {
    const seg: NamedMetrics = { label: "10시~11시", metrics: { ...ZERO_METRICS, impressions: 500, clicks: 0, cost: 20_000 } };
    expect(extractCandidates({ ...base, groups: [gd("C", "G", 1, { byHour: [seg] })] })
      .find((x) => x.kind === "lowCtrSegment")).toBeUndefined();
  });
});

describe("foldByWeekday", () => {
  it("일자별(ISO yyyy-mm-dd) 지표를 요일로 접는다 — 월~일 순서", () => {
    const byDay: NamedMetrics[] = [
      { label: "2026-07-06", metrics: m(10_000, 1, 50_000) },  // 월
      { label: "2026-07-07", metrics: m(20_000, 2, 100_000) }, // 화
      { label: "2026-07-13", metrics: m(30_000, 3, 150_000) }, // 월
    ];
    const folded = foldByWeekday(byDay);
    expect(folded.map((f) => f.label)).toEqual(["월", "화"]);
    expect(folded[0].metrics.cost).toBe(40_000); // 월요일 2건 합산
  });

  it("날짜로 못 읽는 라벨은 건너뛴다", () => {
    expect(foldByWeekday([{ label: "합계", metrics: m(10_000, 1, 50_000) }])).toEqual([]);
  });
});

describe("extractCandidates - hourWeekdaySkew (목표 미달 구간, 그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };

  it("목표 미달 시간대만 problem 행으로 잡는다", () => {
    const groups = [gd("브랜드", "핵심", 1, {
      byHour: [
        { label: "10시~11시", metrics: m(30_000, 3, 270_000) }, // 900% green
        { label: "22시~23시", metrics: m(30_000, 1, 90_000) },  // 300% none
      ],
    })];
    const c = extractCandidates({ ...base, groups }).find((x) => x.kind === "hourWeekdaySkew");
    expect(c).toBeDefined();
    expect(c!.facts.구간).toBe("22시~23시");
    expect(c!.scope).toMatchObject({ campaign: "브랜드", group: "핵심", nccAdgroupId: "grp-1" });
    expect(c!.table.rows.filter((r) => r.problem)).toHaveLength(1);
    expect(c!.table.rows.find((r) => r.problem)!.cells[0]).toBe("22시~23시");
  });

  it("요일 미달 구간 → 후보 (그룹의 byDay를 요일로 접어 판정)", () => {
    const groups = [gd("브랜드", "핵심", 1, {
      byDay: [
        { label: "2026-07-06", metrics: m(30_000, 3, 270_000) }, // 월 green
        { label: "2026-07-08", metrics: m(30_000, 1, 90_000) },  // 수 none
      ],
    })];
    const cands = extractCandidates({ ...base, groups }).filter((x) => x.kind === "hourWeekdaySkew");
    expect(cands).toHaveLength(1);
    expect(cands[0].facts.구간).toBe("수");
  });

  it("전부 목표 이상이면 후보 없음", () => {
    const groups = [gd("브랜드", "핵심", 1, {
      byHour: [
        { label: "10시~11시", metrics: m(30_000, 3, 270_000) },
        { label: "11시~12시", metrics: m(30_000, 3, 260_000) },
      ],
    })];
    expect(extractCandidates({ ...base, groups })
      .find((x) => x.kind === "hourWeekdaySkew")).toBeUndefined();
  });

  it("미달 구간이 있는 그룹이 여럿이면 그룹마다 후보가 따로", () => {
    const mk = (i: number) => gd("브랜드", `그룹${i}`, i, {
      byHour: [
        { label: "10시~11시", metrics: m(30_000, 3, 270_000) },
        { label: "22시~23시", metrics: m(30_000, 1, 90_000) },
      ],
    });
    const cands = extractCandidates({ ...base, groups: [mk(1), mk(2)] })
      .filter((x) => x.kind === "hourWeekdaySkew");
    expect(cands).toHaveLength(2);
    expect(cands.map((c) => c.scope?.group)).toEqual(["그룹1", "그룹2"]);
  });
});

describe("extractCandidates - regionBidSkew (목표 미달 구간, 그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };

  it("목표 미달 지역만 잡는다 (비용 문턱 미만 지역은 제외)", () => {
    const groups = [gd("브랜드", "핵심", 1, {
      byRegion: [
        { label: "서울특별시", metrics: m(50_000, 5, 450_000) }, // 900% green
        { label: "경기도", metrics: m(50_000, 2, 200_000) },     // 400% none
        { label: "세종특별자치시", metrics: m(1_000, 0, 0) },     // 문턱 미만 → 제외
      ],
    })];
    const c = extractCandidates({ ...base, groups }).find((x) => x.kind === "regionBidSkew");
    expect(c).toBeDefined();
    expect(c!.facts.구간).toBe("경기도");
    expect(c!.scope?.group).toBe("핵심");
  });

  it("전부 목표 이상이면 후보 없음", () => {
    const groups = [gd("브랜드", "핵심", 1, {
      byRegion: [
        { label: "서울특별시", metrics: m(50_000, 5, 450_000) },
        { label: "경기도", metrics: m(50_000, 5, 440_000) },
      ],
    })];
    expect(extractCandidates({ ...base, groups })
      .find((x) => x.kind === "regionBidSkew")).toBeUndefined();
  });
});

describe("extractCandidates - lowCtrAd (그룹 단위)", () => {
  const base = { keywords: [] as KeywordGroup[], targetRoas: 800 };
  // 노출/클릭 지정 헬퍼 — 같은 그룹(G/grp-1) 소속 소재.
  const ad = (label: string, impressions: number, clicks: number, group = "G", i = 1): BriefAdRow => ({
    campaign: "C", group, nccCampaignId: `cmp-${i}`, nccAdgroupId: `grp-${i}`,
    label, metrics: { ...ZERO_METRICS, impressions, clicks, cost: 20_000 },
  });

  it("AD_IMP_FLOOR는 1000, LOW_CTR_PCT는 0.5", () => {
    expect(AD_IMP_FLOOR).toBe(1_000);
    expect(LOW_CTR_PCT).toBe(0.5);
  });

  it("노출 임계 이상 + 클릭률 0.5% 미만 소재만 후보 (그룹 scope)", () => {
    const plAds = [
      ad("문구A", 5_000, 10),  // 0.2% → 후보
      ad("문구B", 5_000, 100), // 2.0% → 제외
      ad("문구C", 500, 0),     // 노출 미달 → 제외
    ];
    const c = extractCandidates({ ...base, plAds }).find((x) => x.kind === "lowCtrAd");
    expect(c).toBeDefined();
    expect(c!.facts.ads).toBe("문구A");
    expect(c!.facts.count).toBe(1);
    expect(c!.scope).toMatchObject({ campaign: "C", group: "G", nccAdgroupId: "grp-1" });
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

  it("같은 그룹의 같은 문구는 합산해서 판정 — 문구 교체 후보의 단위는 문구다", () => {
    // 각각 노출 600(임계 미만)이지만 합치면 1,200 + CTR 0.17% → 후보.
    const plAds = [ad("같은문구", 600, 1), ad("같은문구", 600, 1)];
    const c = extractCandidates({ ...base, plAds }).find((x) => x.kind === "lowCtrAd");
    expect(c).toBeDefined();
    expect(c!.facts.count).toBe(1); // 중복 표기 없이 1건
  });

  it("문구 합산 CTR이 건강하면 후보 아님 — 한쪽 소재만 낮아도 문구 탓이 아니다", () => {
    const plAds = [ad("건강문구", 5_000, 10), ad("건강문구", 5_000, 200)]; // 합산 2.1%
    expect(extractCandidates({ ...base, plAds })
      .find((x) => x.kind === "lowCtrAd")).toBeUndefined();
  });

  it("소재 이슈는 그룹마다 따로 — 다른 그룹의 같은 문구는 합치지 않는다", () => {
    // 그룹별 노출 600은 임계 미만 — 그룹을 넘어 합산하면(1,200) 오탐이 된다.
    const plAds = [ad("같은문구", 600, 1, "G1", 1), ad("같은문구", 600, 1, "G2", 2)];
    expect(extractCandidates({ ...base, plAds })
      .find((x) => x.kind === "lowCtrAd")).toBeUndefined();
  });
});

describe("targets 스냅샷", () => {
  it("zeroConvKeyword 후보에 대상 키워드의 수치 지표가 붙는다", () => {
    const out = extractCandidates({
      keywords: [{ campaign: "C", group: "G", keywords: [
        { keyword: "가방", metrics: { ...ZERO_METRICS, impressions: 100, clicks: 10, cost: 20_000, purchaseConv: 0, revenue: 0 } },
      ] }],
    });
    const c = out.find((c) => c.kind === "zeroConvKeyword")!;
    // 라벨은 그룹 경로 접두 — 같은 키워드가 여러 그룹에 있을 때 이력 추적 오매칭 방지.
    expect(c.targets).toEqual([
      { label: "C > G > 가방", cost: 20_000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 },
    ]);
  });

  it("세그먼트 후보에는 미달 구간들이 대상으로 붙는다 — 라벨에 캠페인 > 그룹 경로 포함", () => {
    const seg = (label: string, cost: number, revenue: number): NamedMetrics =>
      ({ label, metrics: { ...ZERO_METRICS, cost, revenue, purchaseConv: 1 } });
    const out = extractCandidates({
      keywords: [],
      targetRoas: 800,
      // 남성 1000%(green) / 여성 200%(none) → 여성만 대상.
      groups: [gd("C", "G", 1, { byGender: [seg("남성", 20_000, 200_000), seg("여성", 20_000, 40_000)] })],
    });
    const c = out.find((c) => c.kind === "genderBidSkew")!;
    expect(c.targets.map((t) => t.label)).toEqual(["C > G > 여성"]);
  });
});
