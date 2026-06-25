// 브랜드검색 계약 일할 계산(proration) 검증 (합성).
//   node scripts/test-report-proration.ts
// report-period.ts는 의존성 없는 순수 모듈이라 로더 없이 직접 실행 가능.
import {
  proratedContractAmount, proratedBrand, previousRange,
  type ProrationContract, type DateRange,
} from "../src/lib/report-period.ts";

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const eq = (a: number, b: number, m: string) => ok(a === b, `${m} (기대 ${b}, 실제 ${a})`);

const R = (since: string, until: string): DateRange => ({ since, until });

// 계약 A: KST 2026-06-01 ~ 2026-06-30 (30일), 300만원 → 1일 10만원.
// 종료 경계는 배타적이라 contractEndDt KST = 2026-07-01(= 마지막 집행일 06-30의 다음 날).
const A: ProrationContract = {
  contractAmt: 3_000_000,
  contractStartDt: "2026-05-31T15:00:00.000Z", // KST 06-01 00:00
  contractEndDt: "2026-06-30T15:00:00.000Z",   // KST 07-01 00:00 (배타)
};

eq(proratedContractAmount(A, R("2026-06-01", "2026-06-30")), 3_000_000, "전체 기간 = 전액");
eq(proratedContractAmount(A, R("2026-06-01", "2026-06-07")), 700_000, "앞 7일");
eq(proratedContractAmount(A, R("2026-06-24", "2026-06-30")), 700_000, "끝 7일(06-30 포함)");
eq(proratedContractAmount(A, R("2026-07-01", "2026-07-07")), 0, "계약 종료 다음날부터 = 0(배타 경계)");
eq(proratedContractAmount(A, R("2026-05-25", "2026-05-31")), 0, "계약 시작 전 = 0");
eq(proratedContractAmount(A, R("2026-05-28", "2026-06-03")), 300_000, "시작 걸침 3일(06-01~03)");
eq(proratedContractAmount(A, R("2026-06-25", "2026-07-05")), 600_000, "종료 걸침 6일(06-25~30)");

// 취소: cancelTm KST 06-15(배타) → 06-01~06-14 14일만.
eq(
  proratedContractAmount({ ...A, cancelTm: "2026-06-14T15:00:00.000Z" }, R("2026-06-01", "2026-06-30")),
  1_400_000, "기간 중 취소(06-15부터 중단) → 14일",
);
// 노출 시작 지연: exposureStartDt KST 06-05 → 06-05~06-30 26일.
eq(
  proratedContractAmount({ ...A, exposureStartDt: "2026-06-04T15:00:00.000Z" }, R("2026-06-01", "2026-06-30")),
  2_600_000, "노출 시작 지연(06-05) → 26일",
);
// 노출 조기 종료: exposureEndDt KST 06-21(배타) → 06-01~06-20 20일.
eq(
  proratedContractAmount({ ...A, exposureEndDt: "2026-06-20T15:00:00.000Z" }, R("2026-06-01", "2026-06-30")),
  2_000_000, "노출 조기 종료(06-21부터 중단) → 20일",
);

// 방어: 날짜 없으면 0, 금액 0이면 0, 총일수<=0이면 0.
eq(proratedContractAmount({ contractAmt: 1_000_000 }, R("2026-06-01", "2026-06-30")), 0, "날짜 없음 = 0");
eq(proratedContractAmount({ ...A, contractAmt: 0 }, R("2026-06-01", "2026-06-30")), 0, "금액 0 = 0");

// PC/모바일 별도 광고그룹 합산 (proratedBrand).
const B: ProrationContract = { ...A, contractAmt: 1_500_000 }; // 1일 5만원
const contracts = [
  { ...A, adgroupId: "ag-pc" },
  { ...B, adgroupId: "ag-mob" },
];
{
  const full = proratedBrand(contracts, R("2026-06-01", "2026-06-30"));
  eq(full.total, 4_500_000, "집계 전체: PC 300만 + 모바일 150만");
  eq(full.byAdgroup.get("ag-pc") ?? -1, 3_000_000, "집계 byAdgroup PC");
  eq(full.byAdgroup.get("ag-mob") ?? -1, 1_500_000, "집계 byAdgroup 모바일");

  const week = proratedBrand(contracts, R("2026-06-01", "2026-06-07"));
  eq(week.total, 1_050_000, "집계 7일: PC 70만 + 모바일 35만");
}

// 같은 광고그룹에 current+next 두 계약 블록 → 겹치는 것만 합산.
{
  const C: ProrationContract = {
    contractAmt: 3_100_000,
    contractStartDt: "2026-06-30T15:00:00.000Z", // KST 07-01
    contractEndDt: "2026-07-31T15:00:00.000Z",   // KST 08-01 (31일)
  };
  const two = [
    { ...A, adgroupId: "ag1" }, // 6월
    { ...C, adgroupId: "ag1" }, // 7월(next)
  ];
  const june = proratedBrand(two, R("2026-06-01", "2026-06-30"));
  eq(june.byAdgroup.get("ag1") ?? -1, 3_000_000, "current+next 중 6월은 current만");
  const cross = proratedBrand(two, R("2026-06-24", "2026-07-07"));
  // 6월: 06-24~30 7일×10만=70만 / 7월: 07-01~07 7일×10만=70만 → 140만
  eq(cross.byAdgroup.get("ag1") ?? -1, 1_400_000, "기간이 두 계약 걸침 → 합산");
}

// 전주 일할 (previousRange) — 계약이 기간 중 시작하면 증감이 실집행 변화 반영.
{
  // 계약 D: KST 06-10 시작 ~ 07-01(배타), 21일, 210만 → 1일 10만.
  const D: ProrationContract = {
    contractAmt: 2_100_000,
    contractStartDt: "2026-06-09T15:00:00.000Z", // KST 06-10
    contractEndDt: "2026-06-30T15:00:00.000Z",   // KST 07-01
  };
  const ds = [{ ...D, adgroupId: "ag" }];
  const cur = R("2026-06-08", "2026-06-14");      // 금주
  const prev = previousRange(cur);                 // 06-01~06-07
  eq(proratedBrand(ds, cur).total, 500_000, "금주(06-10~14, 5일) = 50만");
  eq(proratedBrand(ds, prev).total, 0, "전주(06-01~07, 계약 전) = 0");
}

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
