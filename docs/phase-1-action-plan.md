# Phase 1 — Action Plan

Executable sequence for NewNotams on AWS. Ordered by dependency, not importance. Written the
same way `phase-0-action-plan.md` was: against the real code and the real current state, not
the roadmap's summary of it.

**Goal:** NewNotams serves production traffic on AWS with a real SLO and burn-rate alerts.
Vercel is off for the product. No NAT Gateway exists. One clean billing cycle under budget.

**Budget: $8-15/mo** (`applications.md`'s revision down from the roadmap's stale $20-35 —
RDS is deferred; neither app needs it. `docs/cost/cost-model.md`'s phase table has not been
corrected to match yet; trust `applications.md`).

**Definition of done:** see [§8 Exit criteria](#8-exit-criteria).

**Prerequisite:** Phase 0 is done. Verify before starting:

```powershell
aws sts get-caller-identity --profile platform
# Confirm GovernanceStack, BootstrapStack, DnsStack, PersonalSiteStack all deployed.
```

---

## 0. What reconnaissance against the real repo changed

Phase 0's plan was corrected repeatedly by what the code actually said rather than what the
roadmap assumed. Same discipline here, done up front instead of mid-execution:

- **`applications.md` listed two API routes it didn't fully enumerate.** The real repo
  (`JosephKan3/NewNotams.Net` — renamed from `v0-notam-search-app` 2026-10-05, mid-Phase-1,
  cloned to a sibling checkout the same way
  `personal-page` was in Phase 0) has **seven** routes: `auth/[...nextauth]`, `dismissals`,
  `notify`, `push/subscribe`, `saved-searches`, `schedule`, `weather`. All API-route behavior
  carries over unchanged under OpenNext — this is a lift, not a rewrite — but the inventory
  matters for the SSM secret list below.
- **`/api/notify` has two handlers, not one.** `GET` is the cron path (all schedules,
  `CRON_SECRET` bearer check) — this is what moves to a direct EventBridge → Lambda
  invocation with no public endpoint. `POST` is a user-triggered one-off test send,
  session-authenticated via `auth()` — **this one stays reachable from the browser.** Do not
  remove public access to `/api/notify` entirely; only the cron trigger changes shape.
- **The real Vercel project has exactly 9 secrets**, confirmed via `vercel env ls`, not
  guessed from the code: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `AUTH_SECRET`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
  `CRON_SECRET`. `auth.ts` conditionally wires nine more OAuth providers
  (GitHub, Apple, Discord, Facebook, Twitter, Azure AD, LinkedIn, Twitch, Spotify), but none
  of their env vars exist in the real Vercel project — they are inert dead code, not
  configured providers. Only Google OAuth is live. Migrate the 9 real secrets; do not invent
  credentials for providers nobody configured.
- **`newnotams.net` is not at GoDaddy.** WHOIS confirms registrar **NameCheap**
  (registered 2026-06-04, `clientTransferProhibited` already set), with nameservers
  currently `ns1/ns2.vercel-dns.com` — the domain was pointed at Vercel's own DNS, not a
  registrar-default resolver. ADR-0006's replicate → verify → delegate → cutover sequence
  for `josephkan.ca` still applies unchanged; the only difference is *which* nameservers get
  replaced at the registrar (NameCheap, not GoDaddy) and *which* nameservers are being
  replicated away from (Vercel's, not GoDaddy's own). The real records, read directly against
  `ns1.vercel-dns.com`:
  ```
  newnotams.net       A     64.29.17.1, 64.29.17.65      (dual-IP, Vercel's newer anycast — not the single 76.76.21.21 the personal site used)
  www.newnotams.net   A     64.29.17.1, 216.198.79.65    (A, not CNAME — different from the personal site's www pattern)
  ```
  No TXT, no MX — confirmed via direct query, matching `applications.md`'s claim that
  nothing is at risk during migration. **Do not reuse `vercelRecords` from
  `packages/config/src/domains.ts`** — those are `josephkan.ca`'s values. Add a parallel
  constant for `newnotams.net` with the values above.
- **`@opennextjs/aws` has a real version floor to clear.** The app pins `"next": "16.1.6"`.
  `@opennextjs/aws` v4.1.6 (2026-09-28) bumped its *minimum* supported Next.js to `16.3.6` —
  below that floor is untested, not just unsupported-in-theory. Either bump the app's Next.js
  to `>=16.3.6` first (check the Next.js 16 changelog between `16.1.6` and `16.3.6` for
  breaking changes — likely none, same major), or pin `@opennextjs/aws` to `4.1.5`
  (tested against `16.1.6`-era Next) and revisit the bump later. Decide before scaffolding;
  do not find this out mid-deploy the way Phase 0 found the Next-12-image-loader bug.
- **No OpenNext/Lambda-web-app construct exists yet in `packages/constructs`.** `StaticSite`
  (Phase 0) is for pure static exports behind S3+CloudFront; NewNotams needs Lambda compute.
  This is genuinely new platform work, not reuse — budget real time for it, and make it a
  reusable construct (`packages/constructs/src/opennext-site/`) since the roadmap's own
  Phase 3 flagship item ("Next.js on Lambda via OpenNext + CloudFront" paved-road template) is
  this exact shape, validated by one real consumer now instead of being speculative later.
- **`ScheduledJob` (Phase 0, built for the OANDA fetcher) is directly reusable** for the
  hourly notify cron with no changes — confirmed by reading its construct contract
  (`packages/constructs/src/scheduled-job/scheduled-job.ts`): it owns the function, log
  group, role, and schedule, and grants nothing beyond self-logging, so NewNotams's
  Lambda-invoke permission is added by the caller exactly the way the OANDA fetcher's S3
  write permission was.
- **The app repo stays a separate repo**, same pattern as `personal-website`. NewNotams's
  CDK stacks live in this monorepo at `applications/newnotams/`; the actual Next.js source
  stays at `github.com/JosephKan3/NewNotams.Net`, checked out at deploy time — not
  merged into the monorepo. ADR-0004 describes `applications/newnotams/{infra,src}/` as if
  `src/` lives here; in practice, following the `personal-site` precedent, `infra/` here and
  a cross-repo checkout in CI is the actual working pattern. Update ADR-0004 if this is
  adopted, rather than silently diverging from what it says.

---

## 1. Stage A — Decide the two things that are hard to change later

**Done 2026-10-05.** The version decision: bumped `next` `16.1.6` → `16.3.8`, confirmed with a
real `next build` (clean compile, clean typecheck) and a real `npx open-next build`
(`@opennextjs/aws@4.1.7`, full expected output bundle — server function, assets,
revalidation/warmer/image-optimization functions, middleware). Moved up from Stage F while
already touching this: removed `typescript.ignoreBuildErrors`, which was hiding two real
(trivial, dead-code) type errors in `auth.ts` — `AzureAD` is now `MicrosoftEntraID` with a
different config shape, and a stale `@ts-expect-error` on `trustHost`. Also bumped
`next-auth` `5.0.0-beta.31` → `5.0.0-beta.32`: the pinned version was in `@auth/core`'s
vulnerable range for three CVEs, including a critical one (OAuth state/nonce/PKCE check
cookies not bound to the originating provider). `npm audit` went from 5 vulnerabilities
(2 critical) to 3 (0 critical) — the rest are in `lodash` (via `recharts`, display-only) and
`browserslist` (build-time only via `autoprefixer`), left for a separate decision since
fixing them means a `recharts` major bump. Full detail in the commit message,
`JosephKan3/NewNotams.Net@bf07da6`. **The repo was also renamed** mid-work, from
`v0-notam-search-app` to `NewNotams.Net` — not something this plan did; GitHub's own
redirect caught it on push. Every reference in this plan, `applications.md`, and the
roadmap has been updated to the new name.

> **OpenNext's own build has a known Windows-only bug** (confirmed, not assumed — hit it
> directly): the image-optimization function's dependency-install step constructs an invalid
> temp-directory path on Windows (`mkdtemp` given a path with a literal drive-letter colon in
> the middle) and fails. OpenNext's own docs already say it is "not fully compatible with
> Windows" and recommend WSL. Not a blocker for this plan — the real build runs in CI on
> Linux (§1's own build-location decision below) — but if anyone tries `npx open-next build`
> locally on Windows to sanity-check something, expect this exact failure after
> "OpenNext build complete" prints; it is cosmetic at that point, not a sign the build itself
> failed.

| Decision | Recommendation | Why it's hard to change |
| --- | --- | --- |
| **Bump Next.js to clear the OpenNext version floor, or pin OpenNext down?** | **Decided: bumped Next.js.** See above. | Pinning OpenNext to an older version now means revisiting this the moment a real `@opennextjs/aws` bug fix is needed |
| **Keep `CRON_SECRET` bearer check on the GET path, or drop it for a non-public invoke?** | **Drop the public GET path entirely.** EventBridge invokes the Lambda directly; nothing calls the HTTP route for cron anymore. `CRON_SECRET` becomes unused. | If kept "just in case," it is a public endpoint only pretending not to be one |
| **Where does the OpenNext build happen — in this monorepo's CI, or vendored output checked into the app repo?** | **Build in CI**, same pattern as `personal-website`'s static export: checkout → `npm install` → `npx open-next build` → deploy the `.open-next/` output. Nothing built gets committed. | Committing build output couples the two repos' histories in a way that defeats keeping them separate |

---

## 2. Stage B — The OpenNext construct

**Done 2026-10-05.** `packages/constructs/src/opennext-site/` — `OpenNextSite`, modeled on the
official OpenNext reference CDK implementation
(opennext.js.org/aws/reference-implementation), adapted to this platform's conventions the
way `StaticSite` was for a plain static export.

Confirmed empirically, not assumed, on the two load-bearing design questions this section
originally posed:

- **The image-optimizer Lambda is genuinely dead weight for this app.** Next's own source
  (`get-img-props.ts`) confirms `images.unoptimized: true` means `next/image` never generates
  a `/_next/image?...` request at all — and even a direct hit on that route 404s before the
  server ever calls the optimizer. Grep across `app/` and `lib/` found zero
  `revalidateTag`/`revalidatePath`/`export const revalidate` usage, confirming the DynamoDB
  tag cache and SQS revalidation queue are equally dead weight. `includeImageOptimization`,
  `includeTagCache`, `includeRevalidation` all default to `false` for exactly this reason —
  NewNotams needs none of them, and provisioning them anyway would be real, billed AWS
  resources for nothing.
- **`open-next.config.ts`'s `dangerous.disableTagCache: true`** removes the DynamoDB init
  function from the manifest's `additionalProps`, confirmed by rebuilding and diffing the
  manifest before/after. A synth-time assertion in the construct
  (`assertTagCacheAgreement`) checks this against `includeTagCache` and throws if they
  disagree, so a mismatch between the app's build and the construct's props fails at synth,
  not as a runtime `ResourceNotFoundException` days later.

One real gotcha found and fixed: `open-next.output.json`'s `bundle`/`copy.from` paths are
written relative to the app's project root (confirmed against a real build —
`.open-next/server-functions/default`, not `server-functions/default`, even though the
manifest lives inside `.open-next/`), not relative to the output directory itself. The
construct resolves them against `openNextOutputPath`'s parent so synth is correct regardless
of the CDK process's own working directory.

