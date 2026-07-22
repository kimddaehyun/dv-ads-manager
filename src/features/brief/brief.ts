/**
 * F-Brief — 광고주 보고 문구 생성 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover 행 메뉴 "보고 문구"에서 진입. 계정 1개만(일괄은 범위 밖).
 * 선택 우선 흐름(구조 개편): 기간 선택 → 수집(성과 + 지난 보고 + 변경 이력) → 규칙 엔진 →
 * **이슈 선택 화면**(보고 유형·톤·이력 토글 포함) → 선택한 이슈만 AI 조립 → 결과 패널.
 * 자동 전체 생성 모드는 없다 — AE가 고른 것만 문구가 된다.
 *
 * 진행/취소 패턴은 report.ts와 동일 — 취소해도 진행 중 fetch는 못 멈추므로 토큰으로 무효화.
 * 진행 오버레이(showProgress/hideProgress)는 report.ts에서 import — 복제하면 DOM이 두 개 생긴다.
 * 단 취소 함수는 각자: report의 cancelRun은 report의 runToken을 올리므로 가져다 쓰면 안 된다.
 */

import { showToast } from "@/shared/toast";
import { trackUsage } from "@/shared/usage";
import { friendlyApiError } from "@/shared/friendly-error";
import { type ReportTarget } from "@/features/report/report-build";
import { type DateRange } from "@/features/report/report-period";
import { openReportDatePicker } from "@/features/report/report-datepicker";
import { pool } from "@/features/report/report-data";
import { showProgress, hideProgress } from "@/features/report/report";
import { closePopover } from "@/features/multi-account/multi-account";
import { loadAllUserMeta, updateUserMeta } from "@/features/multi-account/multi-account-storage";
import { normalizeKeyword } from "@/shared/storage-keys";
import { estimateRank } from "@/shared/rank";
import { type RankPosition } from "@/types/storage";
import { type GetBidEstimateRequest, type GetBidEstimateResponse } from "@/types/messages";
import { collectBriefData, buildSummaryText, buildSummarySpec, fetchPowerlinkBidMap, won, type BriefData } from "./brief-data";
import { rangeText } from "@/features/report/report-period";
import { extractCandidates, flattenKeywords, pickRankTargets, roasPct, type BriefKeywordRow, type BriefCandidate, type BriefRuleInput, type BriefThresholds } from "./brief-rules";
import { resolveThresholds, type BriefSensitivity } from "./brief-thresholds";
import { composeBlocks, warmCompose, type ComposedBlock } from "./brief-compose";
import { renderBriefPanel, renderBriefPickPanel, closeBriefPanel, type BriefBlock, type BriefPickState, type BriefPickHandle } from "./brief-panel";
import { saveBriefHistory, fetchBriefHistory, candidatesToActions, type BriefHistoryRecord, type BriefSentStatus } from "./brief-history";
import { openBriefHistoryPanel } from "./brief-history-panel";

let running = false;
let runToken = 0;

function cancelRun(): void {
  runToken++;
  running = false;
  hideProgress();
}

/**
 * 순위 보강 — 대상 행의 rank를 제자리에서 채운다(반환 없음).
 *
 * setup.ts enrichRanks의 GET_BID_ESTIMATE 패턴 복제: 100개 chunk, PC 고정(보고 로그의
 * "2페이지"가 PC 기준), skipPerformance(순위별 시장가만 필요). 순위를 못 얻은 행은
 * rank를 undefined로 남긴다 — extractCandidates가 자연히 건너뛴다.
 *
 * userBid는 ncc 등록 키워드의 실효 입찰가(fetchPowerlinkBidMap) — 리포트 행은 검색어라
 * 입찰가가 없다. 맵에 없는 키워드(확장 매칭 검색어 등)는 순위를 매기지 않는다.
 */
