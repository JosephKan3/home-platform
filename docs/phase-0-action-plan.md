# Phase 0 — Action Plan

Executable sequence for the foundation phase. Ordered by dependency, not importance.

**Goal:** a merge to `main` deploys `josephkan.ca` to production with nobody touching the
console.

**Budget:** $3-8/mo.

**Definition of done:** see [§9 Exit criteria](#9-exit-criteria).

---

## 0. Decisions to lock before starting

These are cheap now and expensive later. Decide, write down, move on.

| Decision | Recommendation | Why it's hard to change |
| --- | --- | --- |
| **Primary region** | **`us-east-1`** | Baked into every stack, every ARN, every SSM path |
| **Identity Center region** | **`us-east-1`** (must match) | Changing requires deleting the entire Identity Center instance and all assignments |
| **Management account email** | `josephkan3+infra@gmail.com` (settled) | Must be globally unique across all of AWS, permanently |
| **Platform account email** | `josephkan3+platform@gmail.com` | Same. Plus-addressing works; use a mailbox you control forever |
| **Monorepo name** | `home-platform` | Encoded in every OIDC trust policy `sub` claim |
| **GitHub org vs personal** | Personal (`JosephKan3`) is fine | Moving to an org later changes every trust policy |

### On `us-east-1` vs `ca-central-1`

`us-east-1` is recommended for Phase 0 despite the Canadian angle:

- **ACM certificates for CloudFront must live in `us-east-1` regardless.** Choosing
  `ca-central-1` as primary means a cross-region certificate stack, a second `cdk bootstrap`,
  and cross-region references — real complexity for the very first thing you build.
- CloudFront terminates at the Toronto edge either way, so origin region barely affects
  user-perceived latency for a static site.
- `us-east-1` is the cheapest region and gets every service first.

`ca-central-1` becomes the right answer if data residency becomes a stated requirement.
NewNotams stores user emails, but PIPEDA does not mandate residency. Revisit if that changes;
it is a Phase 2+ concern, not a Phase 0 one.

---

## 1. Start these on day 1 — they have lead time

Two things take ~24 hours to become useful. Kick them off early; neither blocks anything.

| Item | Lead time | Blocks |
| --- | --- | --- |
| **Activate cost allocation tags** | ~24h to appear, and only applies going forward | Nothing, but data is lost until active |
| **Create AWS Budgets** | ~24h before first evaluation | Nothing, but you're flying blind until then |

While at GoDaddy, confirm **auto-renew and transfer lock are ON**. A lapsed registration
takes down both the platform and the product. That is the only thing worth doing there now.

### Correction: lowering TTLs at GoDaddy is NOT required

An earlier version of this plan said to lower the GoDaddy record TTLs to 300s before
anything else, and called it a blocker for the §5 nameserver switch. **That was wrong**, and
it conflated two different caches.

- **Record TTL** controls how long resolvers cache an *answer* (e.g. `A 76.76.21.21`).
- **Delegation** controls *which nameservers* are asked in the first place.

At **D3 (the nameserver switch)** the zone contents on both sides are byte-identical. A
resolver serving a cached `76.76.21.21` and a resolver doing a fresh lookup against Route53
both produce `76.76.21.21`. No answer changes, so there is nothing to propagate and the old
TTL is irrelevant.

TTL only becomes load-bearing at **G1 (the apex cutover)**, where the value genuinely
changes — and that is already handled: `infrastructure/dns` sets a 300s TTL on every record
it creates, so by the time you reach G1 the records are Route53's and already short-lived,
regardless of what GoDaddy was serving.

**Net: deploy the DNS stack, delegate, then change records.** No TTL preparation needed.

---

## 2. Stage A — Manual bootstrap

Unavoidably manual. This is the entire hand-operated surface of the project; everything after
this is code. Keep a written log of exactly what you clicked.

### A1. Management account

1. Use an existing AWS account **only if it has no workloads**. Otherwise create a new one.
2. Root user: set a strong unique password, **enable hardware or virtual MFA**, remove any
   root access keys.
3. Set the account alias and billing contact.
4. **Enable IAM access to billing data** (Account settings → IAM user and role access to
   Billing Information). Without this, non-root admins cannot see Cost Explorer, and you will
   be confused later.

> **Critical property:** SCPs **do not apply to the management account.** No guardrail you
> write in §6 will constrain it. This is precisely why nothing runs there.

**Done 2026-09-11.** Account `joseph_kan_infra` (`josephkan-infra`,
`josephkan3+infra@gmail.com`), root MFA enabled. An IAM admin user
`joseph-kan-infra-admin` was created with a static access key so the CLI could drive A2
before Identity Center exists. **That user and key are interim and are deleted in A4.**

### A2. Create the Organization

Console → Organizations → Create organization → **All features** (not consolidated billing
only; SCPs require all features).

Note that current AWS consoles create organizations with all features by default, so there
may be nothing to choose. Confirm rather than assume — `FeatureSet` must read `ALL`:

```powershell
aws organizations describe-organization --profile mgmt --query "Organization.FeatureSet"
```

Create OUs:

```
Root
├── Security     (empty — reserved)
├── Workloads
└── Sandbox      (empty — reserved)
```

The OUs are **policy boundaries, not environment labels** — see ADR-0001 for why this is not
`dev` / `qa` / `prod`. Creating the empty ones now costs nothing and means ADR-0001's growth
path is real rather than aspirational.

**Done 2026-09-11.** Organization created, feature set `ALL`, SCP policy type enabled. All
three OUs exist and are empty. IDs are in `.env.local` (gitignored).

### A3. Create the Platform account

Organizations → Add account → Create account.

- Name: `Platform`
- Email: `josephkan3+platform@gmail.com`, the plus-addressed address decided in §0
- Move it into the `Workloads` OU immediately.
- Record its ID as `PLATFORM_ACCOUNT_ID` in `.env.local`.

Then **take control of its root user**: sign out, "Forgot password" against the Platform
account email, set a password, enable MFA, and never use it again.

> **Do not create accounts casually.** AWS limits account closure to ~10% of your accounts per
> month, and newly created accounts have a waiting period before they can be closed.

### A4. IAM Identity Center

1. Enable Identity Center in **`us-east-1`**. This region choice is effectively permanent.
2. Create a user for yourself. Enable MFA.
3. Create permission sets:
   - `AdministratorAccess` — session duration 4h (not the default 1h; it's annoying, and not
     12h either)
   - `ReadOnlyAccess` — session duration 8h
   - `Billing` — for cost work without admin rights
4. Assign yourself `AdministratorAccess` on **both** accounts.
5. Note the start URL (`https://d-xxxxxxxxxx.awsapps.com/start`).
6. **Delete the interim IAM user and access key from A1** (`joseph-kan-infra-admin`), which
   existed only to bridge A2–A3. Standing keys are the thing Identity Center replaces, and
   "no IAM users and no access keys" is a Phase 0 exit criterion.

### A5. Switch off root, switch on SSO

```powershell
aws configure sso
# Start URL: the one from A4
# Region: us-east-1
# Profile names: mgmt and platform
```

Verify both:

```powershell
aws sts get-caller-identity --profile mgmt
aws sts get-caller-identity --profile platform
```

Both must return an `assumed-role/AWSReservedSSO_AdministratorAccess/...` ARN. **From this
point, root is never used again** for either account.

### A6. CDK bootstrap — three qualifiers, and step C1 lands in the middle

Not one bootstrap per account. ADR-0001 shares one account between dev and prod, and the only
place a permissions boundary changes any outcome is the CDK CloudFormation execution role —
`cdk bootstrap --custom-permissions-boundary` attaches the boundary there and nowhere else.
One bootstrap per account would give dev and prod a single shared execution role, so they get
separate **qualifiers** instead:

| Qualifier | Account | Boundary on `cdk-<q>-cfn-exec-role-*` |
| --- | --- | --- |
| `hnbmgmt` | Management | none |
| `hnbprod` | Platform | none |
| `hnbdev` | Platform | `cdk-dev-permissions-boundary` |

**The order is not the obvious one.** `--custom-permissions-boundary` takes a policy *name*
and does not verify the policy exists; if it is missing the bootstrap fails while creating the
execution role. The policy is created by `BootstrapStack` (§4 C1). So the dev bootstrap must
come *after* C1, which in turn needs the prod bootstrap to already exist.

> **`--qualifier` does not rename the CloudFormation stack** — `cdk bootstrap` always creates
> a stack literally named `CDKToolkit` unless `--toolkit-stack-name` is also given. Two
> qualifiers bootstrapped into the same account and region without distinct
> `--toolkit-stack-name` values collide on that one stack, and the second bootstrap **deletes**
> the first qualifier's roles while "updating" it. Steps 2 and 4 below are both in the Platform
> account, so both need distinct names.

```powershell
# 1. Management account. Independent of everything below. No suffix needed: it is the only
#    qualifier ever bootstrapped into this account and region.
npx cdk bootstrap aws://<MGMT_ACCOUNT_ID>/us-east-1 --profile mgmt --qualifier hnbmgmt

# 2. Platform, prod qualifier. No boundary, so nothing must exist first.
npx cdk bootstrap aws://<PLATFORM_ACCOUNT_ID>/us-east-1 --profile platform --qualifier hnbprod `
  --toolkit-stack-name CDKToolkit-hnbprod

# 3. >>> Do §4 C1 here <<< — deploy BootstrapStack (through hnbprod).
#     It creates cdk-dev-permissions-boundary. Confirm before continuing:
aws iam get-policy --profile platform `
  --policy-arn arn:aws:iam::<PLATFORM_ACCOUNT_ID>:policy/cdk-dev-permissions-boundary

# 4. Platform, dev qualifier, with the boundary on its execution role.
npx cdk bootstrap aws://<PLATFORM_ACCOUNT_ID>/us-east-1 --profile platform `
  --qualifier hnbdev `
  --custom-permissions-boundary cdk-dev-permissions-boundary `
  --toolkit-stack-name CDKToolkit-hnbdev

# 5. Verify the attachment. Dev must show the boundary ARN; prod must show null.
aws iam get-role --profile platform --query "Role.PermissionsBoundary" `
  --role-name cdk-hnbdev-cfn-exec-role-<PLATFORM_ACCOUNT_ID>-us-east-1
```

Qualifiers are defined once in `packages/config/src/bootstrap.ts` and consumed by both
`infrastructure/bootstrap` and every app's synthesizer. The bootstrap template caps a
qualifier at 10 characters. **The value passed to `--qualifier` and the value a stack
synthesizes with must match**; nothing checks this, and a mismatch surfaces as an
`AssumeRole` failure naming a role that was never created.

Full commands, plus the manual probe proving the boundary actually denies, are in
`infrastructure/bootstrap/README.md`.

> **Correction to the roadmap:** with two accounts and GitHub OIDC roles living *in* each
> account, **no `--trust` flag is needed.** Each account is bootstrapped standalone and
> deploys into itself. `--trust` becomes relevant only when prod graduates to a third account
> and you want a central deploy account.

> **Order matters:** bootstrap **before** applying SCPs in §6. A region-lock SCP applied first
> can block the bootstrap and produce a confusing failure.

**Stage A output to record:** management account ID, platform account ID, Identity Center
start URL, both root emails.

---

## 3. Stage B — Repo scaffold

Fully local. **Do this in parallel with Stage A** — it touches no AWS.

### B1. Initialize

```
home-platform/
├── infrastructure/
│   ├── org/
│   ├── bootstrap/
│   ├── network/
│   └── platform/
├── applications/
│   └── personal-site/
├── automation/
├── packages/
│   ├── constructs/
│   └── config/
├── docs/                 ← move this repo's docs/ here
└── .github/workflows/
```

pnpm workspaces + Turborepo + TypeScript + CDK v2 + jest + eslint + cdk-nag + Renovate.

### B2. `packages/config` — the single source of truth

```ts
export const accounts = {
  management: { id: '111111111111', region: 'us-east-1' },
  platform:   { id: '222222222222', region: 'us-east-1' },
  // prod:    { id: '...',          region: 'us-east-1' },  ← uncomment to graduate (ADR-0001)
} as const;

export const domains = {
  platform: 'josephkan.ca',
  product:  'newnotams.net',
  internal: 'internal.josephkan.ca',
} as const;

export type Env = 'dev' | 'prod';
```

### B3. The three CDK Aspects

All must fail `cdk synth`, not `cdk deploy`. Each needs a unit test proving it fires —
a guardrail with no test silently rots.

| Aspect | Behavior |
| --- | --- |
| `NoManagedEgressAspect` | **Error** on `CfnNatGateway`, `CfnTransitGateway`, `CfnTransitGatewayAttachment`. **Warn** on non-allowlisted interface endpoints. (ADR-0002) |
| `RequiredTagsAspect` | **Error** on any taggable resource missing `app`, `env`, `owner` |
| `LogRetentionAspect` | **Error** on any `CfnLogGroup` without explicit `RetentionInDays` |

The `PRIVATE_WITH_EGRESS` case needs no separate rule — that subnet type is *what constructs*
the `CfnNatGateway`, so the first rule fires with an error naming the real cause.

### B4. Dependency boundaries

`eslint-plugin-boundaries` encoding ADR-0004's matrix:

```
applications/*   →  packages/*         allowed
automation/*     →  packages/*         allowed
infrastructure/* →  packages/*         allowed
applications/*   →  infrastructure/*   BLOCKED
applications/*   →  applications/*     BLOCKED
infrastructure/* →  applications/*     BLOCKED
```

### B5. Migrate the two app repos in

Preserve history:

```powershell
git subtree add --prefix=applications/personal-site/site `
  https://github.com/JosephKan3/personal-website.git main
```

> **Note the `/site` suffix.** `applications/personal-site/` already holds the CDK package
> (`bin/`, `lib/`, `lambda/`, `test/`). The Next.js source goes in a `site/` subdirectory
> beneath it, not at the package root — a subtree onto the package root would collide with
> the existing files.
>
> Three names are in play and it is easy to confuse them:
>
> | Name | What it is |
> | --- | --- |
> | `personal-website` | the GitHub repo |
> | `applications/personal-site/site/` | where it lands in this monorepo |
> | `personal-page` | the existing sibling checkout on this machine |
>
> `applications/personal-site/README.md` documents the stack's default export path as
> `../../../personal-page/out` (the sibling checkout). After the subtree lands, pass
> `-c siteSourcePath=...` pointing at `site/out` instead.

NewNotams stays where it is until Phase 1 — don't move it while it's still serving from
Vercel and untouched.

**Stage B output:** a repo where `pnpm install && pnpm turbo synth` succeeds and all three
Aspect tests pass, with zero AWS calls.

---

## 4. Stage C — The OIDC handoff

The moment manual work ends. **Deploy this once with SSO admin credentials; everything after
runs through it.**

### C1. Deploy `infrastructure/bootstrap`

Stack contents:

- GitHub OIDC identity provider (`token.actions.githubusercontent.com`).
  **No thumbprint needed** — AWS manages this now.
- Three roles in the Platform account:

| Role | GitHub `sub` condition | May assume |
| --- | --- | --- |
| `gha-plan` | `repo:JosephKan3/home-platform:pull_request` | ReadOnly + both qualifiers' CDK lookup roles |
| `gha-deploy-dev` | `repo:JosephKan3/home-platform:environment:dev` | `cdk-hnbdev-*` bootstrap roles only |
| `gha-deploy-prod` | `repo:JosephKan3/home-platform:environment:prod` | `cdk-hnbprod-*` bootstrap roles only |

Plus `cdk-dev-permissions-boundary`, a fixed-name managed policy denying any action where
`aws:ResourceTag/env = prod`. It is **not attached to any role in this stack** — a boundary
does not follow a role chain, and `gha-deploy-dev` holds no permissions to cap. §2 A6 step 4
attaches it to `cdk-hnbdev-cfn-exec-role-*`, the role that performs dev's mutations.

Trust policy conditions — get these exactly right:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:JosephKan3/home-platform:environment:prod"
  }
}
```

**Never** use `StringLike` with `repo:JosephKan3/*` — that grants every repo you own, forever,
including ones you haven't created.

```powershell
npx cdk deploy BootstrapStack --profile platform
```

**This step sits between §2 A6 steps 2 and 4.** It needs the `hnbprod` bootstrap to exist, and
the `hnbdev` bootstrap needs the boundary policy this stack creates. Return to A6 step 4 once
this succeeds.

### C2. GitHub Environments

Repo → Settings → Environments:

- `dev` — no protection
- `prod` — **required reviewers: yourself.** This is what makes the `environment:prod` sub
  claim meaningful; without it the distinction is cosmetic.

### C3. CI workflow

```
PR:              lint → boundaries → test → synth → aspects → cdk-nag → cdk diff   (gha-plan)
merge to main:   ...  → cdk deploy dev      (gha-deploy-dev)
                      → cdk deploy prod     (gha-deploy-prod, gated on prod environment)
```

### C4. Prove it

Open a trivial PR. Confirm the diff posts, the plan role is read-only, and no AWS credentials
exist anywhere in the repo or in GitHub secrets other than the account IDs.

**Stage C output:** CI can deploy. Local `cdk deploy` should now be considered a break-glass
action, not routine.

---

## 5. Stage D — DNS delegation

The personal site is **live on Vercel**. This sequence is designed so the switch is a no-op.

### D1. Create and replicate (via CDK, deployed by CI)

Create the `josephkan.ca` public hosted zone with the **existing Vercel records**:

```
josephkan.ca       A      76.76.21.21
www.josephkan.ca   CNAME  cname.vercel-dns.com
```

Also add now, since nothing is at risk:

```
_dmarc.josephkan.ca TXT   "v=DMARC1; p=reject;"
```

> An earlier draft also listed an apex `josephkan.ca TXT "v=DMARC1; ..."` record. That was
> wrong: DMARC policy is only ever read at `_dmarc.<domain>`. An apex copy is inert, and
> would be the first thing to drift out of sync. `infrastructure/dns` creates only the
> `_dmarc` record, which is correct.

No mail is sent from this domain — which is exactly why it should be unspoofable. Free.

### D2. Verify against Route53 directly, before delegating

```powershell
$ns = (aws route53 get-hosted-zone --id <ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers
Resolve-DnsName josephkan.ca     -Server $ns[0]
Resolve-DnsName www.josephkan.ca -Server $ns[0]
```

Both must return the **Vercel** values. If they don't, stop — do not proceed to D3.

### D3. Switch nameservers at GoDaddy

Replace GoDaddy's nameservers with the four Route53 ones.

**This is a no-op.** Zone contents are byte-identical to what GoDaddy serves, so no resolver
sees a change. The site does not go down.

While in GoDaddy: **confirm auto-renew and transfer lock are ON.** A lapsed registration takes
down both the platform and the product.

### D4. Wait and verify

`.ca` registry propagation takes 24-48h.

```powershell
Resolve-DnsName josephkan.ca -Type NS
# must return awsdns servers, not domaincontrol.com
```

Check from a second network (phone on cellular) before considering it done.

### D5. Certificate

ACM certificate in **`us-east-1`** for `josephkan.ca` + `*.josephkan.ca`, DNS-validated.
CDK creates the validation records automatically now that Route53 holds the zone.

`us-east-1` is mandatory for CloudFront regardless of primary region — and since primary *is*
`us-east-1` here, there's no cross-region stack to write.

---

## 6. Stage E — Governance as code

**Deploy this by hand**, from `infrastructure/org`, using the management account SSO profile.

> **Correction.** An earlier draft said "deploy through CI". That is not possible and never
> was: this stack targets the **management** account, and `infrastructure/bootstrap` creates
> GitHub OIDC roles only in the Platform account — deliberately, because ADR-0001 keeps the
> management account empty and SCPs do not apply to it anyway. Creating a deploy role there
> would undermine the reason it is kept empty.
>
> `.github/workflows/deploy.yml` contains the step with an explicit `exit 1` and an
> explanation rather than silently skipping it. See `docs/open-issues.md` issue 3.

> **Deploy this only after §2 A6 (bootstrap) and §4 (OIDC) succeed.** SCPs applied earlier can
> block the very operations that set up your ability to deploy.

### E1. SCPs on OUs

Attach to OUs, never accounts, so future accounts inherit automatically.

**Region lock** — the one with a well-known trap. Global services live in `us-east-1` and must
be exempted by service namespace, or you will break IAM, Organizations, Route53, CloudFront,
and billing:

```json
{
  "Effect": "Deny",
  "NotAction": [
    "iam:*", "organizations:*", "route53:*", "cloudfront:*", "waf:*", "wafv2:*",
    "shield:*", "globalaccelerator:*", "support:*", "sts:*", "budgets:*",
    "ce:*", "cur:*", "health:*", "account:*", "artifact:*", "notifications:*"
  ],
  "Resource": "*",
  "Condition": { "StringNotEquals": { "aws:RequestedRegion": ["us-east-1"] } }
}
```

Other SCPs:

| Policy | Effect |
| --- | --- |
| Deny managed egress | `ec2:CreateNatGateway`, `ec2:CreateTransitGateway` (ADR-0002) |
| Deny expensive compute | `ec2:RunInstances` for `p*`, `g*`, `x*`, `u-*`, `*.metal`, and sizes above `large` |
| Deny static credentials | `iam:CreateUser`, `iam:CreateAccessKey` |
| Protect audit | Deny disabling CloudTrail, GuardDuty, Config |
| Protect org | Deny `organizations:LeaveOrganization` |

Apply to `Workloads` and `Sandbox`. Remember: **none of these constrain the management
account.**

### E2. Audit and detection

- Organization CloudTrail → S3 bucket in the management account, **log file validation on**,
  lifecycle to Glacier after 90 days.
- GuardDuty enabled on the Platform account. 30-day free trial, then ~$3-10/mo. Keep it.
- Skip AWS Config for now — its per-item recording charges creep and nothing needs it yet.

> **Deviation, recorded honestly (ADR-0001):** CloudTrail and GuardDuty live in the management
> account rather than a dedicated Security account. An attacker with management access could
> tamper with the audit trail. Mitigated by MFA, Identity Center, and no standing access.

### E3. Cost controls

- **AWS Budget** on the Platform account: $10/mo, alerts at 50%, 80%, 100% actual and 100%
  forecast → email + SNS.
- **Cost Anomaly Detection** monitor with a $5 threshold.
- **Activate cost allocation tags** `app`, `env`, `owner` in Billing → Cost allocation tags.

With a single workload account, **tags are your only billing breakdown.** The `RequiredTagsAspect`
from B3 is what makes them trustworthy.

---

## 7. Stage F — Ship the personal site

### F1. Restructure the OANDA data path

Current: browser → `/api/oandaReturn` → OANDA (server-side, per request).

New: **EventBridge Scheduler (hourly) → Lambda → OANDA → write JSON to S3.** The page fetches
a static file.

Why this is strictly better:

- Zero request-path compute — the site is genuinely static
- Caches perfectly at the CloudFront edge
- The OANDA token sits in a Lambda that is **never internet-reachable**
- An OANDA outage or rate limit cannot affect page loads
- The data is trading history; it does not need to be real-time

Write to `s3://<bucket>/data/oanda-returns.json` and `oanda-trades.json` — **the same bucket
the site is served from**, so the fetch is same-origin and there is no CORS configuration at
all.

Client change is minimal:

```diff
- const response = await fetch("/api/oandaReturn");
+ const response = await fetch("/data/oanda-returns.json");
```

Secrets: `OANDA_ACCOUNT_ID` and `OANDA_ACCESS_TOKEN` → **SSM Parameter Store SecureString**.
Nothing rotates, so Secrets Manager's $0.40/secret is unjustified.

### F2. Static export

Next.js 12, fully static (no `getServerSideProps` anywhere — verified). `next export` works
as-is once the two API routes are gone.

Cleanups while you're in there:

- Delete `next.config.js` **or** `next.config.mjs` — both exist; Next silently ignores one
- Remove the `add` dependency from `package.json` (a stray `npm install add`)
- Delete the ~35 lines of commented-out code in `pages/api/oandaReturn.ts`
- Next.js 12 is past EOL. Upgrading is worth doing but **must not block Phase 0.**

### F3. Site stack

- S3 bucket, private, **Origin Access Control** (not the legacy OAI)
- CloudFront: the ACM cert from D5, HTTP→HTTPS redirect, compression, SPA error handling
- Response headers policy: HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `Content-Security-Policy`
- Short TTL (300s) on `/data/*.json`, long TTL on hashed assets
- CI invalidates the distribution on deploy

### F4. Verify before cutting over

Confirm the site works on the CloudFront domain (`dxxxx.cloudfront.net`) — fully, including
the charts — **before touching DNS.**

---

## 8. Stage G — The apex cutover

The single highest-risk moment in Phase 0, deliberately isolated to one record.

### G1. Flip it

Replace the A record with a Route53 **ALIAS** to the CloudFront distribution:

```
josephkan.ca      ALIAS  → dxxxx.cloudfront.net   (was A 76.76.21.21)
www.josephkan.ca  ALIAS  → dxxxx.cloudfront.net   (or a redirect to apex)
```

ALIAS is required because DNS forbids a CNAME at a zone apex, and CloudFront gives you a
hostname rather than a stable IP. ALIAS queries are free.

By this point the records are Route53's, and `infrastructure/dns` sets a 300s TTL on every
one it creates. So **rollback is five minutes**, and it does not touch nameservers — which
is the entire point of separating D3 from G1.

### G2. Verify, then decommission

```powershell
Resolve-DnsName josephkan.ca
curl.exe -I https://josephkan.ca
curl.exe -I https://www.josephkan.ca
```

Check the certificate, the security headers, and the charts in a real browser. Then remove the
Vercel project for the personal site — **only after** 24h of clean operation.

---

## 9. Exit criteria

Phase 0 is done when **all** of these are true:

- [ ] A merge to `main` deploys `josephkan.ca` with **nobody touching the console**
- [ ] `https://josephkan.ca` serves from CloudFront with a valid ACM cert and charts render
- [ ] Vercel is off for the personal site
- [ ] Root credentials have not been used since §2 A5
- [ ] No IAM users and no access keys exist in either account
- [ ] `Resolve-DnsName josephkan.ca -Type NS` returns AWS nameservers
- [ ] `cdk-hnbdev-cfn-exec-role-*` carries `cdk-dev-permissions-boundary` and
      `cdk-hnbprod-cfn-exec-role-*` carries none (§2 A6 step 5)
- [ ] The manual probe in `infrastructure/bootstrap/README.md` shows the dev execution role
      **denied** tagging an `env=prod` resource **while succeeding** on an untagged one.
      The control call is the point: without it the denial proves only the absence of an Allow.
      CI asserts the offline preconditions
      (`infrastructure/bootstrap/test/dev-permissions-boundary.test.ts`) but cannot execute an
      IAM evaluation, so this one is signed off by hand
- [ ] All three Aspects fail synth in their unit tests
- [ ] A deliberate `SubnetType.PRIVATE_WITH_EGRESS` in a scratch branch **fails CI**
- [ ] A budget alert has fired at least once (set the threshold to $0.01 temporarily to prove it)
- [ ] Cost allocation tags appear in Cost Explorer
- [ ] The monthly bill is **under $8**
- [ ] A teardown runbook exists for everything built in this phase

---

## 10. Gotchas

Ordered by how much time each one costs when hit.

| Gotcha | Consequence | Avoidance |
| --- | --- | --- |
| **SCPs don't apply to the management account** | False sense of protection | Run nothing there. Ever. |
| **Region-lock SCP without global-service exemptions** | Breaks IAM, Route53, CloudFront, billing simultaneously | Use the `NotAction` list in §6 E1 |
| **SCPs applied before `cdk bootstrap`** | Bootstrap fails opaquely | Bootstrap first (§2 A6), SCPs later (§6) |
| **Identity Center region is effectively permanent** | Full teardown and reassignment to change | Choose `us-east-1` and don't revisit |
| **Account emails must be globally unique forever** | Cannot be reused, even after closure | Plus-addressing on a mailbox you'll keep |
| **`StringLike` on `repo:owner/*` in OIDC trust** | Every repo you own can assume the role | Always `StringEquals` with the full `sub` |
| **ACM for CloudFront must be `us-east-1`** | Cert silently won't attach | Primary region is `us-east-1`, so moot |
| **CNAME at zone apex is invalid** | Apex won't resolve | Route53 ALIAS |
| **Delegating NS before replicating records** | Site goes down immediately | §5 D1 → D2 → D3, in order |
| **CloudWatch log retention defaults to infinite** | Slow, silent cost leak | `LogRetentionAspect` fails synth |
| **Cost allocation tags aren't retroactive** | No historical breakdown | Activate on day 1 (§1) |
| **Budgets take ~24h to evaluate** | Silent first day | Create early, verify with a $0.01 threshold |
| **Account closure is rate-limited (~10%/mo)** | Can't undo casual account creation | Create only the two accounts |
| **Deleting `AWS::Organizations::Account` doesn't close the account** | Orphaned account, still billable | Know this before writing the resource |

---

## 11. Explicitly NOT in Phase 0

Scope discipline. Every one of these is a real temptation.

- **No VPC.** Nothing needs one. It's free, but it's Phase 1 work.
- **No RDS.** Neither application needs relational storage (`applications.md`).
- **No ALB.** Both apps front on CloudFront. Saves $17/mo.
- **No Tailscale.** Nothing private exists yet.
- **No NewNotams migration.** Phase 1. Do not touch it while it serves from Vercel.
- **No Authentik, Grafana, Temporal, Step Functions, Platform API, MCP.**
- **No Next.js 12 → 15 upgrade.** Worth doing; not now.
- **No third account.** Two, per ADR-0001.
- **No AWS Config.** Costs creep, nothing needs it.

If a Phase 0 task starts requiring one of these, the task is misscoped.

---

## 12. Suggested order of work

Parallelism matters — Stage B needs no AWS, and DNS has multi-day waits.

Stage B is already **complete** — the repo scaffold, all four CDK stacks, guardrail Aspects,
CI workflows, and runbooks are written and tested. What remains is the manual AWS bootstrap
and the DNS migration.

```
Day 1     §0 Lock the decisions (region, account emails)
          §2 A1-A5  Org, accounts, Identity Center, SSO
          At GoDaddy: confirm auto-renew + transfer lock       ← no TTL change needed

Day 2     §2 A6     cdk bootstrap, steps 1-2 (BEFORE SCPs — see §10)
          §4 C1     Deploy bootstrap stack — creates the dev boundary policy
          §2 A6     steps 4-5: bootstrap hnbdev with the boundary, verify it attached
          §4 C2-C4  GitHub Environments, verify CI
                    ← the manual→automated handoff

Day 3     §5 D1-D2  Deploy DNS stack (origin=vercel), verify against Route53 NS
          §5 D3     Switch nameservers at GoDaddy               ← starts the 24-48h clock
          §6 E1-E3  SCPs, CloudTrail, budgets (manual: GuardDuty, cost tags)

Day 4-5   (waiting on delegation to propagate)
          §7 F1-F4  Seed SSM params, static export, deploy site,
                    verify on the CloudFront domain

Day 5+    §5 D4-D5  Confirm delegation, certificate issues
          §8 G1-G2  Apex cutover (origin=cloudfront), verify,
                    decommission Vercel after 24h clean
          §9        Walk the exit criteria
```

The critical path is delegation propagation (24-48h), which is why D3 happens on day 3
rather than day 5 — everything in §7 can proceed while it settles.
