// src/lib/sheet-costs.ts
import { parseCsv, parsePolishNumber } from "@/lib/csv";

const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_SHEET_CSV_URL ?? "";
const GOOGLE_SHEET_CSV_URL_DIAMOND_PAINTINGS = process.env.GOOGLE_SHEET_CSV_URL_2 ?? "";

export interface SheetCostRow {
  sku: string;
  name: string;
  costNetto: number;
}

async function fetchMainSheetCostRows(): Promise<SheetCostRow[]> {
  const res = await fetch(GOOGLE_SHEET_CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV: ${res.status}`);
  }
  const csvText = await res.text();
  const rows = parseCsv(csvText);

  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const skuIdx = header.indexOf("sku");
  const nameIdx = header.indexOf("nazwa");
  const costIdx = header.indexOf("cena zakupu netto");

  if (skuIdx === -1 || costIdx === -1) {
    throw new Error(
      `Google Sheet is missing expected columns. Found headers: ${header.join(", ")}`
    );
  }

  return rows
    .slice(1)
    .filter((r) => r[skuIdx]?.trim())
    .map((r) => ({
      sku: r[skuIdx].trim(),
      name: nameIdx !== -1 ? (r[nameIdx] ?? "").trim() : "",
      costNetto: parsePolishNumber(r[costIdx] ?? "0"),
    }));
}

async function fetchDiamondPaintingCostRows(): Promise<SheetCostRow[]> {
  const res = await fetch(GOOGLE_SHEET_CSV_URL_DIAMOND_PAINTINGS);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Diamond Painting Google Sheet CSV: ${res.status}`
    );
  }
  const csvText = await res.text();
  const rows = parseCsv(csvText);

  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const skuIdx = header.indexOf("sku");
  const costIdx = header.indexOf("cena netto");

  if (skuIdx === -1 || costIdx === -1) {
    throw new Error(
      `Diamond Painting Google Sheet is missing expected columns. Found headers: ${header.join(", ")}`
    );
  }

  return rows
    .slice(1)
    .filter((r) => r[skuIdx]?.trim())
    .map((r) => ({
      sku: r[skuIdx].trim(),
      name: "",
      costNetto: parsePolishNumber(r[costIdx] ?? "0"),
    }));
}

export async function fetchSheetCostRows(): Promise<SheetCostRow[]> {
  const [mainRows, diamondPaintingRows] = await Promise.all([
    fetchMainSheetCostRows(),
    fetchDiamondPaintingCostRows(),
  ]);

  return [...mainRows, ...diamondPaintingRows];
}

export function matchSheetSku(
  baselinkerSku: string,
  sheetRows: SheetCostRow[]
): SheetCostRow | null {
  if (!baselinkerSku) return null;
  const upperSku = baselinkerSku.toUpperCase();
  const suffixes = [upperSku];
  const delimiterRegex = /[^A-Z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = delimiterRegex.exec(upperSku))) {
    suffixes.push(upperSku.slice(match.index + match[0].length));
  }

  let best: SheetCostRow | null = null;
  for (const row of sheetRows) {
    const sheetSkuUpper = row.sku.toUpperCase();
    const matches = suffixes.some((suffix) => suffix.startsWith(sheetSkuUpper));
    if (matches) {
      if (!best || sheetSkuUpper.length > best.sku.length) {
        best = row;
      }
    }
  }
  return best;
}
