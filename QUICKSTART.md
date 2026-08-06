# QUICKSTART — Phase 0, start to finish

A linear checklist for the first manual bootstrap. Follow it top to bottom. Every judgement
call has already been made; where a step needs a value, it is marked like
`<PLATFORM_ACCOUNT_ID>`.

This is the operational twin of `docs/phase-0-action-plan.md`. That document explains *why*.
This one says *what to type*. If the two disagree, the action plan wins — and tell someone.

All commands are PowerShell on Windows. Run them from the repo root unless a step says
otherwise.

**What you end up with:** `josephkan.ca` served from CloudFront, deployed by a merge to
`main`, with nobody touching the console.

---

## Before you start

| Need | Verify with | Want to see |
| --- | --- | --- |
| Node 20+ | `node --version` | `v20.x` or higher |
| pnpm 10+ | `pnpm --version` | `10.34.3` (the pinned `packageManager`) |
| AWS CLI v2 | `aws --version` | `aws-cli/2.x` |
| git | `git --version` | any recent version |

```powershell
node --version
pnpm --version
aws --version
git --version
```

Also have ready:

- **A credit card.** AWS requires one to open an account even at $0 spend.
- **GoDaddy account access** for `josephkan.ca`, including whatever MFA is on it.
- **A mailbox that supports plus-addressing** (Gmail, Fastmail, most others). You need two
  distinct addresses from one inbox, and you must control that inbox forever.
- **A phone or hardware key for MFA.** You will enable MFA on three identities.
- **Your OANDA account ID and a read-only OANDA personal access token.**

Read `docs/open-issues.md` before you start. Issues 2 and 6 both appear as steps below.

---

## Decisions to make now

Write these down before step 1. They are all effectively permanent.

| Decision | Value | Why it is hard to change |
| --- | --- | --- |
| Primary region | `us-east-1` | Baked into every stack, every ARN, every SSM path. ACM certificates for CloudFront must live in `us-east-1` regardless, so any other primary region means a cross-region certificate stack and a second bootstrap. |
| Identity Center region | `us-east-1` (must match) | Changing it requires deleting the entire Identity Center instance and every assignment. |
| Management account email | `you+aws-mgmt@gmail.com` | Account emails must be globally unique across all of AWS, permanently. They cannot be reused even after the account is closed. |
| Platform account email | `you+aws-platform@gmail.com` | Same. Use a mailbox you will hold forever. |
| GitHub repo | `JosephKan3/home-platform` | Encoded in every OIDC trust policy `sub` claim. Moving to an org later rewrites all three trust policies. |

`ca-central-1` becomes the right answer only if data residency becomes a stated requirement.
PIPEDA does not mandate residency. That is a Phase 2+ question.

---

## 1. AWS account, Organization, OUs

**Goal:** a management account that runs nothing, with an Organization and three OUs.

An **OU** (organizational unit) is a folder inside an Organization that accounts sit in; you
attach guardrail policies to the folder, so accounts added later inherit them automatically.

1. Use an existing AWS account **only if it has no workloads.** Otherwise create a new one
   with the management email from the decisions table.
2. Root user: strong unique password, **enable hardware or virtual MFA**, remove any root
   access keys.
3. Set the account alias and billing contact.
4. **Enable IAM access to billing data:** Account settings → IAM user and role access to
   Billing Information. Without this, non-root admins cannot see Cost Explorer.
5. Console → Organizations → Create organization → **All features**. Not "consolidated
   billing only" — SCPs require all features.
6. Create three OUs under Root:

```
Root
├── Security     (empty — reserved)
├── Workloads
└── Sandbox      (empty — reserved)
```

> **SCPs do not apply to the management account.** No guardrail written in step 9 will
> constrain it. That is precisely why nothing ever runs there.

**Success looks like:** Organizations console shows "All features enabled" and three OUs
under Root.

---

## 2. Create the Platform account

**Goal:** one workload account, inside `Workloads`, with its root user locked down.

1. Organizations → Add account → Create account.
   - Name: `Platform`
   - Email: the plus-addressed platform address from the decisions table
2. Move it into the `Workloads` OU immediately.
3. Take control of its root user: sign out, "Forgot password" against the Platform account
   email, set a password, enable MFA, and never use it again.

> **Do not create accounts casually.** AWS limits account closure to ~10% of your accounts
> per month, and new accounts have a waiting period before they can be closed at all.
> Create exactly these two.

