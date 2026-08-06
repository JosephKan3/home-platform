# @platform/infra-org

Organization guardrails as code (Phase 0 action plan §6, Stage E).

**This is the only stack that deploys to the management account.** Organizations, the
organization CloudTrail, Budgets and Cost Anomaly Detection are all management-account APIs.

## SCPs do not apply to the management account

Nothing here constrains the account it is deployed into. AWS exempts the management account
from SCP evaluation entirely, so every policy in this stack applies only to the OUs it is
attached to. That is not a gap to close — it is the escape hatch that makes a mistaken SCP
recoverable, since the management account can always detach one. It is also exactly why no
workload is ever allowed to run there (action plan §2 A1, §10).

## What this stack does not create

The organization, the `Security` / `Workloads` / `Sandbox` OUs, and the Platform account are
created **by hand** in Stage A. Account creation requires email verification, and deleting an
`AWS::Organizations::Account` resource does not close the account — it orphans it, still
billable, with an email address that can never be reused (§10). OU IDs are therefore inputs,
passed via CDK context.

## Contents

One stack, `GovernanceStack`. SCPs, the audit trail and the cost controls share a stack
because they share a single deploy target, a single lifecycle, and a single reviewer; splitting
them would produce two stacks that are always deployed together.

### Service control policies

Six policy documents in `lib/service-control-policies.ts`, emitted as **three** attached
`AWS::Organizations::Policy` resources.

| Attached policy | Documents merged into it |
| --- | --- |
| `platform-region-lock` | `regionLockPolicy` |
| `platform-cost-guardrails` | `denyManagedEgressPolicy`, `denyExpensiveComputePolicy` |
| `platform-security-guardrails` | `denyStaticCredentialsPolicy`, `protectAuditPolicy`, `protectOrganizationPolicy` |

**Why merged.** AWS allows a maximum of **5 policies attached per OU or account**, and the
AWS-managed `FullAWSAccess` policy occupies one of those slots — leaving four. Six separate
policies would not attach. The grouping is by *reason to change*, not by size:

- The region lock stays alone. It is the highest-risk document in the repo and the one most
  likely to need an emergency detach; bundling anything with it would mean detaching that too.
- Cost guardrails move together — both come from ADR-0002 and the cost budget, and both would
  be relaxed by the same decision.
- Security guardrails move together and, realistically, never move at all.

That leaves one free slot per OU for a future policy without a re-grouping exercise.

Every policy is attached to the `Workloads` and `Sandbox` OUs, **never to an account**
(ADR-0001), so an account later dropped into `Workloads` inherits every guardrail immediately.
A test asserts every target ID starts with `ou-`.

`SCP_MAX_SIZE_BYTES` is 5120, a hard AWS quota enforced by the Organizations API rather than by
CloudFormation template validation — an oversized policy otherwise surfaces as an opaque
failure partway through a deploy. `assertPolicySize(name, doc)` is called at construction time
so it fails locally with the policy name attached.

### The region lock, and how to brick an account

`regionLockPolicy()` denies everything outside `us-east-1` using `NotAction` with a list of
global service namespaces. Global services are reachable only through `us-east-1` endpoints but
report `aws:RequestedRegion` values that are not `us-east-1` — IAM and Organizations report
`aws-global`, others vary. Omitting a namespace from that list denies:

- every IAM call — no role or policy can be created, read, or repaired;
- every Organizations call — the SCP cannot be detached from inside the org;
- every Route53 call — DNS cannot be changed and the site cannot be recovered;
- every CloudFront call — the distribution serving the site is frozen;
- every billing, Cost Explorer, budgets and Support call — the damage is invisible and AWS
  Support cannot be reached to help undo it.

All at once, from one deleted line. Treat any diff that shortens `GLOBAL_SERVICE_NAMESPACES` as
a defect. The test suite loops over the required namespaces individually for this reason.

`acm:*` is deliberately **not** exempt: ACM is regional. CloudFront requires certificates in
`us-east-1`, which is already the only allowed region, so nothing is lost.

### Audit

Organization CloudTrail (`platform-org-trail`) with `isOrganizationTrail`,
`enableLogFileValidation`, `includeGlobalServiceEvents` and `isMultiRegionTrail` all on, writing
to an S3 bucket with `BLOCK_ALL` public access, SSE-S3, `enforceSSL`, versioning, and a
lifecycle rule transitioning to Glacier after 90 days. The bucket is `RETAIN` on stack
deletion — an audit trail that vanishes with its stack is not an audit trail.

ADR-0001 records the deviation honestly: this lives in the management account rather than a
dedicated Security account, so an attacker with management access could tamper with the trail.
Log file validation makes such tampering detectable rather than silent.

### Cost controls

- `AWS::Budgets::Budget`, $10/mo `COST` budget filtered to the Platform account, with four
  notifications: 50% / 80% / 100% `ACTUAL` and 100% `FORECASTED`, all to `alertEmail`.
- `AWS::CE::AnomalyMonitor` (`DIMENSIONAL` / `SERVICE`) plus an `AWS::CE::AnomalySubscription`
  at a $5 absolute-impact threshold, `DAILY` frequency.

The anomaly subscription is only created when `alertEmail` is supplied — a subscription with no
subscriber is invalid.

## Prerequisites

**Deploy only after `cdk bootstrap` (§2 A6) and the OIDC stack (§4).** A region-lock SCP applied
first can block the very operations that establish the ability to deploy.

`isOrganizationTrail` requires CloudTrail to be a trusted service for Organizations. Run once,
from the management account, before the first deploy:

```powershell
aws organizations enable-aws-service-access `
  --service-principal cloudtrail.amazonaws.com --profile mgmt
```

Without it CloudFormation fails when creating the trail.

## Deploy

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
missing. `organizationId` scopes the trail bucket policy so member accounts can deliver logs —
CDK warns at synth if it is absent. `alertEmail` and `budgetAccountId` are optional.

List the OU IDs with:

```powershell
aws organizations list-roots --profile mgmt
aws organizations list-organizational-units-for-parent --parent-id <root id> --profile mgmt
```

## Done manually, not here

Two things are account-level toggles that CloudFormation handles poorly, and are done by hand in
Stage A/E:

- **GuardDuty** on the Platform account. There is no clean CloudFormation path to enabling it
  once per account without the resource fighting an existing detector, and deleting the resource
  disables detection. Enable it in the console; the `protectAuditPolicy` SCP prevents anyone
  from turning it back off.
- **Cost allocation tag activation** for `app`, `env`, `owner` (Billing → Cost allocation tags).
  Activation is a billing-console operation with no CloudFormation resource, takes ~24h to take
  effect, and is **not retroactive** — activate on day 1 (§1). With a single workload account
  these tags are the only billing breakdown, which is what makes `RequiredTagsAspect` load
  bearing.

AWS Config is deliberately skipped (§6 E2, §11); `protectAuditPolicy` still denies disabling it,
which costs nothing and covers the case where it is enabled later.

## Test

```powershell
pnpm --filter @platform/infra-org test
```

Policy-level tests assert size, version, and the specific critical contents of every document,
with the region-lock global exemptions asserted one namespace at a time so a future edit that
drops one fails loudly. Template-level tests assert OU attachment targets, the trail flags, the
bucket's public access block, and the budget's four notifications.
