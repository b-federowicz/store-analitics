// src/app/api/import-delivery-cost/inpost/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber, parseGermanDateToIso, parseIsoDateToIso, parseUsDateToIso } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

const DELIMITER = ";";
const BATCH_SIZE = 500;
const NR_COL = 3;
const NETTO_COL = 7;
const BRUTTO_COL = 8;
const DATE_COL = 4;

interface StageDeliveryCostRow {
  nr: string;
  netto: number;
  brutto: number;
  date_confirm: string; // 2026-05-15 (from "15.05.2026 00:00:00")
}

const parseDate = (dateStr: string): string => {
  const datePart = dateStr.split(" ")[0];
  const parsed =
    parseGermanDateToIso(datePart) ??
    parseIsoDateToIso(datePart) ??
    parseUsDateToIso(datePart);

  if (!parsed) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  return parsed;
}

function parseInpostRows(csvText: string): StageDeliveryCostRow[] {
  const rows = parseCsv(csvText, DELIMITER);
  if (rows.length === 0) return [];

  return rows
    .slice(1) // skip header row
    .filter((r) => r[NR_COL]?.trim())
    .map((r) => ({
      nr: r[NR_COL].trim(),
      netto: parsePolishNumber(r[NETTO_COL] ?? "0"),
      brutto: parsePolishNumber(r[BRUTTO_COL] ?? "0"),
      date_confirm: parseDate(r[DATE_COL]?.trim() ?? ""),
    }));
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
    return NextResponse.json(
      { error: "Missing 'file' in form data." },
      { status: 400 }
    );
  }

  const csvText = await file.text();
  const rows = parseInpostRows(csvText);

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No valid rows found in the CSV." },
      { status: 400 }
    );
  }

  const dedupedRows = Array.from(
    new Map(rows.map((r) => [r.nr, r])).values()
  );

  // Insert only new rows; rows whose `nr` already exists are skipped (not overwritten).
  // Batched so each statement (and its cost-push trigger) stays well under
  // Postgres' statement_timeout even for large CSVs.
  const insertedNrs = new Set<string>();
  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const batch = dedupedRows.slice(i, i + BATCH_SIZE);
    const { data: inserted, error } = await supabaseAdmin
      .from("stage_delivery_cost")
      .upsert(batch, { onConflict: "nr", ignoreDuplicates: true })
      .select("nr");

    if (error) {
      console.error(error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    for (const r of inserted ?? []) insertedNrs.add(r.nr);
  }
  const skippedNrs = dedupedRows
    .map((r) => r.nr)
    .filter((nr) => !insertedNrs.has(nr));

  invalidateDashboardCache();
  return NextResponse.json({
    message: "InPost delivery cost import complete.",
    rowsImported: insertedNrs.size,
    skippedNrs,
  });
}
