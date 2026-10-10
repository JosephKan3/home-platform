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
- **`newnotams.net` is not at GoDaddy, and — this is the important part — it has no fixed
  A records to replicate at all.** WHOIS confirms registrar **NameCheap**
  (registered 2026-06-04, `clientTransferProhibited` already set), with nameservers
  currently `ns1/ns2.vercel-dns.com`. That is the whole story: the domain is delegated to
  **Vercel's own nameservers**, which is a materially different setup from `josephkan.ca`'s
  (a GoDaddy-hosted zone with a plain `A` record pointing at a fixed Vercel IP). Confirmed
  directly from the Vercel dashboard (Project → Settings → Domains → `newnotams.net`):
  **"Current DNS Records" shows no A records at all** — only three `CAA` records
  (`pki.goog`, `sectigo.com`, `letsencrypt.org`). Querying the zone directly
  (`ns1.vercel-dns.com`) repeatedly returns a *rotating* 4-IP pool
  (`64.29.17.1`, `64.29.17.65`, `216.198.79.1`, `216.198.79.65`), 2 at a time, for *both*
  apex and `www` — not two fixed, distinct IP pairs. This is Vercel's anycast network
  (confirmed against Vercel's own docs, `vercel.com/kb/guide/a-record-and-caa-with-vercel`):
  "the correct value for your project is whatever your domain card shows... drawn from a
  pool of anycast IPs," and with nameserver delegation there is no fixed A record published
  at all — Vercel's edge handles routing dynamically.
  **A first attempt at D1 (replicating a 2-IP snapshot per record, captured in one read
  each) was deployed, discovered wrong via a second, more thorough read, and rolled back
  before any registrar change** — see the Phase 1 session log for 2026-10-08. The snapshot
  was not a complete or stable answer; replicating it would not have been a no-op.
  Two more things the dashboard check surfaced that also change the plan:
  - **The apex redirects to `www.newnotams.net`** — `www` is the real canonical URL today,
    not the apex. `DnsStack`/`NewNotamsStack`'s current design treats both as equally
    canonical ALIAS targets; this needs a decision (replicate the redirect via CloudFront
    behavior or a redirect function, or treat it as acceptable differences since Phase 1's
    exit criteria don't mention redirect behavior specifically).
  - **Three `CAA` records restrict certificate issuance** to `pki.goog`, `sectigo.com`,
    `letsencrypt.org`. ACM is not in that list. **`DnsStack`'s product-zone certificate
    cannot validate without an ACM-permitting CAA record in the replicated zone** — this
    would have blocked D5 even if D1's records had been correct. Add
    `0 issue "amazonaws.com"` (or whatever ACM's current documented CAA value is — verify,
    do not assume) as a CAA record in the replicated zone before attempting the certificate
    again.
  There is also a second, unrelated domain connected to the same Vercel team —
  **`new-notams.net`** (hyphenated) — visible in the dashboard's redirect/cert list. Out of
  scope for this migration; noted so it is not confused with `newnotams.net` later.
  No TXT, no MX beyond the three CAA records — confirmed via direct query.
  `newnotamsVercelRecords` (added to `packages/config/src/domains.ts` for the first D1
  attempt) has since been **deleted**, with a comment in its place recording why — the
  revised design writes no pre-cutover apex/`www` records at all, so there is nothing for
  such a constant to hold. The authoritative view of this zone turned out to be
  `vercel dns ls newnotams.net --scope <team>`, which neither the dashboard's "Current DNS
  Records" panel nor any amount of resolver querying made clear: the real records are
  `ALIAS`es to Vercel hostnames, and the rotating IPs were Vercel flattening them at query
  time. See §4 for the resolved design.
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

**Status 2026-10-08: first attempt found wrong and rolled back cleanly; design since
resolved and rewritten below. Not yet re-attempted.** The original plan (replicate fixed
records, then delegate, then cut over — `josephkan.ca`'s shape) does not fit this domain.
The revised sequence is at the end of this section.

`josephkan.ca`'s migration (Phase 0 step 8) assumed a GoDaddy-hosted zone with fixed records
to replicate. `newnotams.net` is delegated to **Vercel's own nameservers**
(`ns1/ns2.vercel-dns.com`), which is not the same shape at all: Vercel's dashboard shows no
A records for this domain (only three `CAA` records), and direct queries against the zone
return a *rotating* pool of (at least) 4 IPs for both apex and `www`, 2 at a time — Vercel's
anycast network, confirmed against Vercel's own documentation
(`vercel.com/kb/guide/a-record-and-caa-with-vercel`: "the correct value for your project is
whatever your domain card shows... drawn from a pool of anycast IPs"). There is no fixed
value to snapshot and replicate the way `josephkan.ca`'s single `76.76.21.21` was. §0 has the
full finding, including the apex-redirects-to-`www` behavior and the CAA records that would
have separately blocked ACM validation even if the record content had been right.

**What actually happened:** D1 was attempted with a 2-IP snapshot per record (one read each),
deployed to a real `createProductZone=true` stack update. A second, more thorough check (10
repeated queries, then the Vercel dashboard itself) found the snapshot incomplete and the
whole replicate-fixed-records premise wrong for this domain. The update was still
`UPDATE_IN_PROGRESS` (blocked on the certificate, which was also doomed by the CAA records)
and was cancelled via `aws cloudformation cancel-update-stack`. The rollback itself hit a
real, separate CDK/ACM gap: the certificate's own DNS-validation CNAME records are not
tracked as CloudFormation resources, so deleting the certificate did not delete them, and
Route53 refused to delete the now-non-empty hosted zone
(`HostedZoneNotEmptyException`) until those two CNAMEs were removed by hand via
`aws route53 change-resource-record-sets`. Full rollback confirmed clean:
`DnsStack` back to `UPDATE_ROLLBACK_COMPLETE`, no product zone, no stray SSM parameter,
`josephkan.ca` untouched throughout.

### What the zone actually contains (resolved 2026-10-08)

`vercel dns ls newnotams.net --scope josephkan3s-projects` — the authoritative answer, which
neither the dashboard's "Current DNS Records" view nor any amount of resolver querying made
clear:

```
CAA      0 issue "pki.goog"                      (default)
CAA      0 issue "sectigo.com"                   (default)
CAA      0 issue "letsencrypt.org"               (default)
*        ALIAS  cname.vercel-dns-017.com.        (default)
@        ALIAS  55ac134bd5db1713.vercel-dns-017.com   (default)
```

**There are no A records at all — only `ALIAS` records to Vercel hostnames.** Every IP I
observed by querying resolvers was Vercel flattening those ALIASes at query time, which is
why repeated queries returned a rotating pool and why no stable value was ever copyable.
All five records are `created: default` (Vercel-managed, no record IDs — listable but not
individually deletable).

### The design, and the ordering problem it had to solve

Two decisions, made against this real picture:

1. **No apex→www redirect on AWS.** Today's `308 newnotams.net → www.newnotams.net` is a
   Vercel dashboard feature, not application code — confirmed: the app repo has no
   `middleware.ts` and no `redirects` in `next.config.mjs`. On AWS both hostnames are
   CloudFront aliases on one distribution and both serve content directly. Accepted as a
   deliberate behavior change (minor SEO duplication, addressable later with a canonical
   tag) rather than building a CloudFront Function to replicate a redirect nothing depends
   on.
2. **The Route53 zone holds no A/ALIAS records until the cutover itself.** Verified via
   `dns.google/resolve?name=newnotams.net&type=NS`: the registry still delegates only to
   `ns1/ns2.vercel-dns.com`, so **nothing queries our Route53 zone until the NameCheap
   nameserver switch**. The zone's contents are irrelevant to live traffic right up to that
   instant. Replicating an unstable, undocumented anycast pool to cover a window in which
   the zone is never consulted buys nothing and risks pointing an authoritative zone at
   Vercel's internal infrastructure.

**The ordering problem this created, and the fix.** ACM validates by CNAME. If that CNAME
must live in our Route53 zone, the certificate cannot issue until the zone is authoritative
— i.e. until *after* the nameserver switch — which means CloudFront could not have a
verified, certificate-attached distribution *before* switching. That would force a cutover
to something unverified, with a **6-hour** rollback (the registry NS TTL is 21600s,
confirmed — not the 5-minute record-TTL rollback `josephkan.ca` enjoyed).

Resolved: **the ACM validation CNAME does not have to live in Route53.** ACM's own
documentation is explicit that it is a plain CNAME to be added at whichever provider is
currently authoritative, and `vercel dns add` can write arbitrary records to this zone while
Vercel still serves it. So the certificate validates *before* the nameserver switch, against
Vercel's zone, and CloudFront is fully verified on its own `dxxxx.cloudfront.net` URL before
any registrar change.

**The CAA records also have to be handled there, not here.** ACM is blocked by the three
existing CAA records (confirmed independently via Google DoH: `pki.goog`,
`letsencrypt.org`, `sectigo.com`, no Amazon CA). ACM accepts any of `amazon.com`,
`amazontrust.com`, `awstrust.com`, `amazonaws.com` (ACM docs, verified — not assumed). Our
certificate covers `newnotams.net` + `www.newnotams.net`, both explicit names with **no
wildcard**, so only an `issue` tag is needed, not `issuewild`.

### The revised sequence

1. **D1 — Unblock ACM at Vercel.** Add an ACM-permitting CAA record to the *Vercel* zone,
   where it takes effect immediately because Vercel is authoritative today:
   ```powershell
   npx vercel dns add newnotams.net '@' CAA '0 issue "amazon.com"' --scope josephkan3s-projects
   ```
   Verify it is live before continuing: `curl.exe -s "https://dns.google/resolve?name=newnotams.net&type=CAA"`
   must list `amazon.com` alongside the three existing entries.
2. **D2 — Create the zone and certificate.** Deploy `DnsStack` with `createProductZone=true`.
   The zone holds the ACM-permitting CAA record and nothing else — no A, no ALIAS. Add the
   certificate's validation CNAME to the **Vercel** zone (`vercel dns add ... CNAME ...`),
   using the `Name`/`Value` from the certificate's `DomainValidationOptions`. The certificate
   validates against Vercel's authoritative answer and reaches `ISSUED` while Vercel is still
   serving the site.

   > **Adding the `www` validation record to Vercel's zone takes
   > `www.newnotams.net` down. This happened — a real ~4-minute outage on
   > 2026-10-08.** Vercel serves `www` via the wildcard `* ALIAS
   > cname.vercel-dns-017.com.` record, and DNS wildcard rules say `*` does not match a
   > name that has *any* record beneath it. Creating
   > `_ab6d0885e3c4130c21bcedcd1eabb99d.www` therefore created a `www` label in the zone,
   > which shadowed the wildcard and made `www.newnotams.net` return NXDOMAIN. The apex
   > was unaffected (it has its own explicit ALIAS, not the wildcard).
   >
   > Mitigations, in order of preference:
   > - **Validate the apex only, and rely on CAA inheritance.** ACM needs one validation
   >   record per name on the certificate, so this is not possible with
   >   `newnotams.net` + `www.newnotams.net` both as SANs. (A wildcard
   >   `*.newnotams.net` SAN would share the apex's validation token, per ACM's docs —
   >   worth considering if the certificate is ever reissued.)
   > - **Add the `www` record, confirm `ISSUED`, then delete it immediately.** This is what
   >   was done. The certificate retains validity after the record is removed (ACM only
   >   needs it present at issuance and for renewal, and ACM reuses the same token — the
   >   second attempt produced byte-identical validation names to the first). Total
   >   exposure is however long issuance takes, which was under a minute of actual
   >   validation plus the time to notice. **Have the `vercel dns rm <record-id>` command
   >   ready before adding the record.**
   >
   > **Open item this leaves:** ACM auto-renewal re-checks the validation records, so the
   > `www` one must exist again at renewal time (certificate expires 2027-04-23). After D4
   > this is a non-issue — Route53 is authoritative by then and `DnsStack` writes an
   > explicit `www` ALIAS, so there is no wildcard left to shadow and the validation record
   > can live in Route53 permanently. **If the cutover has not happened before renewal
   > comes due, the `www` validation record has to be re-added at Vercel and removed again,
   > with the same brief outage.** `RenewalEligibility` currently reads `INELIGIBLE`, which
   > is expected for a certificate not yet attached to anything; re-check it after D3
   > attaches it to CloudFront.
   > - Note that negative (NXDOMAIN) answers get cached by resolvers for the zone's SOA
   >   minimum TTL — 600s here. Recovery at public resolvers (Google, Cloudflare) was
   >   immediate once the record was deleted, but a resolver that cached the NXDOMAIN
   >   during the window keeps serving it until that expires.
3. **D3 — Deploy and verify `NewNotamsStack` end to end on CloudFront's own URL.** Sign-in,
   saved searches, a real push notification — not just a 200 on `/`. Nothing in DNS has
   changed at this point; the live site is untouched and Vercel is still serving it.

   > **This bar was stated correctly but not actually met the first time.** D3 was run,
   > `curl`/`Invoke-WebRequest` checks against `/api/auth/providers` and the homepage passed,
   > and that was taken as "verified." It was not: a real Google sign-in through the live
   > website, tried only after D4's cutover and a user-reported bug ("the login dialog just
   > closes"), uncovered two serious, independent bugs that every HTTP-level check had
   > missed — CloudFront's OAC cannot sign a POST request that carries a body at all
   > (`403 InvalidSignatureException` on every sign-in attempt, silent to anything short of
   > clicking the actual button), and `StringParameter.valueFromLookup` does not decrypt
   > `SecureString` parameters, so the Lambda's `AUTH_GOOGLE_ID` was raw KMS ciphertext, not
   > a real client ID, from the moment it was first deployed. Both are now fixed (see
   > `applications/newnotams/lib/newnotams-stack.ts` and
   > `packages/constructs/src/opennext-site/opennext-site.ts` for the full account in each
   > file's own doc comments) and a real sign-in now completes on the production domain —
   > but this happened in production, during the window between D3 and the user noticing,
   > not during D3 itself. **The lesson, not just the fix: "verify sign-in" has to mean
   > clicking the actual sign-in button in a browser, not checking that the API endpoints
   > respond.** `curl` cannot exercise CSRF-protected, cookie-dependent, or
   > signature-sensitive request paths faithfully enough to stand in for it. Do this for real,
   > by hand, before calling any future D3-shaped step done.
4. **D4 — The cutover, one step.** Switch nameservers at NameCheap from
   `ns1/ns2.vercel-dns.com` to the four Route53 nameservers, *and* deploy `DnsStack` with
   `productOrigin=cloudfront` so the zone holds apex and `www` ALIASes to the distribution.
   Deploy the records **first**, then switch nameservers — that ordering means the zone is
   already correct at the instant it becomes authoritative, with no window where it is
   authoritative but empty. While at NameCheap, confirm auto-renew is on and that
   `clientTransferProhibited` survives the change.
5. **D5 — Verify everywhere, then wait.** `.net` is a gTLD and propagates faster than
   `.ca`'s 24-48h, but verify rather than assume. Check from a second network.

**Rollback** is switching nameservers back at NameCheap: up to 6 hours (registry NS TTL),
not 5 minutes. This is the real cost of the chosen design and the reason D3's verification
bar is deliberately higher than Phase 0's — the cutover is to something already proven
working, so rollback should be a genuine last resort rather than an expected part of the
procedure. Vercel's project must stay up throughout for rollback to be possible, which is
why Stage G's decommission waits for a full observed hourly notify cycle.

The Phase 0 CNAME/A coexistence failure (`infrastructure/dns/README.md`'s "Known failure
mode") does not apply: our zone has no pre-existing CNAME at either name, since no records
are created there before the cutover. Confirm against the real `cdk diff` anyway — don't
assume safety from reasoning alone twice in a row.

---

## 5. Stage E — Observability, the actual point of this phase

**Done (the minimum viable version) 2026-10-10.** The roadmap is explicit that this is the
workload that makes observability matter — a silently-failing weather brief is a real
incident. Minimum viable version:

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

  **Done.** The notify Lambda's own `lambda/notify/index.ts` already threw on a full sweep
  failure, deliberately (see its own comment), which made the choice of metric simple:
  `fn.metricErrors()` — Lambda's standard error count — needed no custom metric filter. A
  CloudWatch Alarm watches it (1 error in a 1-hour period, matching `NOTIFY_INTERVAL` exactly,
  `treatMissingData: NOT_BREACHING`), publishing to a TLS-enforced SNS topic with an email
  subscription (`alertEmail` prop, same convention as `GovernanceStack`'s). Confirmed live:
  the subscription was confirmed via the email link, `aws cloudwatch describe-alarms` shows
  `OK` state. Does **not** cover "the schedule failed to invoke the Lambda at all" (a
  different, rarer failure mode — see `createNotifyFailureAlarm`'s doc comment in
  `applications/newnotams/lib/newnotams-stack.ts` for why that's out of scope for the minimum
  viable version this stage asks for).
- OTel instrumentation and CloudWatch metrics beyond the one alarm above were not done —
  deferred, same reasoning as the next bullet.
- **Grafana Cloud free tier** as the dashboard/alert backend, per the roadmap. Defer the full
  SLO/burn-rate-alert machinery until the basic "did it run, did it error" alarm exists and has
  been observed working for at least one real incident or near-miss — building burn-rate math
  against zero historical data is premature. **The basic alarm now exists** (above); the
  dashboard/SLO layer is still deferred, correctly, per this same reasoning — no real incident
  history exists yet to calibrate against.

---

## 6. Stage F — Clean up what Phase 0's reconnaissance already flagged

**Done.** From `applications.md`'s own notes, cheap to do while already touching this code:

- Remove `typescript.ignoreBuildErrors: true` from `next.config.mjs`. Fix whatever it was
  hiding — do this **before** the OpenNext migration, not after, so any real type error
  surfaces against the known-working Vercel deploy rather than a new, less-familiar Lambda
  deploy path.

  **Done in Stage A** (moved up, since the Next.js version bump was already touching this
  file): fixed the two real type errors the flag was hiding (`auth.ts`'s deprecated `AzureAD`
  import and a stale `@ts-expect-error`). See Stage A's own entry for the full account.
- Add a CloudFront/WAF rate-based rule on `/api/weather` — it is an open, unauthenticated
  proxy to Nav Canada today, and moving it to Lambda doesn't fix that on its own.

  **Done, but not as a CloudFront/WAF rule.** A full WAF web ACL was priced out at ~$5/mo
  base plus per-rule/request charges — a large fraction of the whole phase's $8-15/mo budget,
  to protect one route — and `NewNotamsStack`'s own `AwsSolutions-CFR2` suppression already
  says as much. Used `@upstash/ratelimit` instead, on the same Redis instance `lib/kv.ts`
  already connects to: no new infrastructure, no new cost. 30 requests/60s per client IP
  (from `X-Forwarded-For`, which CloudFront always sets). Verified live: 30 requests succeed,
  the 31st returns `429` with correct `Retry-After`/`X-RateLimit-*` headers, and the window
  resets correctly for a real subsequent request.
- Leave `getSchedulesDueAt`'s N+1 alone. `applications.md` correctly defers the real fix to
  the Phase 2 DynamoDB migration, where querying by notify-hour is the natural fix. Patching
  it now against Upstash would be throwaway work.

  **Left alone, as planned.** No change needed here — recorded for completeness.

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
