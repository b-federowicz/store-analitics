import { supabaseAdmin } from "@/lib/supabase-admin";
import { cachedDashboardQuery } from "@/lib/cache";

const PER_ACCOUNT_SOURCE_TYPES = new Set(["allegro"]);

const MARKETPLACE_LABELS: Record<string, string> = {
  tergpl: "Mediaexpert",
};

function marketplaceLabel(sourceType: string): string {
  return (
    MARKETPLACE_LABELS[sourceType] ??
    sourceType.charAt(0).toUpperCase() + sourceType.slice(1)
  );
}

// "Marketplace: acc_name" is the fixed syntax for any source shown per-account
export function sourceDisplayLabel(sourceType: string, accountName: string): string {
  const label = marketplaceLabel(sourceType);
  return PER_ACCOUNT_SOURCE_TYPES.has(sourceType) ? `${label}: ${accountName}` : label;
}

export type OrderSourceRow = { source_id: number; source_type: string; name: string };

export type SourceGroup = { key: string; label: string; sourceIds: number[] };

export function buildSourceGroups(rows: OrderSourceRow[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const r of rows) {
    const key = PER_ACCOUNT_SOURCE_TYPES.has(r.source_type)
      ? `${r.source_type}:${r.source_id}`
      : r.source_type;
    const existing = groups.get(key);
    if (existing) {
      existing.sourceIds.push(r.source_id);
    } else {
      groups.set(key, {
        key,
        label: sourceDisplayLabel(r.source_type, r.name),
        sourceIds: [r.source_id],
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export type SourceLookupEntry = { source_type: string; name: string; label: string };

export function buildSourceLookup(
  rows: OrderSourceRow[]
): Map<number, SourceLookupEntry> {
  const map = new Map<number, SourceLookupEntry>();
  for (const r of rows) {
    map.set(r.source_id, {
      source_type: r.source_type,
      name: r.name,
      label: sourceDisplayLabel(r.source_type, r.name),
    });
  }
  return map;
}

const fetchOrderSourceRowsCached = cachedDashboardQuery(
  ["order-sources"],
  async (): Promise<OrderSourceRow[]> => {
    const { data, error } = await supabaseAdmin!
      .from("order_sources")
      .select("source_id, source_type, name");

    if (error) throw error;
    return data ?? [];
  }
);

export async function fetchOrderSourceRows(): Promise<OrderSourceRow[]> {
  if (!supabaseAdmin) return [];
  return fetchOrderSourceRowsCached();
}
