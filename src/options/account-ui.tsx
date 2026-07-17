/**
 * account-ui.tsx — F-Accounts 옵션 페이지 계정 카드 (가입/로그인/승인 대기/사용중).
 *
 * 주의: `auth-ui.tsx`는 라이선스 재도입용 비활성 골격(네이버 파트너 가입 폼)이고
 * 이 파일과는 무관하다. 여기는 Supabase 이메일/비밀번호 인증 + profiles.status 승인 게이트.
 *
 * 자세한 가이드: docs/DESIGN.md §Component Catalog.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { getSupabase } from "@/shared/supabase";
import { fetchAuthContext, type AuthState, type ProfileRow } from "@/shared/auth-state";
import { runMigrationOnce } from "@/shared/migrate-local";

function friendlyAuthError(raw: string): string {
  if (raw.includes("Invalid login credentials")) return "이메일 또는 비밀번호가 맞지 않아요";
  if (raw.includes("User already registered")) return "이미 가입된 이메일이에요";
  return "잠시 후 다시 시도해 주세요";
}

interface AccountCardProps {
  onAuthChange?: (state: AuthState, profile: ProfileRow | null) => void;
}

export function AccountCard({ onAuthChange }: AccountCardProps) {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AuthState>("signedOut");
  const [profile, setProfile] = useState<ProfileRow | null>(null);

  function applyState(next: AuthState, nextProfile: ProfileRow | null) {
    setState(next);
    setProfile(nextProfile);
    onAuthChange?.(next, nextProfile);
  }

  useEffect(() => {
    let cancelled = false;
    fetchAuthContext()
      .then(({ state: s, profile: p }) => {
        if (!cancelled) applyState(s, p);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const { state: s, profile: p } = await fetchAuthContext();
    applyState(s, p);
  }

  async function handleSignOut() {
    try {
      await getSupabase().auth.signOut();
    } catch (e) {
      console.warn("[account-ui] signOut failed", e);
    }
    // 같은 크롬 프로필에서 계정을 전환하면 이전 사용자의 자격증명/설정이 남아 오염된다 —
    // 로그아웃 시 사용자 종속 로컬 캐시(자격증명·별칭·그룹·추가목록·스냅샷)를 지운다.
    try {
      const [{ clearLocalCredentials }, { clearLocalAccountState }] = await Promise.all([
        import("@/shared/searchad"),
        import("@/features/multi-account/multi-account-storage"),
      ]);
      await clearLocalCredentials();
      await clearLocalAccountState();
    } catch (e) {
      console.warn("[account-ui] 로그아웃 로컬 정리 실패", e);
    }
    applyState("signedOut", null);
  }

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">계정</h2>
      {loading ? (
        <p className="text-sm text-gray-500">불러오는 중…</p>
      ) : state === "signedOut" ? (
        <AuthForm onDone={refresh} />
      ) : state === "pending" ? (
        <StatusMessage
          text="가입 확인 중이에요. 관리자 승인 후 사용할 수 있어요."
          email={profile?.email}
          onSignOut={handleSignOut}
        />
      ) : state === "blocked" ? (
        <StatusMessage
          text="사용이 중지된 계정이에요."
          email={profile?.email}
          onSignOut={handleSignOut}
        />
      ) : (
        <ApprovedView email={profile?.email} onSignOut={handleSignOut} />
      )}
    </Card>
  );
}

// ============================================================
// 로그인 / 가입 폼
// ============================================================

function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSignUp = mode === "sign-up";
  const canSubmit =
    email.trim().length > 0 && password.trim().length >= 6 && (!isSignUp || name.trim().length > 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const supabase = getSupabase();
      if (isSignUp) {
        // 이름은 가입 metadata로 전달 — 일반 회원은 profiles를 직접 수정할 수 없어(관리자만
        // update) 서버 트리거(handle_new_user)가 여기 값을 프로필에 옮겨 적는다.
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() } },
        });
        if (error) throw error;
        // 이메일 확인 대기 중인 경우 (data.session이 null)
        if (!data.session) {
          setErr("가입 처리 중이에요. 잠시 후 다시 로그인해 주세요.");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
      // 로그인 성공 직후 로컬 ↔ 서버 1회 이관. 실패해도 로그인 자체는 막지 않고 경고만 남긴다
      // (다음 로그인 때 migrated_v1 플래그가 없으니 재시도됨).
      runMigrationOnce().catch((e) => {
        console.warn("[account-ui] 이관 실패", e);
      });
      onDone();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn("[account-ui] auth failed", e);
      setErr(friendlyAuthError(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {isSignUp && (
        <Input
          type="text"
          value={name}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          placeholder="이름"
          required
        />
      )}
      <Input
        type="email"
        value={email}
        autoComplete="email"
        onChange={(e) => setEmail(e.target.value)}
        placeholder="이메일"
        required
      />
      <Input
        type="password"
        value={password}
        autoComplete={isSignUp ? "new-password" : "current-password"}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="비밀번호 (6자 이상)"
        required
        minLength={6}
      />

      {err && (
        <div className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{err}</div>
      )}

      <Button type="submit" variant="brand" disabled={!canSubmit || busy}>
        {busy ? "처리 중…" : isSignUp ? "가입하기" : "로그인"}
      </Button>

      <button
        type="button"
        onClick={() => {
          setMode(isSignUp ? "sign-in" : "sign-up");
          setErr(null);
        }}
        className="text-xs text-gray-500 hover:text-gray-700 self-start"
      >
        {isSignUp ? (
          <>이미 계정이 있으신가요? <span className="underline text-brand">로그인</span></>
        ) : (
          <>계정이 없으신가요? <span className="underline text-brand">가입하기</span></>
        )}
      </button>
    </form>
  );
}

// ============================================================
// 상태별 화면 (pending / blocked)
// ============================================================

function StatusMessage({
  text,
  email,
  onSignOut,
}: {
  text: string;
  email?: string;
  onSignOut: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        {email && <p className="text-sm text-gray-500 mb-1">{email}</p>}
        <p className="text-sm text-gray-700 leading-relaxed break-keep">{text}</p>
      </div>
      <Button variant="secondary" onClick={onSignOut} className="flex-shrink-0">
        로그아웃
      </Button>
    </div>
  );
}

// ============================================================
// 승인 완료 화면
// ============================================================

function ApprovedView({ email, onSignOut }: { email?: string; onSignOut: () => void }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <p className="text-sm text-gray-800 font-medium">{email}</p>
      <Button variant="secondary" onClick={onSignOut}>
        로그아웃
      </Button>
    </div>
  );
}
