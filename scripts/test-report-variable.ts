// 키워드 시트 동적 렌더 검증. node --import ./scripts/ts-resolve.mjs scripts/test-report-variable.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText } from "../src/lib/report-excel.ts";
import {
  renderKeywordSheet,
  renderCampaignSheet,
  renderSummaryTypes,
  type KeywordGroup,
  type CampaignTypeGroup,
  type SummaryType,
} from "../src/lib/report-variable.ts";
import type { ReportMetrics } from "../src/lib/report-data.ts";

const M = (imp: number, clk: number, cost: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, revenue: rev, directConv: dir, indirectConv: indir,
});

// 그룹 2개(브랜드 2키워드 / 핵심키워드 3키워드) — 양식 표본(브랜드 3/핵심 3/세부 3)과 다른 개수로 동적 검증
const groups: KeywordGroup[] = [
  {
    campaign: "파워링크",
    group: "브랜드",
    keywords: [
      { keyword: "케라셀", metrics: M(7000, 300, 540000, 1900000, 26, 11) },
      { keyword: "케라셀네일", metrics: M(2400, 95, 140000, 360000, 4, 2) },
    ],
  },
  {
    campaign: "파워링크",
    group: "핵심키워드",
    keywords: [
      { keyword: "발톱영양제", metrics: M(8500, 310, 480000, 1400000, 18, 8) },
      { keyword: "손톱강화제", metrics: M(6200, 240, 360000, 980000, 12, 5) },
      { keyword: "풋크림", metrics: M(5800, 180, 250000, 620000, 8, 4) },
    ],
  },
  {
    // 키워드 1개짜리 그룹 — 소계를 안 넣는 경로 검증(데이터행을 그대로 베낀 소계는 표만 길어진다)
    campaign: "파워링크",
    group: "단독그룹",
    keywords: [{ keyword: "유일키워드", metrics: M(1000, 50, 30000, 90000, 2, 1) }],
  },
];

// 검색광고 캠페인별 (sheet3 섹션2): 3단계 유형|캠페인|그룹. 파워링크 캠페인A(2그룹) / 쇼핑 캠페인C(1그룹)
const campGroups: CampaignTypeGroup[] = [
  {
    type: "파워링크",
    rows: [
      { campaign: "캠페인A", group: "브랜드", metrics: M(25000, 720, 820000, 2900000, 30, 12) },
      { campaign: "캠페인A", group: "핵심키워드", metrics: M(38000, 980, 1120000, 2400000, 18, 8) },
    ],
  },
  {
    type: "쇼핑검색광고",
    rows: [{ campaign: "캠페인C", group: "핵심상품", metrics: M(40000, 920, 1380000, 3600000, 90, 42) }],
  },
];

// 종합 캠페인 유형별 (sheet2 섹션3): 검색 2유형 + 디스플레이 1유형
const searchTypes: SummaryType[] = [
  { label: "파워링크", metrics: M(45000, 980, 1078000, 3360000, 30, 12) },
  { label: "쇼핑검색광고", metrics: M(58000, 1240, 1870000, 4760000, 110, 51) },
];
const displayTypes: SummaryType[] = [
  { label: "웹사이트전환", metrics: M(1053000, 8995, 2016000, 1466000, 80, 42) },
];

