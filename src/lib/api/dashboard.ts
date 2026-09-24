import { DashboardResponse, Order, RecalcEvent, SourceGroup, StageDeliveryCostRow, VerificationReport } from "../types";
import { readNdjsonStream } from "../stream";

export async function fetchOrderSourceGroups(): Promise<SourceGroup[]> {
  const res = await fetch("/api/dashboard/sources");
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to load order sources");
  return json.groups ?? [];
}

export async function fetchDashboardData(params: {
  marketplace?: string;
  from?: string;
  to?: string;
  search?: string;
  transactionType?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: string;
  signal?: AbortSignal;
}): Promise<DashboardResponse> {
  const qs = new URLSearchParams();
  if (params.marketplace) qs.set("marketplace", params.marketplace);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.search) qs.set("search", params.search);
  if (params.transactionType) qs.set("transactionType", params.transactionType);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.sortOrder) qs.set("sortOrder", params.sortOrder);

  const res = await fetch(`/api/dashboard?${qs}`, { signal: params.signal });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to load dashboard data");
  return json;
}

export async function fetchUnmatchedOrders(params: {
  marketplace?: string;
  from?: string;
  to?: string;
  signal?: AbortSignal;
}): Promise<Order[]> {
  const qs = new URLSearchParams({ type: "orders" });
  if (params.marketplace) qs.set("marketplace", params.marketplace);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const res = await fetch(`/api/dashboard/unmatched?${qs}`, {
    signal: params.signal,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to load unmatched orders");
  return json.rows ?? [];
}

export async function fetchUnmatchedCsvRows(params: {
  marketplace?: string;
  from?: string;
  to?: string;
  signal?: AbortSignal;
}): Promise<StageDeliveryCostRow[]> {
  const qs = new URLSearchParams({ type: "csv" });
  if (params.marketplace) qs.set("marketplace", params.marketplace);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const res = await fetch(`/api/dashboard/unmatched?${qs}`, {
    signal: params.signal,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to load unmatched CSV rows");
  return json.rows ?? [];
}

export async function fetchDashboardExport(params: {
  marketplace?: string;
  from?: string;
  to?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
  signal?: AbortSignal;
}): Promise<Blob> {
  const qs = new URLSearchParams();
  if (params.marketplace) qs.set("marketplace", params.marketplace);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.search) qs.set("search", params.search);
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.sortOrder) qs.set("sortOrder", params.sortOrder);

  const res = await fetch(`/api/dashboard/export?${qs}`, {
    signal: params.signal,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error ?? "Failed to export dashboard data");
  }
  return res.blob();
}

export async function invalidateDashboardCache(): Promise<void> {
  const res = await fetch("/api/dashboard", { method: "POST" });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "Failed to refresh cache");
}

export async function deleteOrders(orderIds: number[]): Promise<void> {
  const res = await fetch("/api/dashboard", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderIds }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "Failed to delete orders");
}

export async function fetchVerificationReport(params?: {
  from?: string;
  to?: string;
  signal?: AbortSignal;
}): Promise<VerificationReport> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);

  const res = await fetch(`/api/dashboard/verify?${qs}`, {
    signal: params?.signal,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to run verification");
  return json;
}

export async function recalculateOrders(
  orderId?: number,
  fetchFromBaselinker: boolean = true,
  onProgress?: (event: RecalcEvent) => void
): Promise<RecalcEvent> {
  const res = await fetch("/api/dashboard/invoke-function", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(orderId !== undefined ? { orderId } : {}),
      fetchFromBaselinker,
    }),
  });

  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error ?? "Failed to recalculate");
  }

  const holder: { finalEvent: RecalcEvent | null } = { finalEvent: null };
  await readNdjsonStream<RecalcEvent>(res, (event) => {
    if (event.type === "progress") {
      onProgress?.(event);
    } else {
      holder.finalEvent = event;
    }
  });

  const result = holder.finalEvent;
  if (!result) {
    throw new Error("Recalculation ended unexpectedly.");
  }
  if (result.type === "error") {
    throw new Error(result.error);
  }

  return result;
}

export async function updateTransactionType(orderId: number, transactionType: string): Promise<void> {
  const res = await fetch("/api/dashboard/transaction-type", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, transactionType }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "Failed to update transaction type");
}