async function fillRanks(bidMap: Map<string, number>, rows: BriefKeywordRow[]): Promise<void> {
  if (bidMap.size === 0) return;

  // 입찰가를 아는 키워드만 조회 — 맵에 없으면 순위를 계산할 수 없어 호출도 낭비다.
  const targets = rows.filter((r) => bidMap.has(normalizeKeyword(r.keyword)));
  if (targets.length === 0) return;

  const uniqueKeywords = Array.from(new Set(targets.map((r) => r.keyword)));
  const rankByKeyword = new Map<string, Partial<Record<RankPosition, number>>>();
  const CHUNK = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueKeywords.length; i += CHUNK) chunks.push(uniqueKeywords.slice(i, i + CHUNK));
  // 동시 3 — 순차에서 병렬로(2026-07-22 속도 개선). 검색광고 공식 API 경유라 부하 감지 리스크는
  // 낮지만 보수적으로 시작. 자격증명 없음 응답이 오면 남은 chunk는 건너뛴다(설계 §5 제약).
  let noCredential = false;
  await pool(chunks, 3, async (chunk) => {
    if (noCredential) return;
    const req: GetBidEstimateRequest = {
      type: "GET_BID_ESTIMATE",
      keywords: chunk.map((k) => ({ keyword: k, currentBid: null })),
      device: "PC",
      skipPerformance: true,
    };
    let resp: GetBidEstimateResponse | undefined;
    try {
      resp = (await chrome.runtime.sendMessage(req)) as GetBidEstimateResponse;
    } catch {
      resp = undefined;
    }
    if (!resp) return;
    if (resp.has_credential === false) {
      noCredential = true;
      return;
    }
    if (resp.ok && Array.isArray(resp.data)) {
      for (const vc of resp.data) rankByKeyword.set(normalizeKeyword(vc.keyword), vc.rank_to_bid);
    }
  });

  for (const r of targets) {
    const key = normalizeKeyword(r.keyword);
    const rtb = rankByKeyword.get(key);
    const bid = bidMap.get(key);
    if (!rtb || bid == null) continue;
    const rank = estimateRank(bid, rtb);
    if (rank !== "out") r.rank = rank; // 순위권 밖은 미기재 — 상향 여지 판단 불가
  }
}

