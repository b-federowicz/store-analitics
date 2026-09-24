import type { supabaseAdmin } from "@/lib/supabase-admin";
import { withRetry } from "@/lib/baselinker";

// Fetches every row for a set-returning RPC, batching past PostgREST's
// default page size. Deliberately avoids `count: "exact"` — Postgres has to
// materialize the whole (unfiltered) result set to compute it, which blows
// past the statement timeout on large/global scopes. Instead we page
// sequentially and stop once a page comes back short.
export async function fetchAllRpcRows<T>(
  admin: NonNullable<typeof supabaseAdmin>,
  rpcName: string,
  params: Record<string, unknown>
): Promise<T[]> {
  const batchSize = 1000;
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await withRetry(() =>
      admin.rpc(rpcName, params).range(offset, offset + batchSize - 1)
    );
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }
  return rows;
}
