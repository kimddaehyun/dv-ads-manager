import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eXZyam5jcHdtY3d5Y2VicmhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDk5MjMsImV4cCI6MjA5OTc4NTkyM30.PsuKHfWH9jWqczx3qrjbXJqVM-rSfwFzJEp26B5CRhk"; // anon 키는 공개용 — 확장에 넣어도 안전 (RLS가 방어)

export const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const o = await chrome.storage.local.get(key);
    return (o[key] as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
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
