// 쇼핑검색_상품 시트(sheet9) 검증 (합성 데이터).
//   node --import ./scripts/ts-resolve.mjs scripts/test-report-product.ts
//
// 이 시트는 캠페인/그룹을 안 나누고 **같은 상품끼리 합친다**. 라이브에서 같은 상품이 여러 그룹에
// 등록돼 중복으로 나온 것이 계기 — 합산이 접기보다 먼저여야 한다(안 그러면 흩어진 상품이 사라짐).
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, forceRecalc, removeSheets, listSheets } from "../src/lib/report-excel.ts";
import { renderProductSheet } from "../src/lib/report-variable.ts";
import { buildProductAdRows, buildProductRows } from "../src/lib/report-build.ts";
import type { AdvReportResult } from "../src/lib/report-data.ts";

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };

// 라이브 응답 모양 그대로 (2026-07-15 정찰): nccAdId는 이름 자리에도 ID가 온다.
const HEAD = ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "nccAdId",
  "impCnt", "clkCnt", "ctr", "cpc", "salesAmt", "ccnt", "drtCcnt", "idrtCcnt", "crto", "ror", "purchaseCcnt", "purchaseConvAmt", "convAmt"];
const row = (tp: string, camp: string, grp: string, adId: string, imp: number, cost: number): string[] =>
  [tp, `[${camp}](cmp-a001-02-0001)`, `[${grp}](grp-a001-02-0001)`, `[${adId}](${adId})`,
    String(imp), "10", "0.1", "10", String(cost), "0", "0", "0", "0", "0", "2", "50000", "50000"];

const AD = (n: number) => `nad-a001-02-00000000000000${n}`;

const res: AdvReportResult = {
  head: HEAD,
  rows: [
    // 같은 상품(헤드셋)이 서로 다른 캠페인·그룹에 등록됨 → 한 줄로 합쳐져야 한다
    row("쇼핑검색", "카탈로그A", "그룹1", AD(1), 3000, 40000),
    row("쇼핑검색", "카탈로그B", "그룹2", AD(2), 1000, 6000),
    // 단독 상품
    row("쇼핑검색", "카탈로그A", "그룹1", AD(3), 1200, 5000),
    // 흩어진 소액 상품: 각각은 0.5%(=약 261원) 미만이 아니지만 합치면 확실히 남는다
    row("쇼핑검색", "카탈로그A", "그룹1", AD(4), 500, 200),
    row("쇼핑검색", "카탈로그B", "그룹2", AD(5), 300, 200),
    // 진짜 잔챙이 → 기타 상품
    row("쇼핑검색", "카탈로그A", "그룹1", AD(6), 100, 50),
    row("파워링크", "파워링크캠", "PL-A", AD(9), 9999, 999999), // 유형 필터로 제외
  ],
  totalResults: 7,
};

const adRows = buildProductAdRows(res, "쇼핑검색");
ok(adRows.length === 6, `소재 행 6개 — 파워링크 제외 (실제 ${adRows.length})`);
ok(adRows.every((a) => a.label.startsWith("nad-")), "합산 전 라벨은 소재ID");

// 상품명 조인: AD1/AD2 = 같은 상품, AD4/AD5 = 같은 상품
const titles = new Map([
  [AD(1), "느루 헤드셋 거치대"],
  [AD(2), "느루 헤드셋 거치대"],
  [AD(3), "느루 V라인 책꽂이"],
  [AD(4), "느루 소액상품"],
  [AD(5), "느루 소액상품"],
  // AD(6)은 일부러 이름 없음 → 소재ID가 라벨로 남아야 함
]);
const rows = buildProductRows(adRows, titles);

const find = (label: string) => rows.find((r) => r.label === label);
ok(!!find("느루 헤드셋 거치대"), "같은 상품이 다른 캠페인·그룹에 있어도 한 줄로 합쳐짐");
ok(find("느루 헤드셋 거치대")!.metrics.cost === 46000, `헤드셋 합산 비용 = 40000+6000 = 46000 (실제 ${find("느루 헤드셋 거치대")!.metrics.cost})`);
ok(find("느루 헤드셋 거치대")!.metrics.impressions === 4000, "헤드셋 합산 노출 = 3000+1000 = 4000");
ok(rows.filter((r) => r.label === "느루 헤드셋 거치대").length === 1, "합쳐진 상품은 한 줄만");
ok(!!find("느루 소액상품"), "흩어진 소액 상품도 합산 후 임계를 넘으면 남는다");
ok(find("느루 소액상품")!.metrics.cost === 400, "소액상품 합산 = 200+200 = 400");
ok(!!find("기타 상품"), "임계 미만은 '기타 상품'으로 접힘");
ok(find("기타 상품")!.metrics.cost === 50, `기타 상품 = 이름없는 잔챙이 50 (실제 ${find("기타 상품")!.metrics.cost})`);

