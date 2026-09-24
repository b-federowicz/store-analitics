// src/app/api/import-orders-xlsx/route.ts
//
// TEMPORARY endpoint: bulk-import Amazon FBA orders from the "VAT
// Transactions Report" xlsx export, since these settle outside BaseLinker
// and never show up in the normal sync. Each row is one line item; rows
// sharing the same external id (COL G) are grouped into a single order.
//
// order_id / order_product_id are BaseLinker's own ids everywhere else in
// this schema (see db.sql), but this feed doesn't have any — so synthetic
// negative ids are derived deterministically from the external id (+ sku
// for lines):
//   - negative can never collide with a real (always-positive) BaseLinker id
//   - deterministic means re-importing the same file is a no-op (insert-only
//     pipeline below skips order_ids that already exist)
//
// Column layout (0-indexed; letters per the Amazon VAT Transactions report):
//   G  (6)  external id                        -> grouping key / external_order_id
//   J  (9)  date_conform                       -> order_date
//   M  (12) sku, trailing "-FBA" stripped      -> baselinker_sku
//   Q  (16) quantity                           -> order_products.quantity
//   AE (30) PRICE_OF_ITEMS_VAT_RATE_PERCENT    -> order_products.vat_rate
//   BA (52) revenue VAT included (line total)  -> order_products.price_brutto (/ quantity)
//   BB (53) currency                           -> orders.currency
//   BN (65) ARRIVAL_COUNTRY                    -> orders.delivery_country_code
//
// COL AD (revenue VAT excluded) isn't stored — order_products.price_netto is
// a generated column (price_brutto / (1 + vat_rate)), so it's derived rather
// than imported.
//
// transaction_type is hardcoded to "FBA"; order_source_id reuses 772
// (Amazon), the same id the BaseLinker sync uses for Amazon accounts.

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import { fetchSheetCostRows } from "@/lib/sheet-costs";
import { parseCsv, parseDashDateToIso, parseGermanDateToIso, parseIsoDateToIso, parseSlashDateToIso } from "@/lib/csv";
import {
  type BaselinkerOrder,
  type BaselinkerOrderRow,
  type BaselinkerLineRow,
  ORDER_LINK,
  cyrb53,
  filterExistingOrderIds,
  insertNewOrdersAndLines,
  resolveFxRates,
  resolveProductId,
  upsertNewProducts,
} from "@/lib/baselinker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AMAZON_SOURCE_ID = 772;

const COL = {
  externalId: 6, // G
  date: 9, // J
  sku: 12, // M
  quantity: 16, // Q
  vatRate: 30, // AE
  revenueGrossInclVat: 52, // BA
  currency: 53, // BB
  countryCode: 65, // BN
} as const;

// Only checked where the report's literal header text was confirmed with
// the user — catches the sheet layout shifting (Amazon adding/removing a
// column) as a clear error instead of silently importing garbage.
const EXPECTED_HEADER_MARKERS: Record<number, string> = {
  [COL.vatRate]: "PRICE_OF_ITEMS_VAT_RATE_PERCENT",
  [COL.countryCode]: "ARRIVAL_COUNTRY",
};

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function parseDateCell(raw: string): string | null {
  const s = raw.trim();
  return (
    parseIsoDateToIso(s) ?? parseGermanDateToIso(s) ?? parseSlashDateToIso(s) ?? parseDashDateToIso(s)
  );
}

