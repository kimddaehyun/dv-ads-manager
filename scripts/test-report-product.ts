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
// pc=구매완료 전환수. 0.5% 접기에 전환 예외가 있어(전환 나면 소액이어도 남김) 행마다 지정한다.
const row = (tp: string, camp: string, grp: string, adId: string, imp: number, cost: number, pc = 2): string[] =>
  [tp, `[${camp}](cmp-a001-02-0001)`, `[${grp}](grp-a001-02-0001)`, `[${adId}](${adId})`,
    String(imp), "10", "0.1", "10", String(cost), "0", "0", "0", "0", "0", String(pc), "50000", "50000"];

const AD = (n: number) => `nad-a001-02-00000000000000${n}`;

const res: AdvReportResult = {
  head: HEAD,
  rows: [
    // 같은 상품(헤드셋)이 서로 다른 캠페인·그룹에 등록됨 → 한 줄로 합쳐져야 한다
    row("쇼핑검색", "카탈로그A", "그룹1", AD(1), 3000, 40000),
    row("쇼핑검색", "카탈로그B", "그룹2", AD(2), 1000, 6000),
    // 단독 상품
    row("쇼핑검색", "카탈로그A", "그룹1", AD(3), 1200, 5000),
    // 흩어진 소액 상품: 각각(200)은 임계(약 258원) 미만이라 따로면 접히지만, 합치면 400이라 남는다.
    // pc=0이어야 전환 예외가 아니라 **합산이 접기보다 먼저**인 덕에 남는 것임이 증명된다.
    row("쇼핑검색", "카탈로그A", "그룹1", AD(4), 500, 200, 0),
    row("쇼핑검색", "카탈로그B", "그룹2", AD(5), 300, 200, 0),
    // 진짜 잔챙이: 소액 + 전환 0 → 기타 상품으로 접힘
    row("쇼핑검색", "카탈로그A", "그룹1", AD(6), 100, 50, 0),
    // 소액이지만 전환 발생 → 예외로 남아야 한다 (묻으면 성과가 안 보임)
    row("쇼핑검색", "카탈로그B", "그룹2", AD(7), 80, 60, 1),
    row("파워링크", "파워링크캠", "PL-A", AD(9), 9999, 999999), // 유형 필터로 제외
  ],
  totalResults: 7,
};

const adRows = buildProductAdRows(res, "쇼핑검색");
ok(adRows.length === 7, `소재 행 7개 — 파워링크 제외 (실제 ${adRows.length})`);
ok(adRows.every((a) => a.label.startsWith("nad-")), "합산 전 라벨은 소재ID");

// 상품명 조인: AD1/AD2 = 같은 상품, AD4/AD5 = 같은 상품. url은 상품 페이지 링크(하이퍼링크용).
// AD(2)에만 링크가 없다 — 같은 상품의 다른 소재에서 채워지는지 본다.
const LONG_TITLE = "느루 프리미엄 원목 헤드셋 거치대 게이밍 데스크 정리 스탠드 5종 세트 한정판";
const info = new Map([
  [AD(1), { title: LONG_TITLE, url: "https://smartstore.naver.com/neuru/products/1?a=1&b=2" }],
  [AD(2), { title: LONG_TITLE }],
  [AD(3), { title: "느루 V라인 책꽂이", url: "https://smartstore.naver.com/neuru/products/3" }],
  [AD(4), { title: "느루 소액상품" }],
  [AD(5), { title: "느루 소액상품" }],
  [AD(7), { title: "느루 전환상품" }],
  // AD(6)은 일부러 이름 없음 → 소재ID가 라벨로 남아야 함
]);
const rows = buildProductRows(adRows, info);

const find = (label: string) => rows.find((r) => r.label === label);
ok(!!find(LONG_TITLE), "같은 상품이 다른 캠페인·그룹에 있어도 한 줄로 합쳐짐");
ok(find(LONG_TITLE)!.metrics.cost === 46000, `헤드셋 합산 비용 = 40000+6000 = 46000 (실제 ${find(LONG_TITLE)!.metrics.cost})`);
ok(find(LONG_TITLE)!.metrics.impressions === 4000, "헤드셋 합산 노출 = 3000+1000 = 4000");
ok(rows.filter((r) => r.label === LONG_TITLE).length === 1, "합쳐진 상품은 한 줄만");
ok(!!find("느루 소액상품"), "흩어진 소액 상품도 합산되어 남는다");
ok(find("느루 소액상품")!.metrics.cost === 400, "소액상품 합산 = 200+200 = 400");
// 접기 폐지 — 소액이든 전환이 없든 모든 상품이 개별 행으로 남는다
ok(!find("기타 상품"), "'기타 상품' 행 없음 — 상품별은 접지 않는다");
ok(!!find(AD(6)), "이름 없는 소액 소재도 접히지 않고 소재ID 라벨로 남는다");
ok(find(AD(6))!.metrics.cost === 50, "잔챙이(50원)도 제 행 유지");
ok(!!find("느루 전환상품") && find("느루 전환상품")!.metrics.cost === 60, "소액 전환상품도 제 행 유지");
// 링크 — 같은 상품의 여러 소재 중 링크 있는 것에서 채워진다
ok(find(LONG_TITLE)!.url === "https://smartstore.naver.com/neuru/products/1?a=1&b=2", "합쳐진 상품의 링크는 링크 있는 소재에서 가져옴");
ok(find("느루 소액상품")!.url === undefined, "링크 없는 상품은 url 없음");

