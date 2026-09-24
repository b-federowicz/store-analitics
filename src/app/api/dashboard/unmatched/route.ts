// src/app/api/dashboard/unmatched/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { Order, StageDeliveryCostRow } from "@/lib/types";
import { buildSourceGroups, buildSourceLookup, fetchOrderSourceRows } from "@/lib/order-sources";
import { fetchAllRpcRows } from "@/lib/rpc";
import { cachedDashboardQuery } from "@/lib/cache";

export const dynamic = "force-dynamic";

type RpcFilters = { p_from: string | null; p_to: string | null; p_source_ids: number[] | null };

type OrderRow = {
  order_id: number;
  external_order_id: string | null;
  order_source: number | null;
  delivery_nr: string | null;
  delivery_country_code: string | null;
  transaction_type: string;
  delivery_cost_netto: number | null;
  revenue_brutto: number | null;
  revenue_netto: number | null;
  fees_brutto: number | null;
  fees_netto: number | null;
  marketing_cost: number | null;
  profit: number | null;
  order_date: string;
  more_info_link: string | null;
  created_at: string;
  products_cost: number;
  margin: number;
};

const fetchUnmatchedCsvRowsCached = cachedDashboardQuery(
  ["unmatched-csv-rows"],
  async (filters: RpcFilters) =>
    fetchAllRpcRows<StageDeliveryCostRow>(supabaseAdmin!, "dashboard_unmatched_csv_rows", filters)
);

const fetchUnmatchedOrderRowsCached = cachedDashboardQuery(
  ["unmatched-order-rows"],
  async (filters: RpcFilters) =>
    fetchAllRpcRows<OrderRow>(supabaseAdmin!, "dashboard_unmatched_orders", filters)
);

export async function GET(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const marketplace = searchParams.get("marketplace")?.trim() ?? "";

  if (type !== "orders" && type !== "csv") {
    return NextResponse.json(
      { error: "type must be 'orders' or 'csv'." },
      { status: 400 }
    );
  }

  try {
    const sourceRows = await fetchOrderSourceRows();
    const sourceGroups = buildSourceGroups(sourceRows);
    const sourceIds = marketplace
      ? sourceGroups.find((g) => g.key === marketplace)?.sourceIds ?? []
      : null;

    const rpcFilters: RpcFilters = { p_from: from, p_to: to, p_source_ids: sourceIds };

    if (type === "csv") {
      const rows = await fetchUnmatchedCsvRowsCached(rpcFilters);
      return NextResponse.json({ rows });
    }

    const sourceLookup = buildSourceLookup(sourceRows);
    const orderRows = await fetchUnmatchedOrderRowsCached(rpcFilters);
    const rows: Order[] = orderRows.map((o) => ({
      order_id: o.order_id,
      external_order_id: o.external_order_id,
      order_source: o.order_source,
      order_source_label:
        (o.order_source !== null ? sourceLookup.get(o.order_source)?.label : undefined) ??
        "Unknown",
      delivery_nr: o.delivery_nr,
      delivery_country_code: o.delivery_country_code,
      transaction_type: o.transaction_type,
      delivery_cost_netto: o.delivery_cost_netto ?? 0,
      revenue_brutto: o.revenue_brutto ?? 0,
      revenue_netto: o.revenue_netto ?? 0,
      fees_brutto: o.fees_brutto ?? 0,
      fees_netto: o.fees_netto ?? 0,
      marketing_cost: o.marketing_cost ?? 0,
      profit: o.profit ?? 0,
      order_date: o.order_date,
      more_info_link: o.more_info_link,
      created_at: o.created_at,
      delivery_matched: false,
      products_cost: o.products_cost,
      margin: o.margin,
    }));
    return NextResponse.json({ rows });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
