# QUICKSTART — Phase 0, start to finish.

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

**Progress:** step 1 is complete — see the note at the end of it. Start at step 2.

---

## Decisions to make now

Write these down before step 1. They are all effectively permanent.

| Decision | Value | Why it is hard to change |
| --- | --- | --- |
| Primary region | `us-east-1` | Baked into every stack, every ARN, every SSM path. ACM certificates for CloudFront must live in `us-east-1` regardless, so any other primary region means a cross-region certificate stack and a second bootstrap. |
| Identity Center region | `us-east-1` (must match) | Changing it requires deleting the entire Identity Center instance and every assignment. |
| Management account email | `josephkan3+infra@gmail.com` (**settled**) | Account emails must be globally unique across all of AWS, permanently. They cannot be reused even after the account is closed. |
| Platform account email | `josephkan3+platform@gmail.com` | Same. Use a mailbox you will hold forever. |
| GitHub repo | `JosephKan3/home-platform` | Encoded in every OIDC trust policy `sub` claim. Moving to an org later rewrites all three trust policies. |

Real account, organization and OU identifiers are **not committed** — they live in
`.env.local`, which is gitignored. Copy `.env.example` to `.env.local` and fill it in as each
step produces a value. Account IDs are not secret, but they are free reconnaissance
(`docs/development.md` §6).

`ca-central-1` becomes the right answer only if data residency becomes a stated requirement.
PIPEDA does not mandate residency. That is a Phase 2+ question.

---

## 1. AWS account, Organization, OUs — DONE

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

### Why these OUs and not `dev` / `qa` / `prod`

The obvious instinct is to make the OUs environments. Resist it. **An OU is a policy
boundary, not a label** — the only thing an OU does is attach SCPs, and accounts inherit
them. So group accounts by *which guardrails they need*, not by lifecycle stage:

| OU | Guardrails it will carry |
| --- | --- |
| `Security` | Audit/log-archive accounts. Deny deleting trails, deny everything but security tooling. Reserved until CloudTrail and GuardDuty graduate out of the management account (ADR-0001 records that as a known deviation). |
| `Workloads` | Region lock, no NAT/TGW, no IAM users, instance-family denies. Step 9 attaches all three SCPs here. |
| `Sandbox` | Deliberately *looser* than Workloads, with a tighter budget. Somewhere to break things without the workload SCPs in the way. |

`dev`, `qa` and `prod` would all need the *same* SCPs, so splitting them into OUs buys
nothing — you would attach identical policies three times and gain no isolation.

The real reason people reach for dev/qa/prod is **account** isolation, and the way to get
that is accounts *inside* `Workloads`:

```
Workloads
├── Platform-Dev
└── Platform-Prod
```

ADR-0001 deliberately declines that for now: dev and prod share the single Platform account,
separated by CDK stages, the `env` tag plus a permissions boundary, and security groups.
That is a documented compromise, not an oversight. When prod graduates to its own account it
drops into `Workloads` and inherits every guardrail on day one with no policy rewrite —
which is the entire payoff of grouping by policy instead of by environment.

> **SCPs do not apply to the management account.** No guardrail written in step 9 will
> constrain it. That is precisely why nothing ever runs there.

**Success looks like:** Organizations console shows "All features enabled" and three OUs
under Root.

**Completed 2026-09-11.** Organization created with all features and the SCP policy type
enabled. Management account `joseph_kan_infra` (alias `josephkan-infra`), root MFA on, one
IAM admin user. The three OUs exist and are empty. Real IDs are in `.env.local`; re-read
them at any time with:

```powershell
aws organizations describe-organization --profile mgmt
aws organizations list-organizational-units-for-parent --parent-id $env:ROOT_OU_ID --profile mgmt
```

---

## 2. Create the Platform account — DONE except root lockdown

**Goal:** one workload account, inside `Workloads`, with its root user locked down.