Verified two ways: 16 unit tests (security posture, opt-in pieces defaulting off and
provisioning correctly when requested, zero unsuppressed cdk-nag errors with every optional
piece both off and on), and a direct synth against NewNotams' real `npx open-next build`
output — correct resource counts (2 Lambda functions: server + the BucketDeployment handler;
no DynamoDB/SQS) and correct CloudFront behaviors (`_next/image*` correctly absent).

New platform work. Built before touching NewNotams' own stack, the same order Phase 0 built
`StaticSite` before `PersonalSiteStack` consumed it.

### B1. What the construct owns

Modeled on `StaticSite`'s discipline (owns the generic shape, the caller wires
application-specific grants):

- **Server Lambda** (the OpenNext `server-function`) — ARM, no VPC attachment (ADR-0002
  strategy 1: NewNotams talks to Upstash over HTTPS and Nav Canada/Google over HTTPS, nothing
  needs a private IP).
- **Image optimization Lambda**, if OpenNext's build emits one — check whether
  `images.unoptimized: true` (already set in `next.config.mjs`) suppresses this. If it does,
  the construct doesn't need to provision it at all; confirm by inspecting `open-next build`'s
  output before assuming.
- **CloudFront distribution** with cache behaviors matching OpenNext's recommended
  split (static assets long-TTL, server function behavior no-cache-by-default,
  `/api/*` passthrough).
