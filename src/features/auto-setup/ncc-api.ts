/**
 * F-AutoSetup — ads.naver.com ncc 생성/삭제 API (콘텐츠 스크립트 전용).
 *
 * F-Setup의 `setup-data.ts`가 계층을 *읽는* 쪽이라면 여기는 *만드는* 쪽이다.
 * 인증은 `authFetch`에 위임하되, **쓰기는 광고주 지정 방식이 읽기와 다르다** —
 * 자세한 함정과 각 본문의 근거는 `./CLAUDE.md`와
 * `docs/superpowers/specs/2026-08-14-f-autosetup-ncc-write-recon.md`(2026-08-14 라이브 정찰).
 *
 * 여기서 만드는 것은 **전부 일시중지(`userLock: true`)** 다. 사람이 확인하고 켠다(설계 §7-1).
 */

import { authFetch } from "@/features/multi-account/multi-account-data";
import type {
  AutoSetupLedger,
  CreateAdgroupInput,
  CreateCampaignInput,
  CreateKeywordInput,
  CreateRsaAdInput,
  CreateShoppingAdInput,
  CreateSiteChannelInput,
  NccChannel,
  ShoppingProduct,
} from "@/types/auto-setup";

const NCC = "/apis/sa/api/ncc";

// ─── 에러 ───

/**
 * 네이버가 실패 이유를 한글로 정확히 준다 (예: "이미 사용 중인 캠페인 이름입니다.").
 * 우리가 지어낸 문구보다 정확하므로 그대로 쓰고, 못 읽었을 때만 대체 문구를 쓴다.
 */
function nccErrorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  console.warn("[dv-ads/auto-setup] ncc 쓰기 실패", raw);
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { title?: string; detail?: string };
      const msg = parsed.detail ?? parsed.title;
      if (msg) return msg;
    } catch {
      /* 응답이 잘렸거나 JSON이 아님 — 아래 대체 문구로 */
    }
  }
  if (/HTTP 5\d\d/.test(raw)) return "네이버 서버가 잠시 응답하지 않아요. 잠시 후 다시 시도해 주세요";
  if (/failed to fetch/i.test(raw)) return "네트워크 연결을 확인해 주세요";
  return fallback;
}

async function nccPost<T>(
  path: string,
  body: unknown,
  customerId: number,
  fallback: string,
): Promise<T> {
  try {
    return await authFetch<T>(path, { method: "POST", body: JSON.stringify(body) }, customerId);
  } catch (e) {
    throw new Error(nccErrorMessage(e, fallback));
  }
}

// ─── 캠페인 ───

export async function createCampaign(
  customerId: number,
  input: CreateCampaignInput,
): Promise<string> {
  const res = await nccPost<{ nccCampaignId?: string }>(
    `${NCC}/campaigns`,
    {
      campaignTp: input.adType,
      customerId,
      name: input.name,
      dailyBudget: input.dailyBudget,
      useDailyBudget: true,
      deliveryMethod: "ACCELERATED",
      trackingMode: "TRACKING_DISABLED",
      usePeriod: false,
      userLock: true,
      delFlag: false,
      expectCost: 0,
      status: "ELIGIBLE",
      statusReason: "ELIGIBLE",
    },
    customerId,
    "캠페인을 만들지 못했어요",
  );
  if (!res?.nccCampaignId) throw new Error("캠페인을 만들었는데 번호를 받지 못했어요");
  return res.nccCampaignId;
}

/** 이름 중복은 네이버가 거부한다 — 초안 이름에 붙일 수 있는 빈 번호를 찾는다. */
export async function findFreeCampaignName(
  customerId: number,
  wanted: string,
): Promise<string> {
  const existing = await listCampaignNames(customerId);
  if (!existing.has(wanted)) return wanted;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${wanted} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("같은 이름의 캠페인이 너무 많아요. 캠페인 이름을 바꿔 주세요");
}

async function listCampaignNames(customerId: number): Promise<Set<string>> {
  const list = await authFetch<Array<{ name?: string }>>(
    `${NCC}/campaigns?recordSize=1001`,
    undefined,
    customerId,
  );
  return new Set((list ?? []).map((c) => c.name ?? ""));
}

// ─── 비즈채널 ───