export function openBriefFlow(anchor: HTMLElement, target: ReportTarget): void {
  if (target.masterCustomerId == null) {
    showToast({ message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
    return;
  }
  if (running) return;
  // anchor 위치는 지금(동기) 캡처 — meta 로드(await) 사이 메뉴 재렌더로 anchor가 떨어질 수 있다.
  const anchorRect = anchor.getBoundingClientRect();
  void loadAllUserMeta().then((metaMap) => {
    if (running) return;
    openReportDatePicker({
      anchor,
      anchorRect,
      subText: target.name,
      showAuthor: false, // 문구에 담당자명이 안 들어간다
      showRoas: true, // 대신 목표 ROAS를 여기서 받는다(광고주별 저장)
      roasInitial: metaMap[target.adAccountNo]?.targetRoas ?? null,
      // metaMap을 넘겨 run에서의 재조회를 없앤다 — 기간 선택 사이에 meta가 바뀔 일은 없다.
      onConfirm: (range, _author, roas) => void run(target, range, roas, metaMap),
    });
  });
}

/** 한 번의 보고 세션 동안 유지되는 재료 — 선택 화면과 결과 패널을 오가도 재수집하지 않는다. */
interface BriefContext {
  target: ReportTarget;
  data: BriefData;
  /** 이력성 후보 포함 전체 후보 목록 — 선택 화면의 인덱스 기준이 된다. */
  candidates: BriefCandidate[];
  targetRoas: number | undefined;
  lastHistory: BriefHistoryRecord | null;
  /** 패널 1회당 이력 레코드 1건(id 고정 upsert) — 재생성해도 같은 보고로 취급. */
  historyId: string;
  /** 이슈 기준 변경 시 재계산 재료 — 재수집 없이 규칙 엔진만 다시 돌린다. */
  ruleInput: Omit<BriefRuleInput, "thresholds">;
  followCand: BriefCandidate | null;
  sensitivity: BriefSensitivity;
  customThresholds: Partial<BriefThresholds>;
  /** 캠페인 유형·광고비 — 선택 화면의 유형 띠·광고비순 정렬 + 브랜드검색 제외 재료. */
  campaignInfo: BriefCampaignInfo;
  /** 캠페인명 → 비용 문턱(원) — 캠페인 머리글 "최소 금액" 표기. 이슈 기준 변경 시 재계산. */
  campaignFloors: Map<string, number>;
  /** 지금 떠 있는 선택 화면 핸들 — showSelection이 매번 갱신. 늦은 순위 합류가 최신 화면을 잡는다. */
  liveHandle?: BriefPickHandle;
}

/** 캠페인명 → 유형/기간 광고비, "캠페인||그룹" → 그룹 광고비. campGroups에서 추가 호출 없이. */
export interface BriefCampaignInfo {
  campaigns: Map<string, { type: string; cost: number }>;
  groups: Map<string, number>;
}

const BRAND_TYPE_LABEL = "브랜드검색/신제품검색";

function buildCampaignInfo(data: BriefData): BriefCampaignInfo {
  const campaigns = new Map<string, { type: string; cost: number }>();
  const groups = new Map<string, number>();
  for (const tg of data.campGroups) {
    for (const r of tg.rows) {
      if (!r.campaign) continue;
      const c = campaigns.get(r.campaign) ?? { type: tg.type, cost: 0 };
      c.cost += r.metrics.cost;
      campaigns.set(r.campaign, c);
      const key = `${r.campaign}||${r.group}`;
      groups.set(key, (groups.get(key) ?? 0) + r.metrics.cost);
    }
  }
  return { campaigns, groups };
}

/**
 * 캠페인별 비용 문턱(2026-07-21 캠페인별 분리) — 각 캠페인의 기간 광고비에 이슈 기준과 같은
 * 비례 공식을 적용한다. 맞춤에서 최소 광고비 %(costFloorPct)를 정하면 그 비율이 우선.
 * 규칙 엔진 판정과 캠페인 머리글의 "최소 금액" 표기가 같은 맵을 쓴다.
 */
function buildCostFloors(
  info: BriefCampaignInfo,
  sensitivity: BriefSensitivity,
  custom: Partial<BriefThresholds>,
): Map<string, number> {
  const roundThousand = (n: number): number => Math.round(n / 1_000) * 1_000;
  const pct = custom.costFloorPct;
  const byCampaign = new Map<string, number>();
  for (const [name, c] of info.campaigns) {
    const floor =
      sensitivity === "custom" && typeof pct === "number" && pct > 0
        ? Math.max(1_000, roundThousand((c.cost * pct) / 100))
        : resolveThresholds({ sensitivity, custom, totalCost: c.cost }).costFloor;
    byCampaign.set(name, floor);
  }
  return byCampaign;
}

/** 브랜드검색 캠페인의 이슈는 보고에서 제외한다(2026-07-21 사용자 요청). */
function dropBrandCandidates(cands: BriefCandidate[], info: BriefCampaignInfo): BriefCandidate[] {
  return cands.filter((c) => !c.scope || info.campaigns.get(c.scope.campaign)?.type !== BRAND_TYPE_LABEL);
}

/** 이슈 기준(민감도)으로 규칙 엔진만 다시 돌려 후보 목록을 갈아끼운다 — 수집 재사용. */
function rebuildCandidates(ctx: BriefContext): void {
  const thresholds = resolveThresholds({
    sensitivity: ctx.sensitivity,
    custom: ctx.customThresholds,
    totalCost: ctx.data.model.totalCurrent.cost,
  });
  // 캠페인별 비용 문턱도 민감도·맞춤에 따라 달라진다 — 함께 재계산.
  const floors = buildCostFloors(ctx.campaignInfo, ctx.sensitivity, ctx.customThresholds);
  ctx.ruleInput.campaignCostFloor = floors;
  ctx.campaignFloors = floors;
  const next = dropBrandCandidates(extractCandidates({ ...ctx.ruleInput, thresholds }), ctx.campaignInfo);
  if (ctx.followCand) next.unshift(ctx.followCand);
  ctx.candidates = next;
}

async function run(
  target: ReportTarget,
  range: DateRange,
  pickedRoas: number | null,
  metaMap: Awaited<ReturnType<typeof loadAllUserMeta>>,
): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  closePopover();
  showProgress("측정 재료를 모으는 중...", cancelRun);
  try {
    const meta = metaMap[target.adAccountNo];
    // 목표 ROAS는 기간 선택창 입력이 원본 — 바뀌었으면 광고주별로 조용히 저장(실패해도 진행).
    const targetRoas = pickedRoas ?? undefined;
    if ((meta?.targetRoas ?? null) !== pickedRoas) {
      void updateUserMeta(target.adAccountNo, { targetRoas })
        .catch((e) => console.warn("[dv-ads/brief] 목표 수익률 저장 실패", e));
    }

    // 입찰가 맵은 수집 데이터와 무관(계정 ID만 쓴다) — 본 수집과 동시에 출발시켜 왕복을 겹친다.
    // 순위 조회 자체는 후보를 좁힌 뒤에만(전체면 수백 회) — 맵 준비만 앞당기는 것.
    const bidMapP: Promise<Map<string, number>> =
      target.masterCustomerId == null
        ? Promise.resolve(new Map())
        : fetchPowerlinkBidMap(target.masterCustomerId).catch((e) => {
            console.warn("[dv-ads/brief] 입찰가 맵 조회 실패 — 순위 후보만 생략", e);
            return new Map<string, number>();
          });

    // 성과 수집 ∥ 지난 보고 — 서로 독립이라 나란히.
    // collectReportData 내부 병렬 구조는 그대로(성능 감사) — 바깥에서만 병렬을 더한다.
    const [data, lastHistoryList] = await Promise.all([
      collectBriefData(target, range),
      fetchBriefHistory(target.adAccountNo, 1).catch((e) => {
        console.warn("[dv-ads/brief] 지난 보고 조회 실패 - 추적 후보만 생략", e);
        return [] as BriefHistoryRecord[];
      }),
    ]);
    if (stale()) return;
    const lastHistory = lastHistoryList[0] ?? null;

    // 순위 보강 — 후보로 좁힌 뒤에만 조회한다(전체면 수백 회 호출).
    // 실패해도 다른 후보는 살린다 — 자격증명 미등록이 흔하다.
    // 이슈 기준 — 프리셋(민감도) + 총광고비 자동 보정 + 직접 설정.
    const sensitivity: BriefSensitivity = meta?.briefSensitivity ?? "normal";
    const customThresholds = meta?.briefThresholds ?? {};
    const thresholds = resolveThresholds({
      sensitivity, custom: customThresholds, totalCost: data.model.totalCurrent.cost,
    });

    // 캠페인별 비용 문턱(2026-07-21) — 순위 조회 대상 선정과 후보 판정이 같은 문턱을 써야 한다.
    const campaignInfo = buildCampaignInfo(data);
    const floors = buildCostFloors(campaignInfo, sensitivity, customThresholds);

    const plRows = flattenKeywords(data.plKeywords);
    const rankTargets = pickRankTargets(plRows, targetRoas, thresholds, floors);

    const ruleInput: Omit<BriefRuleInput, "thresholds"> = {
      keywords: [...data.plKeywords, ...data.shKeywords],
      targetRoas,
      rankedRows: plRows,
      plAds: data.plAds,
      groups: data.groups,
      groupIds: data.groupIds,
    };
    ruleInput.campaignCostFloor = floors;
    const candidates = dropBrandCandidates(extractCandidates({ ...ruleInput, thresholds }), campaignInfo);

    // 변경 이력 후보는 완전 제거(2026-07-21 사용자 결정) — 보고는 현재 캠페인 데이터만 본다.
    // 지난 조치 추적 후보도 잠시 내림 — buildFollowUpCandidate(brief-followup.ts)와 이력 저장은
    // 유지, 여기서 안 만들기만 한다. 되살리려면 currentTargetMap으로 현재 지표 맵을 만들어 넘긴다.
    const followCand: BriefCandidate | null = null;

    hideProgress();
    const ctx: BriefContext = {
      target, data, candidates, targetRoas, lastHistory,
      historyId: crypto.randomUUID(),
      ruleInput, followCand, sensitivity, customThresholds, campaignInfo,
      campaignFloors: floors,
    };
    // AI 조립 준비를 사용자가 이슈를 고르는 시간에 겹친다 — 세션 토큰·서버 인스턴스 워밍업.
    warmCompose();
    // 선택 화면이 먼저다 — AE가 고른 것만 문구가 된다(구조 개편).
    showSelection(ctx, {
      reportType: meta?.briefReportType,
      tone: meta?.briefTone,
    });

    // 순위 보강은 선택 화면을 막지 않는다(2026-07-22 속도 개선) — 화면을 먼저 띄우고,
    // 순위가 도착하면 순위 후보만 늦게 합류시킨다. fillRanks가 plRows(=ruleInput.rankedRows)를
    // 제자리 수정하므로, 이후의 이슈 기준 변경(rebuildCandidates)에도 순위가 자연히 반영된다.
    if (rankTargets.length > 0) {
      void (async () => {
        try {
          await fillRanks(await bidMapP, rankTargets);
        } catch (e) {
          console.warn("[dv-ads/brief] 순위 보강 실패 — 순위 후보만 생략", e);
          return;
        }
        if (stale()) return;
        mergeLateRankCandidates(ctx);
      })();
    }
  } catch (e) {
    console.warn("[dv-ads/brief] 보고 재료 수집 실패", e);
    if (stale()) return;
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false;
  }
}

/** 후보의 동일성 키 — 순위 후보가 늦게 합류해 목록이 늘어나도 기존 체크를 따라가게 한다. */
function candKey(c: BriefCandidate): string {
  return JSON.stringify([c.kind, c.scope?.campaign ?? "", c.scope?.group ?? "", c.facts]);
}

/**
 * 순위 조회가 늦게 끝난 뒤 — 열려 있는 선택 화면에 순위 후보를 합류시킨다.
 * 새 후보가 없거나 선택 화면이 떠 있지 않으면(생성/취소) 아무것도 하지 않는다 —
 * ctx.candidates를 화면 몰래 바꾸면 "다시 고르기"의 선택 인덱스가 어긋난다.
 * 핸들은 ctx.liveHandle — 이슈 기준 변경 등으로 화면이 다시 그려져도 최신 화면을 따라간다.
 */
function mergeLateRankCandidates(ctx: BriefContext): void {
  const handle = ctx.liveHandle;
  if (!handle?.isLive()) return;
  const old = ctx.candidates;
  const snap = handle.snapshot();
  rebuildCandidates(ctx);
  if (ctx.candidates.length <= old.length) {
    ctx.candidates = old; // 내용 동일 — 화면과 인덱스 정합을 위해 원본 유지
    return;
  }
  // 기존 후보는 같은 재료의 재계산이라 키가 그대로다 — 옛 인덱스의 체크·액션을 새 인덱스로 옮긴다.
  const newKeys = ctx.candidates.map(candKey);
  const used = new Set<number>();
  const idxMap = old.map((c) => {
    const k = candKey(c);
    for (let j = 0; j < newKeys.length; j++) {
      if (!used.has(j) && newKeys[j] === k) {
        used.add(j);
        return j;
      }
    }
    return -1;
  });
  const selectedIdx = snap.selectedIdx.map((i) => idxMap[i] ?? -1).filter((i) => i >= 0);
  const actions: BriefPickState["actions"] = {};
  for (const [iStr, a] of Object.entries(snap.actions)) {
    const j = idxMap[Number(iStr)] ?? -1;
    if (j >= 0 && a != null) actions[j] = a;
  }
  showSelection(ctx, { ...snap, selectedIdx, actions });
}

/** 이슈 선택 화면 — 진입점이자 "다시 고르기" 복귀점. 그릴 때마다 ctx.liveHandle을 갱신한다. */
function showSelection(ctx: BriefContext, initial?: Partial<BriefPickState>): void {
  ctx.liveHandle = renderBriefPickPanel({
    advertiserName: ctx.target.name,
    adAccountNo: ctx.target.adAccountNo,
    candidates: ctx.candidates,
    campaignInfo: { ...ctx.campaignInfo, campaignFloors: ctx.campaignFloors },
    prevHistoryAvailable: ctx.lastHistory != null,
    initial,
    thresholds: {
      sensitivity: ctx.sensitivity,
      custom: ctx.customThresholds,
      totalCost: ctx.data.model.totalCurrent.cost,
      onChange: (sensitivity, custom) => {
        ctx.sensitivity = sensitivity;
        ctx.customThresholds = custom;
        // 광고주별 저장 — 실패해도 이번 세션 재계산은 진행.
        void updateUserMeta(ctx.target.adAccountNo, {
          briefSensitivity: sensitivity,
          briefThresholds: sensitivity === "custom" ? custom : undefined,
        }).catch((e) => console.warn("[dv-ads/brief] 이슈 기준 저장 실패", e));
        rebuildCandidates(ctx);
        // 후보 구성이 바뀌어 선택 인덱스는 무효 — 유형·톤만 유지하고 새로 고른다.
        showSelection(ctx, { reportType: initial?.reportType, tone: initial?.tone, advOpen: true });
        showToast({ message: "이슈 기준을 바꿨어요. 목록을 다시 만들었어요", variant: "success" });
      },
    },
    onShowHistory: () => {
      closeBriefPanel();
      openBriefHistoryPanel(ctx.target.adAccountNo, ctx.target.name, () => showSelection(ctx, initial));
    },
    onCompose: (selected, state) => {
      // 광고주별 유형·톤 기억 — 실패해도 진행을 막지 않는다.
      void updateUserMeta(ctx.target.adAccountNo, {
        briefReportType: state.reportType,
        briefTone: state.tone,
      }).catch((e) => console.warn("[dv-ads/brief] 보고 스타일 저장 실패", e));
      void composeAndShow(ctx, selected, state);
    },
  });
}

/** 선택 결과로 AI 조립 → 결과 패널. 재생성도 이 함수로 돌아온다. */
async function composeAndShow(
  ctx: BriefContext,
  selected: BriefCandidate[],
  state: BriefPickState,
): Promise<void> {
  showProgress("광고 성과를 측정하는 중...");
  let aiBlocks: ComposedBlock[] = [];
  // 인사는 고정 문구 — AI에 맡겼더니 "wonbny 광고주님" 같은 계정명 인사가 나와 통일(2026-07-21).
  const greeting = "안녕하세요 대표님";
  if (selected.length > 0 || state.memo !== "") {
    try {
      const composed = await composeBlocks({
        advertiser: ctx.target.name,
        periodText: rangeText(ctx.data.range),
        totals: {
          cost: won(ctx.data.model.totalCurrent.cost),
          revenue: won(ctx.data.model.totalCurrent.revenue),
          roas: roasPct(ctx.data.model.totalCurrent).toFixed(2),
        },
        prevTotals: { roas: roasPct(ctx.data.model.totalPrev).toFixed(2) },
        selected,
        memo: state.memo,
        reportType: state.reportType,
        tone: state.tone,
      });
      aiBlocks = composed.blocks;
      trackUsage("brief_generate");
      // 이슈를 보냈는데 문단이 하나도 안 왔다 — 조용히 표만 내보내면 원인을 알 수 없다.
      if (selected.length > 0 && aiBlocks.length === 0) {
        showToast({ message: "분석 문구가 만들어지지 않았어요. 다시 고르기에서 한 번 더 시도해 주세요", variant: "error" });
      }
    } catch (e) {
      console.warn("[dv-ads/brief] AI 조립 실패 — 선택한 표만 표시", e);
      showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" });
    }
  }
  hideProgress();
  showResult(ctx, selected, state, aiBlocks, greeting);
}

function showResult(
  ctx: BriefContext,
  selected: BriefCandidate[],
  state: BriefPickState,
  aiBlocks: ComposedBlock[],
  greeting: string,
): void {
  const { data, target, targetRoas } = ctx;
  // 후보별 AI 문단을 그 후보의 표 **앞**에 (보고 로그의 문단-사진 1:1 순서).
  // 서버가 문단마다 factIndex([말할 것] 번호, 1부터)를 달아 주므로 번호로 매칭한다 —
  // AI가 문단을 빼먹거나 합쳐도 엉뚱한 표에 붙지 않는다. 번호가 없거나 범위 밖인
  // 문단(AE 메모 등)은 맨 뒤에 붙인다 — 문단을 잃는 것보다 낫다.
  const byIndex = new Map<number, ComposedBlock[]>();
  const unmatched: ComposedBlock[] = [];
  for (const ai of aiBlocks) {
    if (ai.factIndex != null && ai.factIndex >= 1 && ai.factIndex <= selected.length) {
      const list = byIndex.get(ai.factIndex) ?? [];
      list.push(ai);
      byIndex.set(ai.factIndex, list);
    } else {
      unmatched.push(ai);
    }
  }
  const toBlock = (ai: ComposedBlock): BriefBlock =>
    ({ type: "text", text: ai.text, isAiJudgment: ai.isAiJudgment, numberWarning: ai.numberWarning });
  const blocks: BriefBlock[] = [
    { type: "text", text: `${greeting}\n\n${buildSummaryText(data)}` },
    { type: "table", spec: buildSummarySpec(data) },
  ];
  selected.forEach((c, i) => {
    // 표 제목은 그룹만(길어서 짤림) — 소속 캠페인은 문단 첫 줄 "[캠페인 > 그룹]"으로 밝힌다.
    const scopeLabel = c.scope ? `[${c.scope.campaign} > ${c.scope.group}]` : "";
    const matched = byIndex.get(i + 1) ?? [];
    const start = blocks.length; // 이 이슈 세트의 첫 블록 — 패널이 앞에 구분선을 그린다.
    matched.forEach((ai, j) => {
      const b = toBlock(ai);
      // AI가 이미 같은 라벨로 시작하는 문단을 주면(서버 프롬프트에 따라) 중복 부착 금지.
      if (j === 0 && scopeLabel && b.type === "text" && !b.text.trimStart().startsWith(scopeLabel)) {
        b.text = `${scopeLabel}\n${b.text}`;
      }
      blocks.push(b);
    });
    if (matched.length === 0 && scopeLabel) blocks.push({ type: "text", text: scopeLabel });
    blocks.push({ type: "table", spec: c.table });
    blocks[start].sectionStart = true;
  });
  // 미매칭 문단(AE 메모 등)도 마지막 이슈 세트와 붙지 않게 새 섹션으로 구분.
  unmatched.forEach((ai, i) => {
    const b = toBlock(ai);
    if (i === 0) b.sectionStart = true;
    blocks.push(b);
  });

  // 토스트는 금방 사라져 안내로 부적합 — 패널 상단 고정 안내줄 (설계 §5).
  const notices: string[] = [];
  if (targetRoas == null) {
    notices.push("계정 메뉴에서 목표 수익률을 설정하면 키워드 분류도 제안해요");
  }
  if (selected.length === 0) {
    notices.push("고른 이슈가 없어 요약만 표시해요");
  }

  // 이력 저장 — 패널 1회당 레코드 1건(id 고정 upsert). 복사/저장할 때마다 최신 편집본으로 갱신.
  // 저장 실패는 복사를 막지 않는다 — 토스트도 1회만(복사마다 반복되면 소음).
  const aiDraft = aiBlocks.map((b) => b.text).filter((t) => t.trim() !== "").join("\n\n");
  let saveFailedOnce = false;
  const persist = (fullMessage: string, sentStatus: BriefSentStatus): Promise<void> =>
    saveBriefHistory({
      id: ctx.historyId,
      adAccountNo: target.adAccountNo,
      advertiserName: target.name,
      periodSince: data.range.since,
      periodUntil: data.range.until,
      message: fullMessage,
      actions: candidatesToActions(selected),
      reportType: state.reportType,
      tone: state.tone,
      aiDraft,
      includedPreviousHistory: state.includePrevHistory,
      // 변경 이력 기능 제거(2026-07-21) — 이력 스키마 호환을 위해 필드만 고정값으로 남긴다.
      includedChangeHistory: false,
      relatedChangeIds: [],
      sentStatus,
      snapshot: {
        totals: { cost: data.model.totalCurrent.cost, revenue: data.model.totalCurrent.revenue, roas: roasPct(data.model.totalCurrent) },
        prevTotals: { cost: data.model.totalPrev.cost, revenue: data.model.totalPrev.revenue, roas: roasPct(data.model.totalPrev) },
      },
    });
  const onCopyText = (fullMessage: string): void => {
    void persist(fullMessage, "copied").catch((e) => {
      console.warn("[dv-ads/brief] 이력 저장 실패", e);
      if (!saveFailedOnce) {
        saveFailedOnce = true;
        showToast({ message: "복사는 됐지만 보고 이력은 저장하지 못했어요", variant: "error" });
      }
    });
  };
  renderBriefPanel({
    advertiserName: target.name,
    blocks,
    notice: notices.length > 0 ? notices.join(" / ") : undefined,
    onCopyText,
    // 다시 고르기 — 재수집 없이 선택 화면으로(직전 선택 상태 복원).
    onRepick: () => showSelection(ctx, state),
  });
}