- **S3 bucket** for static assets (`.open-next/assets`), OAC, same posture as `StaticSite`'s
  bucket (block all public access, SSE, `abacStatus: true` — see
  `docs/open-issues.md` issue 9 for why that flag is load-bearing for any bucket the dev
  permissions boundary needs to actually protect).
- **Log retention and tagging** via the existing Aspects — no new work, they apply at the
  `App` root already.

### B2. What it does not own

Same rule as `StaticSite`: no grant beyond self-logging. NewNotams' stack adds:

- Upstash credentials (SSM read) — construct doesn't know Upstash exists.
- Google OAuth secret (SSM read).
- VAPID keys (SSM read).
- The EventBridge → Lambda invoke permission for the notify cron, via `ScheduledJob`
  separately — the server Lambda and the cron Lambda are not the same function. OpenNext's
  server function handles HTTP requests; the notify sweep is better as its own small
  `ScheduledJob` Lambda that imports the same `lib/push.ts`/`lib/kv.ts` logic, not a
  warm-path invocation of the big Next.js server bundle for a job with no HTTP request behind
  it. Confirm this split is actually how OpenNext structures cron-style background work
  before committing to it — check the OpenNext docs for a documented pattern first
  (`@opennextjs/aws` has discussion of this exact shape for "warmer" functions and background
  work; read it before reinventing).

