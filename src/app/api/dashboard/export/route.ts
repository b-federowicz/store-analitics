// src/app/api/dashboard/export/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SORTABLE_ORDER_COLUMNS } from "@/constants";
import { buildSourceGroups, buildSourceLookup, fetchOrderSourceRows } from "@/lib/order-sources";

export const dynamic = "force-dynamic";

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

const ORDER_COLUMNS =
  "order_id, external_order_id, order_source, delivery_nr, delivery_country_code, delivery_cost_netto, revenue_netto, fees_netto, marketing_cost, profit, order_date, more_info_link, created_at, products_cost, margin, transaction_type";

const CSV_HEADERS = [
  "order_id",
  "external_order_id",
  "order_source",
  "transaction_type",
  "delivery_nr",
  "delivery_country_code",
  "delivery_cost_netto",
  "revenue_netto",
  "fees_netto",
  "marketing_cost",
  "profit",
  "products_cost",
  "margin",
  "order_date",
  "more_info_link",
  "created_at",
];

type OrderRow = {
  order_id: number;
  external_order_id: string | null;
  order_source: number | null;
  delivery_nr: string | null;
  delivery_country_code: string | null;
  delivery_cost_netto: number | null;
  revenue_netto: number | null;
  fees_netto: number | null;
  marketing_cost: number | null;
  profit: number | null;
  order_date: string;
  margin: number;
  more_info_link: string | null;
  created_at: string;
  products_cost: number;
  transaction_type: string;
};

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
  const to = searchParams.get("to");
  const search = searchParams.get("search")?.trim() ?? "";
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

    const sourceRows = await fetchOrderSourceRows();
    const sourceLookup = buildSourceLookup(sourceRows);
    const sourceGroups = buildSourceGroups(sourceRows);
    const sourceIds = marketplace
      ? sourceGroups.find((g) => g.key === marketplace)?.sourceIds ?? []
      : null;

    const buildQuery = () => {
      let query = admin.from("orders").select(ORDER_COLUMNS, { count: "exact" });
      if (from) query = query.gte("order_date", from);
      if (to) query = query.lte("order_date", to);
      if (sourceIds !== null) {
        query =
          sourceIds.length > 0
            ? query.in("order_source", sourceIds)
            : query.eq("order_source", -1);
      }
      if (search) {
        const like = `%${search}%`;
        const orFilters = [
          `external_order_id.ilike.${like}`,
          `delivery_nr.ilike.${like}`,
        ];
        if (/^\d+$/.test(search)) {
          orFilters.push(`order_id.eq.${search}`);
        }
        query = query.or(orFilters.join(","));
      }
      return query;
    };

    const batchSize = 1000;
    const firstBatch = buildQuery()
      .order(sortDbColumn, { ascending: sortOrder === "asc" })
      .range(0, batchSize - 1);

    const { data: firstData, error: firstError, count } = await firstBatch;
    if (firstError) throw firstError;

    const rows: OrderRow[] = [...(firstData ?? [])];
    const total = count ?? rows.length;

    const remainingOffsets: number[] = [];
    for (let offset = batchSize; offset < total; offset += batchSize) {
      remainingOffsets.push(offset);
    }

    if (remainingOffsets.length > 0) {
      const batches = await Promise.all(
        remainingOffsets.map((offset) =>
          buildQuery()
            .order(sortDbColumn, { ascending: sortOrder === "asc" })
            .range(offset, offset + batchSize - 1)
        )
      );
      for (const { data, error } of batches) {
        if (error) throw error;
        rows.push(...(data ?? []));
      }
    }

    const csv = toCsv(rows, sourceLookup);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dashboard-export.csv"`,
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(
  rows: OrderRow[],
  sourceLookup: Map<number, { label: string }>
): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.order_id,
        row.external_order_id,
        row.order_source !== null
          ? sourceLookup.get(row.order_source)?.label ?? "Unknown"
          : "Unknown",
        row.transaction_type,
        row.delivery_nr,
        row.delivery_country_code,
        row.delivery_cost_netto ?? 0,
        row.revenue_netto ?? 0,
        row.fees_netto ?? 0,
        row.marketing_cost ?? 0,
        row.profit ?? 0,
        row.products_cost,
        row.margin,
        row.order_date,
        row.more_info_link,
        row.created_at,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\r\n");
}
