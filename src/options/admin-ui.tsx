/**
 * admin-ui.tsx — F-Accounts 관리자 탭 (가입 승인/차단 + 관리자 지정).
 *
 * profile.is_admin === true 인 사용자에게만 Options.tsx에서 노출된다.
 * RLS(Task 1) 상 관리자는 profiles 테이블 전체를 select/update 할 수 있다.
 *
 * 시각 디자인은 DV-SEO-Manager(/Users/dh/dvmkt/src/options/admin-panel.tsx)의
 * UsersList를 이식한 것 — 검색창/상태 Dropdown/표/ActionMenu 패턴. 데이터 모델·supabase
 * 쿼리·busy-guard·에러 문구·refetch 로직은 기존 그대로 유지했다. 참조 프로젝트의
 * 체크박스 일괄 작업 UI는 이 프로젝트 사용자 규모에 맞지 않아 이식하지 않았다.
 */

import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { getSupabase } from "@/shared/supabase";
import { ActionMenu, Dropdown, MenuItem, type DropdownOption } from "./admin-widgets";

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
  pending: { label: "대기", className: "bg-amber-100 text-amber-700" },
  approved: { label: "사용 중", className: "bg-green-100 text-green-700" },
  blocked: { label: "중지", className: "bg-red-100 text-red-700" },
};

const STATUS_FILTER_OPTIONS: DropdownOption[] = [
  { value: "", label: "전체 상태" },
  { value: "pending", label: "대기" },
  { value: "approved", label: "사용 중" },
  { value: "blocked", label: "중지" },
];

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

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
  return (
    <span
      className={`inline-flex items-center justify-center w-[80px] py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

export function AdminCard({ currentUserId }: AdminCardProps) {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

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

  const filteredRows = rows.filter((row) => {
    if (statusFilter && row.status !== statusFilter) return false;
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      const hay = `${row.email} ${row.display_name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">관리자 - 가입 승인</h2>

      {error && (
        <div className="mb-3 text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l4 4" />
          </svg>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="이메일 또는 이름 검색"
            className="w-full pl-9 pr-3.5 py-2 text-sm bg-[#f4f5f7] rounded-lg outline-none focus:bg-white focus:ring-2 focus:ring-[#E6783B]/30 placeholder:text-gray-400 transition"
          />
        </div>
        <Dropdown
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_FILTER_OPTIONS}
          className="min-w-[120px]"
        />
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">불러오는 중…</p>
      ) : filteredRows.length === 0 ? (
        <p className="text-sm text-gray-500">
          {rows.length === 0 ? "가입한 사용자가 없어요." : "결과 없음."}
        </p>
      ) : (
        <div className="rounded-xl overflow-hidden bg-[#f4f5f7] max-h-96 overflow-y-auto">
          <div className="hidden sm:grid grid-cols-[160px_1fr_120px_100px_60px] items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-gray-500 bg-[#eef0f3]">
            <span>이름</span>
            <span>이메일</span>
            <span className="text-center">가입일</span>
            <span className="text-center">상태</span>
            <span className="text-center">작업</span>
          </div>
          {filteredRows.map((row) => {
            const isSelf = row.id === currentUserId;
            const busy = busyId === row.id;
            return (
              <div
                key={row.id}
                className="grid grid-cols-[160px_1fr_120px_100px_60px] items-center gap-3 px-4 py-3 text-sm bg-white/40 hover:bg-white transition"
              >
                <div className="min-w-0 truncate text-gray-900">
                  {row.display_name || <span className="text-gray-400">-</span>}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-gray-900 flex items-center gap-1.5">
                    <span className="truncate">{row.email}</span>
                    {isSelf && <span className="text-gray-400 text-xs shrink-0">(나)</span>}
                    {row.is_admin && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 shrink-0">
                        관리자
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-center text-gray-600">{formatDate(row.created_at)}</div>
                <div className="flex justify-center">
                  <StatusBadge status={row.status} />
                </div>
                <div className="flex justify-center">
                  {isSelf ? (
                    <span className="flex items-center justify-center h-8 w-8 text-gray-300" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                        <circle cx="4" cy="10" r="1.6" />
                        <circle cx="10" cy="10" r="1.6" />
                        <circle cx="16" cy="10" r="1.6" />
                      </svg>
                    </span>
                  ) : (
                    <ActionMenu>
                      {(close) => (
                        <>
                          {row.status === "pending" && (
                            <>
                              <MenuItem
                                tone="blue"
                                disabled={busy}
                                onClick={() => {
                                  close();
                                  void updateStatus(row.id, "approved");
                                }}
                              >
                                승인
                              </MenuItem>
                              <MenuItem
                                tone="red"
                                disabled={busy}
                                onClick={() => {
                                  close();
                                  void updateStatus(row.id, "blocked");
                                }}
                              >
                                차단
                              </MenuItem>
                            </>
                          )}
                          {row.status === "approved" && (
                            <>
                              <MenuItem
                                tone="red"
                                disabled={busy}
                                onClick={() => {
                                  close();
                                  void updateStatus(row.id, "blocked");
                                }}
                              >
                                중지
                              </MenuItem>
                              {!row.is_admin && (
                                <MenuItem
                                  tone="blue"
                                  disabled={busy}
                                  onClick={() => {
                                    close();
                                    void makeAdmin(row.id);
                                  }}
                                >
                                  관리자 지정
                                </MenuItem>
                              )}
                            </>
                          )}
                          {row.status === "blocked" && (
                            <MenuItem
                              tone="blue"
                              disabled={busy}
                              onClick={() => {
                                close();
                                void updateStatus(row.id, "approved");
                              }}
                            >
                              승인
                            </MenuItem>
                          )}
                        </>
                      )}
                    </ActionMenu>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