### B3. Unit test

Same requirement as every other Aspect/construct on this platform: a test asserting the
construct actually produces the resources it claims (CloudFront distribution, S3 bucket with
`abacStatus: true`, Lambda with no VPC config), modeled on
`packages/constructs/test/static-site.test.ts`.

---

## 3. Stage C — NewNotams' own stack

**Done 2026-10-08.** `applications/newnotams/` in this monorepo. CDK only — the app source
stays in `NewNotams.Net`, checked out at deploy time (§0, last bullet).

### C1. Seed the SSM parameters — done

All 8 parameters live (the 9th, `CRON_SECRET`, was never migrated — see below). Two of the
9 real secrets from `vercel env ls` turned out not to be retrievable at all: `vercel env pull`
returned empty strings for `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/the three `VAPID_*` values
across every environment (dev, preview, production) — Vercel's "Sensitive" flag blocks a
value from ever being read back via API/CLI after creation, by design, even for the project
owner. Resolved by regenerating both: a fresh VAPID keypair (`npx web-push
generate-vapid-keys`, free, instant) and a second Google OAuth client secret on the *same*
existing Google OAuth client (Google supports multiple simultaneously-valid secrets per
client — the live Vercel deployment's existing secret kept working throughout, no
production impact). `AUTH_SECRET` and the two `KV_REST_API_*` values pulled cleanly from the
`development` scope and were reused as-is.

The 9 real secrets, as `SecureString`:

```powershell
aws ssm put-parameter --name "/newnotams/auth/google-id" --type SecureString --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/auth/google-secret" --type SecureString --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/auth/secret" --type SecureString --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/push/vapid-public-key" --type String --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/push/vapid-private-key" --type SecureString --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/push/vapid-subject" --type String --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/kv/url" --type SecureString --value "<...>" --profile platform
aws ssm put-parameter --name "/newnotams/kv/token" --type SecureString --value "<...>" --profile platform
```

`NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are plain `String`, not `SecureString` —
the public VAPID key is, by design, public (it ships to the browser), and the subject is a
`mailto:` address, not a secret. `CRON_SECRET` is **not migrated** — it becomes unused once
the GET cron path is removed (§1).