export async function listChannels(
  customerId: number,
  channelTp?: string,
): Promise<NccChannel[]> {
  const q = channelTp ? `?channelTp=${encodeURIComponent(channelTp)}` : "";
  const list = await authFetch<
    Array<{
      nccBusinessChannelId?: string;
      channelTp?: string;
      name?: string;
      channelKey?: string;
    }>
  >(`${NCC}/channels${q}`, undefined, customerId);
  return (list ?? [])
    .filter((c) => c.nccBusinessChannelId)
    .map((c) => ({
      id: c.nccBusinessChannelId as string,
      channelTp: c.channelTp ?? "",
      name: c.name ?? "",
      channelKey: c.channelKey ?? "",
    }));
}

/**
 * 웹사이트 비즈채널 생성. URL이 `businessInfo.site` 안에 들어간다 —
 * 최상위에 넣으면 "URL 형식에 맞지 않습니다"만 돌아온다(실측).
 */
export async function createSiteChannel(
  customerId: number,
  input: CreateSiteChannelInput,
): Promise<string> {
  const res = await nccPost<{ nccBusinessChannelId?: string }>(
    `${NCC}/channels`,
    {
      channelTp: "SITE",
      customerId,
      name: input.name,
      businessInfo: {
        site: input.url,
        siteName: input.siteName,
        name: input.name,
        inspectId: "",
        inspectPw: "",
      },
    },
    customerId,
    "웹사이트 정보를 등록하지 못했어요",
  );
  if (!res?.nccBusinessChannelId) throw new Error("웹사이트 정보를 등록했는데 번호를 받지 못했어요");
  return res.nccBusinessChannelId;
}

// ─── 광고그룹 ───

/** 파워링크는 9종을 전부 채워 보낸다. 안 쓰는 타겟도 자리를 비우면 안 된다(실측). */
const WEB_SITE_TARGETS = [
  { targetTp: "MEDIA_TARGET", target: { type: 1, contents: [], search: [], black: {}, white: {} } },
  { targetTp: "PC_MOBILE_TARGET", target: { pc: true, mobile: true } },
  { targetTp: "GENDER_TARGET", target: { male: true, female: true, unknown: true } },
  { targetTp: "REGIONAL_TARGET", target: null },
  { targetTp: "PERIOD_TARGET", target: null },
  { targetTp: "TIME_WEEKLY_TARGET", target: null },
  { targetTp: "GENDER_WEIGHT_TARGET", target: null },
  { targetTp: "AGE_TARGET", target: null },
  { targetTp: "RESTRICT_KEYWORD_TARGET", target: [] },
];

const SHOPPING_TARGETS = [
  { targetTp: "MEDIA_TARGET", target: { type: 1, contents: [], search: [], black: {}, white: {} } },
  { targetTp: "PC_MOBILE_TARGET", target: { pc: true, mobile: true } },
];

export async function createAdgroup(
  customerId: number,
  input: CreateAdgroupInput,
): Promise<string> {
  const shopping = input.adType === "SHOPPING";
  const res = await nccPost<{ nccAdgroupId?: string }>(
    `${NCC}/adgroups`,
    {
      adgroupType: shopping ? "SHOPPING" : "WEB_SITE",
      customerId,
      nccCampaignId: input.nccCampaignId,
      name: input.name,
      bidAmt: input.bidAmt,
      useDailyBudget: input.dailyBudget != null,
      dailyBudget: input.dailyBudget ?? 0,
      pcChannelId: input.channelId,
      mobileChannelId: input.channelId,
      pcChannelKey: input.channelKey,
      mobileChannelKey: input.channelKey,
      pcNetworkBidWeight: 100,
      mobileNetworkBidWeight: 100,
      useCntsNetworkBidAmt: false,
      useCntsNetworkBidWeight: false,
      systemBiddingType: "NONE",
      agreeSystemBidding: false,
      useExpSearch: true,
      expSearchBudgetRatio: 100,
      sharedExpSearchBudgetRatio: 100,
      aiAdsOptIn: true,
      adRollingType: shopping ? "ROUND_ROBIN" : "PERFORMANCE",
      adgroupAttrJson: shopping ? { campaignTp: 2 } : {},
      targetSummary: {},
      budgetLock: false,
      userLock: true,
      delFlag: false,
      expectCost: 0,
      crawlStatus: null,
      targets: shopping ? SHOPPING_TARGETS : WEB_SITE_TARGETS,
    },
    customerId,
    "광고그룹을 만들지 못했어요",
  );
  if (!res?.nccAdgroupId) throw new Error("광고그룹을 만들었는데 번호를 받지 못했어요");
  return res.nccAdgroupId;
}

