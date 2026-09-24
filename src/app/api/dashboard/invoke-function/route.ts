// src/app/api/dashboard/invoke-function/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSheetCostRows, matchSheetSku } from "@/lib/sheet-costs";
import type { RecalcEvent } from "@/lib/types";
import {
  fetchOrderById,
  fetchOrders,
  upsertNewProducts,
  upsertOrderWithLines,
  resolveFxRates,
  resolveOrderRevenue,
  buildOrderAndLineRows,
  upsertOrdersAndLines,
  filterExistingOrderIds,
  withRetry,
  MIN_DAYS_BEFORE_TODAY,
} from "@/lib/baselinker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Recalculates everything for either a single order (orderId provided) or
// every order (orderId omitted):
//   0. (optional, controlled by `fetchFromBaselinker`, default true)
//      re-fetches order(s) straight from BaseLinker and re-upserts their
//      order_products lines — this repairs orders that lost lines to
//      earlier sync bugs (or just gone stale), since products_cost/profit
//      depend on having every line, not just revenue_brutto, and
//      has_skipped_lines needs a fresh BaseLinker read to be accurate.
//      Single-order mode refetches just that order; bulk mode re-pulls
//      every order from the earliest stored order_date onward, batched the
//      same way sync-baselinker-orders does. Requires BASELINKER_API_TOKEN.
//      Set `fetchFromBaselinker: false` to skip this step and just
//      recalculate from what's already stored (sheet costs, delivery
//      costs, recalc_order_profit) — much faster when nothing on the
//      BaseLinker side has changed.
//   1. refreshes products.product_cost_netto from the Google Sheet
//   2. refreshes orders.delivery_cost_netto from stage_delivery_cost (CSV imports)
//   3. force-recalculates revenue_netto / products_cost / profit via
//      recalc_order_profit for every order in scope, regardless of whether
//      step 1 or 2 actually changed anything


const RECALC_CHUNK_SIZE = 500;
const PAGE_SIZE = 1000;


async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const results: T[] = [];
  let page = 0;
  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await withRetry(() => build(from, to));
    if (error) throw error;
    const rows = data ?? [];
    results.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    page++;
  }
  return results;
}

const IN_FILTER_CHUNK_SIZE = 200;

async function selectByIdsChunked<T, Id>(
  ids: Id[],
  build: (chunk: Id[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += IN_FILTER_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_FILTER_CHUNK_SIZE);
    results.push(
      ...(await selectAllPages<T>((from, to) => build(chunk, from, to)))
    );
  }
  return results;
}

