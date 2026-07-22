import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eXZyam5jcHdtY3d5Y2VicmhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDk5MjMsImV4cCI6MjA5OTc4NTkyM30.PsuKHfWH9jWqczx3qrjbXJqVM-rSfwFzJEp26B5CRhk"; // anon 키는 공개용 — 확장에 넣어도 안전 (RLS가 방어)

// 확장 reload 후 남은 고아 컨텍스트는 chrome.* 접근이 "Extension context invalidated"로
// 터진다 — supabase 자동 갱신 타이머·visibility 콜백이 이 예외를 계속 콘솔에 찍으므로,
// 끊긴 걸 감지하면 타이머를 멈추고 저장소 접근은 조용히 no-op 처리한다.
function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

let retired = false;
function retireIfOrphaned(): boolean {
  if (contextAlive()) return false;
  if (!retired) {
    retired = true;
    void client?.auth.stopAutoRefresh();
  }
  return true;
}

export const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    if (retireIfOrphaned()) return null;
    try {
      const o = await chrome.storage.local.get(key);
      return (o[key] as string | undefined) ?? null;
    } catch (e) {
      if (retireIfOrphaned()) return null; // 확인 직후 끊긴 경합 케이스
      throw e;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    if (retireIfOrphaned()) return;
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      if (retireIfOrphaned()) return;
      throw e;
    }
  },
  async removeItem(key: string): Promise<void> {
    if (retireIfOrphaned()) return;
    try {
      await chrome.storage.local.remove(key);
    } catch (e) {
      if (retireIfOrphaned()) return;
      throw e;
    }
  },
};

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: chromeStorageAdapter, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    });
  }
  return client;
}
