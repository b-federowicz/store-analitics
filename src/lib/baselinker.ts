// src/lib/baselinker.ts
import { supabaseAdmin } from "@/lib/supabase-admin";
import { matchSheetSku, type SheetCostRow } from "@/lib/sheet-costs";
import { createPlnRateCache, NbpCurrencyCode } from "./nbp-fx";

// Orders older than this many days are treated as settled/final by the
// account-wide sync and full refresh — recent orders are still confirmed/
// amended in BaseLinker so re-pulling them too early would just churn.
export const MIN_DAYS_BEFORE_TODAY = 7;

export const BASELINKER_URL = "https://api.baselinker.com/connector.php";
export const ORDER_LINK = "https://panel-d.baselinker.com/orders.php#order:";


export interface BaselinkerProduct {
  product_id: string;
  order_product_id: string;
  sku?: string;
  ean?: string;
  name?: string;
  quantity: number;
  price_brutto: number;
  // Only set by feeds that carry an explicit per-line VAT rate (e.g. the
  // Amazon VAT Transactions xlsx import) instead of deriving it from the
  // order's delivery country.
  vat_rate?: number;
}

// Compact 53-bit string hash (cyrb53), safe to use as a JS number without
// precision loss. Only needs to be well-distributed, not cryptographic.
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Resolves the product_id to store for a line. BaseLinker's own product_id
// is used as-is when present and positive. When it's missing/empty (seen in
// practice on lines that don't correspond to a real catalog product) but a
// real sku is present, a synthetic negative id is derived deterministically
// from the sku so the line still gets a valid products row and can be
// cost-matched via matched_sheet_sku — negative so it can never collide with
// a real (always-positive) BaseLinker product_id, and stable so repeated
// syncs and every line sharing that sku resolve to the same product row.
// Returns null when there's neither a usable product_id nor a sku to fall
// back on (e.g. a gift-wrap/service line without a sku) — the caller skips
// those lines rather than storing them under a bogus id.
export function resolveProductId(p: BaselinkerProduct): number | null {
  const rawId = Number(p.product_id);
  if (Number.isFinite(rawId) && rawId > 0) return rawId;

  const sku = p.sku?.trim();
  if (sku) return -(cyrb53(sku) + 1);

  return null;
}

// Known BaseLinker product_ids whose sku BaseLinker sends inconsistently
// (e.g. this service line's real sku is "1", but older orders came through
// with an empty sku). Forcing the sku here keeps matchSheetSku working
// against the Google Sheet regardless of what a given order reports.
const SKU_OVERRIDES: Record<number, string> = {
  398487785: "1",
};

function resolveSku(productId: number, p: BaselinkerProduct): string {
  return SKU_OVERRIDES[productId] ?? (p.sku?.trim() || "unknown");
}

export interface BaselinkerOrder {
  order_id: number;
  external_order_id?: string;
  date_add: number;
  date_confirmed: number;
  order_status_id: number;
  order_source: string;
  order_source_id: number;
  payment_done: number;
  delivery_price: number;
  delivery_package_nr?: string;
  delivery_country_code?: string;
  currency?: string;
  order_page?: string;
  extra_field_2?: string;
  products: BaselinkerProduct[];
}

const VAT_RATE_BY_COUNTRY: Record<string, number> = {
  PL: 0.23,
  DE: 0.19,
  CZ: 0.21,
  HU: 0.27,
  SK: 0.23,
  AT: 0.20,
  FR: 0.20,
  LU: 0.17,
  NL: 0.21,
  UA: 0.0,
};
const DEFAULT_VAT_RATE = 0.23;

// BaseLinker order currencies we know how to convert to PLN via NBP.
export const NBP_CURRENCY_CODE: Record<string, NbpCurrencyCode> = {
  EUR: "eur",
  CZK: "czk",
  HUF: "huf",
};


const DELIVERY_NR_STATUS_LABELS: Record<number, string> = {
  355989: "FBA", // Zamówienia FBA
  31982: "Anulowane", // Anulowane i zwroty
  344598: "Zwrot", // Zwroty
};

