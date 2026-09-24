import * as XLSX from "xlsx";

// Converts the first sheet of an uploaded xlsx file to CSV text, so xlsx
// imports can be parsed with the same string-based CSV pipeline as native
// CSV files. rawNumbers avoids XLSX's default scientific-notation formatting
// for large integers (e.g. a Sendungsnummer stored as a number), at the cost
// of the underlying double-precision loss for values beyond
// Number.MAX_SAFE_INTEGER already baked in by the time we read the cell.
export async function xlsxToCsv(file: File, delimiter = ","): Promise<string> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_csv(worksheet, { FS: delimiter, rawNumbers: true });
}

// A cell typed as a date but left in "General" number format comes through
// sheet_to_csv (even with rawNumbers) as a bare Excel serial number string
// (e.g. "46037") instead of a formatted date, since only cells carrying an
// explicit date format code get formatted as dates. Decode that serial
// number directly.
export function excelSerialToIso(raw: string): string | null {
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  const parsed = XLSX.SSF.parse_date_code(Number(raw));
  if (!parsed) return null;
  return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
}
