import { getSupabase } from "./supabase";

export type AuthState = "signedOut" | "pending" | "blocked" | "approved";

export interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  is_admin: boolean;
}

export function deriveAuthState(hasSession: boolean, status?: string): AuthState {
  if (!hasSession) return "signedOut";

  if (status === "approved") return "approved";
  if (status === "blocked") return "blocked";
  if (status === "pending") return "pending";

  // session은 있는데 status가 없거나 다른 값 → pending (lock-by-default)
  return "pending";
}

export async function fetchAuthContext(): Promise<{ state: AuthState; profile: ProfileRow | null }> {
  try {
    const supabase = getSupabase();
    const { data: session } = await supabase.auth.getSession();

    if (!session?.session) {
      return { state: "signedOut", profile: null };
    }

    const uid = session.session.user.id;

    // Try to fetch the user's profile
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", uid)
      .single();

    if (error || !profile) {
      // Treat as null on error
      return { state: deriveAuthState(true, undefined), profile: null };
    }

    const state = deriveAuthState(true, profile.status);
    return { state, profile: profile as ProfileRow };
  } catch {
    // 잠금이 안전 기본값 — 네트워크 실패가 승인으로 이어지면 안 됨
    return { state: "pending", profile: null };
  }
}
