// Looks up the NBP "table A" average rate (vs. PLN) for a given date and currency.

const MAX_LOOKBACK_DAYS = 10;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 500;

export type NbpCurrencyCode = "eur" | "czk" | "huf";

interface NbpRatesResponse {
  rates: { mid: number }[];
}

function toIsoDate(date: Date): string {
  return !!date ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function isTransientFetchError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof TypeError) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNRESET" || cause?.code === "ETIMEDOUT" || cause?.code === "ECONNREFUSED") {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRateForDate(
  currency: NbpCurrencyCode,
  isoDate: string
): Promise<number | null> {
  const url = new URL(
    `https://api.nbp.pl/api/exchangerates/rates/a/${currency}/${isoDate}/`
  );
  url.searchParams.set("format", "json");

  let res: Response | undefined;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
      break;
    } catch (err) {
      if (err instanceof TypeError && /ByteString/.test(err.message)) return null;
      if (isTransientFetchError(err) && attempt < MAX_FETCH_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!res) return null;

  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    throw new Error(`NBP API request failed (${res.status}) for ${currency.toUpperCase()} ${isoDate}.`);
  }
  const json: NbpRatesResponse = await res.json();
  return json.rates[0]?.mid ?? null;
}

async function findRateWithLookback(
  currency: NbpCurrencyCode,
  fromIsoDate: string
): Promise<number | null> {
  const date = new Date(`${fromIsoDate}T00:00:00Z`);

  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    const candidate = toIsoDate(date);
    const rate = await fetchRateForDate(currency, candidate);
    if (rate !== null) return rate;
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return null;
}

export async function getPlnRate(currency: NbpCurrencyCode, isoDate: string): Promise<number> {
  const rate = await findRateWithLookback(currency, isoDate);
  if (rate !== null) return rate;

  const todayRate = await findRateWithLookback(currency, toIsoDate(new Date()));
  if (todayRate !== null) return todayRate;

  throw new Error(
    `No NBP ${currency.toUpperCase()}/PLN rate found within ${MAX_LOOKBACK_DAYS} days before ${isoDate}, nor before today.`
  );
}

export async function getEurPlnRate(isoDate: string): Promise<number> {
  return getPlnRate("eur", isoDate);
}

// Caches rates per date within a single import so each distinct delivery
// date only hits the NBP API once.
export function createEurPlnRateCache() {
  const cache = new Map<string, Promise<number>>();
  return async function getRate(isoDate: string): Promise<number> {
    let pending = cache.get(isoDate);
    if (!pending) {
      pending = getPlnRate("eur", isoDate);
      cache.set(isoDate, pending);
    }
    return pending;
  };
}

// Multi-currency variant: caches rates per "currency:date" so a single sync
// touching both EUR and CZK orders only hits the NBP API once per pair.
export function createPlnRateCache() {
  const cache = new Map<string, Promise<number>>();
  return async function getRate(currency: NbpCurrencyCode, isoDate: string): Promise<number> {
    const key = `${currency}:${isoDate}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = getPlnRate(currency, isoDate);
      cache.set(key, pending);
    }
    return pending;
  };
}