**Record now, you will need all of it:** management account ID, platform account ID, both
root emails.

---

## 3. Identity Center, permission sets, SSO profiles

**Goal:** two named CLI profiles, `mgmt` and `platform`, that assume admin without root.

1. Enable IAM Identity Center in **`us-east-1`**. This region choice is effectively permanent.
2. Create a user for yourself. Enable MFA.
3. Create permission sets:
   - `AdministratorAccess` — session duration **4h** (not the default 1h, not 12h)
   - `ReadOnlyAccess` — session duration 8h
   - `Billing` — for cost work without admin rights
4. Assign yourself `AdministratorAccess` on **both** accounts.
5. Note the start URL: `https://d-xxxxxxxxxx.awsapps.com/start`

Then configure the CLI:

```powershell
aws configure sso
# Start URL: the one from step 5 above
# Region: us-east-1
# Profile names: mgmt and platform
```

Verify both:

```powershell
aws sts get-caller-identity --profile mgmt
aws sts get-caller-identity --profile platform
```

**Success looks like:** both return an ARN containing
`assumed-role/AWSReservedSSO_AdministratorAccess/`.

> **From this point, root is never used again** for either account. That is a Phase 0 exit
> criterion.

Sessions expire. An expired session surfaces as a credentials error *partway through* a
`cdk deploy`, not at the start. Re-run `aws sso login --profile platform` when that happens.

---

## 4. Set env vars and prove the repo builds

**Goal:** a green local test run before you touch AWS with CDK.

```powershell
$env:MGMT_ACCOUNT_ID     = "<MGMT_ACCOUNT_ID>"
$env:PLATFORM_ACCOUNT_ID = "<PLATFORM_ACCOUNT_ID>"
```

Put both in your PowerShell profile. Every synth, diff and deploy needs them.

```powershell
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
```

**Success looks like:** all tests pass and lint is clean. No AWS credentials are used —
`cdk synth` and the test suite make zero AWS API calls.

If you see `Error: Missing PLATFORM_ACCOUNT_ID. Set it in your shell or as a CI repository
variable.` the variable is either absent or was stripped by turbo. See
`docs/development.md` §6 and §7.

---

## 5. CDK bootstrap — the order is unusual and load-bearing

**Goal:** three bootstrap qualifiers, with the dev one carrying a permissions boundary.

> ### Read this before running anything in this step
>
> The order is **not** the obvious one. It is:
>
> 1. bootstrap the **management** account (`hnbmgmt`)
> 2. bootstrap the Platform account's **prod** qualifier (`hnbprod`)
> 3. **deploy `BootstrapStack`** — step 6 below, which lands in the middle of this step
> 4. bootstrap the Platform account's **dev** qualifier (`hnbdev`) with
>    `--custom-permissions-boundary`
>
> `--custom-permissions-boundary` takes a policy **name**, resolves it to
> `arn:aws:iam::<account>:policy/<name>` inside the bootstrap template, and **does not check
> that the policy exists** — the CLI only regex-validates the string. That policy is created
> by `BootstrapStack`. Run the dev bootstrap first and it fails opaquely while creating the
> CloudFormation execution role, with an error that does not name the missing policy.

> ### Bootstrap BEFORE the SCPs in step 9
>
> A region-lock SCP applied first can block all four bootstraps and produces a confusing
> failure. Governance is step 9 for this reason. Do not reorder.

Why three qualifiers at all: dev and prod share one account (ADR-0001), and a permissions
boundary only changes an outcome on the CDK CloudFormation execution role. One bootstrap per
account would give dev and prod a single shared execution role.

| Qualifier | Account | Boundary on `cdk-<q>-cfn-exec-role-*` |
| --- | --- | --- |
| `hnbmgmt` | Management | none |
| `hnbprod` | Platform | none |
| `hnbdev` | Platform | `cdk-dev-permissions-boundary` |

