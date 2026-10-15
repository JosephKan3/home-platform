# Teardown — Phase 1

Destroying everything Phase 1 built: `newnotams.net` on AWS, its own GitHub OIDC roles, its
own Route53 zone and certificate, and the published `@josephkan3/*` packages that made its
move into its own repo possible.

This is a Phase 1 exit criterion (`docs/phase-1-action-plan.md` §9, mirroring Phase 0's own
§9): the phase is not done until this document exists and works.

**This is additive to, not a replacement for,
[`teardown-phase-0.md`](./teardown-phase-0.md).** Phase 1 shares the Platform account, the
Identity Center session, the `cdk-dev-permissions-boundary`, and the `josephkan.ca` platform
zone with Phase 0 — none of that is duplicated here. Read Phase 0's runbook first if you have
not; this one assumes its prerequisites (SSO login, `.env.local` loaded) are already done.

**Prerequisite:** an SSO admin session in `platform`, same as Phase 0. Nothing here touches
the management account — `NewNotamsStack`, its DNS resources, and its OIDC roles all live in
Platform.

```powershell
aws sso login --profile platform
aws sts get-caller-identity --profile platform
```

**Second prerequisite:** a local clone of `NewNotams.Net` (its own repo, not this one — see
ADR-0009). `NewNotamsStack` lives there, not here.

---

## The two traps, before anything else

### 1. `newnotams.net`'s zone is NOT separate infrastructure from `josephkan.ca`'s

Both live in the **same `DnsStack`**, in this repo's `infrastructure/dns`. There is no
`NewNotamsDnsStack` to destroy independently.

This means `cdk destroy DnsStack` takes down the live `josephkan.ca` apex too — correct only
if you are tearing down Phase 0 and Phase 1 together. To remove **only** `newnotams.net`'s
zone and certificate while leaving `josephkan.ca` running, **redeploy** `DnsStack` with
`createProductZone` *omitted* (its default is `false`), not destroy:

```powershell
cd infrastructure/dns
npx cdk deploy DnsStack --profile platform -c productOrigin=vercel
```

`createProductZone: false` (the default) means CDK removes `ProductZone`, `ProductCertificate`,
and the product-specific records in the same diff that an omitted flag naturally produces —
confirmed by reading `dns-stack.ts`'s own `if (props.createProductZone)` guard. This is a normal
stack update, not a stack deletion, so it is reversible by redeploying with the flag back on.

If the whole platform is being torn down, skip this step — `cdk destroy DnsStack` in Phase 0's
own procedure takes the product zone with it, and the ordering trap below still applies.

### 2. Destroy `NewNotamsStack` before touching `ProductCertificate`

Same ACM-waits-on-CloudFront pattern as Phase 0's `josephkan.ca` certificate (teardown-phase-0
trap/step 3 for `DnsStack`). `ProductCertificate` cannot delete while `NewNotamsStack`'s
CloudFront distribution still references it. Destroy order below reflects this.

---

## Destroy order

```
1. NewNotamsStack                 <newnotams-repo>/cdk        (a different repo — ADR-0009)
2. newnotams.net's zone/cert       infrastructure/dns          (redeploy, or destroy w/ Phase 0)
3. NewNotamsGitHubOidcStack        infrastructure/bootstrap
4. GitHub-side cleanup             NewNotams.Net repo settings
5. GitHub Packages visibility      @josephkan3/config, @josephkan3/constructs
6. Retained buckets, by hand
7. Verify nothing is still billing
```

---

## Step 1 — `NewNotamsStack`

```powershell
cd <path-to-NewNotams.Net-clone>/cdk
npx cdk destroy NewNotamsStack --profile platform -c sitePlaceholder=true
```

`-c sitePlaceholder=true` for the same reason Phase 0's `PersonalSiteStack` destroy needs it:
synth runs before destroy and the stack throws if the real OpenNext build output is not on
disk, which it will not be unless you just ran a full build.

### What actually deletes

The server Lambda, the `ScheduledJob` notify Lambda, its EventBridge schedule
(`NewNotamsStack-NotifyScheduleXXXX`), its log group, the SNS topic (`AlertTopic`, including its
explicit `cloudwatch.amazonaws.com` publish-allow policy — see
[open-issues.md](../open-issues.md) for why that statement exists), the CloudWatch alarm, both
IAM roles, and the CloudFront distribution's associated resources (cache policy, OAC) all delete
cleanly.

### CloudFront: disable, then delete — same 15-20 minute wait as Phase 0

Identical mechanism to `PersonalSiteStack`'s distribution (teardown-phase-0 step 2). Do not
cancel a slow delete. If CloudFormation times out, use the same manual disable → wait →
delete → retry procedure documented there, substituting this stack's distribution ID:

```powershell
aws cloudfront list-distributions --profile platform `
  --query "DistributionList.Items[?contains(Aliases.Items, 'newnotams.net')].[Id,Status,Enabled]" `
  --output table
```

