import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

const DELIMITER = ";";
const BATCH_SIZE = 500;


const NR_COL = 2;
const NETTO_COL = 6;
const FUEL_SURCHARGE_COL = 7;
const TOLL_COL = 8;
const SURCHARGE_COL = 9;


interface StageDeliveryCostRow {
  nr: string;
  netto: number;
}

function parseGlsRows(csvText: string): StageDeliveryCostRow[] {
  const rows = parseCsv(csvText, DELIMITER);


  if (rows.length === 0) return [];

  return rows
    .slice(1)
    .filter((r) => r[NR_COL]?.trim())
    .map((r) => {
      const netto = parsePolishNumber(r[NETTO_COL] ?? "0");
      const fuelSurcharge = parsePolishNumber(r[FUEL_SURCHARGE_COL] ?? "0");
      const toll = parsePolishNumber(r[TOLL_COL] ?? "0");
      const surcharge = parsePolishNumber(r[SURCHARGE_COL] ?? "0");
      return {
        nr: r[NR_COL].trim(),
        netto: netto + fuelSurcharge + toll + surcharge,
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
  const rows = parseGlsRows(csvText);

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
    message: "GLS delivery cost import complete.",
    rowsImported: insertedNrs.size,
    skippedNrs,
  });
}
