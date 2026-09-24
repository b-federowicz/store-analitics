// src/app/api/import-delivery-cost/dhl/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import {
  parseCsv,
  parseCurrencyAmount,
  parseGermanDateToIso,
  parseIsoDateToIso,
  parseUsDateToIso,
} from "@/lib/csv";
import { createEurPlnRateCache } from "@/lib/nbp-fx";
import { excelSerialToIso, xlsxToCsv } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const DELIMITER = ",";
const HEADER_ROW_INDEX = 1;
const NR_HEADER = "sendungsnummer";
const DATE_HEADER = "sendungsdatum";
const FX_RATE_CONCURRENCY = 10;
const BATCH_SIZE = 500;
const NETTO_EUR_HEADER = "netto klient";

interface DhlRow {
  nr: string;
  isoDate: string;
  nettoEur: number;
  isOldDate: boolean;
}

interface StageDeliveryCostRow {
  nr: string;
  netto: number;
  date_confirm: string;
}

function findHeaderCol(header: string[], name: string): number {
  return header.findIndex((h) => h?.trim().toLowerCase() === name);
}

// DHL files sometimes carry a duplicate row for the same "Sendungsnummer"
// where the date cell is blank/garbage and parses to a bogus old date.
// Below this year the date is considered bogus. Whether that's fixed with
// today's date or the row is just dropped is decided later in POST, once we
// know if this nr is a genuine duplicate.
const OLD_DATE_YEAR_THRESHOLD = 2010;

function parseDhlDate(rawInput: string): { isoDate: string | null; isOldDate: boolean } {
  let isoDate: string | null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(rawInput)) isoDate = parseIsoDateToIso(rawInput);
  else if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(rawInput)) isoDate = parseGermanDateToIso(rawInput);
  else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(rawInput)) isoDate = parseUsDateToIso(rawInput);
  else isoDate = excelSerialToIso(rawInput);

  if (isoDate) {
    const year = Number(isoDate.slice(0, 4));
    return { isoDate, isOldDate: year < OLD_DATE_YEAR_THRESHOLD };
  }

  return { isoDate: null, isOldDate: false };
}

function parseDhlRows(csvText: string): DhlRow[] {
  const rows = parseCsv(csvText, DELIMITER);
  if (rows.length <= HEADER_ROW_INDEX) return [];

  const header = rows[HEADER_ROW_INDEX];
  const nrCol = findHeaderCol(header, NR_HEADER);
  const dateCol = findHeaderCol(header, DATE_HEADER);
  const nettoCol = findHeaderCol(header, NETTO_EUR_HEADER);

  if (nrCol === -1 || dateCol === -1 || nettoCol === -1) {
    throw new Error(
      `Could not find expected columns in the DHL file (looking for "Sendungsnummer", "Sendungsdatum", "Netto KLIENT"). Found headers: ${header.join(", ")}`
    );
  }

  return rows
    .slice(HEADER_ROW_INDEX + 1)
    .filter((r) => r[nrCol]?.trim())
    .map((r) => {
      const { isoDate, isOldDate } = parseDhlDate(r[dateCol] ?? "");
      return {
        nr: r[nrCol].trim(),
        isoDate: isoDate ?? "",
        nettoEur: parseCurrencyAmount(r[nettoCol] ?? "0"),
        isOldDate,
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

  let csvRows: DhlRow[];
  try {
    const csvText = await xlsxToCsv(file);
    csvRows = parseDhlRows(csvText);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse the DHL file." },
      { status: 400 }
    );
  }

  if (csvRows.length === 0) {
    return NextResponse.json(
      { error: "No valid rows found in the file." },
      { status: 400 }
    );
  }

  const invalidDateRows = csvRows.filter((r) => !r.isoDate);
  if (invalidDateRows.length > 0) {
    return NextResponse.json(
      {
        error: `Could not parse "Sendungsdatum" for ${invalidDateRows.length} row(s), e.g. nr ${invalidDateRows[0].nr}.`,
      },
      { status: 400 }
    );
  }

  // The same "Sendungsnummer" can appear twice in a DHL file: one row with the
  // real date and a stray duplicate whose date cell is blank/garbage and reads
  // back as an old date (e.g. 1899). For a genuine duplicate, use the real
  // (>= 2010) date — don't patch it with today's date, since the real row
  // already has the answer — but sum nettoEur across all rows for the nr,
  // since the duplicate lines are separate charges, not parsing noise.
  // The today's-date fallback only kicks in for an nr that appears just once
  // and still has an old date, so it doesn't silently break FX-rate lookups.
  const rowsByNr = csvRows.reduce((byNr, row) => {
    const list = byNr.get(row.nr) ?? [];
    list.push(row);
    byNr.set(row.nr, list);
    return byNr;
  }, new Map<string, DhlRow[]>());

  csvRows = Array.from(rowsByNr.values()).map((group) => {
    if (group.length === 1) {
      const row = group[0];
      if (!row.isOldDate) return row;
      return { ...row, isoDate: new Date().toISOString().slice(0, 10) };
    }

    const totalNettoEur = group.reduce((sum, r) => sum + r.nettoEur, 0);
    const genuine = group.filter((r) => !r.isOldDate);
    if (genuine.length > 0) {
      const best = genuine.reduce((latest, r) => (r.isoDate > latest.isoDate ? r : latest));
      return { ...best, nettoEur: totalNettoEur };
    }
    // All duplicates for this nr have a bogus old date; fall back to today.
    return { ...group[0], isoDate: new Date().toISOString().slice(0, 10), nettoEur: totalNettoEur };
  });

  const getRate = createEurPlnRateCache();
  const ratesByDate = new Map<string, number>();
  let rows: StageDeliveryCostRow[];
  try {
    rows = [];
    for (let i = 0; i < csvRows.length; i += FX_RATE_CONCURRENCY) {
      const batch = csvRows.slice(i, i + FX_RATE_CONCURRENCY);
      rows.push(
        ...(await Promise.all(
          batch.map(async (r) => {
            const rate = await getRate(r.isoDate);
            ratesByDate.set(r.isoDate, rate);
            return { nr: r.nr, netto: Math.round(r.nettoEur * rate * 100) / 100, date_confirm: r.isoDate };
          })
        ))
      );
    }
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to fetch EUR/PLN exchange rates from NBP.",
      },
      { status: 502 }
    );
  }

  const ratesUsed = Object.fromEntries(
    Array.from(ratesByDate.entries()).sort(([a], [b]) => a.localeCompare(b))
  );
  console.log("DHL import: EUR/PLN rates used", ratesUsed);

  const dedupedRows = Array.from(
    new Map(rows.map((r) => [r.nr, r])).values()
  );



  // Insert only new rows; rows whose `nr` already exists are skipped (not overwritten).
  // Batched so each statement (and its cost-push trigger) stays well under
  // Postgres' statement_timeout even for large files.
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
    message: "DHL delivery cost import complete.",
    rowsImported: insertedNrs.size,
    skippedNrs,
    ratesUsed,
  });
}
