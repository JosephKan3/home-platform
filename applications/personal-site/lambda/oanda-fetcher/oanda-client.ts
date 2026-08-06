/**
 * OANDA HTTP access and response transformation.
 *
 * Everything in this file is a plain function: data in, data out. The only
 * side effect is the HTTP call in `fetchTransactions`, and even that takes its
 * credentials as an argument rather than reading the environment. That is what
 * makes the interesting logic — the two transformations the page actually
 * depends on — unit-testable without mocking a single AWS client.
 *
 * The transformations are ports of `pages/api/oandaReturn.ts` and
 * `pages/api/oandaTrades.ts` in the personal-website repo. They must stay
 * behaviourally identical, because the page's charts are written against their
 * output shapes.
 */

export const OANDA_BASE_URL = "https://api-fxtrade.oanda.com";

/**
 * Instrument code to display name, ported verbatim from `types/oandaCodes.ts`
 * in the site repo. The pie chart labels come from these values, so the map
 * lives with the producer now rather than with the consumer.
 */
export const OANDA_CODES: Record<string, string> = {
  WHEAT_USD: "Wheat",
  XAU_AUD: "Gold/AUD",
  USD_ZAR: "USD/ZAR",
  CAD_JPY: "CAD/JPY",
  XAU_CAD: "Gold/CAD",
  CAD_HKD: "CAD/HKD",
  CH20_CHF: "Switzerland 20",
  EUR_NOK: "EUR/NOK",
  USB05Y_USD: "US 5Y",
  UK100_GBP: "UK 100",
  HK33_HKD: "Hong Kong",
  XAG_EUR: "Silver/EUR",
  USD_PLN: "USD/PLN",
  GBP_AUD: "GBP/AUD",
  GBP_CHF: "GBP/CHF",
  USD_THB: "USD/THB",
  USD_SGD: "USD/SGD",
  EUR_SEK: "EUR/SEK",
  AUD_JPY: "AUD/JPY",
  EUR_ZAR: "EUR/ZAR",
  TRY_JPY: "TRY/JPY",
  SGD_JPY: "SGD/JPY",
  NZD_JPY: "NZD/JPY",
  US2000_USD: "US Russ",
  AUD_SGD: "AUD/SGD",
  AUD_HKD: "AUD/HKD",
  WTICO_USD: "West Texas Oil",
  XAG_AUD: "Silver/AUD",
  GBP_USD: "GBP/USD",
  USD_MXN: "USD/MXN",
  EUR_CHF: "EUR/CHF",
  AUD_CHF: "AUD/CHF",
  XAU_HKD: "Gold/HKD",
  ZAR_JPY: "ZAR/JPY",
  CHF_ZAR: "CHF/ZAR",
  HKD_JPY: "HKD/JPY",
  SUGAR_USD: "Sugar",
  EUR_PLN: "EUR/PLN",
  XAU_JPY: "Gold/JPY",
  XCU_USD: "Copper",
  XAG_HKD: "Silver/HKD",
  USD_HKD: "USD/HKD",
  XAG_JPY: "Silver/JPY",
  EUR_SGD: "EUR/SGD",
  USD_SEK: "USD/SEK",
  GBP_SGD: "GBP/SGD",
  GBP_NZD: "GBP/NZD",
  XAU_NZD: "Gold/NZD",
  GBP_HKD: "GBP/HKD",
  EUR_HKD: "EUR/HKD",
  USD_JPY: "USD/JPY",
  EUR_TRY: "EUR/TRY",
  CORN_USD: "Corn",
  USD_CHF: "USD/CHF",
  AUD_NZD: "AUD/NZD",
  AU200_AUD: "Australia 200",
  USB30Y_USD: "US T",
  FR40_EUR: "France 40",
  SGD_CHF: "SGD/CHF",
  JP225_USD: "Japan 225",
  GBP_ZAR: "GBP/ZAR",
  USD_NOK: "USD/NOK",
  XAG_USD: "Silver",
  AUD_USD: "AUD/USD",
  EUR_HUF: "EUR/HUF",
  XAG_GBP: "Silver/GBP",
  CAD_SGD: "CAD/SGD",
  NAS100_USD: "US Nas",
  DE10YB_EUR: "Bund",
  EUR_CAD: "EUR/CAD",
  USD_HUF: "USD/HUF",
  XAU_CHF: "Gold/CHF",
  NZD_SGD: "NZD/SGD",
  EUR_JPY: "EUR/JPY",
  NATGAS_USD: "Natural Gas",
  GBP_PLN: "GBP/PLN",
  XAG_NZD: "Silver/NZD",
  USB10Y_USD: "US 10Y",
  EU50_EUR: "Europe 50",
  SG30_SGD: "Singapore 30",
  CHF_JPY: "CHF/JPY",
  XAG_CAD: "Silver/CAD",
  XAG_CHF: "Silver/CHF",
  XAG_SGD: "Silver/SGD",
  XAU_EUR: "Gold/EUR",
  USD_CNH: "USD/CNH",
  XAU_GBP: "Gold/GBP",
  AUD_CAD: "AUD/CAD",
  UK10YB_GBP: "UK 10Y",
  SPX500_USD: "US SPX",
  USD_DKK: "USD/DKK",
  BCO_USD: "Brent Crude",
  EUR_DKK: "EUR/DKK",
  SOYBN_USD: "Soybeans",
  CN50_USD: "China A50",
  USD_CZK: "USD/CZK",
  EUR_GBP: "EUR/GBP",
  NZD_USD: "NZD/USD",
  USD_CAD: "USD/CAD",
  EUR_CZK: "EUR/CZK",
  CAD_CHF: "CAD/CHF",
  NZD_HKD: "NZD/HKD",
  ESPIX_EUR: "Spain 35",
  NZD_CHF: "NZD/CHF",
  XAU_XAG: "Gold/Silver",
  XPD_USD: "Palladium",
  XAU_USD: "Gold",
  XPT_USD: "Platinum",
  JP225Y_JPY: "Japan 225",
  EUR_USD: "EUR/USD",
  CHINAH_HKD: "China H",
  GBP_JPY: "GBP/JPY",
  USD_TRY: "USD/TRY",
  CHF_HKD: "CHF/HKD",
  DE30_EUR: "Germany 30",
  NZD_CAD: "NZD/CAD",
  US30_USD: "US Wall",
  NL25_EUR: "Netherlands 25",
  USB02Y_USD: "US 2Y",
  EUR_NZD: "EUR/NZD",
  XAU_SGD: "Gold/SGD",
  GBP_CAD: "GBP/CAD",
  EUR_AUD: "EUR/AUD",
};

