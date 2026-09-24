// Minimal CSV parser: handles quoted fields with delimiters/newlines.
export function parseCsv(csvText: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (field.length > 0 || row.length > 0) {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        }
        if (char === "\r" && next === "\n") i++;
      } else {
        field += char;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// "12,34" or "12.34" -> 12.34
export function parsePolishNumber(raw: string): number {
  const cleaned = raw.trim().replace(/\s/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// "4,49 €" -> 4.49 (strips currency symbols/whitespace, keeps digits/sign/decimal separator)
export function parseCurrencyAmount(raw: string): number {
  const cleaned = raw
    .trim()
    .replace(/[^\d,.-]/g, "")
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// Rejects digit-shaped but nonexistent dates (month 13, Feb 30, ...) by
// round-tripping through Date.UTC and checking the parts survive unchanged.
function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

// "01.05.2026" -> "2026-05-01"
export function parseGermanDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!match) return null;
  const [, dayRaw, monthRaw, yearRaw] = match;
  const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!isValidYmd(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "2/27/2026" -> "2026-02-27"
export function parseUsDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const [, monthRaw, dayRaw, yearRaw] = match;
  const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!isValidYmd(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "2026-09-03" -> "2026-09-03"
export function parseIsoDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!isValidYmd(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}


export function parseSlashDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const [, aRaw, bRaw, yearRaw] = match;
  const a = Number(aRaw);
  const b = Number(bRaw);
  const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);

  const asEu = isValidYmd(year, b, a) ? { month: b, day: a } : null;
  const asUs = isValidYmd(year, a, b) ? { month: a, day: b } : null;
  const picked = asEu ?? asUs;
  if (!picked) return null;
  return `${year}-${String(picked.month).padStart(2, "0")}-${String(picked.day).padStart(2, "0")}`;
}

// "01-06-2026" -> "2026-06-01" (DD-MM-YYYY, preferred when both readings are
// valid — same EU-first ambiguity resolution as parseSlashDateToIso)
export function parseDashDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (!match) return null;
  const [, aRaw, bRaw, yearRaw] = match;
  const a = Number(aRaw);
  const b = Number(bRaw);
  const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);

  const asEu = isValidYmd(year, b, a) ? { month: b, day: a } : null;
  const asUs = isValidYmd(year, a, b) ? { month: a, day: b } : null;
  const picked = asEu ?? asUs;
  if (!picked) return null;
  return `${year}-${String(picked.month).padStart(2, "0")}-${String(picked.day).padStart(2, "0")}`;
}
