export type VerifyReason =
  | "ok"
  | "invalid_key"
  | "inactive"
  | "expired"
  | "device_kicked"
  | "no_key"
  | "network_error";

export type LicenseTier = "basic" | "brand";

export interface VerifyAccessResult {
  allowed: boolean;
  reason: VerifyReason;
  expires_at?: string | null;
  max_devices?: number | null;
  active_devices?: number;
  tier?: LicenseTier;
}

export interface RegisterDeviceResult {
  ok: boolean;
  reason: VerifyReason;
}

// 스마트스토어센터 "상품 경쟁지표" 응답
// GET /api/product/shared/product-search-popular?_action=productSearchPopularByKeyword&keyword=...
export interface ProductPopularProduct {
  rank: number;
  nvmid: number;
  mallProductId: string;
  productTitle: string;
  imageUrl: string;
  mallSeq: number;
  mallName: string;
  openDate: string;
  link: string;
  mobileLink: string;
  reviewCount: number;
  category: string;
  keepCnt: number;
  lowPrice: number;
  purchaseCnt: number;
  mpTp: number;
  reliabilityType: string;
  rankDownStarScore: number;
  rankDownScoreType: string;
  relevanceStarScore: number;
  similarityStarScore: number;
  qualityStarScore: number;
  abuseStarScore: number;
  recentStarScore: number;
  reviewCountStarScore: number;
  saleStarScore: number;
  hitStarScore: number;
  largeCategoryName: string;
  middleCategoryName: string;
  smallCategoryName: string;
  detailCategoryName: string;
}

export interface ProductPopularResult {
  searchKeyword: string;
  searchTime: string;
  products: ProductPopularProduct[];
}