Run these commands yourself, exactly as Phase 0's `QUICKSTART.md` step 11 did — values never
touch chat, verified afterward only by `aws ssm get-parameter --query Parameter.{Type,Version}`
(never decrypting).

### C2. The stack — done

`NewNotamsStack` wires `OpenNextSite` for the app and `ScheduledJob` for the notify sweep,
closely matching the sketch this section originally had, with one structural difference the
sketch didn't anticipate: **the notify Lambda's handler lives in the app repo
(`lambda/notify/index.ts`), not inlined here**, and imports `lib/notify.ts`/`lib/push.ts` via
relative paths rather than the app's own `@/` tsconfig alias — esbuild (what
`NodejsFunction`/`ScheduledJob` bundles with) does not resolve tsconfig path aliases, and
growing `ScheduledJob` a tsconfig-passthrough option for one caller was rejected in favor of
just not needing one.

The notification-building logic extraction this section called for is done: `lib/notify.ts`
(new, in the app repo) now holds `buildNotification`, `extractNotamSummary`,
`getSchedulesDueAt`, `ScheduleConfig` — moved verbatim out of
`app/api/notify/route.ts`/`app/api/schedule/route.ts`. The old `GET /api/notify` cron path
(bearer-token-checked against `CRON_SECRET`) is deleted entirely; `POST` (the user-triggered
"send test notification now" button) is unchanged and still public.

Two real gaps surfaced here and were fixed in `ScheduledJob` itself, not worked around locally
— this was the first `ScheduledJob` consumer whose entry lives in a different repo than this
monorepo, and `NodejsFunction` has two separate checks that assume otherwise:

- `entry` must live under `projectRoot`, which defaults to this monorepo's own lockfile
  directory (`PathNotUnderRoot` otherwise). Added `ScheduledJobProps.projectRoot`.
- `depsLockFilePath` must *also* live under `projectRoot` — same failure, one layer deeper,
  since the app repo's lockfile is its own `package-lock.json` (npm), not this monorepo's
  `pnpm-lock.yaml`. Added `ScheduledJobProps.depsLockFilePath`.

Both are optional, defaulting to `undefined` (unchanged behavior for the one other
`ScheduledJob` consumer, `personal-site`'s `oanda-fetcher` — confirmed by re-running its full
test suite, 59 tests, after the change, not assumed from the props being optional).

`ScheduledJob.entry` has no placeholder-source concept of its own the way `OpenNextSite` does
— it always tries to resolve a real file. `NewNotamsStack` supplies the equivalent at the call
site: a trivial `lib/placeholder-notify-handler.ts` inside this monorepo, used only when
`usePlaceholderSource` is true, so CI synth never needs the app repo checked out at all.

Verified three ways: 14 unit tests (least-privilege SSM scoping — the server function and the
notify job get non-overlapping grants, since the notify sweep never touches Auth.js's
secrets — plus zero unsuppressed cdk-nag findings), a synth with no app checkout at all (CI's
real condition), and a synth against `NewNotams.Net`'s actual `npx open-next build` output and
real `lambda/notify/index.ts` — clean, no path errors, no credentials warnings.

### C3. ACM certificate and DNS

Same shape as `DnsStack`, parameterized by `domains.product` instead of `domains.platform`.
Either extend the existing `infrastructure/dns` stack to also manage `newnotams.net`'s zone,
or give it its own stack — decide based on whether the two domains' records are ever edited
together in practice. Given they're operationally independent (ADR-0006: "separate identity so
it can be spun out cleanly"), a second, parallel stack
(`infrastructure/dns/lib/newnotams-dns-stack.ts`) is more consistent with that stated goal than
folding it into the existing one.

