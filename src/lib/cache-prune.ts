/**
 * 캐시 prune — chrome.storage.local quota(5MB) 보호.
 *
 * 본 확장은 키워드 단위로 캐시 키를 발급한다(`volume_cache:<keyword>`,
 * `performance_cache:<keyword>:<bid>` 등). 사용자가 광고관리자에서 많은 키워드를
 * 다루다 보면 storage가 무한히 쌓이는데, 4시간 TTL을 넘은 엔트리는 어차피
 * `getCachedBids`/`getCachedPerformance`에서 cache miss로 처리되어 쓸모가 없다.
 * 본 모듈은 expired 엔트리를 storage에서 적극 삭제해 quota 헤드룸을 확보한다.
 *
 * 호출:
 *   - `pruneExpiredCache()` — 즉시 전체 스캔·삭제 (보통은 onInstalled에서 1회)
 *   - `maybePrune()` — 마지막 prune 후 1h 지났을 때만 실행 (hot path에서 호출 가능)
 *
 * 정책:
 *   - TTL 4h는 volume-cache·performance-cache와 동일하게 통일
 *   - 4개 prefix(volume/performance/shopping/current_bid) 모두 동일 정책으로 처리
 *   - 형식이 다른 엔트리(타임스탬프 필드가 없는 키)는 안전하게 보존
 */

const TTL_MS = 4 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// 메타 키는 `__` prefix로 캐시 prefix와 분리 — prune 스캔 대상에서도 제외된다.
const LAST_PRUNE_KEY = "__last_prune_at";

const CACHE_PREFIXES = [
  "volume_cache:",
  "performance_cache:",
  "shopping_cache:",
  "current_bid:",
];

export interface PruneResult {
  removed: number;
  kept: number;
}

export async function pruneExpiredCache(): Promise<PruneResult> {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const toRemove: string[] = [];
  let kept = 0;

  for (const [key, value] of Object.entries(all)) {
    if (!CACHE_PREFIXES.some((p) => key.startsWith(p))) continue;
    const ts = extractTimestamp(value);
    if (ts === null) continue; // 알 수 없는 형식 — 안전하게 보존
    if (now - ts >= TTL_MS) {
      toRemove.push(key);
    } else {
      kept += 1;
    }
  }

  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({ [LAST_PRUNE_KEY]: now });

  return { removed: toRemove.length, kept };
}

export async function maybePrune(): Promise<void> {
  let last: number | undefined;
  try {
    const stored = await chrome.storage.local.get(LAST_PRUNE_KEY);
    last = stored[LAST_PRUNE_KEY] as number | undefined;
  } catch {
    // storage 접근 실패 시 prune skip — hot path 차단 X
    return;
  }
  if (last && Date.now() - last < PRUNE_INTERVAL_MS) return;
  try {
    const result = await pruneExpiredCache();
    if (result.removed > 0) {
      console.log(
        `[dv-ads] cache prune: removed ${result.removed}, kept ${result.kept}`,
      );
    }
  } catch (e) {
    console.warn("[dv-ads] cache prune failed", e);
  }
}

function extractTimestamp(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // KeywordVolumeCache/KeywordPerformanceCache/ShoppingRankCache: fetched_at
  // CurrentBidSnapshot: read_at
  const raw = (v.fetched_at ?? v.read_at) as unknown;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
