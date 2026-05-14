import { supabase } from "./supabase";
import type {
  RegisterDeviceResult,
  VerifyAccessResult,
  VerifyReason,
} from "@/types";

const KEY_STORAGE = "licenseKey";
const DEVICE_ID_STORAGE = "deviceId";
const VERIFY_CACHE_STORAGE = "verifyCache";
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

interface VerifyCache {
  at: number;
  result: VerifyAccessResult;
  forKey: string;
  forDeviceId: string;
}

export async function getDeviceId(): Promise<string> {
  const r = await chrome.storage.local.get(DEVICE_ID_STORAGE);
  const existing = r[DEVICE_ID_STORAGE];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_STORAGE]: fresh });
  return fresh;
}

export async function loadKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(KEY_STORAGE);
  const k = r[KEY_STORAGE];
  return typeof k === "string" && k.length > 0 ? k : null;
}

export async function saveKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_STORAGE]: key });
  await clearVerifyCache();
}

export async function clearKey(): Promise<void> {
  await chrome.storage.local.remove(KEY_STORAGE);
  await clearVerifyCache();
}

async function clearVerifyCache(): Promise<void> {
  await chrome.storage.local.remove(VERIFY_CACHE_STORAGE);
}

async function readVerifyCache(): Promise<VerifyCache | null> {
  const r = await chrome.storage.local.get(VERIFY_CACHE_STORAGE);
  const c = r[VERIFY_CACHE_STORAGE] as VerifyCache | undefined;
  return c ?? null;
}

async function writeVerifyCache(cache: VerifyCache): Promise<void> {
  await chrome.storage.local.set({ [VERIFY_CACHE_STORAGE]: cache });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function registerDevice(key: string): Promise<RegisterDeviceResult> {
  const trimmed = key.trim();
  if (!isUuid(trimmed)) return { ok: false, reason: "invalid_key" };

  const deviceId = await getDeviceId();
  try {
    const { data, error } = await supabase.rpc("register_device", {
      p_key: trimmed,
      p_device_id: deviceId,
      p_user_agent: navigator.userAgent ?? null,
    });
    if (error) {
      console.warn("[license] register_device RPC error", error);
      return { ok: false, reason: "network_error" };
    }
    const reason = (data?.reason as VerifyReason) ?? "network_error";
    const ok = Boolean(data?.ok);
    if (ok) {
      await saveKey(trimmed);
    }
    return { ok, reason };
  } catch (e) {
    console.warn("[license] register_device threw", e);
    return { ok: false, reason: "network_error" };
  }
}

interface VerifyOptions {
  force?: boolean;
}

export async function verifyAccess(opts: VerifyOptions = {}): Promise<VerifyAccessResult> {
  const key = await loadKey();
  if (!key) return { allowed: false, reason: "no_key" };

  const deviceId = await getDeviceId();

  if (!opts.force) {
    const cached = await readVerifyCache();
    if (
      cached &&
      cached.forKey === key &&
      cached.forDeviceId === deviceId &&
      Date.now() - cached.at < VERIFY_CACHE_TTL_MS
    ) {
      return cached.result;
    }
  }

  try {
    const { data, error } = await supabase.rpc("verify_access", {
      p_key: key,
      p_device_id: deviceId,
    });
    if (error) {
      console.warn("[license] verify_access RPC error", error);
      // 네트워크 실패 시 마지막 캐시가 있으면 그라데이션. 없으면 network_error 반환.
      const cached = await readVerifyCache();
      if (cached && cached.forKey === key && cached.forDeviceId === deviceId) {
        return cached.result;
      }
      return { allowed: false, reason: "network_error" };
    }

    const reason = (data?.reason as VerifyReason) ?? "network_error";
    const tierRaw = data?.tier;
    const result: VerifyAccessResult = {
      allowed: Boolean(data?.allowed),
      reason,
      expires_at: (data?.expires_at as string | null | undefined) ?? null,
      max_devices:
        data?.max_devices === null
          ? null
          : typeof data?.max_devices === "number"
            ? data.max_devices
            : undefined,
      active_devices: typeof data?.active_devices === "number" ? data.active_devices : undefined,
      tier: tierRaw === "brand" ? "brand" : tierRaw === "basic" ? "basic" : undefined,
    };

    await writeVerifyCache({
      at: Date.now(),
      result,
      forKey: key,
      forDeviceId: deviceId,
    });

    return result;
  } catch (e) {
    console.warn("[license] verify_access threw", e);
    const cached = await readVerifyCache();
    if (cached && cached.forKey === key && cached.forDeviceId === deviceId) {
      return cached.result;
    }
    return { allowed: false, reason: "network_error" };
  }
}
