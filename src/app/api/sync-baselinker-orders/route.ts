// src/app/api/sync-baselinker-orders/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import { fetchSheetCostRows } from "@/lib/sheet-costs";
import type { SyncEvent } from "@/lib/types";
import {
  fetchOrders,
  syncOrderSources,
  upsertNewProducts,
  resolveFxRates,
  resolveOrderRevenue,
  buildOrderAndLineRows,
  insertNewOrdersAndLines,
  MIN_DAYS_BEFORE_TODAY,
} from "@/lib/baselinker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SyncEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        if (!supabaseAdmin) {
          throw new Error("Supabase is not configured on the server.");
        }

        if (!process.env.BASELINKER_API_TOKEN) {
          throw new Error("Missing BASELINKER_API_TOKEN.");
        }

        const { searchParams } = new URL(request.url);
        const fromParam = searchParams.get("from");
        const dateFrom = fromParam
          ? Math.floor(new Date(fromParam).getTime() / 1000)
          : Math.floor(new Date(2026, 4, 1).getTime() / 1000);

        if (Number.isNaN(dateFrom)) {
          throw new Error("Invalid 'from' date.");
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MIN_DAYS_BEFORE_TODAY);
        const dateTo = Math.floor(cutoff.getTime() / 1000);

        send({ type: "progress", stage: "sheet", message: "Fetching product cost sheet..." });

        const [fetchedOrders, sheetRows, syncedSourceCount] = await Promise.all([
          fetchOrders(dateFrom, dateTo, ({ page, ordersFetched, keepPaging }) => {
            send({
              type: "progress",
              stage: "paging",
              message: keepPaging
                ? `Fetching orders from BaseLinker (page ${page})...`
                : `Fetched ${ordersFetched} orders from BaseLinker.`,
              page,
              ordersFetched,
            });
          }),
          fetchSheetCostRows(),
          syncOrderSources(),
        ]);

        send({
          type: "progress",
          stage: "sources",
          message: `Refreshed ${syncedSourceCount} order source(s).`,
        });

        const dateFilteredOrders = fetchedOrders.filter((o) => o.date_confirmed <= dateTo);

        const { usableOrders, fxRateByOrderId, flaggedCurrencyOrders } = await resolveFxRates(
          dateFilteredOrders
        );

        if (flaggedCurrencyOrders.length > 0) {
          send({
            type: "progress",
            stage: "orders",
            message: `Skipped ${flaggedCurrencyOrders.length} order(s) with an unsupported currency: ${flaggedCurrencyOrders
              .map((o) => `${o.order_id} (${o.currency})`)
              .join(", ")}`,
          });
        }

        if (usableOrders.length === 0) {
          invalidateDashboardCache();
          send({
            type: "done",
            message: "No orders found.",
            ordersFetched: 0,
            ordersInserted: 0,
            lineItemsInserted: 0,
            newProductsCreated: 0,
            lineItemsSkipped: 0,
          });
          controller.close();
          return;
        }

        send({ type: "progress", stage: "products", message: "Upserting new products..." });
        const { created: newProductsCreated, skipped: skippedProducts } = await upsertNewProducts(
          usableOrders,
          sheetRows
        );

        if (skippedProducts.length > 0) {
          send({
            type: "progress",
            stage: "products",
            message: `Skipped ${skippedProducts.length} product(s) missing a valid product id: ${skippedProducts
              .map((s) => `order ${s.order_id} (${s.sku})`)
              .join(", ")}`,
          });
        }

        send({ type: "progress", stage: "orders", message: "Resolving order revenue from payments history..." });
        const revenueByOrderId = await resolveOrderRevenue(usableOrders, ({ resolved, total }) => {
          send({
            type: "progress",
            stage: "orders",
            message: `Resolved revenue for ${resolved} of ${total} order(s)...`,
          });
        });

        const { orderRows, lineRows, skippedLineItems } = buildOrderAndLineRows(
          usableOrders,
          fxRateByOrderId,
          revenueByOrderId
        );

        if (skippedLineItems.length > 0) {
          send({
            type: "progress",
            stage: "lines",
            message: `Skipped ${skippedLineItems.length} line item(s) missing a valid product/order_product id: ${skippedLineItems
              .map((s) => `order ${s.order_id} (${s.sku})`)
              .join(", ")}`,
          });
        }

        send({ type: "progress", stage: "orders", message: `Upserting ${orderRows.length} orders...` });
        if (lineRows.length > 0) {
          send({ type: "progress", stage: "lines", message: `Upserting ${lineRows.length} order line items...` });
        }

        const { ordersInserted, lineItemsInserted } = await insertNewOrdersAndLines(
          orderRows,
          lineRows
        );

        invalidateDashboardCache();
        send({
          type: "done",
          message: "Sync complete.",
          ordersFetched: usableOrders.length,
          ordersInserted,
          lineItemsInserted,
          newProductsCreated,
          lineItemsSkipped: skippedLineItems.length,
        });
      } catch (err) {
        console.error(err);
        const details =
          err && typeof err === "object" && "details" in err && err.details
            ? ` (${err.details})`
            : "";
        send({
          type: "error",
          error: (err instanceof Error ? err.message : "Unknown error") + details,
        });
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