// 쇼핑검색_키워드(sheet6) — 전체합계 행이 양식상 11행(파워링크는 16행). 자동 탐지 검증용.
const shoppingGroups: KeywordGroup[] = [
  {
    campaign: "쇼핑검색광고",
    group: "핵심상품",
    keywords: [
      { keyword: "케라셀 풋크림", metrics: M(18000, 420, 640000, 2200000, 55, 25) },
      { keyword: "케라셀 네일", metrics: M(12000, 300, 460000, 1100000, 28, 12) },
    ],
  },
];

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
renderKeywordSheet(files, "xl/worksheets/sheet5.xml", groups);
renderKeywordSheet(files, "xl/worksheets/sheet6.xml", shoppingGroups);
renderCampaignSheet(files, "xl/worksheets/sheet3.xml", campGroups);
renderSummaryTypes(files, searchTypes, displayTypes);
const out = buildXlsx(files);
writeFileSync("dist-kw-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);
const s5 = readText(re, "xl/worksheets/sheet5.xml");

ok(re["xl/worksheets/sheet5.xml"] !== undefined, "sheet5 존재");
ok(s5.includes("케라셀") && s5.includes("발톱영양제") && s5.includes("풋크림"), "키워드 라벨 주입");
// 행 구성: 4-5 브랜드 키워드, 6 브랜드 소계, 7-9 핵심 키워드, 10 핵심 소계,
//          11 단독그룹(키워드 1개 → 소계 없음), 12 전체합계
ok(/<c r="B4"[^>]*t="inlineStr"[^>]*><is><t[^>]*>파워링크<\/t>/.test(s5), "그룹 첫행에 캠페인명(B4)");
ok(/<c r="C4"[^>]*><is><t[^>]*>브랜드<\/t>/.test(s5), "그룹 첫행에 그룹명(C4)");
ok(/<c r="B5"[^>]*\/>/.test(s5), "후속 데이터행 캠페인칸 빈셀(B5)");
ok(/<c r="D6"[^>]*><is><t[^>]*>소계<\/t>/.test(s5), "브랜드 소계행(D6=소계)");
ok(/<c r="E6"[^>]*><v>9400<\/v>/.test(s5), "브랜드 소계 노출=7000+2400=9400 (E6)");
ok(/<c r="E10"[^>]*><v>20500<\/v>/.test(s5), "핵심키워드 소계 노출=8500+6200+5800=20500 (E10)");
// 키워드 1개짜리 그룹(단독그룹) — 데이터행만 있고 소계행이 없어야 한다
ok(/<c r="D11"[^>]*><is><t[^>]*>유일키워드<\/t>/.test(s5), "단독그룹 데이터행(D11=유일키워드)");
ok((s5.match(/<is><t[^>]*>소계<\/t>/g) ?? []).length === 2, "소계행은 2개(브랜드/핵심)뿐 — 단독그룹엔 없음");
ok(/<c r="B12"[^>]*><is><t[^>]*>전체 합계<\/t>/.test(s5), "전체합계행(B12)");
// 소계를 건너뛴 그룹(단독그룹 1000)도 전체합계에는 그대로 들어가야 한다
ok(/<c r="E12"[^>]*><v>30900<\/v>/.test(s5), "전체합계 노출=9400+20500+1000=30900 (E12) — 소계 생략 그룹도 합산됨");
ok(/<mergeCell ref="B12:D12"\/>/.test(s5), "전체합계 라벨 병합(B12:D12)");
ok(!/<row r="16"/.test(s5), "양식 표본 잔여행(16) 제거됨");

// 검색광고 캠페인별 (sheet3, 3단계 유형|캠페인|그룹, 지표 E~P):
// 제목(2행) 아래 3~13행이 일자별 콤보 그래프 자리라 섹션2가 +11 밀렸다 → 헤더 21,
// 22-23 파워링크 캠페인A 2그룹(C22:C23 병합), 24 파워링크 소계,
// 25 쇼핑 캠페인C **(1행뿐이라 소계 없음)**, 26 전체합계
const s3 = readText(re, "xl/worksheets/sheet3.xml");
ok(/<c r="D21"[^>]*><is><t[^>]*>그룹<\/t>/.test(s3), "검색광고 헤더 그룹열 신설(D21=그룹)");
ok(/<c r="B22"[^>]*><is><t[^>]*>파워링크<\/t>/.test(s3), "검색광고 유형 첫행(B22=파워링크)");
ok(/<c r="C22"[^>]*><is><t[^>]*>캠페인A<\/t>/.test(s3), "검색광고 캠페인명(C22=캠페인A)");
ok(/<c r="D22"[^>]*><is><t[^>]*>브랜드<\/t>/.test(s3), "검색광고 그룹명 D열로 이동(D22=브랜드)");
ok(/<c r="C23"[^>]*\/>/.test(s3), "같은 캠페인 후속행 캠페인칸 빈셀(C23)");
ok(/<mergeCell ref="C22:C23"\/>/.test(s3), "같은 캠페인 세로 병합(C22:C23)");
ok(/<c r="C24"[^>]*><is><t[^>]*>파워링크 소계<\/t>/.test(s3), "검색광고 소계행(C24)에 유형명 포함('파워링크 소계')");
ok(/<c r="E24"[^>]*><v>63000<\/v>/.test(s3), "검색광고 파워링크 소계 노출=25000+38000=63000(E24)");
// 행이 1개뿐인 유형(쇼핑검색광고=캠페인C 하나)은 소계를 안 넣는다 — 데이터행을 그대로 베낀 값이라
// 표만 길어진다. 소계가 빠진 만큼 전체합계도 한 줄 위(26)로 올라온다.
ok(/<c r="B25"[^>]*><is><t[^>]*>쇼핑검색광고<\/t>/.test(s3), "쇼핑 유형 데이터행(B25)");
ok(!/<is><t[^>]*>쇼핑검색광고 소계<\/t>/.test(s3), "행 1개인 유형은 소계행 없음('쇼핑검색광고 소계' 안 나옴)");
ok(!/<mergeCell ref="B25:B25"\/>/.test(s3), "행 1개인 유형은 B열 1칸 병합도 안 만듦");
ok(/<mergeCell ref="B22:B24"\/>/.test(s3), "행 2개+소계인 유형은 B열 병합 유지(B22:B24)");
ok(/<c r="B26"[^>]*><is><t[^>]*>전체 합계<\/t>/.test(s3), "검색광고 전체합계행(B26)");
ok(/<mergeCell ref="B26:D26"\/>/.test(s3), "검색광고 전체합계 라벨 병합 3열(B26:D26)");
// 소계행을 건너뛴 유형의 값도 전체합계에는 그대로 들어가야 한다
ok(/<c r="E26"[^>]*><v>103000<\/v>/.test(s3), "전체합계 노출=63000+40000=103000(E26) — 소계 생략 유형도 합산됨");
// 그래프 자리(3~13행)는 비어 있어야 함 — 섹션1 표는 그 아래(14~18)
ok(!/<row r="([3-9]|1[0-3])"[^>]*><c /.test(s3), "그래프 자리(3~13행)에 셀 없음");
ok(/<mergeCell ref="B20:P20"\/>/.test(s3), "섹션2 헤더 바가 20행(B20:P20)");

// 종합 유형별 (sheet2 섹션3): 31-32 검색2유형, 33 검색소계, 34 디스플레이1유형, 35 디스플레이소계, 36 전체합계
const s2 = readText(re, "xl/worksheets/sheet2.xml");
ok(/<c r="B31"[^>]*><is><t[^>]*>파워링크<\/t>/.test(s2), "종합 유형 파워링크(B31)");
ok(/<c r="B33"[^>]*><is><t[^>]*>검색광고 소계<\/t>/.test(s2), "종합 검색광고 소계행(B33)");
ok(/<c r="C33"[^>]*><v>103000<\/v>/.test(s2), "종합 검색 소계 노출=45000+58000=103000(C33)");
ok(/<c r="B34"[^>]*><is><t[^>]*>웹사이트전환<\/t>/.test(s2), "종합 디스플레이 유형(B34)");
ok(/<c r="B35"[^>]*><is><t[^>]*>디스플레이 소계<\/t>/.test(s2), "종합 디스플레이 소계행(B35)");
ok(/<c r="B36"[^>]*><is><t[^>]*>전체 합계<\/t>/.test(s2), "종합 전체합계행(B36)");
ok(/<mergeCell ref="B29:N29"\/>/.test(s2), "종합 섹션 헤더 병합(B29:N29) 보존");

// 쇼핑검색 전체합계 행 서식 = 파워링크 전체합계 행 서식과 동일해야 함(스크린샷 버그)
const s6 = readText(re, "xl/worksheets/sheet6.xml");
const totalStyle = (xml: string): { K: string; N: string } => {
  const m = xml.match(/<mergeCell ref="B(\d+):D\1"\/>/)!;
  const row = xml.match(new RegExp(`<row r="${m[1]}"[^>]*>([\\s\\S]*?)</row>`))![1];
  const sty = (c: string) => (row.match(new RegExp(`<c r="${c}\\d+"[^>]*\\ss="(\\d+)"`)) ?? [])[1] ?? "없음";
  return { K: sty("K"), N: sty("N") };
};
const pw = totalStyle(s5);
const sh = totalStyle(s6);
ok(sh.K !== "없음" && sh.N !== "없음", "쇼핑검색 전체합계 행에 서식 스타일 존재(무서식 버그 해결)");
ok(pw.K === sh.K && pw.N === sh.N, `쇼핑 전체합계 서식 = 파워링크와 동일 (K:${pw.K}/${sh.K} N:${pw.N}/${sh.N})`);

console.log(fail === 0 ? `\n전체 통과 ✅` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