1. Organizations → Add account → Create account.
   - Name: `Platform`
   - Email: `josephkan3+platform@gmail.com`
2. Move it into the `Workloads` OU immediately:

   ```powershell
   aws organizations move-account --profile mgmt `
     --account-id <new platform account id> `
     --source-parent-id $env:ROOT_OU_ID `
     --destination-parent-id $env:WORKLOADS_OU_ID
   ```

3. Record the new account ID as `PLATFORM_ACCOUNT_ID` in `.env.local`.
4. Take control of its root user: sign out, "Forgot password" against the Platform account
   email, set a password, enable MFA, and never use it again.

> **Do not create accounts casually.** AWS limits account closure to ~10% of your accounts
> per month, and new accounts have a waiting period before they can be closed at all.
> Create exactly these two.

**Record now, you will need all of it:** management account ID, platform account ID, both
root emails. The first goes in `.env.local` as `MGMT_ACCOUNT_ID` (already there), the second
as `PLATFORM_ACCOUNT_ID`.

**Completed 2026-09-11**, except step 4. Account `Platform`
(`josephkan3+platform@gmail.com`) created and moved into `Workloads`;
`PLATFORM_ACCOUNT_ID` is recorded in `.env.local`. Verify the placement with:

```powershell
aws organizations list-accounts-for-parent --parent-id $env:WORKLOADS_OU_ID --profile mgmt
```

> **Step 4 is still outstanding.** The Platform root user has whatever password AWS
> generated and **no MFA**. It is the most privileged identity in the account and no SCP
> constrains a root user. Do the password reset and MFA enrolment before deploying anything
> into this account.

---

## 3. Identity Center, permission sets, SSO profiles — done

**Goal:** two named CLI profiles, `mgmt` and `platform`, that assume admin without root.

**IAM Identity Center** is the replacement for IAM users. Rather than a permanent
username, password and access key, you sign in once (`aws sso login`) and receive
credentials that expire, which the CLI refreshes on demand. It is free. The point is
blast radius: a leaked access key is permanent access, a leaked SSO token expires. This
is why "no IAM users and no access keys" is an exit criterion.

What exists:

- Identity Center enabled in `us-east-1`.
- One permission set, `AdministratorAccess`, session duration **12h** (the AWS maximum).
  `ReadOnlyAccess` and `Billing` permission sets were deliberately **not** created — this
  is a single-operator home lab, not a multi-person org, and the extra profiles buy
  least-privilege separation this threat model doesn't need. Revisit if that changes.
- Assigned to **both** accounts (management and Platform — see `.env.local`).
- Start URL: recorded in `.env.local` as `SSO_START_URL`, not here (gitignored; see below).

`~/.aws/config` has an `[sso-session homelab]` block plus `mgmt` and `platform` profiles
pointing at it (`sso_account_id` + `sso_role_name = AdministratorAccess`), written directly
rather than through `aws configure sso`. It also holds a `legacy` profile pointing at an
unrelated older personal account — leave it alone and never deploy through it. The
`default` profile is deliberately left with no credentials so that a forgotten `--profile`
fails loudly instead of hitting the wrong organization.

Log in once (covers both profiles, since they share the sso-session):

```powershell
aws sso login --profile mgmt
```

Verify both:

```powershell
aws sts get-caller-identity --profile mgmt
aws sts get-caller-identity --profile platform
```

**Success looks like:** both return an ARN containing
`assumed-role/AWSReservedSSO_AdministratorAccess_.../`.

The interim static access key and IAM user `joseph-kan-infra-admin` (bridge for steps 1–2,
before Identity Center existed) have been **deleted** — key, MFA device, login profile,
attached policy, and the user itself. Verified `aws iam list-users --profile mgmt` returns
empty.

> **12h session note:** since sessions last 12h, `aws sso login --profile mgmt` is a
> rare, not hourly, chore. When a command fails with an expired-token error, that's the
> only fix needed — not a broken setup.

> **From this point, root is never used again** for either account. That is a Phase 0 exit
> criterion.

Sessions expire. An expired session surfaces as a credentials error *partway through* a
`cdk deploy`, not at the start. Re-run `aws sso login --profile platform` when that happens.

---

## 4. Set env vars and prove the repo builds

**Goal:** a green local test run before you touch AWS with CDK.

Load everything recorded so far from `.env.local`:

```powershell
Get-Content .env.local | Where-Object { $_ -match '^\s*[^#\s]' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
```

Every synth, diff and deploy needs `MGMT_ACCOUNT_ID` and `PLATFORM_ACCOUNT_ID`. Put the
loader in your PowerShell profile, or set the two by hand each session.

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

Both account IDs must be in the session; load `.env.local` as in step 4.

> **`--qualifier` does not rename the CloudFormation stack.** `cdk bootstrap` always creates
> a stack named `CDKToolkit` unless `--toolkit-stack-name` is also passed — the qualifier only
> changes the *role and bucket names inside it*. Two qualifiers bootstrapped into the same
> account and region without distinct `--toolkit-stack-name` values collide on one stack, and
> the second bootstrap **deletes and replaces** the first one's roles. This happened once
> during initial setup: `hnbprod` was silently destroyed when `hnbdev` was bootstrapped
> straight after it, both defaulting to `CDKToolkit`. Every command below passes an explicit,
> distinct `--toolkit-stack-name` for this reason. Management gets no suffix because it is the
> only qualifier ever bootstrapped into that account and region — nothing to collide with.

### 5a. Bootstrap the management account

Separate account, separate qualifier, no boundary. Nothing else depends on this.

```powershell
npx cdk bootstrap aws://$env:MGMT_ACCOUNT_ID/us-east-1 --profile mgmt --qualifier hnbmgmt
```

### 5b. Bootstrap the Platform account's prod qualifier

No boundary, so nothing has to exist first.

```powershell
npx cdk bootstrap aws://$env:PLATFORM_ACCOUNT_ID/us-east-1 --profile platform --qualifier hnbprod --toolkit-stack-name CDKToolkit-hnbprod
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
  --custom-permissions-boundary cdk-dev-permissions-boundary `
  --toolkit-stack-name CDKToolkit-hnbdev
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

## 6. Deploy BootstrapStack and wire up GitHub — done

**Goal:** GitHub Actions can assume AWS roles with no stored access keys.

This is the one stack deployed by hand. It creates the identity CI uses, so CI cannot
create it. Deployed from `infrastructure/bootstrap`:

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

### The repo did not exist yet

`JosephKan3/home-platform` did not exist before this step — created with
`gh repo create JosephKan3/home-platform --private --source=. --remote=origin --push`, then
made **public** (see below) once GitHub Environments' required-reviewers rule turned out to
need it.

### GitHub repository variables — set

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

### GitHub Environments — set, and why the repo is public

Settings → **Environments**:

- `dev` — no protection rules.
- `prod` — **required reviewers: yourself.**

> Without the required reviewer on `prod`, the `environment:prod` `sub` claim is cosmetic.
> The review gate is the only thing separating prod from dev — prod's CDK execution role is
> deliberately unbounded.

**The required-reviewers protection rule needs a paid plan on a private repo, and is free on a
public one.** GitHub returns `422 Failed to create the environment protection rule... billing
plan` when attempted against a private repo on the free plan. Since this repo stores no
secrets (OIDC-only auth; account IDs are non-secret reconnaissance, not credentials — see
`docs/development.md` §6), the repo was made public rather than paying for Team, and required
reviewers now works.

**Success looks like:** three role ARNs in repository variables, two environments listed
(`dev` with no rules, `prod` with `required_reviewers`), and no AWS access keys anywhere in
the repo or in GitHub secrets. All verified.

---

## 7. Verify CI on a trivial PR — done, and it found two real bugs

**Goal:** proof the OIDC handoff works before anything depends on it.

This is exactly why the step exists: PR #9, the first PR ever opened against this repo,
surfaced two latent bugs that a from-scratch synth/deploy never would have, because CI had
never before run against a real branch diff.

**Bug 1 — `turbo --filter` never reached turbo.** `ci.yml` and `deploy.yml` ran
`pnpm run <script> -- --filter=...`. `pnpm run <script> -- <args>` still prepends pnpm's own
`--` before forwarding, so the actual command turbo saw was
`turbo run <script> -- --filter=...`. Turbo treats anything after its own `--` as a
pass-through argument for each package's underlying script, not as a turbo flag — so
`--filter` never filtered anything at the turbo level. It fell through to every leaf package's
bare `eslint`/`tsc`/`jest` invocation, which doesn't understand `--filter` and exits 2. Fix:
drop the extra `--`. `pnpm run <script> --filter=...` (no `--`) lets pnpm's own arg-forwarding
put `--filter` directly after `turbo run <script>`, where turbo consumes it itself.

**Bug 2 — the OIDC trust policies used the wrong subject format.** GitHub repositories created
after 2026-07-15 get an **immutable** `sub` claim format,
`repo:OWNER@OWNER-ID/REPO@REPO-ID:...`, not the legacy `repo:OWNER/REPO:...`. This repo was
created today, during step 6, so every trust policy in `GitHubOidcStack` used the legacy format
and matched nothing. `AssumeRoleWithWebIdentity` was denied with no indication of *why* — IAM
does not echo back a rejected token's actual claims. Fixed by adding `githubOwnerId`/
`githubRepoId` to `GitHubOidcStack` (real values are public metadata for a public repo, not
secrets) and redeploying `BootstrapStack`.

Confirmed on the PR after both fixes:

- The `gha-plan` role authenticates (`Assume gha-plan` step succeeded).
- `cdk diff` posted as a PR comment (`<!-- cdk-diff -->` marker, from `github-actions[bot]`).
- The plan role is read-only: nothing was created.
- No AWS credentials exist in the repo or in GitHub secrets other than the account IDs.

**Success looks like:** a green CI run with a posted diff. PR #9 merged with all fixes.

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

### 8c. Compare the FULL record set at GoDaddy — done

> **This is the single most important manual verification in Phase 0** (`docs/open-issues.md`
> issue 6). The DNS tests assert that the stack agrees with `@platform/config`. They cannot
> prove that `@platform/config` agrees with what GoDaddy is actually serving today.

Read directly from the GoDaddy DNS management page: `A @ 76.76.21.21`, `NS @`
(GoDaddy's own, replaced by the switch), `CNAME www → cname.vercel-dns.com`,
`CNAME _domainconnect → _domainconnect.gd.domaincontrol.com`, `SOA @`. No MX, no apex TXT,
no CAA.

Every record needed for the site matches the Route53 zone from 8a. One record does **not**
appear in Route53: `_domainconnect`, GoDaddy's proprietary Domain Connect auto-configuration
CNAME. Decided to **not** replicate it — it is a GoDaddy platform feature (one-click DNS setup
for third-party services through GoDaddy's own API) with no function once GoDaddy stops being
the authoritative host. Skipping it does not make the switch a non-no-op. Full reasoning and
the record table are in `docs/open-issues.md` issue 6.

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

## 9. Deploy governance — SCPs, CloudTrail, budgets — done

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

The OU IDs were recorded in `.env.local` at step 1. Re-read them from AWS at any time:

```powershell
aws organizations list-roots --profile mgmt
aws organizations list-organizational-units-for-parent --parent-id $env:ROOT_OU_ID --profile mgmt
```

Deploy from `infrastructure/org`, with `.env.local` loaded into the session (step 4):

```powershell
npx cdk deploy GovernanceStack --profile mgmt `
  -c workloadsOuId=$env:WORKLOADS_OU_ID `
  -c sandboxOuId=$env:SANDBOX_OU_ID `
  -c organizationId=$env:ORGANIZATION_ID `
  -c alertEmail=josephkan3+aws-alerts@gmail.com `
  -c budgetAccountId=$env:PLATFORM_ACCOUNT_ID
```

Note that `Security` is **not** a target. It is empty and reserved; attaching SCPs to an
empty OU does nothing. Add it when it holds an account.

`workloadsOuId` and `sandboxOuId` are required; synth fails with a named error if either is
missing. `alertEmail` and `budgetAccountId` are optional, but the cost anomaly subscription
is only created when `alertEmail` is supplied.

**Success looks like:** three attached policies (`platform-region-lock`,
`platform-cost-guardrails`, `platform-security-guardrails`) on both the `Workloads` and
`Sandbox` OUs, an organization trail, a $10 budget and an anomaly monitor. Confirmed via
`aws organizations list-policies-for-target`, `aws cloudtrail describe-trails` (trail is
named `platform-org-trail`, not literally `OrgTrail` — that's the CDK logical ID),
`aws budgets describe-budgets`, and `aws ce get-anomaly-monitors`/`get-anomaly-subscriptions`.

> **AWS auto-creates a default cost anomaly monitor the first time Cost Explorer runs**
> (`Default-Services-Monitor`, `DIMENSIONAL`/`SERVICE`, $100/40% threshold, unrelated
> subscriber email). Only one `DIMENSIONAL`/`SERVICE` monitor is allowed per account, so
> `CfnAnomalyMonitor` in this stack fails with `CREATE_FAILED: Limit exceeded on dimensional
> spend monitor creation (AlreadyExists)` if that default exists — which rolls back the
> **entire** stack, not just the monitor, since everything is one CloudFormation transaction.
> Fix: delete the AWS default first (subscription before monitor — the monitor can't be
> deleted while a subscription references it), then redeploy:
> ```powershell
> aws ce get-anomaly-subscriptions --profile mgmt
> aws ce delete-anomaly-subscription --subscription-arn <arn> --profile mgmt
> aws ce get-anomaly-monitors --profile mgmt
> aws ce delete-anomaly-monitor --monitor-arn <arn> --profile mgmt
> ```
> An AWS-default "My Zero-Spend Budget" may also exist alongside `platform-monthly-cost` —
> harmless, redundant, and left alone; multiple budgets don't collide the way monitors do.

> **Never shorten the region lock's global-service exemption list.** One deleted namespace
> denies every IAM call, every Organizations call (so the SCP cannot be detached from inside
> the org), every Route53 call, every CloudFront call, and every Support call — all at once.
> Treat any diff that shortens `GLOBAL_SERVICE_NAMESPACES` as a defect.

> **None of these constrain the management account.** That is the escape hatch that makes a
> mistaken SCP recoverable, and it is exactly why nothing runs there.

---

## 10. Manual console steps — GuardDuty and the probe budget done; tags pending 24h

**Goal:** the two things with no clean CloudFormation path.

Both are account-level toggles. The second has a ~24h lead time and is not retroactive.

| Task | Status | Note |
| --- | --- | --- |
| **Enable GuardDuty** on the Platform account | **Done**, via CLI (`aws guardduty create-detector --enable --region us-east-1 --profile platform`), no console needed | 30-day free trial, then ~$3–10/mo. `Status: ENABLED`, detector `5ad049a2e7f1ec4d253f39bc27503297`. The `protectAuditPolicy` SCP (already attached, step 9) now prevents anyone turning it back off. |
| **Activate cost allocation tags** `app`, `env`, `owner` | **Pending** — cannot activate yet | `aws ce update-cost-allocation-tags-status` fails with `Tag keys not found` until AWS has ingested billing data carrying those tag keys, which itself takes up to 24h after the tagged resources (Platform account, DNS stack, etc.) start incurring cost. Re-check with `aws ce list-cost-allocation-tags --profile mgmt`; once the three keys appear (`Status: Inactive`), activate with `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=app,Status=Active TagKey=env,Status=Active TagKey=owner,Status=Active --profile mgmt`. No console needed. |

**Temporary $0.01 budget threshold — done, via CLI**, to prove a budget alert actually fires
(Phase 0 exit criterion). Created `phase0-alert-probe`, `$0.01` MONTHLY, `ACTUAL > $0`,
notifying `+aws-alerts@`. Budgets take ~24h before their first evaluation; check back with
`aws budgets describe-budget --account-id $env:MGMT_ACCOUNT_ID --budget-name phase0-alert-probe
--profile mgmt` and watch for the alert email. **Delete this budget once it has fired once** —
it is a one-time probe, not a permanent guardrail (`platform-monthly-cost` from step 9 is the
real one).

AWS Config is deliberately skipped. Its per-item recording charges creep and nothing needs it.

---

## 11. Seed the OANDA SSM parameters — done

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

**Success looks like:** both `put-parameter` calls return a `Version`. Confirmed both exist as
`SecureString`, version 1. Values were entered directly by hand, never pasted into chat — the
correct way to run this step. Full verification comes in step 12, after the Lambda exists.

---

## 12. Site changes, static export, deploy, verify on CloudFront — done

**Goal:** the site fully working on `dxxxx.cloudfront.net`, before any DNS change.

Deployed to `d3on7sazi3p8l.cloudfront.net`. All of 12a–12d passed, including the deferred
API-route deletion (12a's last cleanup) once 12d confirmed the charts render in a real
browser. Full record of what happened, including one undocumented Next 12.1.6 bug this run
found, is below.

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

### 12b. Build the static export — done, with one undocumented fix required

Next 12, in the site repo:

```powershell
npm run build      # in the site repo
npx next export    # writes ./out
```

> **`next export` fails on this Next 12.1.6 install with every `<Image>` using the default
> loader**, even with `images: { unoptimized: true }` set. That flag is what a later Next.js
> version added to bypass this exact check — the installed 12.1.6 build's `next export`
> (`node_modules/next/dist/export/index.js`) only inspects `images.loader`, never
> `images.unoptimized`, so `unoptimized: true` alone changes nothing here. The fix: set
> `images: { loader: "custom" }` in `next.config.js`, and pass a passthrough `loader` prop
> (`utils/imageLoader.ts` — returns `src` unchanged, since every image here is a static import
> already resolved to a final URL) to **every** `next/image` `<Image>` in the site: the
> headshot and `ProjectCard` in `pages/index.tsx`/`components/ProjectCard/ProjectCard.tsx`,
> and one hero image each in `pages/projects/{advancedRedditFilters,gptuwu,spotitube}.tsx`.
> Missing even one still fails the export.

### 12c. Deploy the site stack

Run from `applications/personal-site`:

```powershell
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

**All passed.** Fetcher invoke logged `oanda.published`, 88 return points, 6 instruments,
75.58% total return, no errors. Both `data/*.json` objects landed in the site bucket. `curl`
confirmed `200` with full security headers (CSP, HSTS, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`) and real data on both JSON endpoints — matching the
compiled JS bundle's fetch calls exactly (`fetch("/data/oanda-returns.json")` /
`fetch("/data/oanda-trades.json")`, confirmed by inspecting the deployed bundle). Charts
confirmed rendering in a real browser. Only then were `pages/api/`, `axios`, and
`utils/request.ts` deleted and the site redeployed (fast update, ~99s — only the S3 content
changed, not the CloudFront distribution itself).

Do not go to step 13 until this passes fully. It has.

---

## 13. The apex cutover — done, hit one real deploy failure

**Goal:** `josephkan.ca` serves from CloudFront.

This is the single highest-risk moment in Phase 0, deliberately isolated to two records.

> **The first two deploy attempts failed on `www` with `RRSet of type A ... is not permitted
> because a conflicting RRSet of type CNAME with the same DNS name already exists`.**
> Route53 forbids a CNAME and an A/ALIAS record coexisting at the same name, even
> momentarily — but CloudFormation's default record replacement is create-then-delete, so it
> tried to create the new `WwwCloudFrontRecord` (type A/ALIAS) while the old
> `WwwVercelRecord` (type CNAME) still existed. The `www` create failed both times; the
> **apex create succeeded both times** (A→A/ALIAS has no such conflict), so the first
> attempt's automatic rollback left a real split-brain: apex live on CloudFront,
> `www` rolled back to Vercel, and — worse — **CloudFormation's own tracked state diverged
> from the live Route53 record** (it believed the apex rollback to Vercel succeeded; it
> hadn't, confirmed by `aws route53 list-resource-record-sets` showing the CloudFront ALIAS
> still live while `cdk diff -c origin=vercel` reported no differences). The site was never
> down at any point — this was a deploy/state problem, not an availability one.
>
> **Fix:** manually delete the conflicting `www` CNAME via `aws route53
> change-resource-record-sets` (a plain `DELETE` change batch) *before* redeploying, so
> CloudFormation's create has nothing to conflict with. Redeployed immediately after —
> `www` was only unresolvable for the few seconds between the manual delete and the
> following deploy's `CREATE_COMPLETE`. Confirmed against the authoritative nameservers
> directly (`Resolve-DnsName ... -Server ns-536.awsdns-03.net`) since local DNS caching from
> the earlier attempts otherwise shows a stale answer for a few minutes.
>
> **If this happens to you:** check `aws route53 list-resource-record-sets` against reality
> before trusting `cdk diff`'s "no differences" — CloudFormation's belief about a
> partially-failed Route53 RecordSet change is not reliable, since Route53 RecordSets are not
> covered by `aws cloudformation detect-stack-drift` (confirmed: it reports `IN_SYNC` while
> the live apex disagreed). Delete the conflicting old record by hand, then redeploy.

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

## 14. Verify, then decommission Vercel — verification done, decommission timer started

```powershell
Resolve-DnsName josephkan.ca
Resolve-DnsName www.josephkan.ca
curl.exe -I https://josephkan.ca
curl.exe -I https://www.josephkan.ca
```

Check the certificate, the security headers, and the charts in a **real browser**.

**All confirmed**, against authoritative nameservers directly (local DNS caching from the
step 13 CNAME/A conflict fix otherwise shows a stale Vercel answer for a few minutes — clear
it with `Clear-DnsClientCache` if in doubt). Both apex and `www` return `200`, full security
headers (CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`), valid TLS, and charts render
in a real browser on the production domain `https://josephkan.ca`.

The two Next.js API routes were already deleted in step 12d, once CloudFront verification
passed, per the plan there.

**Remove the Vercel project for the personal site only after 24 hours of clean operation.**
Not before. Until then it is the rollback target. Cutover completed
2026-09-12T05:02 UTC — do not decommission Vercel before 2026-09-13T05:02 UTC.

---

## Exit checklist

Phase 0 is done when **all** of these are true.

- [ ] A merge to `main` deploys `josephkan.ca` with **nobody touching the console** — not yet
      exercised; every deploy so far in this runbook was manual (`cdk deploy` by hand). A
      real merge-triggered `deploy-dev`/`deploy-prod` run through CI has not happened yet.
- [x] `https://josephkan.ca` serves from CloudFront with a valid ACM cert and charts render —
      verified: `curl` against authoritative nameservers returns `200` with full security
      headers and a valid TLS handshake on both apex and `www`; charts confirmed rendering in
      a real browser on the production domain (step 14)
- [ ] Vercel is off for the personal site — **not yet**, by design. Cutover completed
      2026-09-12T05:02 UTC; the 24h clean-operation window (step 14) has not elapsed. Do not
      decommission before 2026-09-13T05:02 UTC
- [ ] Root credentials have not been used since step 3. **Not clean**: the management
      account's root password shows `password_last_used: 2026-09-11T23:29:19Z` in
      `aws iam get-credential-report`, which falls *during* step 3. Cause: a forgotten
      password, not an AWS platform requirement — signing in as root to check/reset it was
      incidental, not a necessary step of enabling Identity Center. `mfa_active: true` was
      already set on this root user from before (confirmed at session start), so this was a
      login with existing credentials, not a fresh "Forgot password" reset. No other action
      was taken as root beyond that sign-in; Identity Center itself was enabled and
      configured through the console while authenticated as `joseph-kan-infra-admin`. Root
      has not been used since. Treat this as a one-time incidental use to record honestly,
      not a process or platform issue to fix.
- [x] No IAM users and no access keys exist in either account — in particular the interim
      `joseph-kan-infra-admin` user and its access key, created to bridge steps 1–2 before
      Identity Center existed, are **deleted** (step 3). Verified: `aws iam list-users`
      returns empty in both `mgmt` and `platform`
- [x] `Resolve-DnsName josephkan.ca -Type NS` returns AWS nameservers — verified, all four
      `awsdns-*` nameservers
- [x] `cdk-hnbdev-cfn-exec-role-*` carries `cdk-dev-permissions-boundary` and
      `cdk-hnbprod-cfn-exec-role-*` carries none (step 5d) — verified via `aws iam get-role`
- [x] The manual probe in `infrastructure/bootstrap/README.md` shows the dev execution role
      **denied** tagging an `env=prod` resource while succeeding on an untagged one — **now
      passing**. First run failed (`docs/open-issues.md` issue 9): S3 general purpose buckets
      silently ignore `aws:ResourceTag` conditions unless ABAC is explicitly enabled per
      bucket, a default-off S3 setting AWS documents plainly, unrelated to the boundary policy
      itself — confirmed via a cross-service control test against SSM Parameter Store, where
      the identical boundary correctly denied without any such opt-in. Fixed by adding
      `abacStatus: true` to both S3 buckets in `static-site.ts`; re-ran the exact probe and
      confirmed `PutBucketTagging` on the `env=prod` site bucket now returns `AccessDenied`
      naming the boundary, while the untagged control bucket still succeeds. See issue 9 for
      the full investigation and fix.
- [x] All three Aspects fail synth in their unit tests — confirmed passing in the full test
      suite run this session (`packages/constructs` test output includes
      `RequiredTagsAspect`/`NoManagedEgressAspect`/`LogRetentionAspect` negative-path
      assertions via `Annotations.fromStack(stack).hasNoError`/`hasError`)
- [ ] A deliberate `SubnetType.PRIVATE_WITH_EGRESS` in a scratch branch **fails CI** — not
      exercised this session; the Aspect unit tests above prove the check exists and fails
      synth locally, but an actual CI run on a real PR with this violation has not been done
- [ ] A budget alert has fired at least once (set the threshold to $0.01 temporarily to
      prove it) — **in progress**. `phase0-alert-probe` ($0.01 MONTHLY, `ACTUAL > $0`) was
      created in step 10; budgets take ~24h before their first evaluation. Not yet fired as of
      this session. Check `aws budgets describe-budget --account-id $env:MGMT_ACCOUNT_ID
      --budget-name phase0-alert-probe --profile mgmt` and watch for the alert email, then
      **delete the probe budget** once confirmed — it is not a permanent guardrail
- [ ] Cost allocation tags appear in Cost Explorer — **pending**, same ~24h billing-data
      ingestion delay as above (step 10). `aws ce list-cost-allocation-tags` still returns
      empty as of this session
- [ ] The monthly bill is **under $8** — not yet checkable; the account is under 24h old, no
      billing cycle has completed
- [x] A teardown runbook exists for everything built in this phase — confirmed present:
      `docs/runbooks/teardown-phase-0.md`, `docs/runbooks/dns-rollback.md`,
      `docs/runbooks/break-glass.md`

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
