import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "[supabase] VITE_SUPABASE_URL 또는 VITE_SUPABASE_ANON_KEY 가 빌드 시 주입되지 않았습니다.",
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
