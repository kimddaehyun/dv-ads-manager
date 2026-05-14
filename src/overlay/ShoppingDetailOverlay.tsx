/**
 * F003 ShoppingDetailOverlay — 쇼핑검색광고 소재 상세 풀패널 시안.
 * 데이터 소스 Spike B 종속. 본 시안은 더미 UI.
 */

import { useState } from "react";
import iconUrl from "@/assets/icon-128.png";
import { DUMMY_SHOPPING_PRODUCTS } from "@/demo/fixtures";

export function ShoppingDetailOverlay() {
  const product = DUMMY_SHOPPING_PRODUCTS[0];
  const keywords = product.keywords ?? [];
  const [query, setQuery] = useState("");
  const filtered = keywords.filter((k) => k.keyword.includes(query));

  return (
    <div className="bg-white border border-gray-300 rounded overflow-hidden">
      <div className="dvads dvads-page-banner">
        <span className="left">
          <img src={iconUrl} alt="DV" />
          <span>디브이 애드 매니저 활성 · 소재 키워드 {keywords.length}개</span>
        </span>
        <span className="right">캐시 4분 전</span>
      </div>

      <div className="px-3.5 py-2.5 bg-gray-50 border-b border-gray-300 text-xs text-gray-600">
        광고관리자 › 쇼핑검색광고 › 소재 › {product.name}
      </div>

      <div className="p-5">
        <div className="flex items-center justify-between mb-4 gap-3">
          <h3 className="text-base font-semibold text-gray-900">{product.name}</h3>
          <input
            type="text"
            placeholder="키워드 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="text-sm px-3 py-1.5 bg-gray-100 border-0 rounded-md outline-none w-48"
          />
        </div>

        <div className="dvads dvads-shop-panel" style={{ margin: 0 }}>
          <div className="dvads-shop-hdr">
            <span>자동매칭 키워드 {filtered.length} / {keywords.length}개</span>
            <button className="dvads-toggle-btn" style={{ height: 22 }} onClick={() => console.log("refresh")}>
              ↻ 새로고침
            </button>
          </div>
          <table className="dvads-shop-table">
            <thead>
              <tr>
                <th>키워드</th>
                <th>현재 순위</th>
                {Array.from({ length: 15 }, (_, i) => (
                  <th key={i}>{i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((kw) => (
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
      </div>
    </div>
  );
}