async function recalcOrders(
  admin: SupabaseClient,
  orderIds: number[],
  onProgress?: (recalculated: number, total: number) => void
) {
  let recalculated = 0;
  for (let i = 0; i < orderIds.length; i += RECALC_CHUNK_SIZE) {
    const chunk = orderIds.slice(i, i + RECALC_CHUNK_SIZE);
    const { error } = await withRetry(() =>
      admin.rpc("recalc_order_profit_bulk", { p_order_ids: chunk })
    );
    if (error) throw error;
    recalculated += chunk.length;
    onProgress?.(recalculated, orderIds.length);
  }
  return recalculated;
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }
  const admin = supabaseAdmin;

  let orderId: number | undefined;
  let fetchFromBaselinker = true;
  try {
    const body = await req.json();
    if (body?.orderId !== undefined && body?.orderId !== null) {
      orderId = Number(body.orderId);
      if (!Number.isFinite(orderId)) {
        return NextResponse.json({ error: "Invalid orderId." }, { status: 400 });
      }
    }
    if (body?.fetchFromBaselinker !== undefined) {
      fetchFromBaselinker = Boolean(body.fetchFromBaselinker);
    }
  } catch {
  }

  if (fetchFromBaselinker && !process.env.BASELINKER_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing BASELINKER_API_TOKEN." },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RecalcEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        send({ type: "progress", stage: "sheet", message: "Fetching product cost sheet..." });
        const sheetRows = await fetchSheetCostRows();

        let refetchedLines: number | null = null;
        let skippedLineItems: { order_id: number; sku: string }[] = [];

        if (orderId !== undefined) {
          const { data: existingOrderRow, error: existingOrderError } = await withRetry(() =>
            admin
              .from("orders")
              .select("order_id")
              .eq("order_id", orderId as number)
              .maybeSingle()
          );

          if (existingOrderError) throw existingOrderError;

          if (!existingOrderRow) {
            send({
              type: "error",
              error: `Order ${orderId} not found. Run sync first to import it.`,
            });
            controller.close();
            return;
          }
        }

        if (!fetchFromBaselinker) {
        } else if (orderId !== undefined) {
          send({
            type: "progress",
            stage: "order",
            message: `Fetching order ${orderId} from BaseLinker...`,
          });
          const baselinkerOrder = await fetchOrderById(orderId);
          if (!baselinkerOrder) {
            send({
              type: "error",
              error: `Order ${orderId} not found or is too old to be stored in BaseLinker.`,
            });
            controller.close();
            return;
          }

          send({ type: "progress", stage: "products", message: "Upserting new products..." });
          await upsertNewProducts([baselinkerOrder], sheetRows);

          send({ type: "progress", stage: "lines", message: "Upserting order line items..." });
          const result = await upsertOrderWithLines(baselinkerOrder);
          refetchedLines = result.lineItemsUpserted;
          skippedLineItems = result.skippedLineItems;
        } else {
          // Bulk mode: re-pull every order from BaseLinker (from the earliest
          // stored order_date onward) before recalculating, so has_skipped_lines
          // and other order-level fields stay accurate for orders synced before
          // this flag existed — not just newly-synced ones. Batched the same way
          // sync-baselinker-orders does (BaseLinker paging + chunked DB writes).
          const { data: earliestOrderRow, error: earliestOrderError } = await withRetry(() =>
            admin
              .from("orders")
              .select("order_date")
              .order("order_date", { ascending: true })
              .limit(1)
              .maybeSingle()
          );

          if (earliestOrderError) throw earliestOrderError;

          if (earliestOrderRow?.order_date) {
            const dateFrom = Math.floor(new Date(earliestOrderRow.order_date).getTime() / 1000);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - MIN_DAYS_BEFORE_TODAY);
            const dateTo = Math.floor(cutoff.getTime() / 1000);

            const fetchedOrders = await fetchOrders(
              dateFrom,
              dateTo,
              ({ page, ordersFetched, keepPaging }) => {
                send({
                  type: "progress",
                  stage: "orders",
                  message: keepPaging
                    ? `Fetching orders from BaseLinker (page ${page})...`
                    : `Fetched ${ordersFetched} orders from BaseLinker.`,
                  page,
                  count: ordersFetched,
                });
              }
            );
            const dateFilteredOrders = fetchedOrders.filter((o) => o.date_confirmed <= dateTo);

            const { usableOrders: fetchedUsableOrders, fxRateByOrderId } = await resolveFxRates(
              dateFilteredOrders
            );

            const existingOrderIds = await filterExistingOrderIds(
              fetchedUsableOrders.map((o) => o.order_id)
            );
            const usableOrders = fetchedUsableOrders.filter((o) =>
              existingOrderIds.has(o.order_id)
            );

            if (usableOrders.length > 0) {
              send({
                type: "progress",
                stage: "products",
                message: `Upserting new products from ${usableOrders.length} orders...`,
              });
              await upsertNewProducts(usableOrders, sheetRows);

              send({
                type: "progress",
                stage: "orders",
                message: "Resolving order revenue from payments history...",
              });
              const revenueByOrderId = await resolveOrderRevenue(
                usableOrders,
                ({ resolved, total }) => {
                  send({
                    type: "progress",
                    stage: "orders",
                    message: `Resolved revenue for ${resolved} of ${total} order(s)...`,
                  });
                }
              );

              const built = buildOrderAndLineRows(
                usableOrders,
                fxRateByOrderId,
                revenueByOrderId
              );
              send({
                type: "progress",
                stage: "lines",
                message: `Upserting ${usableOrders.length} orders and ${built.lineRows.length} line items...`,
              });
              await upsertOrdersAndLines(built.orderRows, built.lineRows);
              skippedLineItems = built.skippedLineItems;
            }
          }
        }

        type OrderRow = {
          order_id: number;
          delivery_nr: string | null;
          delivery_cost_netto: number | null;
        };
        const orders =
          orderId !== undefined
            ? await selectAllPages<OrderRow>((from, to) =>
                admin
                  .from("orders")
                  .select("order_id, delivery_nr, delivery_cost_netto")
                  .eq("order_id", orderId as number)
                  .range(from, to)
              )
            : await selectAllPages<OrderRow>((from, to) =>
                admin
                  .from("orders")
                  .select("order_id, delivery_nr, delivery_cost_netto")
                  .range(from, to)
              );

        if (orderId !== undefined && orders.length === 0) {
          send({ type: "error", error: `Order ${orderId} not found.` });
          controller.close();
          return;
        }

        const orderIds = orders.map((o) => o.order_id);

        type LineRow = { order_id: number; product_id: number };
        const lines =
          orderId !== undefined
            ? await selectAllPages<LineRow>((from, to) =>
                admin
                  .from("order_products")
                  .select("order_id, product_id")
                  .eq("order_id", orderId as number)
                  .range(from, to)
              )
            : await selectAllPages<LineRow>((from, to) =>
                admin
                  .from("order_products")
                  .select("order_id, product_id")
                  .range(from, to)
              );

        const productIds = Array.from(new Set(lines.map((l) => l.product_id)));

        type ProductRow = { product_id: number; sku: string; product_cost_netto: number };
        let products: ProductRow[] = [];
        if (productIds.length > 0) {
          products = await selectByIdsChunked<ProductRow, number>(
            productIds,
            (chunk, from, to) =>
              admin
                .from("products")
                .select("product_id, sku, product_cost_netto")
                .in("product_id", chunk)
                .range(from, to)
          );
        } else if (orderId === undefined) {
          products = await selectAllPages<ProductRow>((from, to) =>
            admin
              .from("products")
              .select("product_id, sku, product_cost_netto")
              .range(from, to)
          );
        }

        send({
          type: "progress",
          stage: "product-costs",
          message: `Checking sheet costs for ${products.length} product(s)...`,
        });

        let updatedProducts = 0;
        for (const product of products) {
          const match = matchSheetSku(product.sku ?? "", sheetRows);
          if (!match) continue;
          if (match.costNetto === product.product_cost_netto) continue;

          const { error: updateError } = await withRetry(() =>
            admin
              .from("products")
              .update({
                product_cost_netto: match.costNetto,
                matched_sheet_sku: match.sku,
                cost_updated_at: new Date().toISOString(),
              })
              .eq("product_id", product.product_id)
          );

          if (updateError) throw updateError;
          updatedProducts++;
        }

        const deliveryNrs = orders
          .map((o) => o.delivery_nr)
          .filter((nr): nr is string => !!nr);

        let updatedDeliveryCosts = 0;
        if (deliveryNrs.length > 0) {
          send({
            type: "progress",
            stage: "delivery",
            message: `Refreshing delivery costs for ${deliveryNrs.length} order(s)...`,
          });

          let stageRows: { nr: string; netto: number }[] = [];
          let stageError: unknown = null;
          try {
            stageRows = await selectByIdsChunked<{ nr: string; netto: number }, string>(
              Array.from(new Set(deliveryNrs)),
              (chunk, from, to) =>
                admin
                  .from("stage_delivery_cost")
                  .select("nr, netto")
                  .in("nr", chunk)
                  .range(from, to)
            );
          } catch (e) {
            stageError = e;
          }

          if (stageError) {
            console.warn(
              "stage_delivery_cost lookup failed:",
              stageError instanceof Error ? stageError.message : stageError
            );
          } else {
            const stageByNr = new Map(
              (stageRows ?? []).map((r) => [r.nr as string, r.netto as number])
            );

            for (const order of orders) {
              if (!order.delivery_nr) continue;
              const stageNetto = stageByNr.get(order.delivery_nr);
              if (stageNetto === undefined) continue;
              if (stageNetto === order.delivery_cost_netto) continue;

              const { error: updateError } = await withRetry(() =>
                admin
                  .from("orders")
                  .update({ delivery_cost_netto: stageNetto })
                  .eq("order_id", order.order_id)
              );

              if (updateError) throw updateError;
              updatedDeliveryCosts++;
            }
          }
        }

        send({
          type: "progress",
          stage: "recalc",
          message: `Recalculating profit for ${orderIds.length} order(s)...`,
          count: 0,
          total: orderIds.length,
        });
        const recalculatedOrders = await recalcOrders(admin, orderIds, (recalculated, total) => {
          send({
            type: "progress",
            stage: "recalc",
            message: `Recalculated ${recalculated} of ${total} order(s)...`,
            count: recalculated,
            total,
          });
        });

        invalidateDashboardCache();
        send({
          type: "done",
          message: "Recalculation complete.",
          orderId: orderId ?? null,
          refetchedLines,
          skippedLineItems: skippedLineItems.length,
          productsChecked: products.length,
          updatedProducts,
          updatedDeliveryCosts,
          recalculatedOrders,
        });
      } catch (err) {
        console.error(err);
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null
              ? JSON.stringify(err)
              : "Unknown error";
        send({ type: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
