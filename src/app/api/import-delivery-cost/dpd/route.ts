import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";
import { xlsxToCsv, excelSerialToIso } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const DELIMITER = ",";
const HEADER_ROW_INDEX = 0;
const NR_HEADER = "list pierwotny";
const NETTO_HEADER = "kwota";
const DATE_CONFIRM_HEADER = "data nadania";
const BATCH_SIZE = 500;

interface StageDeliveryCostRow {
  nr: string;
  netto: number;
  date_confirm: string; //16.03.2026
}

function findHeaderCol(header: string[], name: string): number {
  return header.findIndex((h) => h?.trim().toLowerCase() === name);
}

function parseDpdRows(csvText: string): StageDeliveryCostRow[] {
  const rows = parseCsv(csvText, DELIMITER);
  if (rows.length <= HEADER_ROW_INDEX) return [];

  const header = rows[HEADER_ROW_INDEX];
  const nrCol = findHeaderCol(header, NR_HEADER);
  const nettoCol = findHeaderCol(header, NETTO_HEADER);
  const dateConfirmCol = findHeaderCol(header, DATE_CONFIRM_HEADER);

  if (nrCol === -1 || nettoCol === -1 || dateConfirmCol === -1) {
    throw new Error(
      `Could not find expected columns in the DPD file (looking for "List pierwotny", "Kwota", "Data nadania"). Found headers: ${header.join(", ")}`
    );
  }

  return rows
    .slice(HEADER_ROW_INDEX + 1)
    .filter((r) => r[nrCol]?.trim())
    .map((r) => ({
      nr: r[nrCol].trim(),
      netto: parsePolishNumber(r[nettoCol]),
      date_confirm: excelSerialToIso(r[dateConfirmCol]) ?? r[dateConfirmCol]?.trim() ?? "",
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

  let csvRows: StageDeliveryCostRow[];
  try {
    const csvText = await xlsxToCsv(file);
    csvRows = parseDpdRows(csvText);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse the DPD file." },
      { status: 400 }
    );
  }

  if (csvRows.length === 0) {
    return NextResponse.json(
      { error: "No valid rows found in the file." },
      { status: 400 }
    );
  }

  const dedupedRows = Array.from(
    new Map(csvRows.map((r) => [r.nr, r])).values()
  );


  const insertedNrs = new Set<string>();

  // Insert only new rows; rows whose `nr` already exists are skipped (not overwritten).
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
    message: "DPD delivery cost import complete.",
    rowsImported: insertedNrs.size,
    skippedNrs,
  });
}