Not yet started — this is Stage D below.

---

## 4. Stage D — DNS migration, `newnotams.net`

Same sequence as ADR-0006 and Phase 0's step 8, substituting NameCheap for GoDaddy and
Vercel's nameservers for GoDaddy's:

1. **D1 — Replicate.** Create the Route53 public hosted zone for `newnotams.net`. Populate it
   with the *current* Vercel records, read in §0: apex `A` → `64.29.17.1`, `64.29.17.65`;
   `www` `A` → `64.29.17.1`, `216.198.79.65`. Deploy with the equivalent of
   `-c origin=vercel` (DNS stack targeting the existing hosting, not yet CloudFront).
2. **D2 — Verify against Route53 directly.** `Resolve-DnsName newnotams.net -Server
   <ns-xxx.awsdns-xx.*>` before touching anything at NameCheap.
3. **D3 — Switch nameservers at NameCheap** from `ns1/ns2.vercel-dns.com` to the four Route53
   nameservers. Confirm **auto-renew** is on and **transfer lock** stays on (WHOIS already
   shows `clientTransferProhibited` — verify this is NameCheap's own lock, not something that
   needs re-enabling after a nameserver change) while in the NameCheap dashboard, same as
   Phase 0's GoDaddy check. This step is a no-op for the live site — zone contents are
   identical on both sides — but confirm propagation before proceeding regardless
   (`.net` is a gTLD; propagation is typically faster than `.ca`'s 24-48h, but verify rather
   than assume).
