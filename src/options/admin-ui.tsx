/**
 * admin-ui.tsx — F-Accounts 관리자 탭 (가입 승인/차단 + 관리자 지정).
 *
 * profile.is_admin === true 인 사용자에게만 Options.tsx에서 노출된다.
 * RLS(Task 1) 상 관리자는 profiles 테이블 전체를 select/update 할 수 있다.
 */

import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { getSupabase } from "@/shared/supabase";

interface AdminRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  is_admin: boolean;
  created_at: string;
}

interface AdminCardProps {
  currentUserId: string;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: "대기중", className: "bg-gray-100 text-gray-600" },
  approved: { label: "사용 중", className: "bg-green-50 text-green-700" },
  blocked: { label: "중지", className: "bg-red-50 text-red-600" },
};

function formatDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sortRows(rows: AdminRow[]): AdminRow[] {
  return [...rows].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export function AdminCard({ currentUserId }: AdminCardProps) {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadRows() {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await getSupabase()
        .from("profiles")
        .select("id, email, display_name, status, is_admin, created_at");
      if (err) throw err;
      setRows(sortRows((data ?? []) as AdminRow[]));
    } catch (e) {
      console.warn("[admin-ui] loadRows failed", e);
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function updateStatus(id: string, status: string) {
    setBusyId(id);
    setError(null);
    try {
      const { error: err } = await getSupabase()
        .from("profiles")
        .update({ status })
        .eq("id", id);
      if (err) throw err;
      await loadRows();
    } catch (e) {
      console.warn("[admin-ui] updateStatus failed", e);
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요");
    } finally {
      setBusyId(null);
    }
  }

  async function makeAdmin(id: string) {
    if (!window.confirm("이 사용자를 관리자로 지정할까요?")) return;
    setBusyId(id);
    setError(null);
    try {
      const { error: err } = await getSupabase()
        .from("profiles")
        .update({ is_admin: true })
        .eq("id", id);
      if (err) throw err;
      await loadRows();
    } catch (e) {
      console.warn("[admin-ui] makeAdmin failed", e);
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">관리자 - 가입 승인</h2>

      {error && (
        <div className="mb-3 text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">가입한 사용자가 없어요.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-4 font-medium">이메일</th>
                <th className="py-2 pr-4 font-medium">이름</th>
                <th className="py-2 pr-4 font-medium">상태</th>
                <th className="py-2 pr-4 font-medium">가입일</th>
                <th className="py-2 pr-4 font-medium">작업</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isSelf = row.id === currentUserId;
                const busy = busyId === row.id;
                const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.pending;
                return (
                  <tr key={row.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-2.5 pr-4 text-gray-800">{row.email}</td>
                    <td className="py-2.5 pr-4 text-gray-700">{row.display_name || "-"}</td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-gray-500">{formatDate(row.created_at)}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-1.5">
                        {row.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              variant="brand"
                              disabled={isSelf || busy}
                              onClick={() => updateStatus(row.id, "approved")}
                            >
                              승인
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isSelf || busy}
                              onClick={() => updateStatus(row.id, "blocked")}
                            >
                              차단
                            </Button>
                          </>
                        )}
                        {row.status === "approved" && (
                          <>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isSelf || busy}
                              onClick={() => updateStatus(row.id, "blocked")}
                            >
                              중지
                            </Button>
                            {!row.is_admin && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isSelf || busy}
                                onClick={() => makeAdmin(row.id)}
                              >
                                관리자 지정
                              </Button>
                            )}
                          </>
                        )}
                        {row.status === "blocked" && (
                          <Button
                            size="sm"
                            variant="brand"
                            disabled={isSelf || busy}
                            onClick={() => updateStatus(row.id, "approved")}
                          >
                            승인
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