Run these from `infrastructure/bootstrap`. Confirm your SSO sessions are live first
(`aws sso login --profile platform`, and the same for `mgmt`).

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
$env:MGMT_ACCOUNT_ID     = "<management account id>"
```

### 5a. Bootstrap the management account

Separate account, separate qualifier, no boundary. Nothing else depends on this.

```powershell
npx cdk bootstrap aws://$env:MGMT_ACCOUNT_ID/us-east-1 --profile mgmt --qualifier hnbmgmt
```

### 5b. Bootstrap the Platform account's prod qualifier

No boundary, so nothing has to exist first.

```powershell
npx cdk bootstrap aws://$env:PLATFORM_ACCOUNT_ID/us-east-1 --profile platform --qualifier hnbprod
```

### 5c. Now go do step 6, then come back

Step 6 deploys `BootstrapStack`, which creates `cdk-dev-permissions-boundary`. Return here
once it succeeds.

### 5d. Bootstrap the Platform account's dev qualifier, with the boundary

Confirm the policy exists first. **This step fails opaquely if it does not.**

```powershell
aws iam get-policy --profile platform `
  --policy-arn "arn:aws:iam::$($env:PLATFORM_ACCOUNT_ID):policy/cdk-dev-permissions-boundary"
```

```powershell
npx cdk bootstrap aws://$env:PLATFORM_ACCOUNT_ID/us-east-1 --profile platform `
  --qualifier hnbdev `
  --custom-permissions-boundary cdk-dev-permissions-boundary
```

The CLI prints `Adding new permissions boundary cdk-dev-permissions-boundary`. That message
is not proof. Confirm the attachment:

```powershell
aws iam get-role --profile platform `
  --role-name "cdk-hnbdev-cfn-exec-role-$($env:PLATFORM_ACCOUNT_ID)-us-east-1" `
  --query "Role.PermissionsBoundary"
```

Expected: a `PermissionsBoundaryArn` ending in `policy/cdk-dev-permissions-boundary`.

The prod role must show `null`:

```powershell
aws iam get-role --profile platform `
  --role-name "cdk-hnbprod-cfn-exec-role-$($env:PLATFORM_ACCOUNT_ID)-us-east-1" `
  --query "Role.PermissionsBoundary"
```

### 5e. Run the boundary probe