// 총액 보존 — 합쳐도 원본과 같아야 한다
const total = rows.reduce((s, r) => s + r.metrics.cost, 0);
const raw = adRows.reduce((s, a) => s + a.metrics.cost, 0);
ok(total === raw && total === 51510, `총비용 보존 = 원본 ${raw.toLocaleString()} (실제 ${total.toLocaleString()})`);
// 비용 내림차순
ok(rows[0].label === LONG_TITLE, "총비용 내림차순 정렬");
ok(rows[rows.length - 1].metrics.cost === 50, "제일 싼 잔챙이가 마지막");

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
ok(s9.includes(LONG_TITLE), "첫 데이터행(B4)=상품명");
ok(/<c r="C4"[^>]*><v>4000<\/v>/.test(s9), "첫 상품 합산 노출(C4)=4000");
ok(/<c r="G4"[^>]*><v>46000<\/v>/.test(s9), "첫 상품 합산 총비용(G4)=46000");
ok(!s9.includes("기타 상품"), "'기타 상품' 행 안 나옴");
// 전체 합계행 — 3=헤더, 4~(3+N)=데이터, 그 다음이 합계
ok(rows.length === 5, `렌더 대상 5행: 헤드셋/V라인/소액상품/전환상품/잔챙이 (실제 ${rows.length}: ${rows.map((r) => r.label).join(",")})`);
const totalRow = 4 + rows.length; // = 9
ok(new RegExp(`<c r="B${totalRow}"[^>]*t="inlineStr"[^>]*><is><t[^>]*>전체 합계</t>`).test(s9), `전체 합계행(B${totalRow})`);
ok(new RegExp(`<c r="G${totalRow}"[^>]*><v>${raw}</v>`).test(s9), `전체 합계 총비용(G${totalRow})=${raw.toLocaleString()}`);
// ── 제목행 잔여 칸 (양식이 키워드 시트 복제라 B~P에 주황 셀이 깔려 있음) ──
// 이 배치는 N에서 끝나므로 O2/P2가 남으면 표 오른쪽에 주황 칸이 떠 있는다.
ok(!/<c r="O2"/.test(s9) && !/<c r="P2"/.test(s9), "제목행 잔여 칸(O2/P2) 제거 — 표 밖 주황 칸 없음");
ok(/<c r="N2"/.test(s9), "제목행은 N2까지 유지(병합 B2:N2 배경)");

// ── 상품명 열 너비: 긴 이름이 다 보여야 한다(기본 55자 상한 해제) ──
const colB = s9.match(/<col min="2" max="2" width="([\d.]+)"/);
ok(!!colB && Number(colB[1]) > 55, `상품명 열(B) 폭이 기본 상한 55 초과 = 전체 노출 (실제 ${colB?.[1]})`);

// ── 하이퍼링크: 상품명 클릭 → 상품 페이지 ──
const rel9 = re["xl/worksheets/_rels/sheet9.xml.rels"] ? readText(re, "xl/worksheets/_rels/sheet9.xml.rels") : "";
ok(/<hyperlinks><hyperlink ref="B4" r:id="rId\d+"\/>/.test(s9), "첫 상품(B4)에 하이퍼링크");
ok(/<hyperlinks>[\s\S]*<\/hyperlinks><pageMargins/.test(s9), "<hyperlinks>가 pageMargins 앞 — 스키마 순서(어기면 엑셀 복구 대화상자)");
ok(/TargetMode="External"/.test(rel9), "링크가 시트 rels에 External로 등록");

// 링크 셀은 파랑+밑줄로 보여야 한다 — 안 그러면 눌러보기 전엔 링크인 줄 모른다
const styles = readText(re, "xl/styles.xml");
const fontList = (styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)?.[1] ?? "").match(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g) ?? [];
const xfList = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
// count 속성과 실제 개수가 어긋나면 엑셀이 '복구' 대화상자를 띄운다
ok(styles.match(/<fonts count="(\d+)"/)?.[1] === String(fontList.length), `fonts count 선언 == 실제 개수(${fontList.length})`);
ok(styles.match(/<cellXfs count="(\d+)"/)?.[1] === String(xfList.length), `cellXfs count 선언 == 실제 개수(${xfList.length})`);
const linkXfIdx = xfList.length - 1;
const linkFontId = Number(xfList[linkXfIdx].match(/fontId="(\d+)"/)?.[1] ?? -1);
ok(/<color rgb="FF0563C1"\/>/.test(fontList[linkFontId] ?? ""), "링크 글꼴 = 파랑(0563C1)");
ok(/<u\/>/.test(fontList[linkFontId] ?? ""), "링크 글꼴 = 밑줄");
ok(/<sz val="\d+"\/>/.test(fontList[linkFontId] ?? ""), "원본 글꼴의 크기 유지(색·밑줄만 덮어씀)");
// 링크 있는 행만 그 스타일 — 없는 행까지 파랗게 하면 안 눌리는 파란 글씨가 된다
const styleOf = (addr: string) => s9.match(new RegExp(`<c r="${addr}"[^>]*s="(\\d+)"`))?.[1];
ok(styleOf("B4") === String(linkXfIdx), `링크 있는 상품(B4)이 링크 스타일 사용 (실제 s=${styleOf("B4")})`);
ok(styleOf("B6") !== String(linkXfIdx), `링크 없는 상품(B6)은 원래 스타일 유지 (실제 s=${styleOf("B6")})`);
// URL의 &는 XML 이스케이프 필수 — 안 하면 파일이 깨진다
ok(rel9.includes("products/1?a=1&amp;b=2") && !/[^m]&[^a]/.test(rel9), "URL의 & 이스케이프(&amp;)");
ok((s9.match(/<hyperlink /g) ?? []).length === 2, "링크 있는 상품 2개만 하이퍼링크(없는 상품은 안 검)");

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
