/**
 * F-Brief — 광고주 보고 문구 생성 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover 행 메뉴 "보고 문구"에서 진입. 계정 1개만(일괄은 범위 밖).
 * 기간 선택 → collectBriefData → 규칙 엔진 → 패널.
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
import { loadAllUserMeta } from "@/features/multi-account/multi-account-storage";
import { normalizeKeyword } from "@/shared/storage-keys";
import { estimateRank } from "@/shared/rank";
import { type RankPosition } from "@/types/storage";
import { type GetBidEstimateRequest, type GetBidEstimateResponse } from "@/types/messages";
import { collectBriefData, buildSummaryText, buildSummarySpec, fetchPowerlinkBidMap, won, type BriefData } from "./brief-data";
import { rangeText } from "@/features/report/report-period";
import { extractCandidates, flattenKeywords, pickRankTargets, roasPct, type BriefKeywordRow, type BriefCandidate } from "./brief-rules";
import { composeBlocks, type ComposedBlock } from "./brief-compose";
import { renderBriefPanel, renderBriefPickPanel, type BriefBlock } from "./brief-panel";

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

async function run(target: ReportTarget, range: DateRange): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  closePopover();
  showProgress("보고 문구를 만드는 중...", cancelRun);
  try {
    const metaMap = await loadAllUserMeta();
    const targetRoas = metaMap[target.adAccountNo]?.targetRoas;
    const data = await collectBriefData(target, range);
    if (stale()) return;

    // 순위 보강 — 후보로 좁힌 뒤에만 조회한다(전체면 수백 회 호출).
    // 실패해도 다른 후보는 살린다 — 자격증명 미등록이 흔하다.
    // 순위 입찰은 파워링크 전용이라 대상도 파워링크 행만(쇼핑검색은 키워드 입찰이 없다).
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

    // 완전자동이 기본 — 후보 전부 선택 + 액션은 AI가 목록에서 고르게(action 비움).
    // 실패해도 요약과 표는 살린다 — 가치의 8할이 규칙 엔진에 있다.
    let aiBlocks: ComposedBlock[] = [];
    if (candidates.length > 0) {
      try {
        aiBlocks = await composeBlocks({
          advertiser: target.name,
          periodText: rangeText(data.range),
          totals: {
            cost: won(data.model.totalCurrent.cost),
            revenue: won(data.model.totalCurrent.revenue),
            roas: roasPct(data.model.totalCurrent).toFixed(2),
          },
          prevTotals: { roas: roasPct(data.model.totalPrev).toFixed(2) },
          selected: candidates.map((c) => ({ ...c, selected: true })),
          memo: "",
        });
      } catch (e) {
        console.warn("[dv-ads/brief] AI 조립 실패 — 요약과 표만 표시", e);
        showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" });
      }
      if (stale()) return;
    }

    hideProgress();
    showResult(target.name, data, candidates, aiBlocks, targetRoas);
  } catch (e) {
    console.warn("[dv-ads/brief] 보고 문구 생성 실패", e);
    if (stale()) return;
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false;
  }
}

/** 결과 패널 렌더 — 완전자동/AE선택 공용. "직접 고르기"에서 재조립할 때도 이걸 부른다. */
function showResult(
  advertiserName: string,
  data: BriefData,
  candidates: BriefCandidate[],
  aiBlocks: ComposedBlock[],
  targetRoas: number | undefined,
): void {
  // 후보별 AI 문단을 그 후보의 표 **앞**에 (보고 로그의 문단-사진 1:1 순서).
  // aiBlocks[i]와 candidates[i]는 서버가 "말할 것 하나당 문단 하나"로 만들어 순서가
  // 대응한다. 개수가 어긋나면(AI가 문단을 합치거나 쪼갬) 남는 문단을 뒤에 붙인다 —
  // 표를 잃는 것보다 순서가 틀리는 게 낫다.
  const blocks: BriefBlock[] = [
    { type: "text", text: buildSummaryText(data) },
    { type: "table", spec: buildSummarySpec(data) },
  ];
  candidates.forEach((c, i) => {
    const ai = aiBlocks[i];
    if (ai) {
      blocks.push({ type: "text", text: ai.text, isAiJudgment: ai.isAiJudgment, numberWarning: ai.numberWarning });
    }
    blocks.push({ type: "table", spec: c.table });
  });
  for (const ai of aiBlocks.slice(candidates.length)) {
    blocks.push({ type: "text", text: ai.text, isAiJudgment: ai.isAiJudgment, numberWarning: ai.numberWarning });
  }

  // 토스트는 금방 사라져 안내로 부적합 — 패널 상단 고정 안내줄 (설계 §5).
  // 후보 0개도 명시한다 — 안 그러면 "비어 보이는 게 고장인지 정상인지" 구분이 안 된다.
  const notices: string[] = [];
  if (targetRoas == null) {
    notices.push("목표 수익률을 설정하면 키워드 분류를 제안해요. 계정 메뉴의 \"목표 수익률\"에서 입력할 수 있어요");
  }
  if (candidates.length === 0) {
    notices.push("이번 기간에는 짚어볼 특이사항(전환 없는 키워드·목표 미달 등)이 없어요. 아래 요약만 그대로 쓰시면 됩니다");
  }

  renderBriefPanel({
    advertiserName,
    blocks,
    notice: notices.length > 0 ? notices.join(" · ") : undefined,
    // AE선택 모드 — 체크한 후보 + 지정 액션 + 자유 메모로 재조립. 같은 엔진이다.
    onPickManually: candidates.length > 0 ? () => openPickFlow(advertiserName, data, candidates, targetRoas) : undefined,
  });
}

/** "직접 고르기" — 후보 선택 화면을 띄우고, 고른 것만으로 다시 문구를 만든다. */
function openPickFlow(
  advertiserName: string,
  data: BriefData,
  candidates: BriefCandidate[],
  targetRoas: number | undefined,
): void {
  renderBriefPickPanel({
    advertiserName,
    candidates,
    onCompose: (selected, memo) => {
      void (async () => {
        showProgress("보고 문구를 만드는 중...");
        let aiBlocks: ComposedBlock[] = [];
        try {
          aiBlocks = await composeBlocks({
            advertiser: advertiserName,
            periodText: rangeText(data.range),
            totals: {
              cost: won(data.model.totalCurrent.cost),
              revenue: won(data.model.totalCurrent.revenue),
              roas: roasPct(data.model.totalCurrent).toFixed(2),
            },
            prevTotals: { roas: roasPct(data.model.totalPrev).toFixed(2) },
            selected,
            memo,
          });
        } catch (e) {
          console.warn("[dv-ads/brief] AI 조립 실패 — 선택한 표만 표시", e);
          showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" });
        }
        hideProgress();
        // 체크한 후보만 문장·표에 나온다 — 안 보낸 건 지어낼 재료가 없다(설계 §3 2겹).
        showResult(advertiserName, data, selected, aiBlocks, targetRoas);
      })();
    },
  });
}