// ─── 소재 ───

/**
 * 파워링크 반응형 소재. 제목 3~7개 / 설명 1~4개를 자산으로 넣으면 네이버가 조합해 노출한다.
 * 제목이 3개 미만이면 네이버가 거부한다.
 */
export async function createRsaAd(
  customerId: number,
  input: CreateRsaAdInput,
): Promise<string> {
  const assets = [
    ...input.headlines.map((text) => asset("HEADLINE", text)),
    ...input.descriptions.map((text) => asset("DESCRIPTION", text)),
  ];
  const res = await nccPost<{ nccAdId?: string }>(
    `${NCC}/ads`,
    {
      customerId,
      type: "RSA_AD",
      nccAdgroupId: input.nccAdgroupId,
      userLock: true,
      inspectRequestMsg: null,
      ad: {
        pc: { display: input.pcUrl, final: input.pcUrl },
        mobile: { display: input.mobileUrl, final: input.mobileUrl },
      },
      assets,
    },
    customerId,
    "광고 문구를 등록하지 못했어요",
  );
  if (!res?.nccAdId) throw new Error("광고 문구를 등록했는데 번호를 받지 못했어요");
  return res.nccAdId;
}

function asset(linkType: "HEADLINE" | "DESCRIPTION", text: string) {
  return { assetType: "TEXT", linkType, assetData: { text }, valid: true };
}

/**
 * 쇼핑몰 상품형 소재 = 상품 그 자체. 파워링크와 달리 **배열 + `?isList=true`** 로 보낸다 —
 * 단일 객체로 보내면 "유효하지 않은 소재입니다"로 거부된다(실측).
 */
export async function createShoppingAds(
  customerId: number,
  input: CreateShoppingAdInput,
): Promise<string[]> {
  if (input.referenceKeys.length === 0) return [];
  const body = input.referenceKeys.map((referenceKey) => ({
    type: "SHOPPING_PRODUCT_AD",
    customerId,
    nccAdgroupId: input.nccAdgroupId,
    referenceKey,
    ad: {},
    // 상속(useGroupBidAmt: true)일 때도 bidAmt를 같이 보낸다 — 화면이 그렇게 보낸다.
    adAttr: { useGroupBidAmt: input.useGroupBidAmt !== false, bidAmt: input.bidAmt },
    userLock: true,
  }));
  const res = await nccPost<Array<{ nccAdId?: string }>>(
    `${NCC}/ads?isList=true`,
    body,
    customerId,
    "상품을 등록하지 못했어요",
  );
  return (res ?? []).map((a) => a.nccAdId).filter((id): id is string => !!id);
}

// ─── 키워드 ───

/** 한 번에 보내는 최대 개수. 화면 모달이 100개까지라 같은 폭으로 나눈다. */
const KEYWORD_CHUNK = 100;

/**
 * 키워드 등록. 그룹ID를 쿼리와 각 항목 양쪽에 넣는다(화면이 그렇게 보낸다).
 * **쇼핑몰 상품형 그룹에는 키워드를 만들 수 없다** — 네이버가 거부한다.
 */
export async function createKeywords(
  customerId: number,
  nccAdgroupId: string,
  keywords: CreateKeywordInput[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < keywords.length; i += KEYWORD_CHUNK) {
    const chunk = keywords.slice(i, i + KEYWORD_CHUNK);
    const body = chunk.map((k) => ({
      customerId,
      nccAdgroupId,
      keyword: k.keyword,
      ...(k.bidAmt != null ? { bidAmt: k.bidAmt, useGroupBidAmt: false } : {}),
      attr: {},
    }));
    const res = await nccPost<Array<{ nccKeywordId?: string }>>(
      `${NCC}/keywords?nccAdgroupId=${encodeURIComponent(nccAdgroupId)}`,
      body,
      customerId,
      "키워드를 등록하지 못했어요",
    );
    for (const k of res ?? []) if (k.nccKeywordId) ids.push(k.nccKeywordId);
  }
  return ids;
}

// ─── 쇼핑몰 상품 조회 (링크 → 소재 연결) ───

