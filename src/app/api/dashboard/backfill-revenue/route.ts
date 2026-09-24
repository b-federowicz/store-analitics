// src/app/api/dashboard/backfill-revenue/route.ts
//
// One-off backfill: fills in revenue_brutto for orders that currently have
// it at 0, by pulling the real order value from BaseLinker's payments history
// (getOrderPaymentsHistory.total_price) and converting it to PLN.
//
// Only orders with revenue_brutto = 0 are touched — orders that already
// have a non-zero revenue were populated from payment_done and are unchanged
// by the "payment_done > 0 wins" rule, so there's nothing to fix there.
//
// The ONLY columns written are orders.revenue_brutto and, via an explicit
// recalc_order_profit_bulk call afterwards, the derived revenue_netto /
// products_cost / profit / margin. Nothing else (lines, products, delivery,
// fees, dates, sources) is read from BaseLinker or modified.
//
// One call walks EVERY zero-revenue order — no need to re-invoke. BaseLinker
// calls are paced to stay under the API's ~100 requests/minute limit, and each
// DB page is written + recalculated before moving on, so progress is durable
// even if the client disconnects mid-run. Just re-run to resume from wherever
// it stopped (already-updated rows drop out of the "= 0" filter).
//
//   ?dryRun=1    resolve values and report, write nothing
//   ?rpm=N       BaseLinker requests per minute (default 90, max 100)
//   ?maxOrders=N safety cap on how many orders one call will process

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import { withRetry, fetchOrderRevenue, NBP_CURRENCY_CODE } from "@/lib/baselinker";
import { createPlnRateCache } from "@/lib/nbp-fx";
import type { RecalcEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
// Long-running by design; the local dev server ignores this, and on Vercel it
// needs fluid compute. If the platform still caps the run, the per-page writes
// mean a re-run picks up cleanly where it left off.
export const maxDuration = 800;

const DB_PAGE_SIZE = 200;
const RECALC_CHUNK_SIZE = 500;
const DEFAULT_RPM = 90;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (err: unknown) => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("rate limit") || msg.includes("ratelimit") || msg.includes("429");
};

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }
  if (!process.env.BASELINKER_API_TOKEN) {
    return NextResponse.json({ error: "Missing BASELINKER_API_TOKEN." }, { status: 500 });
  }
  const admin = supabaseAdmin;

  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get("dryRun") === "1" || searchParams.get("dryRun") === "true";
  const rpm = Math.max(1, Math.min(100, Number(searchParams.get("rpm")) || DEFAULT_RPM));
  const maxOrders = Math.max(1, Number(searchParams.get("maxOrders")) || 100_000);
  const minIntervalMs = Math.ceil(60_000 / rpm);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: RecalcEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // client hung up — keep working, progress is persisted per page
          closed = true;
        }
      };

      // Spaces out BaseLinker calls to <= rpm/minute, retrying with backoff
      // when the API reports a rate-limit hit anyway.
      let lastCallAt = 0;
      const pacedRevenue = async (orderId: number): Promise<number | null> => {
        for (let attempt = 1; ; attempt++) {
          const wait = minIntervalMs - (Date.now() - lastCallAt);
          if (wait > 0) await sleep(wait);
          lastCallAt = Date.now();
          try {
            return await fetchOrderRevenue(orderId);
          } catch (err) {
            if (isRateLimit(err) && attempt <= 5) {
              await sleep(2000 * attempt);
              continue;
            }
            throw err;
          }
        }
      };

      try {
        const { count: totalZero } = await withRetry(() =>
          admin
            .from("orders")
            .select("order_id", { count: "exact", head: true })
            .eq("revenue_brutto", 0)
        );

        send({
          type: "progress",
          stage: "orders",
          message: `${totalZero ?? 0} order(s) with zero revenue. Pacing at ${rpm} req/min` +
            (dryRun ? " (dry run)." : "."),
          count: 0,
          total: totalZero ?? 0,
        });

        const getPlnRate = createPlnRateCache();
        let cursor = 0;
        let seen = 0;
        let written = 0;
        let recalculated = 0;
        const noHistory: number[] = [];
        const unsupportedCurrency: { order_id: number; currency: string }[] = [];

        for (;;) {
          const { data: rows, error: pageError } = await withRetry(() =>
            admin
              .from("orders")
              .select("order_id, currency, order_date")
              .eq("revenue_brutto", 0)
              .gt("order_id", cursor)
              .order("order_id", { ascending: true })
              .limit(DB_PAGE_SIZE)
          );
          if (pageError) throw pageError;

          const page = (rows ?? []) as {
            order_id: number;
            currency: string | null;
            order_date: string;
          }[];
          if (page.length === 0) break;
          cursor = page[page.length - 1].order_id;

          const updates: { order_id: number; revenue_brutto: number }[] = [];
          for (const o of page) {
            if (seen >= maxOrders) break;
            seen++;

            const totalPrice = await pacedRevenue(o.order_id);
            if (totalPrice === null) {
              noHistory.push(o.order_id);
              continue;
            }

            const currency = (o.currency ?? "PLN").toUpperCase();
            let plnValue: number;
            if (currency === "PLN") {
              plnValue = totalPrice;
            } else {
              const nbpCode = NBP_CURRENCY_CODE[currency];
              if (!nbpCode) {
                unsupportedCurrency.push({ order_id: o.order_id, currency });
                continue;
              }
              const rate = await getPlnRate(nbpCode, o.order_date.slice(0, 10));
              plnValue = totalPrice * rate;
            }

            updates.push({
              order_id: o.order_id,
              revenue_brutto: Math.round(plnValue * 100) / 100,
            });

            if (seen % 25 === 0) {
              send({
                type: "progress",
                stage: "orders",
                message: `Resolved ${seen}${totalZero ? ` / ${totalZero}` : ""} order(s)...`,
                count: seen,
                total: totalZero ?? 0,
              });
            }
          }

          if (!dryRun && updates.length > 0) {
            for (const u of updates) {
              const { error: updateError } = await withRetry(() =>
                admin
                  .from("orders")
                  .update({ revenue_brutto: u.revenue_brutto })
                  .eq("order_id", u.order_id)
              );
              if (updateError) throw updateError;
              written++;
            }

            const ids = updates.map((u) => u.order_id);
            for (let i = 0; i < ids.length; i += RECALC_CHUNK_SIZE) {
              const chunk = ids.slice(i, i + RECALC_CHUNK_SIZE);
              const { error: recalcError } = await withRetry(() =>
                admin.rpc("recalc_order_profit_bulk", { p_order_ids: chunk })
              );
              if (recalcError) throw recalcError;
              recalculated += chunk.length;
            }
            invalidateDashboardCache();

            send({
              type: "progress",
              stage: "recalc",
              message: `Written + recalculated ${written} order(s)...`,
              count: written,
              total: totalZero ?? 0,
            });
          }

          if (seen >= maxOrders) break;
        }

        const skipped = noHistory.length + unsupportedCurrency.length;
        if (skipped > 0) {
          send({
            type: "progress",
            stage: "orders",
            message:
              `Skipped ${skipped} order(s): ${noHistory.length} with no usable total_price in ` +
              `payments history, ${unsupportedCurrency.length} in an unsupported currency` +
              (unsupportedCurrency.length
                ? ` (${unsupportedCurrency.map((u) => `${u.order_id}:${u.currency}`).join(", ")})`
                : "") +
              ".",
          });
        }

        send({
          type: "done",
          message: dryRun
            ? `Dry run — would update ${seen - skipped} order(s), skip ${skipped}. Nothing written.`
            : `Backfill complete. Updated ${written} order(s), skipped ${skipped}.`,
          orderId: null,
          refetchedLines: null,
          skippedLineItems: skipped,
          productsChecked: 0,
          updatedProducts: 0,
          updatedDeliveryCosts: 0,
          recalculatedOrders: recalculated,
        });
      } catch (err) {
        console.error(err);
        send({
          type: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
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
