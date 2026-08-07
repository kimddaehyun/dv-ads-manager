// F-Report 리포트 설정 검증 — 접기 임계 비율 옵션 + 직접/간접 열 숨김.
// node --import ./scripts/ts-resolve.mjs scripts/test-report-settings.ts
import { buildKeywordGroups } from "../src/features/report/report-build.ts";
import { hideColumns, dropRowCellsAfter } from "../src/features/report/report-excel.ts";
import type { AdvReportResult } from "../src/features/report/report-data.ts";

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };

// ── 접기 임계 비율 옵션 ──
const HEAD = ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "expKeyword",
  "impCnt", "clkCnt", "ctr", "cpc", "salesAmt", "ccnt", "drtCcnt", "idrtCcnt", "crto", "ror", "purchaseCcnt", "purchaseConvAmt", "convAmt"];
const row = (kw: string, cost: number): string[] =>
  ["파워링크", "[캠페인A](cmp-1)", "[그룹A](grp-1)", kw, "100", "10", "0.1", "10", String(cost),
    "0", "0", "0", "0", "0", "0", "0", "0"];

// 총비용 919,000 — 기본(0.5%) 임계 4,595 / 2% 임계 18,380 / 0 = 접지 않음
const res: AdvReportResult = {
  head: HEAD,
  rows: [row("대형", 900000), row("중형", 15000), row("소형", 4000)],
  totalResults: 3,
};
const kwOf = (ratio?: number) =>
  buildKeywordGroups(res, "파워링크", "expKeyword", ratio)[0].keywords.map((k) => k.keyword);

ok(kwOf().join(",") === "대형,중형,기타 키워드", `기본 0.5%: 소형만 접힘 (실제 ${kwOf().join(",")})`);
ok(kwOf(0.005).join(",") === kwOf().join(","), "0.005 명시 = 기본과 동일");
ok(kwOf(0).join(",") === "대형,중형,소형", `0(접지 않음): 기타 행 없음 (실제 ${kwOf(0).join(",")})`);
ok(kwOf(0.02).join(",") === "대형,기타 키워드", `2%: 중형(15,000)도 접힘 (실제 ${kwOf(0.02).join(",")})`);
// 불변식: 어떤 임계든 총액 보존
for (const r of [0, 0.005, 0.02]) {
  const sum = buildKeywordGroups(res, "파워링크", "expKeyword", r)[0]
    .keywords.reduce((s, k) => s + k.metrics.cost, 0);
  ok(sum === 919000, `임계 ${r}: 총비용 보존 (실제 ${sum.toLocaleString()})`);
}

// ── hideColumns — 기존 <cols> 범위 분할 + hidden="1", 너비/스타일 보존 ──
const xml1 =
  `<worksheet><cols><col min="2" max="2" width="10.5" customWidth="1"/><col min="12" max="15" width="8" customWidth="1"/></cols>` +
  `<sheetData><row r="1"><c r="M1"><v>1</v></c></row></sheetData></worksheet>`;
const hidden1 = hideColumns(xml1, ["M", "N"]); // M=13, N=14 — 12~15 범위 안
ok(hidden1.includes(`<col min="13" max="13" width="8" customWidth="1" hidden="1"/>`),
  "M열: 기존 너비 보존 + hidden");
ok(hidden1.includes(`<col min="14" max="14" width="8" customWidth="1" hidden="1"/>`), "N열 hidden");
ok(hidden1.includes(`<col min="12" max="12" width="8" customWidth="1"/>`), "범위 앞쪽(12) 분할 유지");
ok(hidden1.includes(`<col min="15" max="15" width="8" customWidth="1"/>`), "범위 뒤쪽(15) 분할 유지");
ok(hidden1.includes(`<col min="2" max="2" width="10.5" customWidth="1"/>`), "무관한 열 정의 불변");
ok(hidden1.includes(`<c r="M1"><v>1</v></c>`), "셀 값은 그대로(숨김일 뿐 삭제 아님)");

// cols 블록이 없거나 대상 열 정의가 없으면 새로 만든다.
const xml2 = `<worksheet><sheetData><row r="1"/></sheetData></worksheet>`;
const hidden2 = hideColumns(xml2, ["O", "P"]);
ok(hidden2.includes(`<col min="15" max="15" hidden="1"/>`) && hidden2.includes(`<col min="16" max="16" hidden="1"/>`),
  "cols 블록 없던 시트에도 hidden 열 생성");
ok(hidden2.indexOf("<cols>") < hidden2.indexOf("<sheetData>"), "cols 블록은 sheetData 앞");

// 이미 hidden인 범위를 다시 숨겨도 hidden 중복이 없다.
const xml3 = `<worksheet><cols><col min="13" max="13" width="8" hidden="1"/></cols><sheetData/></worksheet>`;
const hidden3 = hideColumns(xml3, ["M"]);
ok((hidden3.match(/hidden=/g) ?? []).length === 1, "hidden 속성 중복 없음");

// hidden="0"이 있던 열도 속성 중복 없이 hidden="1"로 교체된다 (중복 속성 = XML 위반).
const xml3b = `<worksheet><cols><col min="13" max="13" width="8" hidden="0"/></cols><sheetData/></worksheet>`;
const hidden3b = hideColumns(xml3b, ["M"]);
ok((hidden3b.match(/hidden=/g) ?? []).length === 1 && hidden3b.includes(`hidden="1"`),
  `hidden="0" → hidden="1" 교체(중복 없음)`);

// ── dropRowCellsAfter — 섹션1(sheet3/7) 직접/간접 셀 제거 검증 ──
const xml4 =
  `<worksheet><sheetData>` +
  `<row r="14"><c r="B14" s="1"/><c r="L14" s="2"><v>3</v></c><c r="M14" s="2"><v>4</v></c><c r="N14" s="2"><v>5</v></c></row>` +
  `<row r="15"><c r="M15"><v>9</v></c></row>` +
  `</sheetData></worksheet>`;
const dropped = dropRowCellsAfter(xml4, 14, "L");
ok(!dropped.includes(`r="M14"`) && !dropped.includes(`r="N14"`), "14행 M/N 셀 제거");
ok(dropped.includes(`r="L14"`) && dropped.includes(`r="B14"`), "L 이하 셀 보존");
ok(dropped.includes(`r="M15"`), "다른 행은 불변");

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