/**
 * The account opening date, hardcoded in the original handler with the comment
 * "dont want to fetch from API". Kept as the first point of the returns series
 * so the chart starts at 0% rather than at the first trade's result.
 */
export const SERIES_START = "2022-03-09T17:24:47.605318441Z";

/** A point on the cumulative returns line chart. Matches the site's `Trade` type. */
export interface ReturnPoint {
  readonly date: string;
  readonly cumPerformance: number;
}

/** Instrument display name to number of orders placed. Feeds the pie chart. */
export type TradeCounts = Record<string, number>;

/**
 * The subset of an OANDA transaction these transformations read. Everything is
 * a string in OANDA's wire format, including the numbers.
 */
export interface OandaTransaction {
  readonly type?: string;
  readonly time?: string;
  readonly instrument?: string;
  readonly pl?: string;
  readonly accountBalance?: string;
}

export interface OandaTransactionsResponse {
  readonly transactions?: OandaTransaction[];
}

export interface OandaCredentials {
  readonly accountId: string;
  readonly accessToken: string;
}

export type LogFn = (event: Record<string, unknown>) => void;

export interface FetchOptions {
  /** `ORDER_FILL` for the returns series, `ORDER` for the instrument counts. */
  readonly type: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: LogFn;
  /** Retries on 429 and 5xx only. The original client retried 429 three times. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `GET /v3/accounts/{id}/transactions/sinceid?id=0&type=...`
 *
 * `id=0` means "everything since the beginning of the account", which is what
 * both original handlers asked for. The response is the full transaction
 * history, so this is deliberately the only network call per dataset.
 */
export async function fetchTransactions(
  credentials: OandaCredentials,
  options: FetchOptions,
): Promise<OandaTransaction[]> {
  const {
    type,
    baseUrl = OANDA_BASE_URL,
    fetchImpl = fetch,
    log = () => {},
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const url = `${baseUrl}/v3/accounts/${encodeURIComponent(
    credentials.accountId,
  )}/transactions/sinceid?id=0&type=${encodeURIComponent(type)}`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        // The body is read even on failure: OANDA puts the reason in
        // `errorMessage`, and losing it makes a 400 impossible to diagnose.
        const body = await response.text();
        const error = new Error(
          `OANDA responded ${response.status} for type=${type}: ${body.slice(0, 500)}`,
        );
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
        log({ level: "WARN", msg: "oanda.retry", type, attempt, status: response.status });
        lastError = error;
        await sleep(retryDelayMs * attempt);
        continue;
      }

      const payload = (await response.json()) as OandaTransactionsResponse;
      return payload.transactions ?? [];
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      // A thrown non-OK response is already final; only transport-level
      // failures reach here with attempts remaining.
      if (attempt === maxAttempts || asError.message.startsWith("OANDA responded")) {
        throw asError;
      }
      log({ level: "WARN", msg: "oanda.retry", type, attempt, error: asError.message });
      lastError = asError;
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError ?? new Error(`OANDA request failed for type=${type}`);
}

/**
 * Cumulative percentage return per closed trade, ported from
 * `pages/api/oandaReturn.ts`.
 *
 * Each trade's return is measured against the balance *before* that trade
 * (`balance - pl`), and returns are summed rather than compounded — which is
 * what the original did, and what the chart's y-axis label means. Changing it
 * to a compounded series would silently rewrite the site's headline number.
 *
 * Transactions without a non-zero `pl`, an `accountBalance` and a `time` are
 * skipped: those are the non-closing fills.
 */
export function toCumulativeReturns(transactions: readonly OandaTransaction[]): ReturnPoint[] {
  const performances: ReturnPoint[] = [{ date: SERIES_START, cumPerformance: 0 }];

  let cumulativeReturn = 0;
  for (const transaction of transactions) {
    if (!transaction.pl || !transaction.accountBalance || !transaction.time) {
      continue;
    }
    const pl = parseFloat(transaction.pl);
    if (pl === 0 || Number.isNaN(pl)) {
      continue;
    }
    const balance = parseFloat(transaction.accountBalance);
    cumulativeReturn += (pl / (balance - pl)) * 100;
    performances.push({ date: transaction.time, cumPerformance: cumulativeReturn });
  }

  return performances;
}

/**
 * Orders placed per instrument, ported from `pages/api/oandaTrades.ts`.
 *
 * Deviation from the original, deliberate: an instrument missing from
 * `OANDA_CODES` fell through as the literal string "undefined" and collapsed
 * every unknown instrument into one pie slice labelled `undefined`. Here it
 * falls back to the raw OANDA code, which is at least readable.
 */
export function toTradeCounts(transactions: readonly OandaTransaction[]): TradeCounts {
  const counts: TradeCounts = {};

  for (const transaction of transactions) {
    const instrument = transaction.instrument;
    if (!instrument) {
      continue;
    }
    const displayName = OANDA_CODES[instrument] ?? instrument;
    counts[displayName] = (counts[displayName] ?? 0) + 1;
  }

  return counts;
}

/** The final total the page renders, truncated the same way the page truncates it. */
export function totalReturn(points: readonly ReturnPoint[]): number {
  const last = points[points.length - 1];
  return last === undefined ? 0 : parseFloat(last.cumPerformance.toFixed(2));
}
