import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";
import { excelSerialToIso } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const DELIMITER = ",";
const BATCH_SIZE = 500;

// FedEx invoice CSV uses fixed column positions (0-based):
//   Q  (17th col, index 16) = "Air Waybill Number"        -> numer przewozowy
//   BN (66th col, index 65) = "Air Waybill Total Amount"  -> koszt brutto w PLN
const NR_COL = 16;
const BRUTTO_COL = 65;
const DATE_COL = 25;

// Kwota w kolumnie BN jest brutto (z VAT 23%); netto = brutto / 1.23
const VAT_DIVISOR = 1.23;

interface StageDeliveryCostRow {
  nr: string;
  netto: number;
  brutto: number;
  date_confirm: string;
}

function parseFedexRows(csvText: string): StageDeliveryCostRow[] {
  const rows = parseCsv(csvText, DELIMITER);
  if (rows.length === 0) return [];

  return rows
    .slice(1) // skip header row
    .filter((r) => r[NR_COL]?.trim())
    .map((r) => {
      const brutto = parsePolishNumber(r[BRUTTO_COL] ?? "0");
      return {
        nr: r[NR_COL].trim(),
        brutto: Math.round(brutto * 100) / 100,
        netto: Math.round((brutto / VAT_DIVISOR) * 100) / 100,
        date_confirm: excelSerialToIso(r[DATE_COL]) ?? r[DATE_COL]?.trim() ?? "",
      };
    });
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
  const rows = parseFedexRows(csvText);

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
    message: "FedEx delivery cost import complete.",
    rowsImported: insertedNrs.size,
    skippedNrs,
  });
}