// parseCurrencyAmount defaults invalid/empty input to 0 (fine for the
// original CSV importer, where 0 revenue is a sane baseline) — wrong here,
// since a blank or corrupted price/vat cell must be skipped rather than
// silently treated as 0. Returns NaN instead so callers can catch it.
function parseRequiredNumber(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return NaN;
  const cleaned = trimmed.replace(/[^\d,.-]/g, "").replace(",", ".");
  if (!/\d/.test(cleaned)) return NaN;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

// Handles both a plain fraction ("0.19") and a percentage-formatted cell
// ("19%" or "19,00%") — sheet_to_csv renders a cell using its Excel number
// format, so a percentage-styled VAT column comes through as the latter.
function parseVatRateCell(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const pct = parseRequiredNumber(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? pct / 100 : NaN;
  }
  return parseRequiredNumber(trimmed);
}

function rowIsBlank(cells: string[]): boolean {
  return cells.every((c) => !c || !c.trim());
}

interface GroupAccum {
  externalId: string;
  dateIso: string;
  currency: string;
  countryCode: string | null;
  grossTotal: number;
  lines: {
    orderProductId: number;
    sku: string;
    quantity: number;
    priceBrutto: number; // per unit
    vatRate: number;
  }[];
}

interface ParseResult {
  orders: BaselinkerOrder[];
  errors: string[];
  // Full accounting of every data row, so a raw-row count from the sheet can
  // always be reconciled against what actually got imported instead of
  // guessing where the gap went.
  rowCounts: {
    totalDataRows: number;
    blankRows: number;
    missingExternalId: number;
    validLines: number;
  };
}

// Converts the sheet to CSV with SheetJS's own writer (rendering each cell
// through its Excel number format, same as opening the file and hitting
// "Save as CSV") and re-parses it with the same delimiter-aware parser the
// hand-built CSV importer used — avoids relying on raw cell typing (Date
// objects, serial numbers, locale-specific formatting) since that's exactly
// where reading xlsx cells directly gets fragile.
function parseXlsxOrders(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const csvText = XLSX.utils.sheet_to_csv(sheet);
  const rows = parseCsv(csvText, ",");

  const errors: string[] = [];
  const rowCounts = { totalDataRows: 0, blankRows: 0, missingExternalId: 0, validLines: 0 };
  if (rows.length < 2) return { orders: [], errors: ["Sheet has no data rows."], rowCounts };

  const header = rows[0].map((h) => h?.trim().toUpperCase());
  for (const [idxStr, marker] of Object.entries(EXPECTED_HEADER_MARKERS)) {
    const idx = Number(idxStr);
    if (header[idx] !== marker) {
      errors.push(
        `Column ${columnLetter(idx)}: expected header "${marker}", found "${header[idx] ?? ""}". Sheet layout may have changed.`
      );
    }
  }
  if (errors.length > 0) return { orders: [], errors, rowCounts };

  const groups = new Map<string, GroupAccum>();

  rowCounts.totalDataRows = rows.length - 1;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (rowIsBlank(row)) {
      rowCounts.blankRows++;
      continue;
    }

    const externalId = (row[COL.externalId] ?? "").trim();
    if (!externalId) {
      rowCounts.missingExternalId++;
      continue;
    }

    const quantity = parseRequiredNumber(row[COL.quantity] ?? "");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Row ${i + 1}: invalid quantity, skipped.`);
      continue;
    }

    const skuRaw = (row[COL.sku] ?? "").trim();
    const sku = skuRaw.replace(/-FBA$/i, "");
    if (!sku) {
      errors.push(`Row ${i + 1}: missing sku, skipped.`);
      continue;
    }

    const grossTotal = parseRequiredNumber(row[COL.revenueGrossInclVat] ?? "");
    if (!Number.isFinite(grossTotal)) {
      errors.push(`Row ${i + 1}: invalid revenue amount, skipped.`);
      continue;
    }

    const currency = (row[COL.currency] ?? "").trim().toUpperCase();
    if (!currency) {
      errors.push(`Row ${i + 1}: missing currency, skipped.`);
      continue;
    }

    const dateIso = parseDateCell(row[COL.date] ?? "");
    if (!dateIso) {
      errors.push(`Row ${i + 1}: could not parse date, skipped.`);
      continue;
    }

    const vatRate = parseVatRateCell(row[COL.vatRate] ?? "");
    if (!Number.isFinite(vatRate)) {
      errors.push(`Row ${i + 1}: missing/invalid.`);
      continue;
    }
    const countryCode = (row[COL.countryCode] ?? "").trim().toUpperCase() || null;

    let group = groups.get(externalId);
    if (!group) {
      group = { externalId, dateIso, currency, countryCode, grossTotal: 0, lines: [] };
      groups.set(externalId, group);
    }

    const lineIndex = group.lines.length;
    group.lines.push({
      orderProductId: -(cyrb53(`xlsx-fba:${externalId}:${sku}:${lineIndex}`) + 1),
      sku,
      quantity,
      priceBrutto: grossTotal / quantity,
      vatRate,
    });
    group.grossTotal += grossTotal;
    rowCounts.validLines++;
  }

  const orders: BaselinkerOrder[] = Array.from(groups.values()).map((g) => {
    const ts = Math.floor(new Date(`${g.dateIso}T00:00:00Z`).getTime() / 1000);
    return {
      order_id: -(cyrb53(`xlsx-fba:${g.externalId}`) + 1),
      external_order_id: g.externalId,
      date_add: ts,
      date_confirmed: ts,
      order_status_id: 0,
      order_source: "amazon",
      order_source_id: AMAZON_SOURCE_ID,
      payment_done: g.grossTotal,
      delivery_price: 0,
      delivery_country_code: g.countryCode ?? undefined,
      currency: g.currency,
      products: g.lines.map((l) => ({
        product_id: "",
        order_product_id: String(l.orderProductId),
        sku: l.sku,
        quantity: l.quantity,
        price_brutto: l.priceBrutto,
        vat_rate: l.vatRate,
      })),
    };
  });

  return { orders, errors, rowCounts };
}

// Mirrors lib/baselinker.ts's buildOrderAndLineRows, but sources vat_rate
// from the line itself (set explicitly above from COL AE) instead of
// deriving it from delivery_country_code — this feed gives an accurate
// per-line rate directly.
function buildXlsxOrderAndLineRows(
  orders: BaselinkerOrder[],
  fxRateByOrderId: Map<number, number>
): { orderRows: BaselinkerOrderRow[]; lineRows: BaselinkerLineRow[]; skippedLineItems: { order_id: number; sku: string }[] } {
  const skippedLineItems: { order_id: number; sku: string }[] = [];
  const skippedOrderIds = new Set<number>();

  const lineRows: BaselinkerLineRow[] = orders.flatMap((order) => {
    const fxRate = fxRateByOrderId.get(order.order_id) ?? 1;

    return (order.products ?? [])
      .map((p) => {
        const productId = resolveProductId(p);
        return {
          order_product_id: Number(p.order_product_id),
          order_id: order.order_id,
          product_id: productId ?? NaN,
          baselinker_sku: p.sku || "unknown",
          quantity: p.quantity,
          vat_rate: p.vat_rate ?? NaN,
          price_brutto: p.price_brutto * fxRate,
        };
      })
      .filter((row) => {
        const valid =
          Number.isFinite(row.order_product_id) &&
          Number.isFinite(row.product_id) &&
          Number.isFinite(row.quantity) &&
          row.quantity > 0 &&
          Number.isFinite(row.vat_rate);
        if (!valid) {
          skippedLineItems.push({ order_id: row.order_id, sku: row.baselinker_sku });
          skippedOrderIds.add(row.order_id);
        }
        return valid;
      });
  });

  const orderRows: BaselinkerOrderRow[] = orders.map((o) => {
    const fxRate = fxRateByOrderId.get(o.order_id) ?? 1;
    return {
      order_id: o.order_id,
      external_order_id: o.external_order_id ?? null,
      order_source: o.order_source_id,
      transaction_type: "FBA",
      delivery_nr: null,
      delivery_country_code: o.delivery_country_code ?? null,
      currency: o.currency ?? "PLN",
      revenue_brutto: o.payment_done * fxRate,
      order_date: new Date(o.date_add * 1000).toISOString().slice(0, 10),
      more_info_link: `${ORDER_LINK}${o.order_id}`,
      has_skipped_lines: skippedOrderIds.has(o.order_id),
    };
  });

  return { orderRows, lineRows, skippedLineItems };
}

export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { orders: xlsxOrders, errors: parseErrors, rowCounts } = parseXlsxOrders(buffer);

  if (xlsxOrders.length === 0) {
    return NextResponse.json(
      { error: "No orders found in the xlsx.", details: parseErrors, rowCounts },
      { status: 400 }
    );
  }

  // Insert-only: drop any order_id that already exists so existing orders are
  // never touched (lines included). Since order_id is derived deterministically
  // from the external id, re-uploading the same file is naturally a no-op.
  const existingIds = await filterExistingOrderIds(xlsxOrders.map((o) => o.order_id));
  const newOrders = xlsxOrders.filter((o) => !existingIds.has(o.order_id));
  const skippedExisting = xlsxOrders
    .filter((o) => existingIds.has(o.order_id))
    .map((o) => o.external_order_id);

  if (newOrders.length === 0) {
    invalidateDashboardCache();
    return NextResponse.json({
      message: "Nothing to import — every order in the xlsx already exists.",
      ordersInserted: 0,
      lineItemsInserted: 0,
      newProductsCreated: 0,
      skippedExisting,
      parseErrors,
      rowCounts,
    });
  }

  const sheetRows = await fetchSheetCostRows();

  const { usableOrders, fxRateByOrderId, flaggedCurrencyOrders } = await resolveFxRates(newOrders);

  if (usableOrders.length === 0) {
    return NextResponse.json(
      {
        error: "No orders with a supported currency to import.",
        flaggedCurrencyOrders,
      },
      { status: 400 }
    );
  }

  const { created: newProductsCreated, skipped: skippedProducts } = await upsertNewProducts(
    usableOrders,
    sheetRows
  );

  const { orderRows, lineRows, skippedLineItems } = buildXlsxOrderAndLineRows(
    usableOrders,
    fxRateByOrderId
  );

  const { ordersInserted, lineItemsInserted } = await insertNewOrdersAndLines(orderRows, lineRows);

  invalidateDashboardCache();

  return NextResponse.json({
    message: "xlsx order import complete.",
    ordersInserted,
    lineItemsInserted,
    newProductsCreated,
    skippedExisting,
    flaggedCurrencyOrders,
    skippedProducts,
    skippedLineItems,
    parseErrors,
    rowCounts,
  });
}
