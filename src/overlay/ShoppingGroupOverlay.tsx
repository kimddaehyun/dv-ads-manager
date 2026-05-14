/**
 * F002 ShoppingGroupOverlay — 쇼핑검색광고 그룹 inline 펼침 시안.
 * 데이터 소스는 Spike B(Phase 4)에서 확정 — 본 시안은 더미 데이터로 UI만.
 */

import { useState } from "react";
import iconUrl from "@/assets/icon-128.png";
import { DUMMY_SHOPPING_PRODUCTS, type DemoShoppingProduct } from "@/demo/fixtures";

export function ShoppingGroupOverlay() {
  return (
    <div className="bg-white border border-gray-300 rounded overflow-hidden">
      <div className="dvads dvads-page-banner">
        <span className="left">
          <img src={iconUrl} alt="DV" />
          <span>디브이 애드 매니저 활성 · 3개 소재 분석 가능</span>
        </span>
        <span className="right">캐시 4분 전</span>
      </div>

      <div className="px-3.5 py-2.5 bg-gray-50 border-b border-gray-300 text-xs text-gray-600">
        광고관리자 › 쇼핑검색광고 › 그룹 디퓨저 › 소재
      </div>

      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-gray-50 text-xs text-gray-600 font-medium border-b border-gray-200">
            <th className="text-left px-3 py-2.5 w-[40%]">소재</th>
            <th className="text-left px-3 py-2.5">상태</th>
            <th className="text-left px-3 py-2.5">노출수</th>
            <th className="text-left px-3 py-2.5">키워드 분석</th>
          </tr>
        </thead>
        <tbody>
          {DUMMY_SHOPPING_PRODUCTS.map((p) => (
            <ProductRow key={p.productId} product={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductRow({ product }: { product: DemoShoppingProduct }) {
  const [expanded, setExpanded] = useState(false);
  const hasKeywords = product.keywords && product.keywords.length > 0;

  return (
    <>
      <tr className={expanded ? "border-b-0" : "border-b border-gray-100"}>
        <td className="px-3 py-2.5 text-gray-900">{product.name}</td>
        <td className="px-3 py-2.5 text-gray-700">
          {product.status === "running" ? "진행 중" : <span className="text-gray-400">일시중지</span>}
        </td>
        <td className="px-3 py-2.5 text-gray-800">{product.impressions.toLocaleString()}</td>
        <td className="px-3 py-2.5">
          {hasKeywords && (
            <button
              className={`dvads dvads-toggle-btn ${expanded ? "expanded" : ""}`}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "키워드 닫기" : "키워드 분석"} <span className="chev">{expanded ? "▴" : "▾"}</span>
            </button>
          )}
        </td>
      </tr>
      {expanded && product.keywords && (
        <tr className="dvads dvads-expand-row">
          <td colSpan={4}>
            <KeywordPanel keywords={product.keywords} />
          </td>
        </tr>
      )}
    </>
  );
}

function KeywordPanel({ keywords }: { keywords: NonNullable<DemoShoppingProduct["keywords"]> }) {
  return (
    <div className="dvads dvads-shop-panel">
      <div className="dvads-shop-hdr">
        <span>자동매칭 키워드 {keywords.length}개 × 1~15위 예상 입찰가</span>
        <span>3분 전 캐시</span>
      </div>
      <table className="dvads-shop-table">
        <thead>
          <tr>
            <th>키워드</th>
            <th>현재</th>
            {Array.from({ length: 15 }, (_, i) => (
              <th key={i}>{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw) => (
            <tr key={kw.keyword} className={kw.currentRank === null ? "miss" : ""}>
              <td>{kw.keyword}</td>
              <td>{kw.currentRank === null ? "미노출" : `${kw.currentRank}위`}</td>
              {kw.rankToBid.map((v, i) => (
                <td key={i}>{v.toLocaleString()}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
