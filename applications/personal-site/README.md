# @platform/personal-site

`josephkan.ca` — the Next.js static export on S3 + CloudFront, plus the scheduled Lambda that
replaces its two API routes (Phase 0 action plan §7 Stage F).

This package contains **infrastructure only**. The site source still lives at
`github.com/JosephKan3/personal-website` and moves in via `git subtree` later:

```powershell
git subtree add --prefix=applications/personal-site/site `
  https://github.com/JosephKan3/personal-website.git main
```

Until then the stack deploys from a sibling checkout (see [Building and deploying](#building-and-deploying)).

---

## The OANDA restructure

**Today:** browser → `/api/oandaReturn` → OANDA, server-side, on every page load.

**Here:** EventBridge Scheduler (hourly) → Lambda → OANDA → two JSON files in S3. The page
fetches static files.

```
                                   hourly
  EventBridge Scheduler ──────────────────────► oanda-fetcher (Lambda, ARM64, Node 20)
                                                  │  reads SSM SecureString
                                                  │  GET api-fxtrade.oanda.com
                                                  ▼
  browser ──► CloudFront ──OAC──► S3 ◄────── data/oanda-returns.json
                                             data/oanda-trades.json
```

Why this is strictly better than two request-path Lambdas:

- **Zero request-path compute.** The site is genuinely static. Nothing runs when someone
  loads the page.
- **Caches perfectly at the edge.** A per-request Lambda behind CloudFront would be
  effectively uncacheable; a JSON file with a 300s TTL is not.
- **The OANDA token lives in a process that is never internet-reachable.** The fetcher has no
  URL, no API Gateway, and no CloudFront behaviour pointing at it. The only thing that can
  invoke it is the schedule.
- **An OANDA outage or rate limit cannot affect page loads.** The worst case is that the
  charts show yesterday's numbers.
- **The data is trading history.** It does not need to be real-time, and pretending otherwise
  was the only thing forcing compute into the request path.

### Same bucket, therefore no CORS

The JSON is written into `s3://<site-bucket>/data/`, the **same bucket the site is served
from**. That makes the browser's fetch same-origin, which means there is no CORS
configuration anywhere in this stack: no bucket CORS rule, no `Access-Control-Allow-Origin`
response header, no `OPTIONS` behaviour, and no preflight round trip on every page load. A
separate data bucket would have needed all four, and each one is a way to break the charts
silently.

The cost of the choice is that the bucket has two writers, which is why the Lambda's
`s3:PutObject` is scoped to `arn:.../data/*` rather than to the bucket. A compromised fetcher
cannot rewrite `index.html`. That scope is asserted in `test/site-stack.test.ts`, and it is
the single most valuable test in this package.

### Failure behaviour

On any OANDA failure the handler logs a structured `ERROR` and throws — **without writing
anything**. Both datasets are fetched and transformed in full before the first `PutObject`,
so a failure on the second request cannot leave one fresh file next to one stale one. Stale
data is fine here; a mismatched pair is not.

Throwing (rather than exiting quietly) is deliberate: it moves the Lambda `Errors` metric,
which is what an alarm would watch. Scheduler retries twice, then gives up.

All logging is structured JSON on `stdout` — no `console.log` of raw strings. This is the
first service on the platform and its logs need to be queryable in Logs Insights.

---

## Changes the site repo needs

### 1. The client change — two lines

```diff
-        const response = await fetch("/api/oandaReturn");
+        const response = await fetch("/data/oanda-returns.json");
```

```diff
-        const response = await fetch("/api/oandaTrades");
+        const response = await fetch("/data/oanda-trades.json");
```

Both are in `pages/index.tsx`. The response shapes are unchanged — `ReturnPoint[]` and
`Record<string, number>` — so `LineChart` and `PieChart` need no edits at all.

### 2. Cleanups before migration

| Change | Why |
| --- | --- |
| Delete **either** `next.config.js` **or** `next.config.mjs` | Both exist. Next uses one and silently ignores the other. Keep `next.config.js` — it is the one carrying the real config (`sassOptions.includePaths`, `optimizeFonts`); `next.config.mjs` only sets `reactStrictMode`, which the other already sets. |
| Remove `"add": "^2.0.6"` from `package.json` | A stray `npm install add`. It is not imported anywhere. |
| Delete the ~35 lines of commented-out code at the top of `pages/api/oandaReturn.ts` | An earlier implementation that fetched `/v3/accounts/{id}` and derived a single return figure. Superseded, and it is the first thing anyone reading that file trips over. |
| Delete **both** API routes once the Lambda is live | `pages/api/oandaReturn.ts` and `pages/api/oandaTrades.ts`. `next export` refuses to run while `pages/api/` exists. Do this *after* verifying the CloudFront domain serves the charts (Stage F4), not before. |
| `axios` and `utils/request.ts` become unused | Both API routes were their only consumers. The Lambda uses native `fetch`. |

### 3. Next.js 12 is past EOL

