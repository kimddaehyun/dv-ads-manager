/**
 * 대행권 점검 결과 엑셀 다운로드.
 *
 * write-excel-file/browser는 무거운 의존성이라 호출 측(multi-account.ts)에서 동적 import로
 * 분리해 콘텐츠 초기 번들을 부풀리지 않는다 (setup-excel/report와 동일 패턴).
 *
 * 컬럼은 ads.naver.com '대행권 이관 관리' 화면이 보여주는 항목을 모두 담는다:
 * 우리 계정명/번호 + 상태 + 에이전시 + 대표·담당 관리 계정(명/번호) + 승인 일자 + 영업 타입.
 */

import writeXlsxFile from "write-excel-file/browser";
import type { SheetData } from "write-excel-file/browser";

export interface AgencyCheckExcelRow {
  name: string;        // 우리 계정명 (별칭 우선)
  adAccountNo: number; // 우리 계정번호
  statusLabel: string; // 상태 (정상 / 타대행사 / 없음 / 확인 필요)
  agency: string;      // 에이전시명 (확인 필요는 사유 메시지)
  ownerName: string;   // 대표 관리 계정명
  ownerNo: string;     // 대표 관리 계정번호
  directName: string;  // 담당 관리 계정명
  directNo: string;    // 담당 관리 계정번호
  acceptedAt: string;  // 승인 일자 (YYYY.MM.DD)
  salesType: string;   // 영업 타입
  yesterdayCost: number | null; // 전일 광고비 (SA+DA 합산, 원). 조회 실패 시 null.
  bizMoney: number | null;      // 비즈머니 잔액 (원). 조회 실패 시 null.
}

export async function downloadAgencyCheckExcel(rows: AgencyCheckExcelRow[]): Promise<void> {
  const headers = [
    "계정명",
    "계정번호",
    "상태",
    "에이전시",
    "대표 관리 계정",
    "대표 계정번호",
    "담당 관리 계정",
    "담당 계정번호",
    "승인 일자",
    "영업 타입",
    "전일 광고비",
    "비즈머니",
  ];
  const header = headers.map((value) => ({ value, fontWeight: "bold" as const }));
  const body = rows.map((r) => [
    { value: r.name },
    { value: String(r.adAccountNo) }, // 계정번호는 식별자 — 천단위 구분 없이 문자열로
    { value: r.statusLabel },
    { value: r.agency },
    { value: r.ownerName },
    { value: r.ownerNo },
    { value: r.directName },
    { value: r.directNo },
    { value: r.acceptedAt },
    { value: r.salesType },
    // 금액은 숫자형 — 천단위 서식으로 합계/정렬 가능. 조회 실패(null)는 빈 셀.
    r.yesterdayCost != null
      ? { type: Number, value: Math.round(r.yesterdayCost), format: "#,##0" as const }
      : { value: "" },
    r.bizMoney != null
      ? { type: Number, value: Math.round(r.bizMoney), format: "#,##0" as const }
      : { value: "" },
  ]);
  const data: SheetData = [header, ...body];
  const columns = [
    { width: 24 }, // 계정명
    { width: 12 }, // 계정번호
    { width: 10 }, // 상태
    { width: 26 }, // 에이전시
    { width: 22 }, // 대표 관리 계정
    { width: 12 }, // 대표 계정번호
    { width: 22 }, // 담당 관리 계정
    { width: 12 }, // 담당 계정번호
    { width: 14 }, // 승인 일자
    { width: 26 }, // 영업 타입
    { width: 14 }, // 전일 광고비
    { width: 14 }, // 비즈머니
  ];

  const result = await writeXlsxFile([{ data, columns, sheet: "대행권 점검" }], {
    fontFamily: "맑은 고딕",
    fontSize: 10,
  });
  const blob = await result.toBlob();

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `대행권점검_${stamp}.xlsx`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