export function vatRateForCountry(countryCode?: string): number {
  if (!countryCode) return DEFAULT_VAT_RATE;
  return VAT_RATE_BY_COUNTRY[countryCode.toUpperCase()] ?? DEFAULT_VAT_RATE;
}



// Sliding-window limiter: keep the timestamps of the last MAX_REQUESTS calls;
// before firing a new one, if the window is full, wait until the oldest call
// ages out. Conservative cap leaves headroom for clock skew and other tokens
// sharing the account. Module-scoped, so it bounds the whole server process.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const recentRequestTimes: number[] = [];
let rateLimitChain: Promise<void> = Promise.resolve();

export async function acquireRateLimitSlot(): Promise<void> {
  // Serialize slot acquisition so concurrent callers don't all read the same
  // window state and burst past the cap together.
  const wait = rateLimitChain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (recentRequestTimes.length > 0 && now - recentRequestTimes[0] >= RATE_LIMIT_WINDOW_MS) {
        recentRequestTimes.shift();
      }
      if (recentRequestTimes.length < RATE_LIMIT_MAX_REQUESTS) {
        recentRequestTimes.push(now);
        return;
      }
      const sleepMs = RATE_LIMIT_WINDOW_MS - (now - recentRequestTimes[0]) + 5;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  });
  rateLimitChain = wait.catch(() => {});
  return wait;
}