Next 12.1.6 stopped receiving security updates long ago and the upgrade to 14/15 is worth
doing. It **must not block Phase 0**. The site has no `getServerSideProps` anywhere, so it is
fully static-exportable as-is, and shipping the deployment pipeline is the Phase 0 exit
criterion — not modernising the app. Schedule the upgrade for after the apex cutover has been
stable for a week.

Note when the upgrade happens: Next 13+ replaces `next export` with `output: "export"` in
`next.config.js`, and `next/image` needs `images.unoptimized: true` for a static export.

---

## Building and deploying

### Static export

Next 12:

```powershell
npm run build      # in the site repo
npx next export    # writes ./out
```

Next 13+: set `output: "export"` in `next.config.js`; `next build` writes `out/` directly.

### Deploy

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
npx cdk deploy PersonalSiteStack --profile platform
```

By default the stack reads the export from `../../../personal-page/out` relative to this
package — a sibling checkout of the site repo. Override it:

```powershell
npx cdk deploy PersonalSiteStack -c siteSourcePath=C:\path\to\out --profile platform
```

If the directory does not exist, synth fails with a message naming the path and the three
ways to fix it, rather than a CDK stack trace from deep inside `Source.asset`.

### Synth without the site checked out

CI validates this stack — synth, cdk-nag, `cdk diff`, unit tests — in a checkout that has
never built the Next.js app. `-c sitePlaceholder=true` renders the whole stack with a
generated inline `index.html` in place of the export:

```powershell
npx cdk synth -c sitePlaceholder=true
```

This is what `pnpm synth` runs. It is opt-in and never the default, because deploying with it
would publish a placeholder page to a live domain.

The alternative — skipping `BucketDeployment` entirely when the directory is missing — was
rejected: CI would then be validating a template structurally different from the deployed
one, which is most of the value of validating it.

### CloudFront invalidation

`BucketDeployment` invalidates `/*` on every deploy. Invalidation is free up to 1,000 paths
per month, far more than this site will use. Enumerating paths instead would risk serving a
new `index.html` against stale hashed chunks.

---

## Seeding the OANDA secrets

Two SSM **SecureString** parameters, seeded once, by hand, out of band. They are not in CDK
because a secret value in a CloudFormation template is a secret in every deploy log.

```powershell
aws ssm put-parameter `
  --name "/personal-site/oanda/account-id" `
  --type SecureString `
  --value "<OANDA account id, e.g. 001-002-1234567-890>" `
  --description "OANDA v3 account ID for josephkan.ca" `
  --profile platform

aws ssm put-parameter `
  --name "/personal-site/oanda/access-token" `
  --type SecureString `
  --value "<OANDA personal access token>" `
  --description "OANDA v3 API token. Read-only use." `
  --profile platform
```

Add `--overwrite` when rotating.

**SSM SecureString, not Secrets Manager.** Nothing here rotates, so Secrets Manager's
$0.40/secret/month buys nothing. SecureString with the AWS-managed key is free and gets the
same KMS encryption and the same IAM-scoped decrypt.

The Lambda reads both at cold start via one `GetParameters` call and caches them in module
scope. Its IAM policy names the **two parameter ARNs specifically** — not
`parameter/personal-site/*`, which would grant every future secret this application acquires.
Also asserted in the tests.

Verify after seeding:

```powershell
aws lambda invoke --function-name <fetcher name> --profile platform out.json
aws s3 ls s3://<bucket>/data/ --profile platform
```

---

## Stack contents

| Resource | Notes |
| --- | --- |
| S3 bucket | Private, `BLOCK_ALL`, SSE-S3, `enforceSSL`, versioned. Removal policy from the env profile (`RETAIN` in prod). |
| CloudFront distribution | **Origin Access Control**, not the legacy OAI. Aliases `josephkan.ca` and `www.josephkan.ca`. HTTP→HTTPS, compression, HTTP/2 + HTTP/3. |
| Certificate | Read from SSM at `/platform/acm/josephkan.ca/certificate-arn`, published by `infrastructure/dns`. Per ADR-0004 this crosses the seam via SSM, never a CloudFormation export. |
| Cache behaviours | Default `CACHING_OPTIMIZED` for hashed assets; `/data/*` on a dedicated policy with a **300s** TTL matching the write cadence. |
| Response headers policy | HSTS, `X-Content-Type-Options`, `Referrer-Policy`, CSP, `X-Frame-Options: DENY`. |
| `oanda-fetcher` Lambda | Node 20, **ARM64** (~20% cheaper per GB-s, no native deps to worry about), 512 MB, 60s timeout. Bundled with esbuild; the AWS SDK is externalised because the runtime ships it. |
| Log group | Explicit `RetentionDays` from the env profile. Declared as a real `LogGroup` rather than the deprecated `logRetention` prop, so `LogRetentionAspect` can actually see it. |
| Schedule | `aws-scheduler` L2, `rate(1 hour)`. |
| `BucketDeployment` | `prune: false` — pruning would delete `data/*` on every site deploy and blank the charts until the next scheduled run. |

### Error responses: `/404.html`, not `/index.html`

Both 403 and 404 map to `/404.html` with an HTTP 404 status.

This is a Next.js **static export**, not a single-page app. Every route is a real prerendered
HTML file and Next emits a real `404.html`. The SPA pattern of rewriting 404s to
`/index.html` with a 200 would serve the homepage for every mistyped URL and tell search
engines it was a valid page.

403 is included because S3 returns `AccessDenied` rather than `NoSuchKey` for a missing
object when the caller lacks `s3:ListBucket` — which is exactly the case here, since OAC
grants only `s3:GetObject`. Without the 403 mapping, a typo'd URL returns a raw S3 XML error.

### EventBridge Scheduler, not `events.Rule`

The `aws-cdk-lib/aws-scheduler` L2 is stable in the CDK version this repo pins (2.263), so it
is used directly. Scheduler is the right service rather than merely the newer one:

- retry and dead-letter configuration is per schedule, not per target;
- it is the same primitive NewNotams needs in Phase 1, and `applications.md` calls it out as a
  first-class platform construct — building the second consumer on `events.Rule` would mean
  two scheduling stories on one platform;
- free at this volume.

### The Content-Security-Policy

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';
base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests
```

The site earns a tight policy. After the restructure it makes exactly one kind of network
call — same-origin `fetch` of `/data/*.json` — and loads no third-party script, font, or
analytics. Chart.js arrives through the Next bundle, not a CDN, so `script-src 'self'` with
**no `unsafe-inline` and no `unsafe-eval`** holds.

`style-src` is the one concession. Next.js injects inline `<style>` for its CSS runtime and
`next/image` emits inline `style` attributes, so `'unsafe-inline'` is required there.
Removing it needs a per-request nonce, which needs request-path compute — precisely what this
design removed. Inline *style* is a far weaker vector than inline script, and the trade is
worth stating rather than hiding.

`img-src` allows `data:` for the blur placeholders `next/image` emits. `connect-src 'self'`
is what makes the CORS-free design enforceable rather than merely conventional: if a future
change reintroduces a third-party API call from the browser, the browser blocks it.

Revisit this if analytics, a font CDN, or an embedded widget is ever added. It will break
loudly, which is the intent.

---

## Verification

From the repo root:

```powershell
pnpm install
pnpm --filter @platform/personal-site build
pnpm --filter @platform/personal-site test
$env:PLATFORM_ACCOUNT_ID = "222222222222"   # any 12-digit value for synth
pnpm --filter @platform/personal-site synth
```

Account IDs come from environment variables (`packages/config/src/accounts.ts`), so no real
account ID is committed. Tests set them at the top of the file.

### After deploying, before touching DNS (Stage F4)

Confirm the site works fully on the CloudFront domain — **including the charts** — before the
apex cutover:

```powershell
curl.exe -I https://dxxxx.cloudfront.net
curl.exe https://dxxxx.cloudfront.net/data/oanda-returns.json
curl.exe https://dxxxx.cloudfront.net/data/oanda-trades.json
```

Then perform the cutover from `infrastructure/dns`, passing the distribution domain from this
stack's `DistributionDomainName` output:

```powershell
npx cdk deploy DnsStack -c origin=cloudfront -c cloudFrontDomainName=dxxxx.cloudfront.net
```

---

## For a reviewer checking the OANDA port

`lambda/oanda-fetcher/oanda-client.ts` is a port of `pages/api/oandaReturn.ts` and
`pages/api/oandaTrades.ts`. Things worth checking against the originals:

- **The returns series sums rather than compounds.** Each trade's return is
  `pl / (balance - pl) * 100` and those are added together. That is what the original did and
  what the site's headline "Total Return" figure means today. A compounded series would be
  more conventional and would silently change the number on a live page. There is a test
  asserting the summed result specifically.
- **`SERIES_START`** is the hardcoded `2022-03-09T17:24:47.605318441Z` from the original,
  kept so the chart starts at 0% rather than at the first trade's result. The original comment
  read "dont want to fetch from API".
- **The skip conditions are identical**: a fill is counted only if `pl` is present and
  non-zero, and `accountBalance` and `time` are both present.
- **`type` differs between the two calls** — `ORDER_FILL` for returns, `ORDER` for the
  instrument counts — and both use `id=0`, i.e. the entire account history. Getting these
  backwards produces plausible-looking but wrong charts.
- **One deliberate deviation:** an instrument missing from `OANDA_CODES` used to fall through
  as the literal string `"undefined"`, collapsing every unknown instrument into a single pie
  slice labelled `undefined`. Here it falls back to the raw OANDA code. This changes rendered
  output if any traded instrument is absent from the map — worth an eyeball on the first live
  run.
- **`OANDA_CODES` is copied from `types/oandaCodes.ts`**, with one fix: the original's last
  entry was `EUR_AUD: "EUR/AUD,"` with a trailing comma inside the string. Corrected here.
- **Retry behaviour is narrower than the original.** `utils/request.ts` retried on 429 and on
  timeouts with `Retry-After` handling; this retries on 429 and 5xx with linear backoff, three
  attempts, and does not retry 4xx. A 401 from a bad token will not fix itself, and the
  schedule runs again in an hour regardless.
- **`totalReturn` is not written to S3.** The page derives it from the last point of the
  returns array, exactly as it does today. The function exists so the value can be logged.