### Both S3 buckets survive — RETAIN, same as Phase 0's site bucket

Confirmed directly from the deployed stack: `envName: "prod"` resolves
`profileFor("prod").removalPolicy` to `RETAIN` for both the site-assets bucket and its access-log
bucket (`packages/constructs/src/opennext-site/opennext-site.ts`). No DynamoDB table exists
(`includeTagCache` is off for this stack — Upstash KV owns the app's own data, not CDK).

Record both bucket names now, from the live account (CloudFormation does not output them):

```powershell
aws cloudformation list-stack-resources --stack-name NewNotamsStack --profile platform `
  --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId"
```

As of this writing: `newnotamsstack-sitebucket978d4aeb-<suffix>` and
`newnotamsstack-siteaccesslogbucketd8c8e27d-<suffix>`. Handled in step 6.

### The SSM parameters are NOT deleted by this stack

All eight `/newnotams/*` parameters (`auth/google-id`, `auth/google-secret`, `auth/secret`,
`kv/url`, `kv/token`, `push/vapid-public-key`, `push/vapid-private-key`, `push/vapid-subject`)
were seeded out of band — `NewNotamsStack` only reads them, never creates or owns them as CDK
resources. They survive `cdk destroy` with zero storage cost (SSM `Standard` parameters are
free) and are not part of this teardown unless you want them gone:

```powershell
aws ssm get-parameters-by-path --path /newnotams --profile platform --recursive `
  --query "Parameters[].Name" --output text
# then, only if genuinely done with this app:
# aws ssm delete-parameter --name <each one> --profile platform
```

Keeping them costs nothing and means a future rebuild does not need to go back to Google Cloud
Console, generate a new VAPID keypair, or re-provision Upstash. See
[What to keep](#what-to-keep).

---

## Step 2 — `newnotams.net`'s Route53 zone and ACM certificate

Covered by trap 1 above. If tearing down Phase 1 only (keeping `josephkan.ca` running):

```powershell
cd infrastructure/dns
npx cdk deploy DnsStack --profile platform -c productOrigin=vercel
```

If tearing down the whole platform, this is already handled by Phase 0's own `DnsStack`
destroy step — do not run both.

### The zone blocks on records CDK does not own — same `HostedZoneNotEmpty` pattern

Identical failure mode to Phase 0's zone (teardown-phase-0 step 3). The product zone can pick
up a stray ACM validation CNAME (the `www` shadow-record gotcha in ADR-0006/Stage D is exactly
this) or a hand-added debugging record. Check and clear before retrying:

```powershell
aws route53 list-resource-record-sets --hosted-zone-id <PRODUCT_ZONE_ID> --profile platform `
  --query "ResourceRecordSets[?Type != 'NS' && Type != 'SOA'].[Name,Type]" --output table
```

### NameCheap propagation is slower than GoDaddy's — up to 6 hours, not 5 minutes

If `newnotams.net` was ever delegated to Route53 at the registrar (NameCheap, not GoDaddy —
confirmed in ADR-0006), its registry TTL is 21600s (6h), unlike `josephkan.ca`'s 300s apex
records. A rollback here is not same-day the way Phase 0's is. Plan accordingly if this domain
still needs to resolve during teardown.

---

## Step 3 — `NewNotamsGitHubOidcStack`

A second, independent `GitHubOidcStack` instance (see `infrastructure/bootstrap/bin/app.ts`),
trust-scoped exclusively to `JosephKan3/NewNotams.Net`'s repo ID. Destroying it does not touch
`BootstrapStack`'s own `gha-plan`/`gha-deploy-dev`/`gha-deploy-prod` roles — confirmed these are
separate CloudFormation stacks, not resources in the same one.

```powershell
cd infrastructure/bootstrap
npx cdk destroy NewNotamsGitHubOidcStack --profile platform
```

### What this does NOT delete — and should not

- **The OIDC provider itself** (`token.actions.githubusercontent.com`). This stack was deployed
  with `existingOidcProviderArn` pointing at `BootstrapStack`'s provider, never creating a
  second one (AWS allows exactly one per issuer URL per account). Destroying this stack leaves
  the provider alone, correctly — `home-platform`'s own CI still needs it.
- **`cdk-dev-permissions-boundary`**. Deployed with `useExistingDevPermissionsBoundary: true`
  specifically so a second managed policy of the same name is never created. There is nothing
  of this stack's to delete here; the boundary is `BootstrapStack`'s resource.

After this step, `NewNotams.Net`'s CI can no longer assume any AWS role — equivalent to Phase
0's own "point of no return for CI" note on destroying `BootstrapStack`.

---

## Step 4 — GitHub-side cleanup on the `NewNotams.Net` repo

None of this is AWS-billed, but leaving it configured against roles that no longer exist means
the next CI run fails with a confusing `AssumeRoleWithWebIdentity` denial instead of a clear
"these don't exist" signal.

```powershell
gh variable list --repo JosephKan3/NewNotams.Net
gh variable delete AWS_PLAN_ROLE_ARN --repo JosephKan3/NewNotams.Net
gh variable delete AWS_DEPLOY_DEV_ROLE_ARN --repo JosephKan3/NewNotams.Net
gh variable delete AWS_DEPLOY_PROD_ROLE_ARN --repo JosephKan3/NewNotams.Net
gh variable delete ALERT_EMAIL --repo JosephKan3/NewNotams.Net
```

The `dev`/`prod` GitHub Environments (the latter with its required-reviewer protection rule)
can stay — they are harmless and free, and recreating the reviewer rule by hand is the one part
of this setup with no CLI/IaC path (see this phase's own session notes on
`gh api .../environments` reviewer configuration). Only remove them if the repo itself is being
archived.

---

## Step 5 — GitHub Packages: `@josephkan3/config` and `@josephkan3/constructs`

These were made **public** (not reverted to private) specifically so `NewNotams.Net`'s
`GITHUB_TOKEN` could pull them without a per-repo Actions-access grant — there is no API for
that grant, confirmed by direct research; public visibility was the IaC-friendly alternative.

**Do not revoke public visibility as part of this teardown if `home-platform` itself is still
running** — `personal-site` and any other in-repo consumer resolve these from the registry via
the same mechanism `NewNotams.Net` does. Only consider this if Phase 0 is also being torn down
in full.

If genuinely decommissioning both packages:

```powershell
gh api --method DELETE /user/packages/npm/config
gh api --method DELETE /user/packages/npm/constructs
```

This requires a token with `delete:packages` scope — `gh auth refresh -h github.com -s delete:packages`
first. Packages are recoverable for 30 days after deletion if this turns out to be premature.

---

## Step 6 — The retained buckets

Both versioned, same emptying requirement as Phase 0's buckets — reuse the
`Clear-VersionedBucket` function from [`teardown-phase-0.md`](./teardown-phase-0.md#step-6--the-retained-buckets)
rather than duplicating it here.

```powershell
Clear-VersionedBucket -Bucket "<newnotamsstack-sitebucket... name from step 1>" -Profile platform
Clear-VersionedBucket -Bucket "<newnotamsstack-siteaccesslogbucket... name from step 1>" -Profile platform
```

---

## What to keep

| Keep | Why |
| --- | --- |
| **The `newnotams.net` registration at NameCheap** | Same reasoning as `josephkan.ca` at GoDaddy — permanent loss if the registration lapses. |
| **The `/newnotams/*` SSM parameters** | Free, and losing them means regenerating the VAPID keypair (every existing push subscription breaks, see this phase's own debugging of exactly that failure mode) and going back to Google Cloud Console for new OAuth credentials. |
| **`@josephkan3/config`/`@josephkan3/constructs` on GitHub Packages** | Free (public npm packages cost nothing to host), and deleting them breaks any repo still resolving them — confirmed `home-platform`'s own `personal-site` may still depend on the registry copy, not just the workspace source. |
| **The OIDC provider and `cdk-dev-permissions-boundary`** | Shared with `home-platform`'s own CI (Phase 0). Neither is this phase's to delete. |

---

## Step 7 — Verify nothing is still billing

Same 24-hour Cost Explorer lag as Phase 0. Reuse that runbook's
[step 9](./teardown-phase-0.md#step-9--verify-nothing-is-still-billing) verification sweep —
it already checks CloudFront distributions, Lambda functions, EventBridge schedules, and log
groups platform-wide, which covers `NewNotamsStack`'s resources without duplication. The one
addition specific to this phase:

```powershell
# Confirm the product zone is really gone (or still correctly present, if kept)
aws route53 list-hosted-zones --profile platform --query "HostedZones[?Name=='newnotams.net.']"
```

Expect only what [What to keep](#what-to-keep) explains to remain. An orphaned SNS topic, a
still-subscribed email address, or a lingering CloudWatch alarm are the classic Phase-1-specific
stragglers — `NewNotamsStack`'s own destroy should take all three, but confirm:

```powershell
aws sns list-topics --profile platform --query "Topics[?contains(TopicArn,'NewNotams')]"
aws cloudwatch describe-alarms --profile platform --query "MetricAlarms[?contains(AlarmName,'NewNotams')]"
```

---

## Uncertainties in this procedure

- **Whether `createProductZone=false` redeploy cleanly removes an already-live `ProductZone`
  with real delegation (post-cutover) has not been exercised.** The flag's guard
  (`if (props.createProductZone)`) is straightforward CDK conditional-resource logic and should
  work the same as any other conditional removal, but this specific path — a zone that is
  actively delegated at a registrar, not just created and abandoned — has not been tested live.
- **NameCheap's exact propagation behavior on zone deletion** is documented as "up to 6h" from
  the registry TTL, not measured directly in this phase.
- **GitHub Packages' 30-day recovery window after deletion** is per GitHub's own documentation,
  not independently verified here.