/** 한 페이지에 받아올 상품 수. `page` 파라미터는 `{쪽}-{개수}-{정렬}` 형태다. */
const PRODUCT_PAGE_SIZE = 2000;
/** 상품이 아무리 많아도 여기서 멈춘다 — 무한 루프 방지. */
const PRODUCT_PAGE_CAP = 10;

/**
 * 쇼핑몰 상품 목록. 상품이 한 페이지를 넘는 스토어가 있으므로 끝까지 넘긴다 —
 * 한 페이지만 보면 오래된 상품의 링크가 "못 찾음"으로 나온다.
 */
export async function searchShoppingProducts(
  customerId: number,
  mallChannelId: string,
  prodNm = "",
): Promise<ShoppingProduct[]> {
  const q = prodNm ? `&prodNm=${encodeURIComponent(prodNm)}` : "";
  const out: ShoppingProduct[] = [];
  const seen = new Set<string>();
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < PRODUCT_PAGE_CAP && out.length < total; page += 1) {
    const res = await authFetch<{ products?: RawProduct[]; totalCount?: number }>(
      `${NCC}/channels/${encodeURIComponent(mallChannelId)}/shopping-products` +
        `?page=${page}-${PRODUCT_PAGE_SIZE}-RGST_YMDT_DESC${q}`,
      undefined,
      customerId,
    );
    if (typeof res?.totalCount === "number") total = res.totalCount;
    const items = res?.products ?? [];
    if (items.length === 0) break;

    let added = 0;
    for (const raw of items) {
      const p = normalizeProduct(raw);
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      added += 1;
    }
    // 쪽 번호 규칙이 예상과 다르면 같은 목록이 다시 온다. 새로 들어온 게 없으면 멈춘다.
    if (added === 0) break;
  }
  return out;
}

/**
 * 스마트스토어 상품 링크에서 상품을 찾는다.
 * 링크 속 번호는 `mallProductId`이고 소재에 넣을 값은 `id`라, 이 조회를 반드시 거쳐야 한다.
 */
export async function findProductByLink(
  customerId: number,
  mallChannelId: string,
  link: string,
): Promise<ShoppingProduct | null> {
  const mallProductId = mallProductIdFromLink(link);
  if (!mallProductId) return null;
  const products = await searchShoppingProducts(customerId, mallChannelId);
  return products.find((p) => p.mallProductId === mallProductId) ?? null;
}

/** `https://smartstore.naver.com/main/products/13630656637` → `13630656637` */
export function mallProductIdFromLink(link: string): string | null {
  return link.match(/\/products\/(\d+)/)?.[1] ?? null;
}

interface RawProduct {
  id?: string;
  mallProductId?: string;
  productTitle?: string;
  mallProductUrl?: string;
  imageUrl?: string;
  lowPrice?: string;
  fullMallCatNm?: string;
  registrable?: boolean;
}

function normalizeProduct(p: RawProduct): ShoppingProduct {
  return {
    id: p.id ?? "",
    mallProductId: p.mallProductId ?? "",
    productTitle: p.productTitle ?? "",
    mallProductUrl: p.mallProductUrl ?? "",
    imageUrl: p.imageUrl ?? "",
    lowPrice: p.lowPrice ?? "",
    fullMallCatNm: p.fullMallCatNm ?? "",
    registrable: p.registrable !== false,
  };
}

// ─── 되돌리기 ───

/**
 * 만든 것을 지운다. 캠페인을 지우면 하위 그룹·소재·키워드가 같이 사라진다(실측).
 * 일부가 실패해도 나머지는 계속 지우고, 못 지운 것을 돌려준다 — 사용자에게 남은 것을 알려야 한다.
 */
export async function rollback(ledger: AutoSetupLedger): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const id of ledger.campaignIds) {
    if (!(await tryDelete(`${NCC}/campaigns/${encodeURIComponent(id)}`, ledger.customerId))) {
      failed.push(id);
    }
  }
  for (const id of ledger.channelIds) {
    if (!(await tryDelete(`${NCC}/channels/${encodeURIComponent(id)}`, ledger.customerId))) {
      failed.push(id);
    }
  }
  return { failed };
}

async function tryDelete(path: string, customerId: number): Promise<boolean> {
  try {
    await authFetch(path, { method: "DELETE" }, customerId);
    return true;
  } catch (e) {
    console.warn("[dv-ads/auto-setup] 삭제 실패", path, e);
    return false;
  }
}
