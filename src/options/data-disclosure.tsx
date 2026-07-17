import { useState } from "react";
import { Card } from "@/components/Card";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-ads-legal/";

interface Row {
  data: string;
  use: string;
  destination: string;
}

const COLLECTED: Row[] = [
  {
    data: "네이버 검색광고 API 자격증명 (Customer ID / Access License / Secret Key)",
    use: "사용자가 등록한 광고주의 검색광고 API 호출 (키워드별 순위·예상 입찰가 조회)",
    destination: "사내 서버(Supabase) 저장 - Secret Key는 암호화 저장, 로컬은 캐시",
  },
  {
    data: "광고관리자 페이지의 키워드·입찰가·소재 정보",
    use: "키워드 옆 오버레이에 순위·예상 입찰가 표시",
    destination: "사용자 브라우저 메모리만 - 외부 전송 없음",
  },
  {
    data: "회원 정보 (이메일)",
    use: "로그인 계정 식별 및 관리자 승인 여부 확인",
    destination: "사내 서버(Supabase) 저장",
  },
  {
    data: "계정 설정·그룹 (별칭·즐겨찾기·목표 ROAS·계정 그룹 등)",
    use: "다계정 대시보드·보고 문구 등에서 사용자별 설정 유지",
    destination: "사내 서버(Supabase) 저장",
  },
];

const NOT_COLLECTED = [
  "이름·이메일·전화번호·주소 등 개인 식별 정보",
  "위치 정보 / 금융 정보 / 건강 정보",
  "개인 통신 내역 / 일반 웹 탐색 기록",
];

export default function DataDisclosure() {
  // 기본은 접힘 - 매번 볼 내용이 아니라서 자리만 차지하지 않게 하고, 필요할 때 펼쳐 본다.
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-base font-semibold text-gray-900"
        >
          데이터 처리 요약
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <polyline points="5 8 10 13 15 8" />
          </svg>
        </button>
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs underline text-brand"
        >
          전체 개인정보처리방침 보기 ↗
        </a>
      </div>

      {open && (
      <div className="overflow-hidden rounded-lg bg-input mt-4">
        <table className="w-full text-xs">
          <thead className="text-gray-700">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-1/3">수집 항목</th>
              <th className="text-left px-3 py-2 font-medium w-1/3">사용 목적</th>
              <th className="text-left px-3 py-2 font-medium w-1/3">전달처 / 저장 위치</th>
            </tr>
          </thead>
          <tbody className="text-gray-700 bg-white">
            {COLLECTED.map((r, i) => (
              <tr key={i} className="border-t border-divider align-top">
                <td className="px-3 py-2">{r.data}</td>
                <td className="px-3 py-2">{r.use}</td>
                <td className="px-3 py-2">{r.destination}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {open && (
        <div className="mt-4 text-xs text-gray-600">
          <p className="font-medium text-gray-800 mb-1">수집하지 않는 정보</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {NOT_COLLECTED.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
