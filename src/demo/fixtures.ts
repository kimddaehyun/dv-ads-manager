/**
 * 데모 페이지 더미 데이터.
 * Phase 3 실 storage·API 연동 시 이 fixture들이 실제 값으로 대체됨.
 */

export const DUMMY_LICENSE = {
  tier: "basic",
  expiresAt: "2026-12-31",
  verifiedAt: "3분 전",
};

export const DUMMY_CREDENTIALS = {
  customerId: "12345",
  accessLicense: "0100000000abcdef0123456789",
  secretKey: "secret-key-not-real",
};

export interface DemoKeyword {
  keyword: string;
  currentBid: number;
  quality: number;
  impressions: number;
  clicks: number;
  rank: number | "loading" | "out"; // 1~15 | "out" (순위권 밖) | "loading"
  rankToBid?: number[]; // length 15, index 0 = 1위 입찰가
  subTag?: string; // 예: "적은검색량"
}

export const DUMMY_KEYWORDS: DemoKeyword[] = [
  {
    keyword: "강남역 헬스장",
    currentBid: 1250,
    quality: 7,
    impressions: 1847,
    clicks: 62,
    rank: 4,
    rankToBid: [3200, 2400, 1950, 1650, 1420, 1210, 1050, 910, 800, 720, 640, 570, 510, 460, 420],
  },
  {
    keyword: "강남 PT",
    currentBid: 2400,
    quality: 8,
    impressions: 2103,
    clicks: 94,
    rank: 2,
    rankToBid: [3200, 2400, 1950, 1650, 1420, 1210, 1050, 910, 800, 720, 640, 570, 510, 460, 420],
  },
  {
    keyword: "강남 필라테스",
    currentBid: 720,
    quality: 7,
    impressions: 892,
    clicks: 24,
    rank: 11,
  },
  {
    keyword: "강남역 요가",
    currentBid: 540,
    quality: 6,
    impressions: 563,
    clicks: 14,
    rank: 13,
  },
  {
    keyword: "강남 다이어트",
    currentBid: 180,
    quality: 5,
    impressions: 87,
    clicks: 2,
    rank: "out",
    subTag: "적은검색량",
  },
  {
    keyword: "강남역 운동",
    currentBid: 0,
    quality: 0,
    impressions: 0,
    clicks: 0,
    rank: "loading",
  },
];

export interface DemoShoppingKeyword {
  keyword: string;
  currentRank: number | null; // null = 미노출
  rankToBid: number[];
}

export interface DemoShoppingProduct {
  productId: string;
  name: string;
  status: "running" | "paused";
  impressions: number;
  keywords?: DemoShoppingKeyword[];
}

export const DUMMY_SHOPPING_PRODUCTS: DemoShoppingProduct[] = [
  {
    productId: "p1",
    name: "린넨 아로마 디퓨저 200ml",
    status: "running",
    impressions: 4127,
    keywords: [
      { keyword: "린넨 디퓨저", currentRank: 3, rankToBid: [1800, 1420, 1180, 980, 820, 700, 600, 520, 460, 410, 370, 330, 300, 270, 250] },
      { keyword: "아로마 디퓨저", currentRank: 7, rankToBid: [2400, 1950, 1620, 1360, 1150, 980, 840, 720, 620, 540, 470, 420, 370, 330, 300] },
      { keyword: "방 디퓨저", currentRank: 2, rankToBid: [1200, 950, 790, 660, 560, 480, 410, 350, 300, 260, 230, 200, 180, 160, 140] },
      { keyword: "천연 디퓨저", currentRank: null, rankToBid: [1650, 1320, 1090, 910, 770, 650, 560, 480, 420, 370, 330, 290, 260, 230, 210] },
      { keyword: "홈데코 디퓨저", currentRank: 5, rankToBid: [1400, 1120, 930, 780, 660, 560, 480, 410, 350, 310, 270, 240, 210, 190, 170] },
    ],
  },
  {
    productId: "p2",
    name: "우드 차콜 디퓨저 100ml",
    status: "running",
    impressions: 2847,
  },
  {
    productId: "p3",
    name: "시트러스 룸스프레이",
    status: "paused",
    impressions: 0,
  },
];
