import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { fetchAllRpcRows } from "@/lib/rpc";
import { withRetry, ORDER_LINK } from "@/lib/baselinker";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "warning" | "error";

type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  summary: string;
  details?: unknown[];
  detailsTruncated?: boolean;
};

const EPSILON = 0.01;
const MAX_DETAILS = 50;


function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < EPSILON + 1e-9;
}

function capDetails<T>(items: T[]): { details: T[]; truncated: boolean } {
  return {
    details: items.slice(0, MAX_DETAILS),
    truncated: items.length > MAX_DETAILS,
  };
}

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`[verify] start: ${step}`);
  try {
    const result = await fn();
    console.log(`[verify] done: ${step} (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.error(`[verify] FAILED: ${step} (${Date.now() - start}ms)`, err);
    throw err;
  }
}

export async function GET(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }
  const admin = supabaseAdmin;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const checks: Check[] = [];

  try {
    {
      const { error } = await timed("schema check", () =>
        withRetry(() =>
          admin
            .from("orders")
            .select("order_id, margin, products_cost, revenue_netto, profit, delivery_cost_netto, fees_netto, marketing_cost, has_skipped_lines")
            .limit(1)
        )
      );
      checks.push(
        error
          ? {
              id: "schema",
              label: "orders table has expected columns",
              status: "error",
              summary: error.message,
            }
          : {
              id: "schema",
              label: "orders table has expected columns",
              status: "ok",
              summary: "margin, products_cost, revenue_netto, profit, delivery_cost_netto, fees_netto, marketing_cost, has_skipped_lines all present.",
            }
      );
    }

    // --- Fetch orders in scope for the recalculation check ---
    type OrderRow = {
      order_id: number;
      revenue_brutto: number | null;
      revenue_netto: number | null;
      delivery_cost_netto: number | null;
      fees_netto: number | null;
      marketing_cost: number | null;
      products_cost: number | null;
      profit: number | null;
      margin: number | null;
      delivery_nr: string | null;
      transaction_type: string | null;
      has_skipped_lines: boolean | null;
    };

    const fetchAll = async <T>(
      build: (offset: number, limit: number) => PromiseLike<{ data: unknown; error: unknown }>
    ): Promise<T[]> => {
      const batchSize = 1000;
      const rows: T[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await withRetry(() => build(offset, batchSize));
        if (error) throw error;
        const batch = (data ?? []) as T[];
        rows.push(...batch);
        if (batch.length < batchSize) break;
        offset += batchSize;
      }
      return rows;
    };

    const orders = await timed("fetch orders", () =>
      fetchAll<OrderRow>((offset, limit) => {
        let q = admin
          .from("orders")
          .select(
            "order_id, revenue_brutto, revenue_netto, delivery_cost_netto, fees_netto, marketing_cost, products_cost, profit, margin, delivery_nr, transaction_type, has_skipped_lines"
          );
        if (from) q = q.gte("order_date", from);
        if (to) q = q.lte("order_date", to);
        return q.order("order_id", { ascending: true }).range(offset, offset + limit - 1);
      })
    );

    // --- 1. Recompute revenue_netto / products_cost / profit / margin ---
    type LineRow = {
      order_id: number;
      quantity: number;
      vat_rate: number;
      product_id: number;
      products: { product_cost_netto: number | null; sku: string | null; matched_sheet_sku: string | null } | null;
    };

    const lines = await timed("fetch order_products lines", () =>
      fetchAll<LineRow>((offset, limit) =>
        admin
          .from("order_products")
          .select("order_id, quantity, vat_rate, product_id, products(product_cost_netto, sku, matched_sheet_sku)")
          .order("order_product_id", { ascending: true })
          .range(offset, offset + limit - 1)
      )
    );

    const linesByOrder = new Map<number, LineRow[]>();
    for (const line of lines) {
      const arr = linesByOrder.get(line.order_id) ?? [];
      arr.push(line);
      linesByOrder.set(line.order_id, arr);
    }

    const mismatches: Array<{
      order_id: number;
      field: string;
      stored: number | null;
      recomputed: number | null;
      more_info_link: string;
    }> = [];

    await timed("recompute netto/products_cost/profit/margin", async () => {
    for (const o of orders) {
      const orderLines = linesByOrder.get(o.order_id) ?? [];
      const maxVat =
        orderLines.length > 0
          ? Math.max(...orderLines.map((l) => l.vat_rate))
          : 0.23;

      const expectedNetto = round2((o.revenue_brutto ?? 0) / (1 + maxVat));
      const expectedProductsCost = round2(
        orderLines.reduce(
          (acc, l) => acc + (l.products?.product_cost_netto ?? 0) * l.quantity,
          0
        )
      );
      const expectedProfit = round2(
        expectedNetto - expectedProductsCost - (o.delivery_cost_netto ?? 0) - (o.fees_netto ?? 0) - (o.marketing_cost ?? 0)
      );
      const expectedMargin =
        expectedNetto !== 0 ? round2((expectedProfit / expectedNetto) * 100) : null;

      if (!nearlyEqual(o.revenue_netto, expectedNetto)) {
        mismatches.push({ order_id: o.order_id, field: "revenue_netto", stored: o.revenue_netto, recomputed: expectedNetto, more_info_link: `${ORDER_LINK}${o.order_id}` });
      }
      if (!nearlyEqual(o.products_cost, expectedProductsCost)) {
        mismatches.push({ order_id: o.order_id, field: "products_cost", stored: o.products_cost, recomputed: expectedProductsCost, more_info_link: `${ORDER_LINK}${o.order_id}` });
      }
      if (!nearlyEqual(o.profit, expectedProfit)) {
        mismatches.push({ order_id: o.order_id, field: "profit", stored: o.profit, recomputed: expectedProfit, more_info_link: `${ORDER_LINK}${o.order_id}` });
      }
      if (!nearlyEqual(o.margin, expectedMargin)) {
        mismatches.push({ order_id: o.order_id, field: "margin", stored: o.margin, recomputed: expectedMargin, more_info_link: `${ORDER_LINK}${o.order_id}` });
      }
    }
    });

    {
      const { details, truncated } = capDetails(mismatches);
      checks.push({
        id: "recalculation",
        label: "profit/margin/products_cost match recomputed values",
        status: mismatches.length === 0 ? "ok" : "error",
        summary:
          mismatches.length === 0
            ? `All ${orders.length} orders in scope match their recomputed values.`
            : `${mismatches.length} field mismatch(es) across ${orders.length} orders in scope. Run recalculateOrders (POST /api/dashboard/invoke-function) for the affected order_ids, or investigate if it recurs.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- 2. Zero-cost products still referenced by order lines ---
    const zeroCostProducts = new Map<
      number,
      { product_id: number; sku: string | null; matched_sheet_sku: string | null; affected_orders: Set<number> }
    >();
    let zeroCostLineCount = 0;
    for (const l of lines) {
      if ((l.products?.product_cost_netto ?? 0) === 0) {
        const entry = zeroCostProducts.get(l.product_id) ?? {
          product_id: l.product_id,
          sku: l.products?.sku ?? null,
          matched_sheet_sku: l.products?.matched_sheet_sku ?? null,
          affected_orders: new Set<number>(),
        };
        entry.affected_orders.add(l.order_id);
        zeroCostProducts.set(l.product_id, entry);
        zeroCostLineCount += 1;
      }
    }
    const zeroCostProductDetails = Array.from(zeroCostProducts.values())
      .map((p) => ({
        product_id: p.product_id,
        sku: p.sku,
        matched_sheet_sku: p.matched_sheet_sku,
        affected_orders: p.affected_orders.size,
      }))
      .sort((a, b) => b.affected_orders - a.affected_orders);
    {
      const { details, truncated } = capDetails(zeroCostProductDetails);
      checks.push({
        id: "zero-cost-products",
        label: "products with a cost of 0 (unmatched to the cost sheet)",
        status: zeroCostProducts.size === 0 ? "ok" : "error",
        summary:
          zeroCostProducts.size === 0
            ? "No order lines reference a zero-cost product."
            : `${zeroCostProducts.size} distinct product(s), ${zeroCostLineCount} order line(s) are costed at 0 — products_cost/profit are understated for those orders until the product is matched to the cost sheet.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- 3. Orders with lines skipped during BaseLinker sync ---
    const skippedLineOrders = orders.filter((o) => o.has_skipped_lines);
    {
      const { details, truncated } = capDetails(
        skippedLineOrders.map((o) => ({ order_id: o.order_id, more_info_link: `${ORDER_LINK}${o.order_id}` }))
      );
      checks.push({
        id: "skipped-lines",
        label: "orders with lines skipped during BaseLinker sync",
        status: skippedLineOrders.length === 0 ? "ok" : "error",
        summary:
          skippedLineOrders.length === 0
            ? "No orders have skipped lines from the last sync."
            : `${skippedLineOrders.length} order(s) had one or more lines skipped during sync (bad id/quantity) — products_cost/profit are understated until resolved. Re-sync or investigate the affected orders.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- empty revenue_brutto (breaks netto/profit/margin recalculation) ---
    const emptyPriceBruttoOrders = orders.filter(
      (o) => o.revenue_brutto === null || o.revenue_brutto === 0
    );
    {
      const { details, truncated } = capDetails(
        emptyPriceBruttoOrders.map((o) => ({ order_id: o.order_id, more_info_link: `${ORDER_LINK}${o.order_id}` }))
      );
      checks.push({
        id: "empty-revenue-brutto",
        label: "orders with an empty revenue_brutto",
        status: emptyPriceBruttoOrders.length === 0 ? "ok" : "error",
        summary:
          emptyPriceBruttoOrders.length === 0
            ? "All orders in scope have a revenue_brutto."
            : `${emptyPriceBruttoOrders.length} order(s) in scope have no revenue_brutto — netto/profit/margin cannot be computed for them until it is set.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- 4b. Orders with an empty/missing delivery_nr ---
    const emptyDeliveryNrOrders = orders.filter(
      (o) => !o.delivery_nr || o.delivery_nr.trim() === ""
    );
    {
      const { details, truncated } = capDetails(
        emptyDeliveryNrOrders.map((o) => ({ order_id: o.order_id, more_info_link: `${ORDER_LINK}${o.order_id}` }))
      );
      checks.push({
        id: "empty-delivery-nr",
        label: "orders with an empty delivery_nr",
        status: emptyDeliveryNrOrders.length === 0 ? "ok" : "warning",
        summary:
          emptyDeliveryNrOrders.length === 0
            ? "All orders in scope have a delivery_nr."
            : `${emptyDeliveryNrOrders.length} order(s) in scope have no delivery_nr — delivery cost cannot be matched for them until one is set.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- 4. Duplicate delivery_nr across orders (trigger applies cost to *every* match) ---
    const ordersByDeliveryNr = new Map<string, number[]>();
    for (const o of orders) {
      if (!o.delivery_nr) continue;
      const arr = ordersByDeliveryNr.get(o.delivery_nr) ?? [];
      arr.push(o.order_id);
      ordersByDeliveryNr.set(o.delivery_nr, arr);
    }
    const duplicateDeliveryNrs = Array.from(ordersByDeliveryNr.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([delivery_nr, order_ids]) => ({
        delivery_nr,
        order_ids,
        more_info_links: order_ids.map((id) => `${ORDER_LINK}${id}`),
      }));
    {
      const { details, truncated } = capDetails(duplicateDeliveryNrs);
      checks.push({
        id: "duplicate-delivery-nr",
        label: "delivery_nr is unique across orders",
        status: duplicateDeliveryNrs.length === 0 ? "ok" : "error",
        summary:
          duplicateDeliveryNrs.length === 0
            ? "No two orders share the same delivery_nr."
            : `${duplicateDeliveryNrs.length} delivery_nr value(s) are shared by multiple orders — the same CSV cost row will be applied to all of them.`,
        details,
        detailsTruncated: truncated,
      });
    }

    // --- 5. Delivery-cost reconciliation (global, unfiltered) + near-match detection ---
   
    const GLOBAL_RPC_FILTERS = { p_from: null, p_to: null, p_source_ids: null };
    const [unmatchedOrderRows, unmatchedCsvRows] = await timed(
      "rpc: dashboard_unmatched_orders + dashboard_unmatched_csv_rows",
      () =>
        Promise.all([
          fetchAllRpcRows<{ order_id: number; delivery_nr: string | null }>(
            admin,
            "dashboard_unmatched_orders",
            GLOBAL_RPC_FILTERS
          ),
          fetchAllRpcRows<{ nr: string }>(
            admin,
            "dashboard_unmatched_csv_rows",
            GLOBAL_RPC_FILTERS
          ),
        ])
    );

    const unmatchedDbOrders = unmatchedOrderRows.filter(
      (o): o is { order_id: number; delivery_nr: string } => !!o.delivery_nr
    );

    // Near-match detection still needs every order's delivery_nr (matched
    // included), so pull just that column rather than full order rows.
    const allOrderNrRows = await timed("fetch all order delivery_nr", () =>
      fetchAll<{ delivery_nr: string }>((offset, limit) =>
        admin
          .from("orders")
          .select("delivery_nr")
          .not("delivery_nr", "is", null)
          .range(offset, offset + limit - 1)
      )
    );

    const orderNrSet = new Set(allOrderNrRows.map((o) => o.delivery_nr));

    const canon = (s: string) => s.trim().toLowerCase();
    const canonOrderMap = new Map<string, string[]>();
    for (const nr of orderNrSet) {
      const c = canon(nr);
      const arr = canonOrderMap.get(c) ?? [];
      arr.push(nr);
      canonOrderMap.set(c, arr);
    }

    const nearMatches: Array<{ order_delivery_nr: string; csv_nr: string }> = [];
    for (const r of unmatchedCsvRows) {
      const c = canon(r.nr);
      const candidates = canonOrderMap.get(c);
      if (candidates) {
        for (const orderNr of candidates) {
          nearMatches.push({ order_delivery_nr: orderNr, csv_nr: r.nr });
        }
      }
    }

    {
      const { details, truncated } = capDetails(
        unmatchedDbOrders.map((o) => ({
          order_id: o.order_id,
          delivery_nr: o.delivery_nr,
          more_info_link: `${ORDER_LINK}${o.order_id}`,
        }))
      );
      checks.push({
        id: "unmatched-orders",
        label: "orders with a delivery_nr but no matching CSV cost row",
        status: unmatchedDbOrders.length === 0 ? "ok" : "warning",
        summary:
          unmatchedDbOrders.length === 0
            ? "Every order's delivery_nr has a matching stage_delivery_cost row."
            : `${unmatchedDbOrders.length} order(s) have a delivery_nr with no imported cost yet.`,
        details,
        detailsTruncated: truncated,
      });
    }
    {
      const { details, truncated } = capDetails(unmatchedCsvRows.map((r) => r.nr));
      checks.push({
        id: "unmatched-csv-rows",
        label: "imported CSV cost rows with no matching order",
        status: unmatchedCsvRows.length === 0 ? "ok" : "warning",
        summary:
          unmatchedCsvRows.length === 0
            ? "Every stage_delivery_cost row matches an order."
            : `${unmatchedCsvRows.length} CSV row(s) don't match any order's delivery_nr (order not synced yet, or the number doesn't match exactly).`,
        details,
        detailsTruncated: truncated,
      });
    }
    {
      const { details, truncated } = capDetails(nearMatches);
      checks.push({
        id: "near-match-delivery-nr",
        label: "delivery_nr / CSV nr differing only by case or whitespace",
        status: nearMatches.length === 0 ? "ok" : "error",
        summary:
          nearMatches.length === 0
            ? "No case/whitespace-only mismatches found between orders.delivery_nr and stage_delivery_cost.nr."
            : `${nearMatches.length} pair(s) differ only by case/whitespace — these are silently reported as unmatched even though they're almost certainly the same shipment. Likely a trimming inconsistency between BaseLinker sync and CSV import.`,
        details,
        detailsTruncated: truncated,
      });
    }

    const overallStatus: CheckStatus = checks.some((c) => c.status === "error")
      ? "error"
      : checks.some((c) => c.status === "warning")
      ? "warning"
      : "ok";

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      scope: { from: from ?? null, to: to ?? null, ordersChecked: orders.length },
      status: overallStatus,
      checks,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
