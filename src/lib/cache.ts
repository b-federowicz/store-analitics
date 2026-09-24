import { revalidateTag, unstable_cache } from "next/cache";

// Bump REVALIDATE_SECONDS if the dashboard feels too stale; invalidate
// immediately after any write via revalidateTag(DASHBOARD_CACHE_TAG) instead
// of shortening this further.
export const DASHBOARD_CACHE_TAG = "dashboard";
const REVALIDATE_SECONDS = 30;

// Wraps a query function with Next's data cache, tagged so writers can
// invalidate it with revalidateTag. Every value the query result depends on
// must be passed as an argument (not captured from closure) — unstable_cache
// keys on keyParts + serialized arguments, not on closure state.
export function cachedDashboardQuery<Args extends unknown[], T>(
  keyParts: string[],
  fn: (...args: Args) => Promise<T>
) {
  return unstable_cache(fn, keyParts, {
    tags: [DASHBOARD_CACHE_TAG],
    revalidate: REVALIDATE_SECONDS,
  });
}

// Call after any write (order sync, delivery-cost import, recalculation,
// order delete) so the next dashboard read is guaranteed fresh instead of
// waiting out REVALIDATE_SECONDS.
export function invalidateDashboardCache(): void {
  revalidateTag(DASHBOARD_CACHE_TAG, { expire: 0 });
}