// 총액 보존 — 접고 합쳐도 원본과 같아야 한다
const total = rows.reduce((s, r) => s + r.metrics.cost, 0);
const raw = adRows.reduce((s, a) => s + a.metrics.cost, 0);
ok(total === raw && total === 51450, `총비용 보존 = 원본 ${raw.toLocaleString()} (실제 ${total.toLocaleString()})`);
// 비용 내림차순
ok(rows[0].label === "느루 헤드셋 거치대", "총비용 내림차순 정렬");
ok(rows[rows.length - 1].label === "기타 상품", "기타 상품은 항상 마지막");

// ── 렌더 ──
const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
ok(listSheets(files).some((s) => s.name === "쇼핑검색_상품"),
  "양식에 쇼핑검색_상품 시트 존재 (build-report-template-product-sheet.mjs 실행됨)");
renderProductSheet(files, "xl/worksheets/sheet9.xml", rows, "쇼핑검색 상품별 성과");
removeSheets(files, ["디스플레이", "디스플레이_상세"]);
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-product-sample.xlsx", out);

const re = openXlsx(out);
const s9 = readText(re, "xl/worksheets/sheet9.xml");
ok(/<c r="B2"[^>]*t="inlineStr"[^>]*><is><t[^>]*>쇼핑검색 상품별 성과<\/t>/.test(s9), "제목(B2)=쇼핑검색 상품별 성과");
ok(/<c r="B3"[^>]*t="inlineStr"[^>]*><is><t[^>]*>상품명<\/t>/.test(s9), "B열 헤더(B3)=상품명 (캠페인 아님)");
ok(/<c r="C3"[^>]*t="inlineStr"[^>]*><is><t[^>]*>노출<\/t>/.test(s9), "지표가 C열부터 시작(C3=노출) — 캠페인/그룹 열 없음");
ok(/<c r="B4"[^>]*t="inlineStr"[^>]*><is><t[^>]*>느루 헤드셋 거치대<\/t>/.test(s9), "첫 데이터행(B4)=상품명");
ok(/<c r="C4"[^>]*><v>4000<\/v>/.test(s9), "첫 상품 합산 노출(C4)=4000");
ok(/<c r="G4"[^>]*><v>46000<\/v>/.test(s9), "첫 상품 합산 총비용(G4)=46000");
ok(s9.includes("기타 상품"), "기타 상품 행 렌더");
// 전체 합계행 — 3=헤더, 4~(3+N)=데이터, 그 다음이 합계
ok(rows.length === 4, `렌더 대상 4행: 헤드셋/V라인/소액상품/기타 상품 (실제 ${rows.length}: ${rows.map((r) => r.label).join(",")})`);
const totalRow = 4 + rows.length; // = 8
ok(new RegExp(`<c r="B${totalRow}"[^>]*t="inlineStr"[^>]*><is><t[^>]*>전체 합계</t>`).test(s9), `전체 합계행(B${totalRow})`);
ok(new RegExp(`<c r="G${totalRow}"[^>]*><v>${raw}</v>`).test(s9), `전체 합계 총비용(G${totalRow})=${raw.toLocaleString()}`);
// 키워드 시트는 그대로 캠페인/그룹/키워드 3열이어야 함(회귀 방지)
const s6 = readText(re, "xl/worksheets/sheet6.xml");
ok(!/<c r="B3"[^>]*t="inlineStr"[^>]*><is><t[^>]*>상품명<\/t>/.test(s6), "쇼핑검색_키워드는 상품 레이아웃으로 안 바뀜");
// 탭 순서
const names = listSheets(re).map((s) => s.name);
ok(names.indexOf("쇼핑검색_상품") === names.indexOf("쇼핑검색_키워드") + 1,
  `탭 순서: 쇼핑검색_키워드 바로 뒤 (실제 ${names.join(" | ")})`);

console.log(fail === 0
  ? `\n전체 통과 ✅  (샘플: dist-report-product-sample.xlsx, ${out.length} bytes)`
  : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
