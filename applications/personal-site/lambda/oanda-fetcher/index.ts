/**
 * oanda-fetcher — the scheduled half of the personal site.
 *
 * EventBridge Scheduler invokes this hourly. It reads two SSM SecureString
 * parameters, calls OANDA twice, and writes two JSON files into the same S3
 * bucket the site is served from. The browser then fetches static files, so
 * there is no request-path compute and no CORS configuration anywhere.
 *
 * The one property this handler exists to guarantee: **the S3 objects are
 * either both replaced with a complete new pair, or neither is touched.**
 * Both datasets are fetched and transformed in full before the first
 * `PutObject`, so an OANDA outage leaves the last good data in place and the
 * charts keep rendering. Stale data is fine here — this is trading history.
 * A half-written pair is not.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  fetchTransactions,
  toCumulativeReturns,
  toTradeCounts,
  totalReturn,
} from "./oanda-client.js";
import type { OandaCredentials } from "./oanda-client.js";

/**
 * Structured logs only. This is the first service on the platform and the
 * observability story is part of the point: CloudWatch Logs Insights can query
 * these fields directly, and a raw `console.log` string cannot be queried at
 * all.
 */
function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ service: "oanda-fetcher", ...event })}\n`);
}

const region = process.env["AWS_REGION"];
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });

/**
 * Cached across warm invocations. The parameters never change between deploys
 * and the schedule is hourly, so this saves a KMS decrypt on most invocations
 * without introducing any staleness that matters.
 */
let cachedCredentials: OandaCredentials | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function loadCredentials(): Promise<OandaCredentials> {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const accountIdParam = required("OANDA_ACCOUNT_ID_PARAMETER");
  const accessTokenParam = required("OANDA_ACCESS_TOKEN_PARAMETER");

  const response = await ssm.send(
    new GetParametersCommand({
      Names: [accountIdParam, accessTokenParam],
      WithDecryption: true,
    }),
  );

  const values = new Map(
    (response.Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]),
  );
  const accountId = values.get(accountIdParam);
  const accessToken = values.get(accessTokenParam);

  if (!accountId || !accessToken) {
    throw new Error(
      `SSM did not return both OANDA parameters. Invalid: ${(response.InvalidParameters ?? []).join(", ")}. ` +
        "Seed them with `aws ssm put-parameter --type SecureString` — see the package README.",
    );
  }

  cachedCredentials = { accountId, accessToken };
  return cachedCredentials;
}

async function putJson(bucket: string, key: string, body: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
      // Matches the CloudFront /data/* behaviour and the hourly schedule.
      // Anything longer would serve data older than the next write.
      CacheControl: "public, max-age=300",
    }),
  );
}

export async function handler(): Promise<void> {
  const bucket = required("SITE_BUCKET");
  const returnsKey = required("RETURNS_KEY");
  const tradesKey = required("TRADES_KEY");
  const startedAt = Date.now();

  try {
    const credentials = await loadCredentials();

    // Both datasets are materialised before anything is written. This is the
    // no-partial-write guarantee; do not move a put above this line.
    const [fillTransactions, orderTransactions] = await Promise.all([
      fetchTransactions(credentials, { type: "ORDER_FILL", log }),
      fetchTransactions(credentials, { type: "ORDER", log }),
    ]);

    const returns = toCumulativeReturns(fillTransactions);
    const trades = toTradeCounts(orderTransactions);

    await Promise.all([
      putJson(bucket, returnsKey, returns),
      putJson(bucket, tradesKey, trades),
    ]);

    log({
      level: "INFO",
      msg: "oanda.published",
      returnPoints: returns.length,
      instruments: Object.keys(trades).length,
      totalReturnPct: totalReturn(returns),
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const asError = error instanceof Error ? error : new Error(String(error));
    log({
      level: "ERROR",
      msg: "oanda.failed",
      error: asError.message,
      durationMs: Date.now() - startedAt,
      // Said explicitly because it is the design decision, not an accident:
      // the previous objects are still being served.
      note: "no S3 object was overwritten; the site continues serving the last good data",
    });
    // Rethrow so the invocation is recorded as an error and the Lambda Errors
    // metric — the thing an alarm would watch — actually moves.
    throw asError;
  }
}