4. **D4 — Wait, verify everywhere.**
5. **D5 — Cut over.** Once `OpenNextSite`'s CloudFront distribution is deployed and verified
   independently (its own `dxxxx.cloudfront.net` URL, before any DNS points at it — same
   discipline as Phase 0 step 12's CloudFront-first verification), replace both A records with
   ALIASes to the distribution. **Expect the same CNAME/A coexistence failure Phase 0 hit at
   this exact step** (`docs/open-issues.md`-adjacent: see `infrastructure/dns/README.md`'s
   "Known failure mode" note, added after Phase 0's real incident). Both of `newnotams.net`'s
   records are already type `A` here (not a CNAME like the personal site's `www` was), so this
   specific failure mode may not even apply — **A replaced by A/ALIAS has no such conflict,
   only a CNAME-to-A/ALIAS transition does.** Confirm this reasoning against the actual `cdk
   diff` output before deploying; don't assume safety, verify it the way Phase 0's apex cutover
   should have been verified the first time.

---

## 5. Stage E — Observability, the actual point of this phase

The roadmap is explicit that this is the workload that makes observability matter — a
silently-failing weather brief is a real incident. Minimum viable version:

- **OTel instrumentation** in the OpenNext server function and the notify Lambda. Check
  `@opennextjs/aws`'s documented OTel support before hand-rolling instrumentation — this is
  exactly the kind of thing likely already solved upstream.
- **CloudWatch metrics**: Lambda error rate, duration, concurrent executions on both
  functions; EventBridge Scheduler's own invocation-success metric for the notify job
  specifically (this is the signal that answers "did the hourly sweep actually run," distinct
  from "did it run without throwing").
- **One alarm that matters more than the rest**: notify job's EventBridge Scheduler
  target-invocation failures, or a CloudWatch Logs metric filter on the Lambda's own
  `"ok": false` / error-count counters. A missed hourly run with no alert is exactly the
  silent-failure scenario the roadmap calls out by name.
- **Grafana Cloud free tier** as the dashboard/alert backend, per the roadmap. Defer the full
  SLO/burn-rate-alert machinery until the basic "did it run, did it error" alarm exists and has
  been observed working for at least one real incident or near-miss — building burn-rate math
  against zero historical data is premature.

---

## 6. Stage F — Clean up what Phase 0's reconnaissance already flagged

From `applications.md`'s own notes, cheap to do while already touching this code:

- Remove `typescript.ignoreBuildErrors: true` from `next.config.mjs`. Fix whatever it was
  hiding — do this **before** the OpenNext migration, not after, so any real type error
  surfaces against the known-working Vercel deploy rather than a new, less-familiar Lambda
  deploy path.
- Add a CloudFront/WAF rate-based rule on `/api/weather` — it is an open, unauthenticated
  proxy to Nav Canada today, and moving it to Lambda doesn't fix that on its own.
- Leave `getSchedulesDueAt`'s N+1 alone. `applications.md` correctly defers the real fix to
  the Phase 2 DynamoDB migration, where querying by notify-hour is the natural fix. Patching
  it now against Upstash would be throwaway work.

---

## 7. Stage G — Decommission Vercel for the product

Same discipline as Phase 0's personal-site decommission: **not before 24h of clean
production operation on AWS.** Unlike the personal site, this one has a real cron job with
real users receiving push notifications — watch at least one full hourly cycle actually fire
and deliver before calling it clean, not just "the homepage returns 200."

---

## 8. Exit criteria

Phase 1 is done when **all** of these are true:

- [ ] NewNotams serves production traffic at `newnotams.net` from Lambda + CloudFront, with
      nobody touching the console for a routine deploy (same CI discipline as Phase 0's
      `deploy-dev`/`deploy-prod`, extended to this stack).
- [ ] The hourly notify job runs via direct EventBridge → Lambda invocation. `/api/notify`'s
      GET cron path and `CRON_SECRET` are gone; POST (user-triggered test send) still works
      from the browser.
- [ ] `Resolve-DnsName newnotams.net -Type NS` returns AWS nameservers.
- [ ] `https://newnotams.net` serves from CloudFront with a valid ACM cert; sign-in
      (Google OAuth + credentials), saved searches, and push notifications all work
      end-to-end against the AWS deployment.
- [ ] No VPC exists. No NAT Gateway exists. (`NoManagedEgressAspect` covers this
      automatically — no new verification needed beyond what Phase 0 already proved it does.)
- [ ] Vercel is off for the product, only after a full real hourly notify cycle has been
      observed succeeding in production on AWS.
- [ ] At least one alarm exists for "the hourly notify job did not run or errored," and it has
      been proven to fire (same "prove the alert actually fires" discipline as Phase 0's
      budget-alert exit criterion — don't take a configured-but-unverified alarm on faith).
- [ ] `typescript.ignoreBuildErrors` is removed from the app's `next.config.mjs` and the build
      is clean without it.
- [ ] `/api/weather` has a rate limit.
- [ ] One full billing cycle confirms the combined Phase 0 + Phase 1 bill stays under
      **$15/mo** (the revised `applications.md` ceiling, not the roadmap's stale $35).
- [ ] A teardown runbook exists for everything built in this phase, matching Phase 0's
      `docs/runbooks/teardown-phase-0.md` pattern.

---

## 9. Explicitly NOT in Phase 1

Carried over from the roadmap's own scope discipline, confirmed still correct against the
real code:

- **No VPC.** Confirmed by reading the actual app code (§0): nothing needs a private IP.
  The roadmap's "build the VPC now, it's free" item is **deferred**, not adopted here — it
  exists for Phase 2's Tailscale/RDS/private-zone work, none of which this phase needs.
  Building it now with nothing to attach to it yet is scope creep against this phase's own
  goal; revisit when Phase 2 actually needs it.
- **No RDS, no ElastiCache.** Confirmed by `applications.md`'s access-pattern analysis.
  Upstash stays, unchanged, until Phase 2's DynamoDB migration.
- **No Authentik, no identity migration.** Auth.js keeps owning users directly. Phase 2.
- **No DynamoDB migration.** Phase 2, deliberately decoupled from the compute migration so a
  failed deploy has one variable to debug, not two.
- **No full SLO/burn-rate alerting machinery.** Stage E builds the one alarm that matters;
  the roadmap's "multi-window burn-rate alerts" is worth doing once there's enough real
  operational history to calibrate against, not on day one.