The two-call probe in `infrastructure/bootstrap/README.md` ("Verify the boundary is
load-bearing") is a Phase 0 exit criterion and cannot be automated. Run it now, while you
have SSO admin credentials in hand, and record the result. Follow that README verbatim,
**including its step 4 cleanup** — its step 2 temporarily widens a trust policy.

The control call is the whole point: tagging an untagged bucket must **succeed** while
tagging an `env=prod` bucket is **denied**. Without the control, the denial proves only the
absence of an Allow, which is indistinguishable from the original bug (`docs/open-issues.md`
issue 1).

> **Qualifier mismatches are silent.** The value passed to `--qualifier` and the value a
> stack synthesizes with must be identical. Nothing checks them against each other; a
> mismatch surfaces at deploy time as an `AssumeRole` failure naming a role that was never
> created.

---

## 6. Deploy BootstrapStack and wire up GitHub

**Goal:** GitHub Actions can assume AWS roles with no stored access keys.

This is the one stack deployed by hand. It creates the identity CI uses, so CI cannot
create it. Run from `infrastructure/bootstrap`.

```powershell
npx cdk deploy BootstrapStack --profile platform
```

If the account already holds a GitHub OIDC provider (an account may have only one per issuer
URL), reference it instead of creating a second:

```powershell
npx cdk deploy BootstrapStack --profile platform `
  -c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

Confirm the boundary policy landed before returning to step 5d:

```powershell
aws iam get-policy --profile platform `
  --policy-arn "arn:aws:iam::$($env:PLATFORM_ACCOUNT_ID):policy/cdk-dev-permissions-boundary"
```

### GitHub repository variables

Settings → Secrets and variables → Actions → **Variables**. These are variables, not
secrets — none of them is confidential.

| Variable | Value |
| --- | --- |
| `AWS_PLAN_ROLE_ARN` | `BootstrapStack` output |
| `AWS_DEPLOY_DEV_ROLE_ARN` | `BootstrapStack` output |
| `AWS_DEPLOY_PROD_ROLE_ARN` | `BootstrapStack` output |
| `MGMT_ACCOUNT_ID` | management account ID |
| `PLATFORM_ACCOUNT_ID` | platform account ID |
| `WORKLOADS_OU_ID` | optional; lets CI synth `GovernanceStack` (see step 9) |
| `SANDBOX_OU_ID` | optional; same |

### GitHub Environments

Settings → **Environments**:

- `dev` — no protection rules.
- `prod` — **required reviewers: yourself.**

> Without the required reviewer on `prod`, the `environment:prod` `sub` claim is cosmetic.
> The review gate is the only thing separating prod from dev — prod's CDK execution role is
> deliberately unbounded.

**Success looks like:** three role ARNs in repository variables, two environments listed,
and no AWS access keys anywhere in the repo or in GitHub secrets.

---

## 7. Verify CI on a trivial PR

**Goal:** proof the OIDC handoff works before anything depends on it.

Open a pull request with a trivial change — a typo fix in a comment is enough.

Confirm on the PR:

- The `gha-plan` role authenticates (no `configure-aws-credentials` error).
- `cdk diff` posts.
- The plan role is read-only: nothing was created.
- No AWS credentials exist in the repo or in GitHub secrets other than the account IDs.

**Success looks like:** a green CI run with a posted diff.

From here, local `cdk deploy` is a break-glass action, not routine. The exceptions are
`BootstrapStack` (already done) and `GovernanceStack` (step 9), both of which are
deliberately hand-deployed.

---

## 8. DNS: deploy in `vercel` mode, verify, then delegate

**Goal:** move DNS hosting from GoDaddy to Route53 without the live site noticing.

`josephkan.ca` is serving right now from Vercel. The whole design of this step is to make the
nameserver switch a **no-op**: Route53 serves byte-identical answers, so no resolver observes
a change.

> **There is no TTL change at GoDaddy.** An earlier plan version said to lower TTLs first.
> That was wrong and it conflated two caches. Record TTL controls how long a resolver caches
> an *answer*; delegation controls *which nameservers are asked*. At the switch, both sides
> answer `76.76.21.21`, so nothing propagates and the old TTL is irrelevant. TTL only matters
> at the apex cutover (step 13), and `infrastructure/dns` already sets 300s on every record
> it creates.

### 8a. Deploy the DNS stack

Default `origin` is `vercel`. Run from `infrastructure/dns`.

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
npx cdk deploy DnsStack --profile platform
```

Record the outputs `PlatformZoneId` and `PlatformZoneNameServers`.

### 8b. Verify against the Route53 nameservers, before delegating

```powershell
$ns = (aws route53 get-hosted-zone --id <ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers

Resolve-DnsName josephkan.ca        -Server $ns[0]
Resolve-DnsName www.josephkan.ca    -Server $ns[0]
Resolve-DnsName _dmarc.josephkan.ca -Type TXT -Server $ns[0]
```

Expected:

- `josephkan.ca` → `A 76.76.21.21`
- `www.josephkan.ca` → `CNAME cname.vercel-dns.com`
- `_dmarc.josephkan.ca` → `TXT "v=DMARC1; p=reject;"`

Compare against what GoDaddy currently serves:

```powershell
Resolve-DnsName josephkan.ca     -Server ns73.domaincontrol.com
Resolve-DnsName www.josephkan.ca -Server ns73.domaincontrol.com
```

If the two do not agree on the apex A record and the `www` CNAME, **stop.** Fix
`vercelRecords` in `@platform/config` and redeploy before going further.

### 8c. Compare the FULL record set at GoDaddy

> **This is the single most important manual verification in Phase 0** (`docs/open-issues.md`
> issue 6). The DNS tests assert that the stack agrees with `@platform/config`. They cannot
> prove that `@platform/config` agrees with what GoDaddy is actually serving today.
>
> Open the GoDaddy DNS management page and read **every** record, not just the apex and
> `www`. If GoDaddy holds anything not replicated into the Route53 zone — a domain
> verification TXT, a CAA record, an MX record, anything Vercel added automatically — then
> the switch is **not** a no-op and the live site breaks on delegation.
>
> Any record that exists at GoDaddy and not in Route53 must be added to the stack and
> redeployed, then re-verified through 8b, before you touch nameservers.

While you are in GoDaddy, **confirm auto-renew and transfer lock are ON.** A lapsed
registration takes down both the platform and the product. That plus the record comparison
are the only GoDaddy tasks before delegation.

### 8d. Switch nameservers at GoDaddy

Only once 8b and 8c both pass. Replace GoDaddy's nameservers with the four Route53 ones from
the `PlatformZoneNameServers` output.

> **8d must not happen before 8b and 8c pass.** Delegating before the records are replicated
> takes the live site down immediately, and the fix then waits on registry propagation rather
> than on a 300s TTL.

### 8e. Wait and verify

**`.ca` registry propagation takes 24–48 hours.** Start the clock now; steps 9 through 12 all
proceed while it settles.

```powershell
Resolve-DnsName josephkan.ca -Type NS
# must return awsdns servers, not domaincontrol.com

Resolve-DnsName josephkan.ca
Resolve-DnsName www.josephkan.ca
# still the Vercel values — nothing has moved yet
```

Check from a second network (phone on cellular) before considering it done.

### 8f. Certificate

The ACM certificate is already in `DnsStack` and validates automatically once Route53 holds
the zone.

```powershell
aws acm list-certificates --region us-east-1 --profile platform
aws ssm get-parameter --name /platform/acm/josephkan.ca/certificate-arn --profile platform
```

**Success looks like:** status `ISSUED`. A certificate stuck in `PENDING_VALIDATION` after 8e
means delegation has not fully taken effect. Wait. Do not intervene manually.

---

## 9. Deploy governance — SCPs, CloudTrail, budgets

**Goal:** guardrails as code, attached to OUs.

> **Only now.** Steps 5, 6 and 7 must all have succeeded. A region-lock SCP applied earlier
> can block the very operations that establish your ability to deploy.

`GovernanceStack` targets the **management account**, which deliberately has no GitHub OIDC
deploy role. **It is deployed by hand**, with SSO admin credentials, and the `deploy-prod`
job contains an explicit `exit 1` saying so. (`docs/phase-0-action-plan.md` §6 implies CI
deploys it; that is wrong — see `docs/open-issues.md` issue 3.)

Enable CloudTrail as a trusted service for Organizations first. Without it, CloudFormation
fails when creating the organization trail.

```powershell
aws organizations enable-aws-service-access `
  --service-principal cloudtrail.amazonaws.com --profile mgmt
```

Get the OU IDs:

```powershell
aws organizations list-roots --profile mgmt
aws organizations list-organizational-units-for-parent --parent-id <root id> --profile mgmt
```

Deploy from `infrastructure/org`:

```powershell
$env:MGMT_ACCOUNT_ID = "<management account id>"
npx cdk deploy GovernanceStack --profile mgmt `
  -c workloadsOuId=ou-xxxx-xxxxxxxx `
  -c sandboxOuId=ou-xxxx-xxxxxxxx `
  -c organizationId=o-xxxxxxxxxx `
  -c alertEmail=you@example.com `
  -c budgetAccountId=<platform account id>
```

`workloadsOuId` and `sandboxOuId` are required; synth fails with a named error if either is
missing. `alertEmail` and `budgetAccountId` are optional, but the cost anomaly subscription
is only created when `alertEmail` is supplied.

**Success looks like:** three attached policies (`platform-region-lock`,
`platform-cost-guardrails`, `platform-security-guardrails`) on both the `Workloads` and
`Sandbox` OUs, an organization trail, a $10 budget and an anomaly monitor.

> **Never shorten the region lock's global-service exemption list.** One deleted namespace
> denies every IAM call, every Organizations call (so the SCP cannot be detached from inside
> the org), every Route53 call, every CloudFront call, and every Support call — all at once.
> Treat any diff that shortens `GLOBAL_SERVICE_NAMESPACES` as a defect.

> **None of these constrain the management account.** That is the escape hatch that makes a
> mistaken SCP recoverable, and it is exactly why nothing runs there.

---

## 10. Manual console steps

**Goal:** the two things with no clean CloudFormation path.

Both are account-level toggles. Do them now — the second one has a ~24h lead time and is not
retroactive.

| Task | Where | Note |
| --- | --- | --- |
| **Enable GuardDuty** on the Platform account | GuardDuty console, Platform account, `us-east-1` | 30-day free trial, then ~$3–10/mo. Keep it. The `protectAuditPolicy` SCP then prevents anyone turning it back off. |
| **Activate cost allocation tags** `app`, `env`, `owner` | Billing → Cost allocation tags, management account | Takes ~24h to appear and applies **only going forward**. With one workload account these tags are the only billing breakdown you get. |

Also create a **temporary $0.01 budget threshold** so you can prove a budget alert actually
fires — that is a Phase 0 exit criterion. Budgets take ~24h before their first evaluation.

AWS Config is deliberately skipped. Its per-item recording charges creep and nothing needs it.

---

## 11. Seed the OANDA SSM parameters

**Goal:** two SecureString parameters the fetcher Lambda reads at cold start.

Seeded by hand, out of band. They are not in CDK because a secret value in a CloudFormation
template is a secret in every deploy log.

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

**Success looks like:** both `put-parameter` calls return a `Version`. Full verification comes
in step 12, after the Lambda exists.

---

## 12. Site changes, static export, deploy, verify on CloudFront

**Goal:** the site fully working on `dxxxx.cloudfront.net`, before any DNS change.

### 12a. Change the site code

In the site repo (`github.com/JosephKan3/personal-website`), both edits are in
`pages/index.tsx`:

```diff
-        const response = await fetch("/api/oandaReturn");
+        const response = await fetch("/data/oanda-returns.json");
```

```diff
-        const response = await fetch("/api/oandaTrades");
+        const response = await fetch("/data/oanda-trades.json");
```

The response shapes are unchanged, so `LineChart` and `PieChart` need no edits.

Cleanups while you are in there:

| Change | Why |
| --- | --- |
| Delete `next.config.mjs`, keep `next.config.js` | Both exist; Next uses one and silently ignores the other. `next.config.js` carries the real config (`sassOptions.includePaths`, `optimizeFonts`); `next.config.mjs` only sets `reactStrictMode`, which the other already sets. |
| Remove `"add": "^2.0.6"` from `package.json` | A stray `npm install add`. Not imported anywhere. |
| Delete the ~35 lines of commented-out code at the top of `pages/api/oandaReturn.ts` | Superseded implementation. First thing anyone reading that file trips over. |
| Delete **both** API routes | `pages/api/oandaReturn.ts` and `pages/api/oandaTrades.ts`. `next export` refuses to run while `pages/api/` exists. **Do this after 12d verifies the charts**, not before. |

`axios` and `utils/request.ts` become unused once the routes are gone.

Do **not** upgrade Next.js 12 now. It is past EOL and the upgrade is worth doing, but it must
not block Phase 0. Schedule it for a week after the apex cutover is stable.

### 12b. Build the static export

Next 12, in the site repo:

```powershell
npm run build      # in the site repo
npx next export    # writes ./out
```

### 12c. Deploy the site stack

Run from `applications/personal-site`:

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
npx cdk deploy PersonalSiteStack --profile platform
```

By default the stack reads the export from `../../../personal-page/out` relative to that
package — a sibling checkout of the site repo. Override it:

```powershell
npx cdk deploy PersonalSiteStack -c siteSourcePath=C:\path\to\out --profile platform
```

> **Never deploy with `-c sitePlaceholder=true`.** That flag renders a generated inline
> `index.html` so CI can synth without the site checked out. Deploying it would publish a
> placeholder page to a live domain.

**A new CloudFront distribution takes 15–20 minutes to deploy.** That is normal. Wait.

### 12d. Verify the data path and the site

Invoke the fetcher once by hand rather than waiting an hour for the schedule:

```powershell
aws lambda invoke --function-name <fetcher name> --profile platform out.json
aws s3 ls s3://<bucket>/data/ --profile platform
```

Then verify on the CloudFront domain, using the stack's `DistributionDomainName` output:

```powershell
curl.exe -I https://dxxxx.cloudfront.net
curl.exe https://dxxxx.cloudfront.net/data/oanda-returns.json
curl.exe https://dxxxx.cloudfront.net/data/oanda-trades.json
```

**Success looks like:** `200` on the site, and both JSON files return real data. Then open
`https://dxxxx.cloudfront.net` in a real browser and confirm **the charts render.** Not just
the page — the charts.

Do not go to step 13 until this passes fully.

---

## 13. The apex cutover

**Goal:** `josephkan.ca` serves from CloudFront.

This is the single highest-risk moment in Phase 0, deliberately isolated to two records.

> **It is reversible in about five minutes and does not touch nameservers.** Every record
> `infrastructure/dns` creates carries a 300s TTL, so redeploying with `origin=vercel` puts
> the old values back within five minutes. That is the entire reason step 8d and this step
> are separate events: a problem with the AWS deployment is a record change, not a 24–48h
> registry propagation.

Preconditions, all of them:

- Step 8e shows AWS nameservers for `josephkan.ca`.
- Step 8f shows the certificate `ISSUED`.
- Step 12d passed, charts included.
- Vercel is still serving. It is the fallback.

Run `cdk diff` first. It should show exactly two changes: the apex `A` record replaced by an
ALIAS, and the `www` `CNAME` replaced by an ALIAS. **If anything else moves, stop.**

From `infrastructure/dns`:

```powershell
npx cdk deploy DnsStack --profile platform `
  -c origin=cloudfront `
  -c cloudFrontDomainName=dxxxx.cloudfront.net
```

ALIAS is required, not CNAME: DNS forbids a CNAME at a zone apex because the apex holds SOA
and NS records, and CloudFront publishes a hostname rather than a stable IP. ALIAS queries
are free.

For a permanent flip, change `"origin": "vercel"` to `"origin": "cloudfront"` in `cdk.json`
and add `"cloudFrontDomainName"` next to it, so CI deploys the cut-over state by default.

**Rollback**, if anything looks wrong:

```powershell
npx cdk deploy DnsStack --profile platform -c origin=vercel
```

Or revert the `cdk.json` change and let CI redeploy. Nameservers are not touched.

---

## 14. Verify, then decommission Vercel

```powershell
Resolve-DnsName josephkan.ca
Resolve-DnsName www.josephkan.ca
curl.exe -I https://josephkan.ca
curl.exe -I https://www.josephkan.ca
```

Check the certificate, the security headers, and the charts in a **real browser**.

Then delete the two Next.js API routes from the site repo (12a), since the Lambda is now the
data path.

**Remove the Vercel project for the personal site only after 24 hours of clean operation.**
Not before. Until then it is the rollback target.

---

## Exit checklist

Phase 0 is done when **all** of these are true.

- [ ] A merge to `main` deploys `josephkan.ca` with **nobody touching the console**
- [ ] `https://josephkan.ca` serves from CloudFront with a valid ACM cert and charts render
- [ ] Vercel is off for the personal site
- [ ] Root credentials have not been used since step 3
- [ ] No IAM users and no access keys exist in either account
- [ ] `Resolve-DnsName josephkan.ca -Type NS` returns AWS nameservers
- [ ] `cdk-hnbdev-cfn-exec-role-*` carries `cdk-dev-permissions-boundary` and
      `cdk-hnbprod-cfn-exec-role-*` carries none (step 5d)
- [ ] The manual probe in `infrastructure/bootstrap/README.md` shows the dev execution role
      **denied** tagging an `env=prod` resource **while succeeding** on an untagged one. The
      control call is the point: without it the denial proves only the absence of an Allow.
      CI asserts the offline preconditions
      (`infrastructure/bootstrap/test/dev-permissions-boundary.test.ts`) but cannot execute an
      IAM evaluation, so this one is signed off by hand
- [ ] All three Aspects fail synth in their unit tests
- [ ] A deliberate `SubnetType.PRIVATE_WITH_EGRESS` in a scratch branch **fails CI**
- [ ] A budget alert has fired at least once (set the threshold to $0.01 temporarily to
      prove it)
- [ ] Cost allocation tags appear in Cost Explorer
- [ ] The monthly bill is **under $8**
- [ ] A teardown runbook exists for everything built in this phase

---

## If something goes wrong

| Symptom | Go to |
| --- | --- |
| `josephkan.ca` is down, 404s, serves the wrong page, has a TLS error, or the charts are broken | `docs/runbooks/dns-rollback.md` |
| CI fails at `configure-aws-credentials`, or a deploy fails with `AccessDenied` while you hold admin, or an SCP has locked you out | `docs/runbooks/break-glass.md` |
| You need to deliberately destroy what Phase 0 built | `docs/runbooks/teardown-phase-0.md` |
| `Missing PLATFORM_ACCOUNT_ID`, an `AssumeRole` failure naming a `cdk-<qualifier>-*` role, a cdk-nag error, a false "Missing required tag(s)", a jest module resolution error, or an unexplained `AccessDenied` inside `ROLLBACK_IN_PROGRESS` | the troubleshooting table in `docs/development.md` §7 |
| Something contradicts this document | `docs/phase-0-action-plan.md`, then `docs/open-issues.md` |

Two failure modes worth recognising on sight:

- **`AccessDenied` / `UnauthorizedOperation` with no useful detail, inside a
  `ROLLBACK_IN_PROGRESS`** — that is an SCP denial. SCPs deny at the account boundary and
  CloudFormation surfaces the raw API error with no mention of the policy.
- **`AccessDenied` in a dev deploy on a resource tagged `env=prod`** — working as designed.
  That is the permissions boundary doing its job.