async function callBaselinker(method: string, parameters: Record<string, unknown> = {}) {
  const params = new URLSearchParams({
    method,
    parameters: JSON.stringify(parameters),
  });

  await acquireRateLimitSlot();

  const res = await fetch(BASELINKER_URL, {
    method: "POST",
    headers: {
      "X-BLToken": process.env.BASELINKER_API_TOKEN!,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`BaseLinker API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (data.status !== "SUCCESS") {
    throw new Error(`BaseLinker error: ${data.error_message ?? "unknown"}`);
  }

  return data;
}

export interface InventoryProduct {
  id: string;
  name: string;
  ean: string;
  sku: string;
  quantity: number;
  location: string;
  image: string;
}

// The inventory/warehouse to scan against can be pinned via env; otherwise
// the account's first inventory and its first warehouse are used, cached
// for the life of the server process since accounts rarely have more than
// one and it doesn't change at runtime.
let cachedInventoryTarget: { inventoryId: string; warehouseId: string } | null = null;

async function resolveInventoryTarget(): Promise<{ inventoryId: string; warehouseId: string }> {
  const envInventoryId = process.env.BASELINKER_INVENTORY_ID;
  const envWarehouseId = process.env.BASELINKER_WAREHOUSE_ID;
  if (envInventoryId && envWarehouseId) {
    return { inventoryId: envInventoryId, warehouseId: envWarehouseId };
  }

  if (cachedInventoryTarget) return cachedInventoryTarget;

  const data = await callBaselinker("getInventories");
  const inventories: Array<{
    inventory_id: number | string;
    is_default?: boolean;
    default_warehouse?: string;
    warehouses?: string[];
  }> = data.inventories ?? [];

  const inventory = inventories.find((inv) => inv.is_default) ?? inventories[0];
  if (!inventory) {
    throw new Error("No BaseLinker inventory is configured for this account.");
  }

  const warehouseId = inventory.default_warehouse ?? inventory.warehouses?.[0];
  if (!warehouseId) {
    throw new Error("The BaseLinker inventory has no warehouse configured.");
  }

  cachedInventoryTarget = {
    inventoryId: envInventoryId ?? String(inventory.inventory_id),
    warehouseId: envWarehouseId ?? warehouseId,
  };
  return cachedInventoryTarget;
}

// Resolves a scanned EAN or SKU to the full inventory record, mirroring
// what getInventoryProductsList + getInventoryProductsData return.
export async function lookupInventoryProduct(code: string): Promise<InventoryProduct | null> {
  const clean = code.trim();
  if (!clean) return null;

  const { inventoryId, warehouseId } = await resolveInventoryTarget();

  const toProduct = (
    id: string,
    record: {
      text_fields?: { name?: string };
      ean?: string;
      sku?: string;
      stock?: Record<string, number>;
      locations?: Record<string, string>;
      images?: Record<string, string>;
    }
  ): InventoryProduct => {
    const imageKeys = Object.keys(record.images ?? {}).sort((a, b) => Number(a) - Number(b));
    return {
      id,
      name: record.text_fields?.name ?? "",
      ean: record.ean ?? "",
      sku: record.sku ?? "",
      quantity: record.stock?.[warehouseId] ?? 0,
      location: record.locations?.[warehouseId] ?? "",
      image: imageKeys.length ? (record.images?.[imageKeys[0]] ?? "") : "",
    };
  };

  // A scanned code could be a BaseLinker product id, an EAN or a SKU. Product
  // ids aren't filterable via getInventoryProductsList, so try resolving it
  // as an id directly first and only fall back to an EAN/SKU filter search.
  if (/^\d+$/.test(clean)) {
    const byId = await callBaselinker("getInventoryProductsData", {
      inventory_id: inventoryId,
      products: [clean],
    });
    const record = byId.products?.[clean];
    if (record) return toProduct(clean, record);
  }

  const isEan = /^\d{8,14}$/.test(clean);
  const listData = await callBaselinker("getInventoryProductsList", {
    inventory_id: inventoryId,
    ...(isEan ? { filter_ean: clean } : { filter_sku: clean }),
  });

  const products: Record<string, { id: string }> = listData.products ?? {};
  const id = Object.keys(products)[0];
  if (!id) return null;

  const dataResult = await callBaselinker("getInventoryProductsData", {
    inventory_id: inventoryId,
    products: [id],
  });

  const record = dataResult.products?.[id];
  if (!record) return null;

  return toProduct(id, record);
}

export interface FetchOrdersProgress {
  page: number;
  ordersFetched: number;
  keepPaging: boolean;
}

export async function fetchOrders(
  dateFrom: number,
  dateTo?: number,
  onProgress?: (progress: FetchOrdersProgress) => void
) {
  const orders: BaselinkerOrder[] = [];
  let dateConfirmedFrom = dateFrom;
  let keepPaging = true;
  let page = 0;

  while (keepPaging) {
    const data = await callBaselinker("getOrders", {
      date_confirmed_from: dateConfirmedFrom,
      get_unconfirmed_orders: false,
    });

    const batch: BaselinkerOrder[] = data.orders ?? [];
    orders.push(...batch);
    page += 1;

    if (batch.length < 100) {
      keepPaging = false;
    } else {
      const lastDate = Math.max(...batch.map((o) => o.date_confirmed));
      if (dateTo !== undefined && lastDate > dateTo) {
        keepPaging = false;
      } else {
        dateConfirmedFrom = lastDate + 1;
      }
    }

    onProgress?.({ page, ordersFetched: orders.length, keepPaging });
  }

  return orders;
}

// Fetches a single order straight from BaseLinker by its own order_id,
// regardless of confirmation date — used to refresh one order's data
// (e.g. to restore order_products lines lost to earlier sync bugs) without
// re-pulling the whole account's order history.
export async function fetchOrderById(
  orderId: number
): Promise<BaselinkerOrder | null> {
  const data = await callBaselinker("getOrders", {
    order_id: orderId,
    get_unconfirmed_orders: true,
    include_commissions: true,
  });

  const orders: BaselinkerOrder[] = data.orders ?? [];
  return orders.find((o) => o.order_id === orderId) ?? orders[0] ?? null;
}

export interface OrderSourceInfo {
  source_id: number;
  source_type: string;
  name: string;
}


export async function fetchOrderSources(): Promise<OrderSourceInfo[]> {
  const data = await callBaselinker("getOrderSources");

  const sources: OrderSourceInfo[] = [];
  const byType: Record<string, Record<string, string>> = data.sources ?? {};
  for (const [sourceType, accounts] of Object.entries(byType)) {
    for (const [id, name] of Object.entries(accounts)) {
      sources.push({ source_id: Number(id), source_type: sourceType, name });
    }
  }
  return sources;
}

// Refreshes the order_sources table from BaseLinker — meant to run once per
// order sync
export async function syncOrderSources(): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;

  const sources = await fetchOrderSources();
  if (sources.length === 0) return 0;

  const uniqueSources = new Map<number, OrderSourceInfo>();
  for (const s of sources) {
    uniqueSources.set(s.source_id, s);
  }

  const rows = Array.from(uniqueSources.values()).map((s) => ({
    source_id: s.source_id,
    source_type: s.source_type,
    name: s.name,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await withRetry(() =>
    db
      .from("order_sources")
      .upsert(rows, { onConflict: "source_id" })
  );

  if (error) throw error;
  return rows.length;
}

export interface UpsertNewProductsResult {
  created: number;
  skipped: { order_id: number; sku: string }[];
}

export async function upsertNewProducts(
  orders: BaselinkerOrder[],
  sheetRows: SheetCostRow[]
): Promise<UpsertNewProductsResult> {
  if (!supabaseAdmin) return { created: 0, skipped: [] };
  const db = supabaseAdmin;

  const skipped: { order_id: number; sku: string }[] = [];
  const uniqueProducts = new Map<number, BaselinkerProduct>();
  for (const order of orders) {
    for (const p of order.products ?? []) {
      const productId = resolveProductId(p);
      if (productId === null) {
        skipped.push({ order_id: order.order_id, sku: p.sku || "unknown" });
        continue;
      }
      if (!uniqueProducts.has(productId)) {
        uniqueProducts.set(productId, p);
      }
    }
  }

  const productIds = Array.from(uniqueProducts.keys());
  if (productIds.length === 0) return { created: 0, skipped };

  const CHUNK_SIZE = 500;
  const existingIds = new Set<number>();
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    const { data: existing, error: existingError } = await withRetry(() =>
      db
        .from("products")
        .select("product_id")
        .in("product_id", chunk)
    );

    if (existingError) throw existingError;

    for (const row of existing ?? []) {
      existingIds.add(row.product_id);
    }
  }

  const missingIds = productIds.filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    const newRows = missingIds.map((id) => {
      const p = uniqueProducts.get(id)!;
      const sku = resolveSku(id, p);
      const match = matchSheetSku(sku, sheetRows);
      return {
        product_id: id,
        ean: p.ean || null,
        sku,
        matched_sheet_sku: match?.sku ?? null,
        product_cost_netto: match?.costNetto ?? 0,
        cost_updated_at: match ? new Date().toISOString() : null,
      };
    });

    const { error: insertError } = await withRetry(() =>
      db
        .from("products")
        .insert(newRows)
    );

    if (insertError) throw insertError;
  }

  return { created: missingIds.length, skipped };
}

export interface ResolveFxRatesResult {
  usableOrders: BaselinkerOrder[];
  fxRateByOrderId: Map<number, number>;
  flaggedCurrencyOrders: { order_id: number; currency: string }[];
}

// Resolves a PLN FX rate for every order (1 for PLN orders, looked up via
// NBP for known foreign currencies), dropping orders in unsupported
// currencies rather than guessing. Dedupes by order_id (BaseLinker's
// getOrders can return the same order across adjacent pages).
// Caps how many orders are resolved concurrently — resolveFxRates can be
// called with thousands of orders in bulk mode, and firing them all at
// once as a single Promise.all floods api.nbp.pl with concurrent
// connections (it starts resetting them under that load).
const FX_RESOLVE_CONCURRENCY = 10;

export async function resolveFxRates(
  orders: BaselinkerOrder[]
): Promise<ResolveFxRatesResult> {
  const getPlnRate = createPlnRateCache();
  const flaggedCurrencyOrders: { order_id: number; currency: string }[] = [];
  const fxRateByOrderId = new Map<number, number>();

  const resolveOne = async (o: BaselinkerOrder) => {
    const currency = (o.currency ?? "PLN").toUpperCase();
    if (currency === "PLN") {
      fxRateByOrderId.set(o.order_id, 1);
      return o;
    }

    const nbpCode = NBP_CURRENCY_CODE[currency];
    if (!nbpCode) {
      flaggedCurrencyOrders.push({ order_id: o.order_id, currency });
      return null;
    }

    // Falls back to today's rate internally if no rate is found near
    // the order's date. Uses date_confirmed (when the order was
    // settled/paid) rather than date_add (when it was created).
    const isoDate = new Date(o.date_confirmed * 1000).toISOString().slice(0, 10);
    const rate = await getPlnRate(nbpCode, isoDate);
    fxRateByOrderId.set(o.order_id, rate);
    return o;
  };

  const resolved: (BaselinkerOrder | null)[] = [];
  for (let i = 0; i < orders.length; i += FX_RESOLVE_CONCURRENCY) {
    const batch = orders.slice(i, i + FX_RESOLVE_CONCURRENCY);
    resolved.push(...(await Promise.all(batch.map(resolveOne))));
  }
  const filtered = resolved.filter((o): o is BaselinkerOrder => o !== null);

  const usableOrders = Array.from(
    new Map(filtered.map((o) => [o.order_id, o])).values()
  );

  return { usableOrders, fxRateByOrderId, flaggedCurrencyOrders };
}

export interface BaselinkerPayment {
  paid_before: number;
  paid_after: number;
  total_price: number;
  currency: string;
  external_payment_id: string;
  date: number;
  comment: string;
}

// Pulls an order's gross total from getOrderPaymentsHistory. getOrders'
// payment_done only reflects money actually received, so it's 0 for any
// order not yet settled (all COD orders, plus prepaid orders whose payment
// hasn't posted) — the payments history carries the real order value in
// every entry's total_price. Returns null when there's no usable entry so
// the caller can fall back to payment_done.
export async function fetchOrderRevenue(orderId: number): Promise<number | null> {
  const data = await callBaselinker("getOrderPaymentsHistory", {
    order_id: orderId,
    show_full_history: true,
  });

  const payments: BaselinkerPayment[] = data.payments ?? [];
  const totals = payments
    .map((p) => Number(p.total_price))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (totals.length === 0) return null;
  return Math.max(...totals);
}


const REVENUE_RESOLVE_CONCURRENCY = 10;

export interface ResolveOrderRevenueProgress {
  resolved: number;
  total: number;
}

// Builds order_id -> gross total (in the order's own currency, pre-FX).
// payment_done (money actually received) is the order's revenue whenever it's
// non-zero. Only when it's 0 — every COD order before the courier remits, plus
// any prepaid order whose payment hasn't posted — do we hit
// getOrderPaymentsHistory for the real order value (total_price). This keeps
// the call count to the handful of unpaid orders in a batch rather than one
// call per order, which would blow the route's time budget / BaseLinker's
// rate limit on a full sync. Falls back to payment_done (0) when the history
// has no usable total_price either.
export async function resolveOrderRevenue(
  orders: BaselinkerOrder[],
  onProgress?: (progress: ResolveOrderRevenueProgress) => void
): Promise<Map<number, number>> {
  const revenueByOrderId = new Map<number, number>();

  const needsHistory: BaselinkerOrder[] = [];
  for (const o of orders) {
    if (o.payment_done > 0) {
      revenueByOrderId.set(o.order_id, o.payment_done);
    } else {
      needsHistory.push(o);
    }
  }

  let resolved = 0;
  for (let i = 0; i < needsHistory.length; i += REVENUE_RESOLVE_CONCURRENCY) {
    const batch = needsHistory.slice(i, i + REVENUE_RESOLVE_CONCURRENCY);
    await Promise.all(
      batch.map(async (o) => {
        const fromHistory = await fetchOrderRevenue(o.order_id);
        revenueByOrderId.set(o.order_id, fromHistory ?? o.payment_done);
      })
    );
    resolved += batch.length;
    onProgress?.({ resolved, total: needsHistory.length });
  }

  return revenueByOrderId;
}

export interface BaselinkerOrderRow {
  order_id: number;
  external_order_id: string | null;
  order_source: number;
  transaction_type: string;
  delivery_nr: string | null;
  delivery_country_code: string | null;
  currency: string;
  revenue_brutto: number;
  order_date: string;
  more_info_link: string;
  has_skipped_lines: boolean;
}

export interface BaselinkerLineRow {
  order_product_id: number;
  order_id: number;
  product_id: number;
  baselinker_sku: string;
  quantity: number;
  vat_rate: number;
  price_brutto: number;
}

export interface BuildOrderAndLineRowsResult {
  orderRows: BaselinkerOrderRow[];
  lineRows: BaselinkerLineRow[];
  skippedLineItems: { order_id: number; sku: string }[];
}

// Builds the order + order_products rows ready to upsert. Line items with a
// non-finite order_product_id/product_id (BaseLinker omits order_product_id
// on some lines) or quantity <= 0 (e.g. a cancelled/replaced line BaseLinker
// still lists) can't be stored — order_products_quantity_check rejects
// quantity <= 0 — so they're filtered out and tracked rather than dropped
// silently, since a missing line under-counts products_cost/profit. Any order
// with at least one skipped line is flagged via has_skipped_lines so that
// under-costing is visible instead of silently inflating profit; a clean
// pass (no skips) clears the flag.
export function buildOrderAndLineRows(
  orders: BaselinkerOrder[],
  fxRateByOrderId: Map<number, number>,
  revenueByOrderId?: Map<number, number>
): BuildOrderAndLineRowsResult {
  const skippedLineItems: { order_id: number; sku: string }[] = [];
  const skippedOrderIds = new Set<number>();

  const lineRows: BaselinkerLineRow[] = orders.flatMap((order) => {
    const vatRate = vatRateForCountry(order.delivery_country_code);
    const fxRate = fxRateByOrderId.get(order.order_id) ?? 1;

    return (order.products ?? [])
      .map((p) => {
        const productId = resolveProductId(p);
        return {
          order_product_id: Number(p.order_product_id),
          order_id: order.order_id,
          product_id: productId ?? NaN,
          baselinker_sku: productId !== null ? resolveSku(productId, p) : p.sku || "unknown",
          quantity: p.quantity,
          vat_rate: vatRate,
          price_brutto: p.price_brutto * fxRate,
        };
      })
      .filter((row) => {
        const valid =
          Number.isFinite(row.order_product_id) &&
          Number.isFinite(row.product_id) &&
          Number.isFinite(row.quantity) &&
          row.quantity > 0;
        if (!valid) {
          skippedLineItems.push({ order_id: row.order_id, sku: row.baselinker_sku });
          skippedOrderIds.add(row.order_id);
        }
        return valid;
      });
  });

  const orderRows: BaselinkerOrderRow[] = orders.map((o) => {
    const fxRate = fxRateByOrderId.get(o.order_id) ?? 1;
    const revenueBrutto = revenueByOrderId?.get(o.order_id) ?? o.payment_done;
    return {
      order_id: o.order_id,
      external_order_id: o.external_order_id ?? null,
      order_source: o.order_source_id,
      transaction_type: o.extra_field_2 === "Fulfillment: AFN"
        ? "FBA"
        : DELIVERY_NR_STATUS_LABELS[o.order_status_id] ? DELIVERY_NR_STATUS_LABELS[o.order_status_id] : "Sprzedaż",
      delivery_nr: o.delivery_package_nr?.trim() || null,
      delivery_country_code: o.delivery_country_code ?? null,
      currency: o.currency ?? "PLN",
      revenue_brutto: revenueBrutto * fxRate,
      order_date: new Date(o.date_add * 1000).toISOString().slice(0, 10),
      more_info_link: `${ORDER_LINK}${o.order_id}`,
      has_skipped_lines: skippedOrderIds.has(o.order_id),
    };
  });

  return { orderRows, lineRows, skippedLineItems };
}

const UPSERT_CHUNK_SIZE = 500;

// Long syncs make hundreds of sequential Supabase requests over the same
// keep-alive pool; an idle socket getting reset by the server (ECONNRESET /
// "fetch failed") is a transient network blip, not a real failure, but it
// used to abort the whole multi-minute sync. Retry those specifically with
// backoff instead of every error, so a genuine PostgREST error still throws
// immediately.
export async function withRetry<T>(fn: () => PromiseLike<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
      const isTransient =
        cause?.code === "ECONNRESET" ||
        message.includes("ECONNRESET") ||
        message.includes("fetch failed");

      if (!isTransient || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

export interface UpsertOrdersAndLinesResult {
  ordersUpserted: number;
  lineItemsUpserted: number;
}

// Upserts orders, then reconciles order_products against the current line
// set: deletes any stored line that's fallen out of it (or stale rows keep
// contributing to revenue_netto forever), then upserts the current
// lines. Done as batched lookups/deletes/upserts (chunked) rather than
// per-order queries, since a multi-month sync means thousands of orders.
export async function upsertOrdersAndLines(
  orderRows: BaselinkerOrderRow[],
  lineRows: BaselinkerLineRow[]
): Promise<UpsertOrdersAndLinesResult> {
  if (!supabaseAdmin) return { ordersUpserted: 0, lineItemsUpserted: 0 };
  if (orderRows.length === 0) return { ordersUpserted: 0, lineItemsUpserted: 0 };
  const db = supabaseAdmin;

  // Chunked, not one statement: each upserted row fires the orders_after_update
  // row trigger (recalc_order_profit per order whose commission/delivery
  // changed), so a full backfill in a single statement runs thousands of
  // recalcs at once and hits statement_timeout.
  let ordersUpserted = 0;
  for (let i = 0; i < orderRows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = orderRows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { data: upsertedOrders, error: ordersError } = await withRetry(() =>
      db
        .from("orders")
        .upsert(chunk, { onConflict: "order_id" })
        .select("order_id")
    );

    if (ordersError) throw ordersError;
    ordersUpserted += upsertedOrders?.length ?? 0;
  }

  if (lineRows.length > 0) {
    const orderIds = Array.from(new Set(lineRows.map((r) => r.order_id)));
    const currentIds = new Set(lineRows.map((r) => r.order_product_id));

    const staleIds: number[] = [];
    for (let i = 0; i < orderIds.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = orderIds.slice(i, i + UPSERT_CHUNK_SIZE);
      const { data: existingLines, error: existingLinesError } = await withRetry(() =>
        db
          .from("order_products")
          .select("order_product_id")
          .in("order_id", chunk)
      );

      if (existingLinesError) throw existingLinesError;

      for (const row of existingLines ?? []) {
        if (!currentIds.has(row.order_product_id)) {
          staleIds.push(row.order_product_id);
        }
      }
    }

    for (let i = 0; i < staleIds.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = staleIds.slice(i, i + UPSERT_CHUNK_SIZE);
      const { error: deleteStaleError } = await withRetry(() =>
        db
          .from("order_products")
          .delete()
          .in("order_product_id", chunk)
      );

      if (deleteStaleError) throw deleteStaleError;
    }

    for (let i = 0; i < lineRows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = lineRows.slice(i, i + UPSERT_CHUNK_SIZE);
      const { error: upsertError } = await withRetry(() =>
        db
          .from("order_products")
          .upsert(chunk, { onConflict: "order_product_id" })
      );

      if (upsertError) throw upsertError;
    }
  }

  return {
    ordersUpserted,
    lineItemsUpserted: lineRows.length,
  };
}

export interface InsertNewOrdersAndLinesResult {
  ordersInserted: number;
  lineItemsInserted: number;
}

// Insert-only counterpart to upsertOrdersAndLines: used by the account-wide
// sync, which should only ever add orders that aren't in the DB yet, never
// silently overwrite fields on ones that are already there (that's
// invoke-function's job). ignoreDuplicates turns the upsert into ON CONFLICT
// DO NOTHING, so .select() returns only the rows actually inserted. No
// stale-line reconciliation here — a brand-new order can't have stale lines,
// and an order that already exists is left untouched entirely (lines
// included) rather than partially patched.
export async function insertNewOrdersAndLines(
  orderRows: BaselinkerOrderRow[],
  lineRows: BaselinkerLineRow[]
): Promise<InsertNewOrdersAndLinesResult> {
  if (!supabaseAdmin) return { ordersInserted: 0, lineItemsInserted: 0 };
  if (orderRows.length === 0) return { ordersInserted: 0, lineItemsInserted: 0 };
  const db = supabaseAdmin;

  const { data: insertedOrders, error: ordersError } = await withRetry(() =>
    db
      .from("orders")
      .upsert(orderRows, { onConflict: "order_id", ignoreDuplicates: true })
      .select("order_id")
  );

  if (ordersError) throw ordersError;

  let lineItemsInserted = 0;
  for (let i = 0; i < lineRows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = lineRows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { data: insertedLines, error: insertLinesError } = await withRetry(() =>
      db
        .from("order_products")
        .upsert(chunk, { onConflict: "order_product_id", ignoreDuplicates: true })
        .select("order_product_id")
    );

    if (insertLinesError) throw insertLinesError;
    lineItemsInserted += insertedLines?.length ?? 0;
  }

  return {
    ordersInserted: insertedOrders?.length ?? 0,
    lineItemsInserted,
  };
}

// Chunked lookup of which of the given order ids already exist in the
// orders table — lets invoke-function restrict its bulk refresh to orders
// that were already synced, rather than inserting new ones (sync's job).
export async function filterExistingOrderIds(
  orderIds: number[]
): Promise<Set<number>> {
  const existing = new Set<number>();
  if (!supabaseAdmin || orderIds.length === 0) return existing;
  const db = supabaseAdmin;

  for (let i = 0; i < orderIds.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = orderIds.slice(i, i + UPSERT_CHUNK_SIZE);
    const { data, error } = await withRetry(() =>
      db
        .from("orders")
        .select("order_id")
        .in("order_id", chunk)
    );

    if (error) throw error;
    for (const row of data ?? []) {
      existing.add(row.order_id);
    }
  }

  return existing;
}

export interface UpsertOrderWithLinesResult {
  lineItemsUpserted: number;
  skippedLineItems: { order_id: number; sku: string }[];
}

// Refreshes a single order straight from BaseLinker data — used to repair
// an order that lost its order_products lines to earlier sync bugs. Goes
// through the same FX/validity pipeline as the bulk sync so it can't throw
// on exactly the malformed lines it's meant to repair.
export async function upsertOrderWithLines(
  order: BaselinkerOrder
): Promise<UpsertOrderWithLinesResult> {
  if (!supabaseAdmin) return { lineItemsUpserted: 0, skippedLineItems: [] };

  const { usableOrders, fxRateByOrderId, flaggedCurrencyOrders } = await resolveFxRates([
    order,
  ]);

  if (usableOrders.length === 0) {
    if (flaggedCurrencyOrders.length > 0) {
      throw new Error(`Unsupported order currency: ${flaggedCurrencyOrders[0].currency}`);
    }
    return { lineItemsUpserted: 0, skippedLineItems: [] };
  }

  const revenueByOrderId = await resolveOrderRevenue(usableOrders);

  const { orderRows, lineRows, skippedLineItems } = buildOrderAndLineRows(
    usableOrders,
    fxRateByOrderId,
    revenueByOrderId
  );
  const { lineItemsUpserted } = await upsertOrdersAndLines(orderRows, lineRows);

  return { lineItemsUpserted, skippedLineItems };
}
