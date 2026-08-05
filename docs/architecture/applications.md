# Applications

The two real applications that will drive platform requirements. A platform built without a
customer is always wrong, so these define what actually gets built.

---

## NewNotams (`newnotams.net`)

Aviation weather and NOTAM briefing tool for Canadian airspace. Proxies and reformats the
Nav Canada `plan.navcanada.ca` alpha API, with saved searches, NOTAM dismissal tracking, and
scheduled web-push notifications.

**Repo:** `github.com/JosephKan3/v0-notam-search-app`
**Currently:** Vercel, Next.js 16 App Router, React 19, Upstash Redis, Auth.js v5 (Google OAuth
+ credentials), Web Push via VAPID, external hourly cron hitting `/api/notify`.

### What it actually needs

| Need | Evidence | Platform implication |
| --- | --- | --- |
| Server-side rendering + API routes | `app/api/*/route.ts`, `auth()` session calls | Not a static site. Needs real compute. |
| Key-value store | `lib/kv.ts`, `lib/user-store.ts` — users, saved searches, dismissals, schedules | The one genuinely interesting migration question |
| Scheduled job, hourly | `/api/notify` GET with `CRON_SECRET`, iterates all schedules | EventBridge Scheduler → Lambda |
| Outbound HTTPS to third parties | Nav Canada API, Google OAuth, web-push endpoints | **The no-NAT constraint applies here** |
| Secrets | `AUTH_SECRET`, Google OAuth pair, VAPID pair, `CRON_SECRET` | SSM SecureString |
| User accounts | scrypt password hashing, Google OAuth | Candidate to migrate to Authentik in Phase 2 |

### Why this is the right first application

It exercises nearly every platform capability without being trivial: authenticated
server-rendered app, a datastore, a scheduled background job, third-party API egress, secrets,
and a public domain. If the platform can host this well, it can host most things.

It also has a **real cron job with real state**, which is exactly the kind of workload that
makes the observability and alerting work matter. A weather brief that silently stops
arriving is a genuine incident with a genuine SLO.

### Migration path

**Phase 1 — lift, minimal change.**

Deploy the Next.js app on **Lambda** via OpenNext (`@opennextjs/aws`), fronted by CloudFront.
This is the closest AWS analogue to Vercel's model and keeps the App Router, server actions,
and API routes working without a rewrite.

- Compute: Lambda, ARM, **no VPC attachment**. The app talks to Nav Canada, Google, and push
  endpoints over the internet, and to its datastore over HTTPS. Egress strategy 1 from
  ADR-0002 — free, unmetered, no ENI cold-start penalty. This is the ideal case for the
  no-NAT design.
- CDN + static assets: CloudFront + S3 with OAC.
- Datastore: **keep Upstash Redis initially.** It is HTTPS-based (`@upstash/redis` is a REST
  client, not a TCP client), so it works unchanged from a VPC-less Lambda, and its free tier
  covers this workload. Migrating the datastore and the compute in the same step would make a
  failed deploy impossible to diagnose.
- Cron: **EventBridge Scheduler** → Lambda, hourly. Replaces the external cron service.
  Keep the `CRON_SECRET` bearer check, or drop it in favour of direct Lambda invocation with
  no public endpoint at all — better, since the notify path stops being internet-reachable.
- Secrets: SSM Parameter Store SecureString. Nothing here rotates, so Secrets Manager's
  $0.40/secret is not justified (7 secrets = $2.80/mo saved).
- DNS: `newnotams.net` hosted zone in Route53, ACM cert in `us-east-1` for CloudFront.

Estimated cost: **~$1-3/mo.** Lambda's free tier (1M requests, 400k GB-s, permanent) and
CloudFront's 1 TB free tier will absorb essentially all of this workload.

**Phase 2 — datastore decision.**

The interesting architectural question. Three options:

| Option | Cost | Trade |
| --- | --- | --- |
| **Stay on Upstash** | $0 | Works today. External dependency. Zero platform value. |
| **DynamoDB** | ~$0 | Closest fit to the actual access patterns — every operation in `user-store.ts`, `saved-searches.ts`, and `schedule/route.ts` is a key lookup or a set membership. `schedule_user_ids` becomes a GSI or a sparse index. Keeps Lambda out of the VPC. **Recommended.** |
| **RDS Postgres** | shared instance | Forces VPC attachment, which means ENI cold starts and either RDS Proxy or careful connection pooling. Only justified if the app grows relational queries. |

DynamoDB is the right answer here, and notably it *preserves* the no-VPC property that makes
this app so cheap. The `getKv()` accessor in `lib/kv.ts` is already a seam — a `DynamoStore`
implementation behind the same interface is a contained change.

**Phase 2 — identity.**

Auth.js currently owns users directly (`lib/user-store.ts` does its own scrypt hashing). The
platform position is that applications should never manage users independently. Migrating to
Authentik as the OIDC provider, with Auth.js configured as a client, is a good Phase 2
exercise — and a genuine data migration with existing users, which is more interesting than a
greenfield SSO setup.

Note the existing OAuth path already derives user IDs deterministically from an email SHA-256
(`findOrCreateOAuthUser`), which makes ID stability across an identity-provider migration
tractable.

