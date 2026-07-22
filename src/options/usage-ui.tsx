/**
 * usage-ui.tsx — 관리자 사용량 카드.
 *
 * usage_daily(선택 기간 합계) + admin_alert_counts(알림 켠 계정 수, 현재 상태)를
 * 사용자별 1행 표로 보여준다. profile.is_admin === true 인 사용자에게만 노출.
 */

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/Card";
import { getSupabase } from "@/shared/supabase";
import { openReportDatePicker } from "@/features/report/report-datepicker";
import { rangeForPreset, type DateRange } from "@/features/report/report-period";
// 달력(dvads-rdp) 스타일은 콘텐츠 스크립트 전용 CSS에 있어 옵션 페이지에선 직접 로드.
import "@/styles/overlay.css";

const AI_EVENTS = ["ai_brief", "ai_report_msg", "ai_tone"];

// Gemini 3.1 Flash-Lite 요금 (USD / 100만 토큰, 2026-07 기준). 모델 교체 시 함께 갱신.
const PRICE_IN_PER_M = 0.25;
const PRICE_OUT_PER_M = 1.5;
const USD_TO_KRW = 1500; // 환율 고정 추정치

function estimateCostKrw(tokensIn: number, tokensOut: number): number {
  return ((tokensIn * PRICE_IN_PER_M + tokensOut * PRICE_OUT_PER_M) / 1_000_000) * USD_TO_KRW;
}

function fmtKrw(v: number): string {
  if (v <= 0) return "-";
  if (v < 10) return `${v.toFixed(1)}원`;
  return `${Math.round(v).toLocaleString()}원`;
}
const FEATURE_COLUMNS: Array<{ event: string; label: string }> = [
  { event: "report_excel", label: "리포트" },
  { event: "setup_excel", label: "세팅안" },
  { event: "brief_generate", label: "보고문구" },
  { event: "history_report", label: "관리이력" },
  { event: "bid_change", label: "입찰변경" },
  { event: "asset_bulk", label: "확장소재" },
  { event: "agency_check", label: "대행권점검" },
];

interface UsageRow {
  userId: string;
  name: string;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  features: Record<string, number>;
  alertBizmoney: number;
  alertBrand: number;
  alertChangeWatch: number;
}

function fmtNum(n: number): string {
  return n > 0 ? n.toLocaleString() : "-";
}

function fmtDotRange(r: DateRange): string {
  return `${r.since.replaceAll("-", ".")}. ~ ${r.until.replaceAll("-", ".")}.`;
}

export function UsageCard() {
  const [range, setRange] = useState<DateRange>(() => rangeForPreset("last30Incl", new Date()));
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const periodBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const supabase = getSupabase();
        const [profilesRes, usageRes, alertsRes] = await Promise.all([
          supabase.from("profiles").select("id, email, display_name"),
          // 테이블 직접 select는 PostgREST 페이지 한도(1,000행)에서 조용히 잘린다 — 서버 합산 RPC 사용.
          supabase.rpc("admin_usage_summary", { p_since: range.since, p_until: range.until }),
          supabase.rpc("admin_alert_counts"),
        ]);
        if (profilesRes.error) throw profilesRes.error;
        if (usageRes.error) throw usageRes.error;
        if (alertsRes.error) throw alertsRes.error;
        if (cancelled) return;

        const byUser = new Map<string, UsageRow>();
        const ensure = (userId: string): UsageRow => {
          let r = byUser.get(userId);
          if (!r) {
            r = {
              userId, name: userId, aiCalls: 0, tokensIn: 0, tokensOut: 0,
              features: {}, alertBizmoney: 0, alertBrand: 0, alertChangeWatch: 0,
            };
            byUser.set(userId, r);
          }
          return r;
        };
        for (const u of (usageRes.data ?? []) as Array<{ user_id: string; event: string; total_count: number; total_tokens_in: number; total_tokens_out: number }>) {
          const r = ensure(u.user_id);
          if (AI_EVENTS.includes(u.event)) {
            r.aiCalls += u.total_count;
            r.tokensIn += u.total_tokens_in;
            r.tokensOut += u.total_tokens_out;
          } else {
            r.features[u.event] = (r.features[u.event] ?? 0) + u.total_count;
          }
        }
        for (const a of (alertsRes.data ?? []) as Array<{ user_id: string; bizmoney_accounts: number; brand_accounts: number; change_watch_accounts: number }>) {
          const r = ensure(a.user_id);
          r.alertBizmoney = a.bizmoney_accounts;
          r.alertBrand = a.brand_accounts;
          r.alertChangeWatch = a.change_watch_accounts;
        }
        for (const p of (profilesRes.data ?? []) as Array<{ id: string; email: string; display_name: string }>) {
          const r = byUser.get(p.id);
          if (r) r.name = p.display_name || p.email;
        }
        setRows([...byUser.values()].sort((a, b) => a.name.localeCompare(b.name, "ko")));
      } catch (e) {
        console.warn("[usage-ui] load failed", e);
        if (!cancelled) setError("사용량을 불러오지 못했어요. 잠시 후 다시 시도해 주세요");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range.since, range.until]);

  function openPeriodPicker(): void {
    const anchor = periodBtnRef.current;
    if (!anchor) return;
    openReportDatePicker({
      anchor,
      subText: "사용량 조회 기간",
      showAuthor: false,
      initialRange: range,
      onConfirm: (r) => setRange(r),
    });
  }

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900">관리자 - 사용량</h2>
        <button
          ref={periodBtnRef}
          type="button"
          onClick={openPeriodPicker}
          className="h-8 px-3 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
        >
          {fmtDotRange(range)}
        </button>
      </div>

      {error && (
        <div className="mb-3 text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">불러오는 중...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">기록된 사용량이 없어요.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4 font-medium">사용자</th>
                <th className="py-2 px-3 font-medium text-right">AI 호출</th>
                <th className="py-2 px-3 font-medium text-right">토큰(입력)</th>
                <th className="py-2 px-3 font-medium text-right">토큰(출력)</th>
                <th className="py-2 px-3 font-medium text-right">비용</th>
                {FEATURE_COLUMNS.map((c) => (
                  <th key={c.event} className="py-2 px-3 font-medium text-right">{c.label}</th>
                ))}
                <th className="py-2 px-3 font-medium text-right">비즈머니알림 계정</th>
                <th className="py-2 px-3 font-medium text-right">브랜드알림 계정</th>
                <th className="py-2 px-3 font-medium text-right">변경이력알림 계정</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 pr-4 text-gray-900">{r.name}</td>
                  <td className="py-2 px-3 text-right">{fmtNum(r.aiCalls)}</td>
                  <td className="py-2 px-3 text-right">{fmtNum(r.tokensIn)}</td>
                  <td className="py-2 px-3 text-right">{fmtNum(r.tokensOut)}</td>
                  <td className="py-2 px-3 text-right">{fmtKrw(estimateCostKrw(r.tokensIn, r.tokensOut))}</td>
                  {FEATURE_COLUMNS.map((c) => (
                    <td key={c.event} className="py-2 px-3 text-right">{fmtNum(r.features[c.event] ?? 0)}</td>
                  ))}
                  <td className="py-2 px-3 text-right">{fmtNum(r.alertBizmoney)}</td>
                  <td className="py-2 px-3 text-right">{fmtNum(r.alertBrand)}</td>
                  <td className="py-2 px-3 text-right">{fmtNum(r.alertChangeWatch)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
