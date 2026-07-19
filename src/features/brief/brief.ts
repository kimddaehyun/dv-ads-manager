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
import { friendlyApiError } from "@/shared/friendly-error";
import { type ReportTarget } from "@/features/report/report-build";
import { type DateRange } from "@/features/report/report-period";
import { openReportDatePicker } from "@/features/report/report-datepicker";
import { showProgress, hideProgress } from "@/features/report/report";
import { closePopover } from "@/features/multi-account/multi-account";
import { loadAllUserMeta, updateUserMeta } from "@/features/multi-account/multi-account-storage";
import { normalizeKeyword } from "@/shared/storage-keys";
import { estimateRank } from "@/shared/rank";
import { type RankPosition } from "@/types/storage";
import { type GetBidEstimateRequest, type GetBidEstimateResponse } from "@/types/messages";
import { collectBriefData, buildSummaryText, buildSummarySpec, fetchPowerlinkBidMap, won, type BriefData } from "./brief-data";
import { rangeText } from "@/features/report/report-period";
import { extractCandidates, flattenKeywords, pickRankTargets, roasPct, type BriefKeywordRow, type BriefCandidate, type BriefTargetSnapshot } from "./brief-rules";
import { composeBlocks, toPrevReport, type ComposedBlock } from "./brief-compose";
import { renderBriefPanel, renderBriefPickPanel, closeBriefPanel, type BriefBlock, type BriefPickState } from "./brief-panel";
import { saveBriefHistory, fetchBriefHistory, candidatesToActions, type BriefHistoryRecord, type BriefTone, type BriefSentStatus } from "./brief-history";
import { buildFollowUpCandidate, currentTargetMap } from "./brief-followup";
import { openBriefHistoryPanel } from "./brief-history-panel";
import { fetchBriefChangeEvents, type BriefChangeFetchResult } from "./brief-change-data";
import { evaluateChangeImpacts, buildChangeHistoryCandidates } from "./brief-change-rules";
import { openBriefToneDialog } from "./brief-tone-panel";

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
async function fillRanks(customerId: number, rows: BriefKeywordRow[]): Promise<void> {
  const bidMap = await fetchPowerlinkBidMap(customerId);
  if (bidMap.size === 0) return;

  // 입찰가를 아는 키워드만 조회 — 맵에 없으면 순위를 계산할 수 없어 호출도 낭비다.
  const targets = rows.filter((r) => bidMap.has(normalizeKeyword(r.keyword)));
  if (targets.length === 0) return;

  const uniqueKeywords = Array.from(new Set(targets.map((r) => r.keyword)));
  const rankByKeyword = new Map<string, Partial<Record<RankPosition, number>>>();
  const CHUNK = 100;
  for (let i = 0; i < uniqueKeywords.length; i += CHUNK) {
    const chunk = uniqueKeywords.slice(i, i + CHUNK);
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
    if (!resp) continue;
    if (resp.has_credential === false) return; // 자격증명 없음 — 조용히 스킵(설계 §5 제약)
    if (resp.ok && Array.isArray(resp.data)) {
      for (const vc of resp.data) rankByKeyword.set(normalizeKeyword(vc.keyword), vc.rank_to_bid);
    }
  }

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
  openReportDatePicker({
    anchor,
    subText: target.name,
    showAuthor: false, // 문구에 담당자명이 안 들어간다
    onConfirm: (range) => void run(target, range),
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
  changeRes: BriefChangeFetchResult;
  /** 패널 1회당 이력 레코드 1건(id 고정 upsert) — 재생성해도 같은 보고로 취급. */
  historyId: string;
}

async function run(target: ReportTarget, range: DateRange): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  closePopover();
  showProgress("보고 재료를 모으는 중...", cancelRun);
  try {
    const metaMap = await loadAllUserMeta();
    const meta = metaMap[target.adAccountNo];
    const targetRoas = meta?.targetRoas;

    // 기간 경계(ms, KST) — 변경이력 조회 창과 "기간 시작 전/중" 판정에 쓴다.
    const sinceMs = Date.parse(`${range.since}T00:00:00+09:00`);
    const untilMs = Date.parse(`${range.until}T23:59:59+09:00`);

    // 성과 수집 ∥ 지난 보고 ∥ 변경 이력 — 서로 독립이라 나란히.
    // collectReportData 내부 병렬 구조는 그대로(성능 감사) — 바깥에서만 병렬을 더한다.
    const [data, lastHistoryList, changeRes] = await Promise.all([
      collectBriefData(target, range),
      fetchBriefHistory(target.adAccountNo, 1).catch((e) => {
        console.warn("[dv-ads/brief] 지난 보고 조회 실패 - 추적 후보만 생략", e);
        return [] as BriefHistoryRecord[];
      }),
      target.masterCustomerId != null
        ? fetchBriefChangeEvents(target.masterCustomerId, sinceMs, untilMs)
        : Promise.resolve({ events: [], actorsMissing: true } as BriefChangeFetchResult),
    ]);
    if (stale()) return;
    const lastHistory = lastHistoryList[0] ?? null;

    // 순위 보강 — 후보로 좁힌 뒤에만 조회한다(전체면 수백 회 호출).
    // 실패해도 다른 후보는 살린다 — 자격증명 미등록이 흔하다.
    const plRows = flattenKeywords(data.plKeywords);
    const rankTargets = pickRankTargets(plRows, targetRoas);
    if (rankTargets.length > 0 && target.masterCustomerId != null) {
      try {
        await fillRanks(target.masterCustomerId, rankTargets);
      } catch (e) {
        console.warn("[dv-ads/brief] 순위 보강 실패 — 순위 후보만 생략", e);
      }
    }
    if (stale()) return;

    const candidates = extractCandidates({
      keywords: [...data.plKeywords, ...data.shKeywords],
      placements: data.model.byPlacement,
      targetRoas,
      rankedRows: plRows,
      products: data.products,
      byGender: data.model.byGender,
      byAge: data.model.byAge,
      byDevice: data.byDevice,
      plAds: data.plAds,
      byHour: data.byHour,
      byDay: data.model.byDay,
      byRegion: data.byRegion,
    });

    // 변경 이력 후보 — 전기 지표는 상품 델타에서만 나온다(추가 API 호출 없음).
    // 키워드 등 전기 지표가 없는 대상은 "판단 보류"로 변경 사실만 전달된다.
    const currentMap = currentTargetMap(candidates, plRows);
    const prevMap = new Map<string, BriefTargetSnapshot>();
    for (const p of data.products) {
      prevMap.set(p.label, {
        label: p.label,
        cost: p.prev.cost, revenue: p.prev.revenue, purchaseConv: p.prev.purchaseConv,
        clicks: p.prev.clicks, impressions: p.prev.impressions,
      });
    }
    const changeCands = buildChangeHistoryCandidates(
      evaluateChangeImpacts(changeRes.events, prevMap, currentMap, sinceMs),
    );
    candidates.unshift(...changeCands);

    // 지난 조치 추적 — 후속 언급이 보고의 첫 화제(보고 관례)라 맨 앞에 둔다.
    if (lastHistory) {
      const follow = buildFollowUpCandidate(lastHistory, currentMap);
      if (follow) candidates.unshift(follow);
    }

    hideProgress();
    const ctx: BriefContext = {
      target, data, candidates, targetRoas, lastHistory, changeRes,
      historyId: crypto.randomUUID(),
    };
    // 선택 화면이 먼저다 — AE가 고른 것만 문구가 된다(구조 개편).
    showSelection(ctx, {
      reportType: meta?.briefReportType,
      tone: meta?.briefTone,
    });
  } catch (e) {
    console.warn("[dv-ads/brief] 보고 재료 수집 실패", e);
    if (stale()) return;
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false;
  }
}

/** 이슈 선택 화면 — 진입점이자 "다시 고르기" 복귀점. */
function showSelection(ctx: BriefContext, initial?: Partial<BriefPickState>): void {
  renderBriefPickPanel({
    advertiserName: ctx.target.name,
    candidates: ctx.candidates,
    prevHistoryAvailable: ctx.lastHistory != null,
    changeDisabledReason: ctx.changeRes.actorsMissing
      ? "변경이력 알림에서 우리 팀 작업자를 등록하면 쓸 수 있어요"
      : undefined,
    initial,
    onToneSettings: () => openBriefToneDialog(),
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
  showProgress("보고 문구를 만드는 중...");
  let aiBlocks: ComposedBlock[] = [];
  if (selected.length > 0 || state.memo !== "") {
    try {
      aiBlocks = await composeBlocks({
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
        prevReport: state.includePrevHistory && ctx.lastHistory ? toPrevReport(ctx.lastHistory) : undefined,
      });
    } catch (e) {
      console.warn("[dv-ads/brief] AI 조립 실패 — 선택한 표만 표시", e);
      showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" });
    }
  }
  hideProgress();
  showResult(ctx, selected, state, aiBlocks);
}

function showResult(
  ctx: BriefContext,
  selected: BriefCandidate[],
  state: BriefPickState,
  aiBlocks: ComposedBlock[],
): void {
  const { data, target, targetRoas } = ctx;
  // 후보별 AI 문단을 그 후보의 표 **앞**에 (보고 로그의 문단-사진 1:1 순서).
  // aiBlocks[i]와 selected[i]는 서버가 "말할 것 하나당 문단 하나"로 만들어 순서가
  // 대응한다. 개수가 어긋나면(AI가 문단을 합치거나 쪼갬) 남는 문단을 뒤에 붙인다 —
  // 표를 잃는 것보다 순서가 틀리는 게 낫다.
  const blocks: BriefBlock[] = [
    { type: "text", text: buildSummaryText(data) },
    { type: "table", spec: buildSummarySpec(data) },
  ];
  selected.forEach((c, i) => {
    const ai = aiBlocks[i];
    if (ai) {
      blocks.push({ type: "text", text: ai.text, isAiJudgment: ai.isAiJudgment, numberWarning: ai.numberWarning });
    }
    blocks.push({ type: "table", spec: c.table });
  });
  for (const ai of aiBlocks.slice(selected.length)) {
    blocks.push({ type: "text", text: ai.text, isAiJudgment: ai.isAiJudgment, numberWarning: ai.numberWarning });
  }

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
      includedChangeHistory: state.includeChangeHistory,
      relatedChangeIds: selected.map((c) => c.changeEventId).filter((id): id is string => id != null),
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
  const onSave = (fullMessage: string): void => {
    void persist(fullMessage, "saved_only")
      .then(() => showToast({ message: "보고 이력에 저장했어요", variant: "success" }))
      .catch((e) => {
        console.warn("[dv-ads/brief] 이력 저장 실패", e);
        showToast({ message: "보고 이력을 저장하지 못했어요", variant: "error" });
      });
  };

  renderBriefPanel({
    advertiserName: target.name,
    blocks,
    notice: notices.length > 0 ? notices.join(" · ") : undefined,
    onCopyText,
    onSave,
    // 재생성 — 같은 선택으로 다시. 톤 버튼은 톤만 바꿔 다시(선택·유형·이력 포함 유지).
    onRegenerate: (toneOverride?: BriefTone) => {
      const next: BriefPickState = { ...state, tone: toneOverride ?? state.tone };
      void composeAndShow(ctx, selected, next);
    },
    onShowHistory: () => {
      closeBriefPanel();
      openBriefHistoryPanel(target.adAccountNo, target.name, () =>
        showResult(ctx, selected, state, aiBlocks));
    },
    // 다시 고르기 — 재수집 없이 선택 화면으로(직전 선택 상태 복원).
    onRepick: () => showSelection(ctx, state),
  });
}
