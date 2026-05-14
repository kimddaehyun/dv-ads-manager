const PRIVACY_URL = "https://kimddaehyun.github.io/dv-tag-legal/";
const ORANGE = "#E6783B";

interface Row {
  data: string;
  use: string;
  destination: string;
}

const COLLECTED: Row[] = [
  {
    data: "라이선스 키 · 디바이스 ID · User-Agent",
    use: "라이선스 정상 발급 여부 및 디바이스 수 관리",
    destination: "운영자 서버 (`*.supabase.co`)",
  },
  {
    data: "네이버 검색광고 API 자격증명 (Customer ID / Access License / Secret Key)",
    use: "본인 명의의 검색광고 API 호출 (검색량 조회)",
    destination: "사용자 PC만 (`chrome.storage.local`) - 외부 전송 없음",
  },
  {
    data: "네이버 쇼핑 검색어 · 검색 결과 · manuTag · sellerTags",
    use: "패널 안에서 태그 추출·동의어·노출 분석 표시",
    destination: "사용자 브라우저 메모리만 - 외부 전송 없음",
  },
];

const NOT_COLLECTED = [
  "이름·이메일·전화번호·주소 등 개인 식별 정보",
  "위치 정보 / 금융 정보 / 건강 정보",
  "개인 통신 내역 / 일반 웹 탐색 기록",
];

export default function DataDisclosure() {
  return (
    <section className="bg-white border rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-900">
          데이터 처리 요약
        </h2>
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs underline"
          style={{ color: ORANGE }}
        >
          전체 개인정보처리방침 보기 ↗
        </a>
      </div>

      <div className="overflow-hidden rounded border border-gray-200 mt-4">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-1/3">수집 항목</th>
              <th className="text-left px-3 py-2 font-medium w-1/3">사용 목적</th>
              <th className="text-left px-3 py-2 font-medium w-1/3">전달처 / 저장 위치</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            {COLLECTED.map((r, i) => (
              <tr key={i} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2">{r.data}</td>
                <td className="px-3 py-2">{r.use}</td>
                <td className="px-3 py-2">{r.destination}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-gray-600">
        <p className="font-medium text-gray-800 mb-1">수집하지 않는 정보</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {NOT_COLLECTED.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>

    </section>
  );
}
