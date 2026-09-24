import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";
import {
  IMPORT_CSV_ALLOWED_ID_COLUMNS,
  IMPORT_CSV_ALLOWED_VALUE_COLUMNS,
  TRANSACTION_TYPES,
} from "@/constants";

export const dynamic = "force-dynamic";

const DELIMITER = ";";
const CONCURRENCY = 20;
const ID_COL = 0;
const INPUT_COL = 1;

interface ImportCsvRows {
  idLabel: string;
  columnLabel: string;
  rows: { id: string; value: string }[];
}

function parseImportCsvRows(csvText: string): ImportCsvRows {
  const rows = parseCsv(csvText, DELIMITER);
  if (rows.length === 0) return { idLabel: "", columnLabel: "", rows: [] };
  const idLabel = rows[0][ID_COL]?.trim() ?? "";
  const columnLabel = rows[0][INPUT_COL]?.trim() ?? "";
  const filteredRows = rows
    .slice(1)
    .map((r) => ({
      id: r[ID_COL].trim(),
      value: (r[INPUT_COL] ?? "").trim(),
    }));

  return { idLabel, columnLabel, rows: filteredRows };
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
  const { idLabel, columnLabel, rows } = parseImportCsvRows(csvText);

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No valid rows found in the CSV." },
      { status: 400 }
    );
  }

  if (!(IMPORT_CSV_ALLOWED_ID_COLUMNS as readonly string[]).includes(idLabel)) {
    return NextResponse.json(
      {
        error: `First CSV column must map to one of: ${IMPORT_CSV_ALLOWED_ID_COLUMNS.join(", ")}. Got "${idLabel}".`,
      },
      { status: 400 }
    );
  }
  if (!(IMPORT_CSV_ALLOWED_VALUE_COLUMNS as readonly string[]).includes(columnLabel)) {
    return NextResponse.json(
      {
        error: `Second CSV column must map to one of: ${IMPORT_CSV_ALLOWED_VALUE_COLUMNS.join(", ")}. Got "${columnLabel}".`,
      },
      { status: 400 }
    );
  }

  const dedupedRows = Array.from(
    new Map(rows.map((r) => [r.id, r])).values()
  );

  if (columnLabel === "transaction_type") {
    const invalidValues = Array.from(
      new Set(
        dedupedRows
          .map((r) => r.value)
          .filter((v) => !(TRANSACTION_TYPES as readonly string[]).includes(v))
      )
    );
    if (invalidValues.length > 0) {
      return NextResponse.json(
        {
          error: `transaction_type must be one of: ${TRANSACTION_TYPES.join(", ")}. Invalid value(s) in CSV: ${invalidValues.join(", ")}.`,
        },
        { status: 400 }
      );
    }
  }

  // Update-only: never create new order rows from a cost CSV. Each row is
  // matched against an existing order and only touches `columnLabel`; ids
  // with no matching order are reported back as unmatched, not inserted.
  const matchedIds = new Set<string>();
  for (let i = 0; i < dedupedRows.length; i += CONCURRENCY) {
    const batch = dedupedRows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) =>
        supabaseAdmin!
          .from("orders")
          .update({
            [columnLabel]:
              columnLabel === "transaction_type"
                ? row.value
                : parsePolishNumber(row.value),
          })
          .eq(idLabel, row.id)
          .select(idLabel)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const { data, error } = results[j];
      if (error) {
        console.error(error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (data && data.length > 0) matchedIds.add(batch[j].id);
    }
  }

  const unmatchedIds = dedupedRows
    .map((r) => r.id)
    .filter((id) => !matchedIds.has(id));

  invalidateDashboardCache();
  return NextResponse.json({
    message: "Csv import complete.",
    rowsImported: matchedIds.size,
    unmatchedIds,
  });
}