### Notes from reading the code

- `app/api/weather/route.ts` is an open proxy — it forwards arbitrary query parameters to Nav
  Canada with no authentication or rate limiting. Fine at current traffic, but it's the one
  endpoint that could be abused to generate cost or get the source IP blocked upstream. Worth
  a CloudFront rate-limit rule or a WAF rate-based rule when it moves.
- `next.config.mjs` sets `typescript.ignoreBuildErrors: true`. That should come off before
  this becomes the reference application for a platform whose CI story is part of the pitch.
- `getSchedulesDueAt` fans out one `get` per user. Fine now; becomes an N+1 at scale. A
  DynamoDB migration would naturally fix it via a query on notify-hour.

---

## Personal site (`josephkan.ca`)

Portfolio and personal page. Next.js 12 / React 18, SCSS modules, Chart.js visualizations of
live OANDA trading data, project write-ups.

**Repo:** `github.com/JosephKan3/personal-website`
**Currently:** Vercel. Apex `A 76.76.21.21`, `www CNAME cname.vercel-dns.com`. Registered at
GoDaddy. No MX, no TXT — nothing at risk during DNS migration.

The domain doubles as the **platform** domain (ADR-0006): the apex serves this site, while
`api.` and the Tailscale-only `internal.` private zone hang off the same zone.

### What it actually needs

| Need | Evidence | Platform implication |
| --- | --- | --- |
| Static pages | `pages/index.tsx`, `pages/projects/*` — no `getServerSideProps` anywhere | Fully static-exportable |
| Two API routes | `pages/api/oandaReturn.ts`, `oandaTrades.ts` — server-side OANDA calls | Small Lambdas, or precomputed |
| Secrets | `OANDA_ACCOUNT_ID`, `OANDA_ACCESS_TOKEN` | SSM SecureString. **Must stay server-side.** |
| Charts | Client-side Chart.js, fetched on mount | No SSR requirement |

### Why this is the right *first* deployment

It is the smallest possible end-to-end proof of the entire Phase 0 pipeline: GitHub → OIDC →
CDK → CloudFormation → S3 → CloudFront → ACM → Route53, with no database, no VPC, and no
state. If this deploys from a merge to `main` with nobody touching the console, Phase 0's exit
criterion is met.

### Migration path

**Phase 0 — static site, deployed first.**

- CloudFront + S3 with Origin Access Control. Effectively free.
- The two OANDA API routes become **two small Lambdas behind a CloudFront behavior**, or —
  better — an **EventBridge-scheduled Lambda that fetches OANDA hourly and writes a JSON file
  to S3**, which the page fetches statically.

  The second approach is strictly better here: it removes all request-path compute, caches
  perfectly at the edge, hides the OANDA token behind a process that is never internet-
  reachable, and means an OANDA outage or rate limit can't affect page loads. The data is
  trading history — it does not need to be real-time.

- Next.js 12 is well past end of life. Either upgrade to 14/15 or, since the site is fully
  static, `next export` it as-is. The upgrade is worth doing but should not block Phase 0.
- The apex must be a Route53 **ALIAS** record, not a CNAME — DNS forbids CNAMEs at a zone
  apex, and CloudFront gives you a hostname rather than a stable IP. This is the reason DNS
  delegation to Route53 is mandatory rather than a preference (ADR-0006).

Estimated cost: **under $1/mo.**

### Notes from reading the code

- `pages/api/oandaReturn.ts` has ~35 lines of commented-out earlier implementation. Worth
  deleting when it moves.
- Both `next.config.js` and `next.config.mjs` exist. Next will use one and silently ignore
  the other; remove the dead one.
- `package.json` has an `add` dependency (`"add": "^2.0.6"`), which is almost certainly an
  accidental `npm install add`. Remove it.

---

## What these two applications imply for the platform

Reading the actual requirements rather than guessing at them changes a few things:

1. **Neither application needs a VPC.** The personal site is static; NewNotams talks to
   Upstash and DynamoDB over HTTPS. Both run as VPC-less Lambdas with free internet egress.
   This validates the no-NAT decision (ADR-0002) directly — the constraint costs nothing here.

2. **RDS is not needed in Phase 1.** The roadmap provisions a shared Postgres `t4g.micro`,
   but neither application requires relational storage. **Defer RDS until something actually
   needs it**, saving ~$12/mo and keeping Phase 1 nearer $8 than $35. Provision it when a
   third application or a pgvector workload justifies it.

3. **EventBridge Scheduler matters more than expected.** Both applications want scheduled
   work. It is free at this volume and should be a first-class construct in
   `packages/constructs/`.

4. **The paved road's first template is "Next.js on Lambda via OpenNext + CloudFront."**
   Both apps fit it. That is the `platform new-service` scaffold to build first, and having
   two real consumers means the abstraction is validated rather than speculative.

5. **A shared ALB is not needed yet.** Both applications front on CloudFront. The ALB
   ($17/mo) is deferred until a genuinely long-running container exists — likely Authentik in
   Phase 2, which may itself be avoidable.

Revised Phase 1 target: **$8-15/mo**, down from $20-35.
