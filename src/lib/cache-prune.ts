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
 *   - F-MultiAccount 스냅샷(`multi_account_snapshot:*`)은 별도 7일 TTL — 표시 TTL(1h)이
 *     지나도 stale-while-revalidate로 옛 숫자를 보여주는 용도가 있어 바로 지우면 안 되고,
 *     7일 넘게 안 갱신된 것(삭제한 계정·한 번 방문만 한 계정)만 정리한다.
 *   - 형식이 다른 엔트리(타임스탬프 필드가 없는 키)는 안전하게 보존
 */

const TTL_MS = 4 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_PREFIX = "multi_account_snapshot:";
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    let ttl: number;
    if (CACHE_PREFIXES.some((p) => key.startsWith(p))) {
      ttl = TTL_MS;
    } else if (key.startsWith(SNAPSHOT_PREFIX)) {
      ttl = SNAPSHOT_TTL_MS;
    } else {
      continue;
    }
    const ts = extractTimestamp(value);
    if (ts === null) continue; // 알 수 없는 형식 — 안전하게 보존
    if (now - ts >= ttl) {
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

/**
 * 모든 캐시 일괄 삭제 — 사용자 명시 액션(옵션 페이지의 "캐시 삭제" 버튼)에서 호출.
 *
 * 삭제 대상:
 *   - F001 캐시 4종: volume/performance/shopping/current_bid
 *   - F-MultiAccount 디렉터리 캐시(`multi_account_directory`)와 스냅샷(`multi_account_snapshot:*`)
 *
 * 보존 대상(사용자 데이터):
 *   - 검색광고 자격증명(`searchadCredentials`)
 *   - F-MultiAccount 추가 목록(`multi_account_added_list`)·별칭 메타(`multi_account_user_meta`)
 *
 * 캐시는 다음 사용 시 자동으로 재수집된다 — 영구 데이터 손실 없음.
 */
export async function clearAllCaches(): Promise<{ removed: number }> {
  const all = await chrome.storage.local.get(null);
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (CACHE_PREFIXES.some((p) => key.startsWith(p))) {
      toRemove.push(key);
      continue;
    }
    if (key === "multi_account_directory") {
      toRemove.push(key);
      continue;
    }
    if (key.startsWith("multi_account_snapshot:")) {
      toRemove.push(key);
      continue;
    }
  }
  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
  }
  return { removed: toRemove.length };
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
