/**
 * The transformations here produce the two numbers the site actually shows:
 * the headline total return and the instrument pie chart. They are ports of
 * `pages/api/oandaReturn.ts` and `pages/api/oandaTrades.ts`, and a silent
 * divergence would be a wrong number rendered confidently.
 *
 * The fixtures mirror OANDA's wire shape: every field, including the numbers,
 * arrives as a string.
 */

import {
  OANDA_CODES,
  SERIES_START,
  fetchTransactions,
  toCumulativeReturns,
  toTradeCounts,
  totalReturn,
} from "../lambda/oanda-fetcher/oanda-client.js";
import type { OandaTransaction } from "../lambda/oanda-fetcher/oanda-client.js";

const CREDENTIALS = { accountId: "001-002-1234567-890", accessToken: "token-abc" };

/**
 * A realistic ORDER_FILL history: two winning trades and one loser, plus the
 * non-closing fills OANDA interleaves — an opening fill with pl "0.0000" and a
 * financing-style entry with no accountBalance.
 */
const FILL_TRANSACTIONS: OandaTransaction[] = [
  {
    type: "ORDER_FILL",
    time: "2022-03-10T14:00:00.000000000Z",
    instrument: "EUR_USD",
    pl: "0.0000",
    accountBalance: "1000.0000",
  },
  {
    type: "ORDER_FILL",
    time: "2022-03-11T14:00:00.000000000Z",
    instrument: "EUR_USD",
    pl: "100.0000",
    accountBalance: "1100.0000",
  },
  {
    type: "ORDER_FILL",
    time: "2022-03-12T14:00:00.000000000Z",
    instrument: "XAU_USD",
    pl: "-110.0000",
    accountBalance: "990.0000",
  },
  {
    type: "ORDER_FILL",
    time: "2022-03-13T14:00:00.000000000Z",
    instrument: "USB10Y_USD",
    pl: "9.9000",
  },
  {
    type: "ORDER_FILL",
    time: "2022-03-14T14:00:00.000000000Z",
    instrument: "USB10Y_USD",
    pl: "99.0000",
    accountBalance: "1089.0000",
  },
];

const ORDER_TRANSACTIONS: OandaTransaction[] = [
  { type: "MARKET_ORDER", instrument: "EUR_USD" },
  { type: "MARKET_ORDER", instrument: "EUR_USD" },
  { type: "LIMIT_ORDER", instrument: "XAU_USD" },
  { type: "MARKET_ORDER", instrument: "USB10Y_USD" },
  // No instrument: order cancellations and take-profit orders look like this.
  { type: "ORDER_CANCEL" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("toCumulativeReturns", () => {
  const points = toCumulativeReturns(FILL_TRANSACTIONS);

  test("starts at the account opening date with 0%, so the chart begins at zero", () => {
    expect(points[0]).toEqual({ date: SERIES_START, cumPerformance: 0 });
  });

  test("skips fills with zero pl, a missing balance, or a missing time", () => {
    // Five transactions in, three of which close a position.
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.date)).not.toContain("2022-03-10T14:00:00.000000000Z");
    expect(points.map((p) => p.date)).not.toContain("2022-03-13T14:00:00.000000000Z");
  });

  test("measures each trade against the balance before it, and sums rather than compounds", () => {
    // +100 on 1000 = +10%; -110 on 1100 = -10%; +99 on 990 = +10%.
    // A compounded series would end at 9.0%, not 10%. This assertion is the
    // guard against someone "fixing" that.
    expect(points[1]?.cumPerformance).toBeCloseTo(10, 10);
    expect(points[2]?.cumPerformance).toBeCloseTo(0, 10);
    expect(points[3]?.cumPerformance).toBeCloseTo(10, 10);
  });

  test("carries the transaction time through as the point's date", () => {
    expect(points[1]?.date).toBe("2022-03-11T14:00:00.000000000Z");
  });

  test("an empty history still yields the zero point rather than an empty chart", () => {
    expect(toCumulativeReturns([])).toEqual([{ date: SERIES_START, cumPerformance: 0 }]);
  });
});

describe("totalReturn", () => {
  test("truncates to two decimals the same way the page did", () => {
    expect(totalReturn(toCumulativeReturns(FILL_TRANSACTIONS))).toBe(10);
    expect(totalReturn([{ date: SERIES_START, cumPerformance: 1.23456 }])).toBe(1.23);
  });

  test("is 0 for an empty series", () => {
    expect(totalReturn([])).toBe(0);
  });
});

