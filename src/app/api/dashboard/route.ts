// src/app/api/dashboard/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type {
  DashboardResponse,
  Order,
  ProfitByDate,
  StageDeliveryCostRow,
} from "@/lib/types";
import { SORTABLE_ORDER_COLUMNS } from "@/constants";
import { buildSourceGroups, buildSourceLookup, fetchOrderSourceRows } from "@/lib/order-sources";
import { cachedDashboardQuery, invalidateDashboardCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

type RpcFilters = {
  p_from: string | null;
  p_to: string | null;
  p_source_ids: number[] | null;
  p_transaction_type: string | null;
};

const SORT_COLUMN_TO_DB_COLUMN: Record<string, string> = {
  order_date: "order_date",
  revenue_netto: "revenue_netto",
  products_cost: "products_cost",
  delivery_cost_netto: "delivery_cost_netto",
  fees_netto: "fees_netto",
  marketing_cost: "marketing_cost",
  profit: "profit",
  margin: "margin"
};

type OrderRow = {
  order_id: number;
  external_order_id: string | null;
  order_source: number | null;
  delivery_nr: string | null;
  transaction_type: string;
  delivery_country_code: string | null;
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

type DashboardSummaryRow = {
  total_orders: number | string;
  total_profit: number | string;
  total_revenue_netto: number | string;
  total_revenue_brutto: number | string;
  total_delivery_cost: number | string;
  total_commission: number | string;
  total_product_cost: number | string;
  total_marketing_cost: number | string;
  matched_delivery_count: number | string;
  unmatched_db_order_count: number | string;
  unmatched_csv_row_count: number | string;
};


const UNMATCHED_PREVIEW_LIMIT = 100;

const ORDER_COLUMNS =
  "order_id, external_order_id, order_source, delivery_nr, transaction_type, delivery_country_code, delivery_cost_netto, revenue_brutto, revenue_netto, fees_brutto, fees_netto, marketing_cost, profit, order_date, more_info_link, created_at, products_cost, margin";

const fetchSummaryCached = cachedDashboardQuery(
  ["dashboard-summary"],
  async (filters: RpcFilters): Promise<DashboardSummaryRow> => {
    const { data, error } = await supabaseAdmin!
      .rpc("dashboard_summary", filters)
      .single();
    if (error) throw error;
    return data as DashboardSummaryRow;
  }
);

const fetchProfitByDateCached = cachedDashboardQuery(
  ["dashboard-profit-by-date"],
  async (filters: RpcFilters): Promise<ProfitByDate[]> => {
    const { data, error } = await supabaseAdmin!.rpc(
      "dashboard_profit_by_date",
      filters
    );
    if (error) throw error;
    return (data ?? []).map((r: { date: string; profit: number; orders: number }) => ({
      date: r.date,
      profit: Number(r.profit),
      orders: Number(r.orders),
    }));
  }
);

const fetchUnmatchedOrdersCached = cachedDashboardQuery(
  ["dashboard-unmatched-orders"],
  async (filters: RpcFilters): Promise<OrderRow[]> => {
    const { data, error } = await supabaseAdmin!
      .rpc("dashboard_unmatched_orders", filters)
      .range(0, UNMATCHED_PREVIEW_LIMIT - 1);
    if (error) throw error;
    return data ?? [];
  }
);

const fetchUnmatchedCsvRowsCached = cachedDashboardQuery(
  ["dashboard-unmatched-csv-rows"],
  async (filters: RpcFilters): Promise<StageDeliveryCostRow[]> => {
    const { data, error } = await supabaseAdmin!
      .rpc("dashboard_unmatched_csv_rows", filters)
      .range(0, UNMATCHED_PREVIEW_LIMIT - 1);
    if (error) throw error;
    return data ?? [];
  }
);

// Search + pagination are pushed down to Postgres so the response for a
// given page only pulls the rows it actually needs.
const fetchPagedOrdersCached = cachedDashboardQuery(
  ["dashboard-paged-orders"],
  async (params: {
    from: string | null;
    to: string | null;
    sourceIds: number[] | null;
    transactionType: string | null;
    search: string;
    sortDbColumn: string;
    sortOrder: "asc" | "desc";
    page: number;
    pageSize: number;
  }): Promise<{ rows: OrderRow[]; total: number }> => {
    const { from, to, sourceIds, transactionType, search, sortDbColumn, sortOrder, page, pageSize } = params;

    let query = supabaseAdmin!.from("orders").select(ORDER_COLUMNS, { count: "exact" });
    if (from) query = query.gte("order_date", from);
    if (to) query = query.lte("order_date", to);
    if (sourceIds !== null) {
      query =
        sourceIds.length > 0
          ? query.in("order_source", sourceIds)
          : query.eq("order_source", -1);
    }
    if (transactionType) query = query.eq("transaction_type", transactionType);

    if (search) {
      // Accept a single term or many, separated by whitespace / commas / newlines.
      const tokens = search.split(/[\s,]+/).filter(Boolean);
      const numeric = tokens.filter((t) => /^\d+$/.test(t));
      const nonNumeric = tokens.filter((t) => !/^\d+$/.test(t));
      const orFilters: string[] = [];
      if (numeric.length > 0) {
        orFilters.push(`order_id.in.(${numeric.join(",")})`);
        orFilters.push(`external_order_id.in.(${numeric.join(",")})`);
        // A single numeric term may also be a (partial) delivery number.
        if (tokens.length === 1) {
          orFilters.push(`delivery_nr.ilike.%${numeric[0]}%`);
        }
      }
      for (const t of nonNumeric) {
        const like = `%${t}%`;
        orFilters.push(
          `external_order_id.ilike.${like}`,
          `delivery_nr.ilike.${like}`
        );
      }
      if (orFilters.length > 0) query = query.or(orFilters.join(","));
    }

    const pageStart = (page - 1) * pageSize;
    const { data, error, count } = await query
      .order(sortDbColumn, { ascending: sortOrder === "asc" })
      .order("order_id", { ascending: true })
      .range(pageStart, pageStart + pageSize - 1);

    if (error) throw error;
    return { rows: data ?? [], total: count ?? 0 };
  }
);

export async function GET(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const marketplace = searchParams.get("marketplace")?.trim() ?? "";
  const transactionType = searchParams.get("transactionType")?.trim() || null;
  const to = searchParams.get("to");
  const search = searchParams.get("search")?.trim() ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") ?? "25") || 25)
  );
  const sortByParam = searchParams.get("sortBy") ?? "order_date";
  const sortBy = (SORTABLE_ORDER_COLUMNS as readonly string[]).includes(
    sortByParam
  )
    ? sortByParam
    : "order_date";
  const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
  const sortDbColumn = SORT_COLUMN_TO_DB_COLUMN[sortBy];

  try {
    const admin = supabaseAdmin;

      const timed = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        console.log(`[dashboard] ${label} took ${Date.now() - start}ms`);
      }
    };

    // Small table (one row per BaseLinker account), refreshed once per order
    // sync — safe to pull in full on every request instead of joining.
    const sourceRows = await fetchOrderSourceRows();
    const sourceLookup = buildSourceLookup(sourceRows);
    const sourceGroups = buildSourceGroups(sourceRows);
    const sourceIds = marketplace
      ? sourceGroups.find((g) => g.key === marketplace)?.sourceIds ?? []
      : null;

    const rpcFilters: RpcFilters = {
      p_from: from,
      p_to: to,
      p_source_ids: sourceIds,
      p_transaction_type: transactionType,
    };

    const [
      summaryRow,
      profitByDate,
      unmatchedOrderRows,
      unmatchedCsvRows,
      pagedOrdersResult,
    ] = await Promise.all([
      timed("fetchSummary", () => fetchSummaryCached(rpcFilters)),
      timed("fetchProfitByDate", () => fetchProfitByDateCached(rpcFilters)),
      timed("fetchUnmatchedOrders", () => fetchUnmatchedOrdersCached(rpcFilters)),
      timed("fetchUnmatchedCsvRows", () => fetchUnmatchedCsvRowsCached(rpcFilters)),
      timed("fetchPagedOrders", () =>
        fetchPagedOrdersCached({
          from,
          to,
          sourceIds,
          transactionType,
          search,
          sortDbColumn,
          sortOrder,
          page,
          pageSize,
        })
      ),
    ]);

    
    const pagedDeliveryNrs = pagedOrdersResult.rows
      .map((o) => o.delivery_nr)
      .filter((nr): nr is string => !!nr);
    let pagedMatchedNrSet = new Set<string>();
    if (pagedDeliveryNrs.length > 0) {
      const { data: matchedRows, error: matchedError } = await admin
        .from("stage_delivery_cost")
        .select("nr")
        .in("nr", pagedDeliveryNrs);
      if (matchedError) throw matchedError;
      pagedMatchedNrSet = new Set((matchedRows ?? []).map((r) => r.nr));
    }

    const withMatchFlag = (o: OrderRow, matched: boolean): Order => ({
      order_id: o.order_id,
      external_order_id: o.external_order_id,
      order_source: o.order_source,
      order_source_label:
        (o.order_source !== null ? sourceLookup.get(o.order_source)?.label : undefined) ??
        "Unknown",
      delivery_nr: o.delivery_nr,
      transaction_type: o.transaction_type,
      delivery_country_code: o.delivery_country_code,
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
      delivery_matched: matched,
      products_cost: o.products_cost,
      margin: o.margin,
    });

    const unmatchedDbOrders = unmatchedOrderRows.map((o) =>
      withMatchFlag(o, false)
    );
    const pagedOrders = pagedOrdersResult.rows.map((o) =>
      withMatchFlag(o, !!o.delivery_nr && pagedMatchedNrSet.has(o.delivery_nr))
    );
    const filteredTotal = pagedOrdersResult.total;

    const totalOrders = Number(summaryRow.total_orders);
    const totalProfit = Number(summaryRow.total_profit);

    const response: DashboardResponse = {
      summary: {
        totalOrders,
        totalProfit,
        totalRevenueNetto: Number(summaryRow.total_revenue_netto),
        totalRevenueBrutto: Number(summaryRow.total_revenue_brutto),
        totalDeliveryCost: Number(summaryRow.total_delivery_cost),
        totalCommission: Number(summaryRow.total_commission),
        totalProductCost: Number(summaryRow.total_product_cost),
        totalMarketingCost: Number(summaryRow.total_marketing_cost),
        avgProfitPerOrder:
          totalOrders > 0 ? round2(totalProfit / totalOrders) : 0,
        matchedDeliveryCount: Number(summaryRow.matched_delivery_count),
        unmatchedDbOrderCount: Number(summaryRow.unmatched_db_order_count),
        unmatchedCsvRowCount: Number(summaryRow.unmatched_csv_row_count),
      },
      profitByDate,
      orders: {
        rows: pagedOrders,
        total: filteredTotal,
        page,
        pageSize,
      },
      unmatchedCsvRows: unmatchedCsvRows,
      unmatchedDbOrders: unmatchedDbOrders,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST() {
  invalidateDashboardCache();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  let orderIds: number[];
  try {
    const body = await request.json();
    orderIds = Array.isArray(body?.orderIds)
      ? body.orderIds.map((id: unknown) => Number(id))
      : [];
  } catch {
    orderIds = [];
  }

  if (orderIds.length === 0 || orderIds.some((id) => !Number.isFinite(id))) {
    return NextResponse.json(
      { error: "orderIds must be a non-empty array of numbers." },
      { status: 400 }
    );
  }

  try {
    const { error } = await supabaseAdmin
      .from("orders")
      .delete()
      .in("order_id", orderIds);

    if (error) throw error;

    invalidateDashboardCache();
    return NextResponse.json({ deleted: orderIds.length });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
