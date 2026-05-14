/**
 * F001 PowerlinkOverlay — 데모 시안용 React 컴포넌트.
 *
 * 호스트 페이지(ads.naver.com 파워링크 키워드 테이블)를 fake로 렌더하고,
 * 그 위에 우리 오버레이 요소(.dvads-page-banner, .dvads-rank-badge,
 * .dvads-expand-panel)를 inline 주입한 모습을 보여줌.
 *
 * Phase 3 Task 010에서 실제 콘텐츠 스크립트는 이 컴포넌트를 그대로 쓰지 않고
 * native DOM 조작으로 동일한 마크업·CSS 클래스를 host DOM에 삽입.
 *
 * 3 상태:
 *   - ok        : 자격증명 등록 + 라이선스 활성 → 배지·펼침 활성
 *   - no-cred   : 자격증명 미등록 → page banner warn + 배지 없음
 *   - locked    : 라이선스 미설정 → page banner lock + 배지 없음
 */

import { useState } from "react";
import iconUrl from "@/assets/icon-128.png";
import type { DemoKeyword } from "@/demo/fixtures";
import { DUMMY_KEYWORDS } from "@/demo/fixtures";

export type PowerlinkState = "ok" | "no-cred" | "locked";

interface Props {
  state: PowerlinkState;
}

export function PowerlinkOverlay({ state }: Props) {
  return (
    <div className="bg-white border border-gray-300 rounded overflow-hidden">
      {state === "ok" && <ActiveBanner />}
      {state === "no-cred" && <NoCredBanner />}
      {state === "locked" && <LockedBanner />}

      <div className="px-3.5 py-2.5 bg-gray-50 border-b border-gray-300 text-xs text-gray-600">
        광고관리자 › 캠페인 › 파워링크 그룹A › 키워드
      </div>

      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-gray-50 text-xs text-gray-600 font-medium border-b border-gray-200">
            <th className="text-left px-3 py-2.5 w-[38%]">키워드</th>
            <th className="text-left px-3 py-2.5">현재 입찰가</th>
            <th className="text-left px-3 py-2.5">품질지수</th>
            <th className="text-left px-3 py-2.5">노출수</th>
            <th className="text-left px-3 py-2.5">클릭수</th>
          </tr>
        </thead>
        <tbody>
          {DUMMY_KEYWORDS.map((kw) => (
            <KeywordRow key={kw.keyword} kw={kw} showBadge={state === "ok"} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActiveBanner() {
  return (
    <div className="dvads dvads-page-banner">
      <span className="left">
        <img src={iconUrl} alt="DV" />
        <span>디브이 애드 매니저 활성 · 1~15위 분석 (6개 키워드)</span>
      </span>
      <span className="right">캐시 2분 전</span>
    </div>
  );
}

function NoCredBanner() {
  return (
    <div className="dvads dvads-page-banner warn">
      <span className="left">
        <span style={{ fontSize: 14 }}>⚠</span>
        <span>
          디브이 애드 매니저: 검색광고 API 키가 등록돼 있지 않아 분석이 비활성입니다.{" "}
          <a>옵션에서 등록 →</a>
        </span>
      </span>
    </div>
  );
}

function LockedBanner() {
  return (
    <div className="dvads dvads-page-banner lock">
      <span className="left">
        <span style={{ fontSize: 14 }}>🔒</span>
        <span>
          디브이 애드 매니저: 라이선스 키가 필요합니다.{" "}
          <a style={{ color: "#E6783B" }}>옵션에서 등록 →</a>
        </span>
      </span>
    </div>
  );
}

function KeywordRow({ kw, showBadge }: { kw: DemoKeyword; showBadge: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className={expanded ? "border-b-0" : "border-b border-gray-100"}>
        <td className="px-3 py-2.5 align-middle">
          <div className="flex items-center gap-2.5">
            <span className="text-gray-900">{kw.keyword}</span>
            {kw.subTag && (
              <span className="inline-block px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-500 rounded">
                {kw.subTag}
              </span>
            )}
            <span className="dvads dvads-cell-spacer" />
            {showBadge && <Badge kw={kw} expanded={expanded} onClick={() => setExpanded((v) => !v)} />}
          </div>
        </td>
        <td className="px-3 py-2.5 text-gray-800">{kw.currentBid ? `${kw.currentBid.toLocaleString()}원` : "—"}</td>
        <td className="px-3 py-2.5 text-gray-800">{kw.quality || "—"}</td>
        <td className="px-3 py-2.5 text-gray-800">{kw.impressions.toLocaleString()}</td>
        <td className="px-3 py-2.5 text-gray-800">{kw.clicks}</td>
      </tr>
      {expanded && kw.rankToBid && (
        <tr className="dvads dvads-expand-row">
          <td colSpan={5}>
            <BidExpandPanel rankToBid={kw.rankToBid} currentRank={typeof kw.rank === "number" ? kw.rank : 0} />
          </td>
        </tr>
      )}
    </>
  );
}

function Badge({ kw, expanded, onClick }: { kw: DemoKeyword; expanded: boolean; onClick: () => void }) {
  if (kw.rank === "loading") {
    return <span className="dvads dvads-rank-badge loading">분석 중…</span>;
  }
  if (kw.rank === "out") {
    return (
      <span className="dvads dvads-rank-badge warn" onClick={onClick}>
        순위권 밖 <span className="chev">▾</span>
      </span>
    );
  }
  return (
    <span className="dvads dvads-rank-badge" onClick={onClick}>
      {kw.rank}위 <span className="chev">{expanded ? "▴" : "▾"}</span>
    </span>
  );
}

function BidExpandPanel({ rankToBid, currentRank }: { rankToBid: number[]; currentRank: number }) {
  return (
    <div className="dvads dvads-expand-panel">
      <div className="dvads-expand-hdr">
        <span className="meta">1~15위 예상 입찰가 · 시장 단위 추정 · 2분 전 캐시</span>
        <button className="refresh-btn" onClick={() => console.log("refresh")}>↻ 새로고침</button>
      </div>
      <table className="dvads-bid-table">
        <thead>
          <tr>
            <th>순위</th>
            {Array.from({ length: 15 }, (_, i) => (
              <th key={i}>{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="current">
            <td>예상가 (원)</td>
            {rankToBid.map((v, i) => (
              <td key={i} className={i + 1 === currentRank ? "" : ""}>
                {v.toLocaleString()}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