describe("toTradeCounts", () => {
  const counts = toTradeCounts(ORDER_TRANSACTIONS);

  test("counts orders per instrument using the display names the chart labels with", () => {
    expect(counts).toEqual({ "EUR/USD": 2, Gold: 1, "US 10Y": 1 });
  });

  test("ignores transactions with no instrument", () => {
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(4);
  });

  test("falls back to the raw code for an unmapped instrument", () => {
    // The original produced a slice literally labelled "undefined" here, and
    // collapsed every unknown instrument into it.
    expect(toTradeCounts([{ instrument: "NOT_A_REAL_CODE" }])).toEqual({ NOT_A_REAL_CODE: 1 });
  });

  test("the ported code map covers the instruments actually traded", () => {
    for (const transaction of ORDER_TRANSACTIONS) {
      if (transaction.instrument) {
        expect(OANDA_CODES[transaction.instrument]).toBeDefined();
      }
    }
  });
});

describe("fetchTransactions", () => {
  test("requests sinceid from id=0 with the bearer token and the requested type", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ transactions: FILL_TRANSACTIONS }));

    const transactions = await fetchTransactions(CREDENTIALS, {
      type: "ORDER_FILL",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(transactions).toEqual(FILL_TRANSACTIONS);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api-fxtrade.oanda.com/v3/accounts/001-002-1234567-890/transactions/sinceid" +
        "?id=0&type=ORDER_FILL",
    );
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-abc");
  });

  test("treats a response with no transactions array as an empty history", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}));
    await expect(
      fetchTransactions(CREDENTIALS, {
        type: "ORDER",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual([]);
  });

  test("retries a 429 and succeeds, matching the original retry behaviour", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ transactions: ORDER_TRANSACTIONS }));

    const transactions = await fetchTransactions(CREDENTIALS, {
      type: "ORDER",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: 0,
    });

    expect(transactions).toEqual(ORDER_TRANSACTIONS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not retry a 401 — a bad token will not fix itself", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(JSON.stringify({ errorMessage: "Insufficient authorization" }), { status: 401 }),
    );

    await expect(
      fetchTransactions(CREDENTIALS, {
        type: "ORDER_FILL",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/OANDA responded 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("surfaces the OANDA error message so a 400 is diagnosable from logs", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(JSON.stringify({ errorMessage: "Invalid account ID" }), { status: 400 }),
    );

    await expect(
      fetchTransactions(CREDENTIALS, {
        type: "ORDER_FILL",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/Invalid account ID/);
  });

  test("gives up after the attempt limit on a persistent 503", async () => {
    const fetchImpl = jest.fn(async () => new Response("unavailable", { status: 503 }));

    await expect(
      fetchTransactions(CREDENTIALS, {
        type: "ORDER",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/OANDA responded 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("propagates a transport failure after exhausting retries", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("socket hang up");
    });

    await expect(
      fetchTransactions(CREDENTIALS, {
        type: "ORDER",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/socket hang up/);
  });
});

/**
 * The failure contract the handler is built around: both datasets must be
 * materialised before either is written, so a failure on the second fetch
 * cannot leave one fresh file next to one stale one.
 */
describe("no partial write on failure", () => {
  const writes: string[] = [];

  /** Mirrors the handler's ordering without dragging the AWS SDK into the test. */
  async function publish(fetchImpl: typeof fetch): Promise<void> {
    const [fills, orders] = await Promise.all([
      fetchTransactions(CREDENTIALS, { type: "ORDER_FILL", fetchImpl, retryDelayMs: 0 }),
      fetchTransactions(CREDENTIALS, { type: "ORDER", fetchImpl, retryDelayMs: 0 }),
    ]);
    const returns = toCumulativeReturns(fills);
    const trades = toTradeCounts(orders);
    writes.push(JSON.stringify(returns), JSON.stringify(trades));
  }

  beforeEach(() => {
    writes.length = 0;
  });

  test("a failure on either dataset writes nothing at all", async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("ORDER_FILL")
        ? jsonResponse({ transactions: FILL_TRANSACTIONS })
        : new Response("upstream exploded", { status: 500 });
    });

    await expect(publish(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /OANDA responded 500/,
    );
    expect(writes).toHaveLength(0);
  });

  test("both files are written together on success", async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request) =>
      String(input).includes("ORDER_FILL")
        ? jsonResponse({ transactions: FILL_TRANSACTIONS })
        : jsonResponse({ transactions: ORDER_TRANSACTIONS }),
    );

    await publish(fetchImpl as unknown as typeof fetch);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0] as string)).toHaveLength(4);
    expect(JSON.parse(writes[1] as string)).toEqual({ "EUR/USD": 2, Gold: 1, "US 10Y": 1 });
  });
});
