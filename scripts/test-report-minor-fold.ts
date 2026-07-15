// 0.5% 미만 행 접기 검증 (합성 데이터). node --import ./scripts/ts-resolve.mjs scripts/test-report-minor-fold.ts
//
// 핵심 불변식 2가지:
//  1) 접어도 총액이 바뀌면 안 된다 (예전 topN 컷은 잘린 만큼 소계가 어긋났다).
//  2) 임계는 **캠페인마다** — 시트 전체 기준이면 큰 캠페인이 임계를 끌어올려 작은 캠페인이 통째로 접힌다.
import { buildKeywordGroups } from "../src/lib/report-build.ts";
import type { AdvReportResult } from "../src/lib/report-data.ts";

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };

// advanced-report 응답 모양: head 순서 = row 값 순서.
const HEAD = ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "expKeyword",
  "impCnt", "clkCnt", "ctr", "cpc", "salesAmt", "ccnt", "drtCcnt", "idrtCcnt", "crto", "ror", "purchaseCcnt", "purchaseConvAmt", "convAmt"];
// cost = salesAmt, pc = purchaseCcnt(구매완료). 나머지는 접기 판단에 안 쓰여 0.
const row = (tp: string, camp: string, grp: string, kw: string, cost: number, pc = 0): string[] =>
  [tp, `[${camp}](cmp-1)`, `[${grp}](grp-1)`, kw, "100", "10", "0.1", "10", String(cost),
    "0", "0", "0", "0", "0", String(pc), "0", "0"];

// 캠페인A 총비용 1,000,000 → 임계 5,000 / 캠페인B 총비용 98,400 → 임계 492
const res: AdvReportResult = {
  head: HEAD,
  rows: [
    row("파워링크", "캠페인A", "그룹A", "케라셀", 600000),
    row("파워링크", "캠페인A", "그룹A", "케라셀샴푸", 300000),
    row("파워링크", "캠페인A", "그룹A", "잔챙이1", 4000),        // < 5000 → 기타
    row("파워링크", "캠페인A", "그룹A", "잔챙이2", 3000),        // < 5000 → 기타
    row("파워링크", "캠페인A", "그룹A", "전환난잔챙이", 3000, 2), // < 5000 이지만 전환 2 → 남는다
    row("파워링크", "캠페인A", "그룹A2", "다른그룹키워드", 90000),
    row("파워링크", "캠페인B", "그룹B", "탈모샴푸", 95000),
    row("파워링크", "캠페인B", "그룹B", "소액이지만유효", 3000),  // 캠페인B 임계 500 초과 → 남는다
    row("파워링크", "캠페인B", "그룹B", "진짜잔챙이", 400),       // < 500 → 기타
    row("쇼핑검색", "캠페인C", "그룹C", "다른유형", 999999),      // 유형 필터로 제외
  ],
  totalResults: 10,
};

const groups = buildKeywordGroups(res, "파워링크", "expKeyword");
const byGroup = (name: string) => groups.find((g) => g.group === name)!;
const kwOf = (name: string) => byGroup(name).keywords.map((k) => k.keyword);
const costOf = (grp: string, kw: string) => byGroup(grp).keywords.find((k) => k.keyword === kw)?.metrics.cost;

ok(groups.length === 3, `파워링크 그룹 3개 (실제 ${groups.length})`);
ok(!groups.some((g) => g.keywords.some((k) => k.keyword === "다른유형")), "다른 캠페인 유형(쇼핑검색) 제외");

// 캠페인A/그룹A — 임계 5,000
ok(kwOf("그룹A").join(",") === "케라셀,케라셀샴푸,전환난잔챙이,기타 키워드",
  `그룹A = 케라셀,케라셀샴푸,전환난잔챙이,기타 키워드 (실제 ${kwOf("그룹A").join(",")})`);
ok(costOf("그룹A", "기타 키워드") === 7000, `그룹A 기타 = 4000+3000 = 7000 (실제 ${costOf("그룹A", "기타 키워드")})`);
ok(kwOf("그룹A").includes("전환난잔챙이"), "전환 난 키워드는 임계 미만이어도 남는다");

// 캠페인B — 임계 492 (캠페인A 기준 5,000이면 '소액이지만유효'가 잘못 접힌다)
ok(kwOf("그룹B").join(",") === "탈모샴푸,소액이지만유효,기타 키워드",
  `그룹B = 탈모샴푸,소액이지만유효,기타 키워드 (실제 ${kwOf("그룹B").join(",")})`);
ok(costOf("그룹B", "기타 키워드") === 400, `그룹B 기타 = 400 (실제 ${costOf("그룹B", "기타 키워드")})`);
ok(byGroup("그룹B").keywords.every((k) => k.keyword !== "진짜잔챙이"), "캠페인B 임계(492) 미만은 접힘");
ok(kwOf("그룹B").includes("소액이지만유효"),
  "임계가 시트 전체가 아닌 '해당 캠페인' 총비용 기준 (3000원이 캠페인B에선 살아남음)");

// 같은 캠페인의 다른 그룹도 캠페인 임계를 공유
ok(kwOf("그룹A2").join(",") === "다른그룹키워드", `그룹A2 = 다른그룹키워드 (실제 ${kwOf("그룹A2").join(",")})`);

// 불변식: 접어도 총액 보존 — 캠페인A 1,000,000 + 캠페인B 98,400
const rendered = groups.reduce((s, g) => s + g.keywords.reduce((t, k) => t + k.metrics.cost, 0), 0);
const raw = res.rows.filter((r) => r[0] === "파워링크").reduce((s, r) => s + Number(r[8]), 0);
ok(rendered === raw && rendered === 1098400,
  `접은 뒤에도 총비용 보존 = 원본 ${raw.toLocaleString()} (실제 ${rendered.toLocaleString()})`);

// 접을 게 없으면 기타 행을 안 만든다.
const clean: AdvReportResult = {
  head: HEAD,
  rows: [row("파워링크", "캠페인A", "그룹A", "케라셀", 500), row("파워링크", "캠페인A", "그룹A", "탈모", 500)],
  totalResults: 2,
};
ok(!buildKeywordGroups(clean, "파워링크", "expKeyword")[0].keywords.some((k) => k.keyword === "기타 키워드"),
  "임계 넘는 행만 있으면 기타 행 없음");

// 전부 0원(집행 없는 기간)이면 임계 0 → 아무것도 안 접힌다.
const zero: AdvReportResult = {
  head: HEAD,
  rows: [row("파워링크", "캠페인A", "그룹A", "케라셀", 0), row("파워링크", "캠페인A", "그룹A", "탈모", 0)],
  totalResults: 2,
};
const zeroKw = buildKeywordGroups(zero, "파워링크", "expKeyword")[0].keywords;
ok(zeroKw.length === 2 && !zeroKw.some((k) => k.keyword === "기타 키워드"),
  "전부 0원이면 임계 0 → 접기 없음(0원 키워드가 통째로 기타로 사라지지 않음)");

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
