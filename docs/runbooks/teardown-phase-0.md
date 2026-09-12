# Teardown — Phase 0

Destroying everything Phase 0 built, in an order that actually completes.

This is a Phase 0 exit criterion (`docs/phase-0-action-plan.md` §9): the phase is not done
until this document exists and works. It is not an emergency procedure — take the time to read
it before starting.

**Prerequisite:** an SSO admin session, not CI. Teardown detaches the SCPs and deletes the
OIDC roles that CI authenticates with, so CI removes its own ability to continue partway
through.

```powershell
aws sso login --profile platform
aws sso login --profile mgmt
aws sts get-caller-identity --profile platform
aws sts get-caller-identity --profile mgmt
```

Both must return an `assumed-role/AWSReservedSSO_AdministratorAccess/...` ARN.

Load the account and OU identifiers from `.env.local` (gitignored) into the session; every
step below needs them:

```powershell
Get-Content .env.local | Where-Object { $_ -match '^\s*[^#\s]' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
```

---

## The three traps, before anything else

Read these first. Each one costs an hour or a live outage if hit in the wrong order.

### 1. Reverse the DNS apex BEFORE destroying anything

If the apex has been cut over to CloudFront (Stage G1), the site is served by the
distribution that step 2 destroys. Destroy first and `josephkan.ca` returns 404 — or nothing —
for as long as teardown takes.

Flip `origin` back to `vercel` and redeploy **first**:

```powershell
npx cdk deploy DnsStack --profile platform -c origin=vercel
```

Run from `infrastructure/dns`. TTLs are 300s, so resolvers pick up the Vercel values within
five minutes. Verify before continuing:

```powershell
Resolve-DnsName josephkan.ca
curl.exe -I https://josephkan.ca
```

The apex must return `76.76.21.21` and the site must load. This requires the Vercel project to
still exist — which is why `infrastructure/dns/README.md` says not to decommission it until
24h of clean operation. If Vercel is already gone, either accept downtime or stand the site
back up there before proceeding.

If the domain is being abandoned entirely, this step is optional. If it is not, it is
mandatory.

### 2. Detach SCPs BEFORE destroying what they deny

SCPs are evaluated on every API call in the `Workloads` OU, including delete calls. The
region-lock policy denies anything reporting a region other than `us-east-1`, and
`platform-cost-guardrails` denies EC2 networking actions. A destroy that trips one of these
fails with an opaque `UnauthorizedOperation` or `AccessDenied` and **no indication that an SCP
was the cause** — the error looks like an IAM problem in an account where you hold admin.

Detach from the management account, which SCPs never constrain:

```powershell
# List what is attached to the Workloads OU
aws organizations list-policies-for-target `
  --target-id <workloads-ou-id> --filter SERVICE_CONTROL_POLICY --profile mgmt

# Detach the two that block teardown, from BOTH OUs
aws organizations detach-policy --policy-id <region-lock-policy-id> `
  --target-id <workloads-ou-id> --profile mgmt
aws organizations detach-policy --policy-id <cost-guardrails-policy-id> `
  --target-id <workloads-ou-id> --profile mgmt
aws organizations detach-policy --policy-id <region-lock-policy-id> `
  --target-id <sandbox-ou-id> --profile mgmt
aws organizations detach-policy --policy-id <cost-guardrails-policy-id> `
  --target-id <sandbox-ou-id> --profile mgmt
```

`platform-security-guardrails` can stay attached until step 4 — it denies static credentials
and audit tampering, neither of which teardown does. Detaching it early is harmless.

Confirm the detach took effect before continuing. It is immediate, but a stale session can
mislead:

```powershell
aws organizations list-policies-for-target `
  --target-id <workloads-ou-id> --filter SERVICE_CONTROL_POLICY --profile mgmt
```

> The SCP resources themselves are destroyed with `GovernanceStack` in step 4. CloudFormation
> detaches before deleting, so the manual detach here is only about unblocking steps 2 and 3 —
> which run *before* step 4 and would otherwise be denied by policies that still exist.

### 3. `RETAIN` means the bucket survives `cdk destroy`

Both S3 buckets in Phase 0 are `RemovalPolicy.RETAIN`:

| Bucket | Stack | Why RETAIN |
| --- | --- | --- |
| Site bucket | `PersonalSiteStack` | `profileFor("prod").removalPolicy` is RETAIN (`packages/config/src/environments.ts`) |
| `OrgTrailBucket` | `GovernanceStack` | An audit trail that vanishes with its stack is not an audit trail |

`cdk destroy` will report success and leave both buckets, their contents, and their bills
behind. They are deleted by hand, in step 5, or deliberately kept — see
[What to keep](#what-to-keep).

---

## Destroy order

Reverse of the create order in `docs/phase-0-action-plan.md` §12.

```
0. Reverse the DNS apex to vercel            (trap 1 above)
1. Detach the region-lock and cost SCPs      (trap 2 above)
2. PersonalSiteStack     applications/personal-site
3. DnsStack              infrastructure/dns
4. GovernanceStack       infrastructure/org        (management account)
5. BootstrapStack        infrastructure/bootstrap
6. Retained buckets, by hand
7. CDKToolkit bootstrap stacks, both accounts
8. Accounts and the organization             (read the caveats first)
```

---

## Step 2 — `PersonalSiteStack`

The slowest step. Budget 20-40 minutes, most of it waiting on CloudFront.

```powershell
cd applications/personal-site
npx cdk destroy PersonalSiteStack --profile platform -c sitePlaceholder=true
```

`-c sitePlaceholder=true` is needed because synth runs before destroy and the stack throws if
the Next.js export is not on disk.

### What actually deletes

The Lambda, the log group, the EventBridge schedule, the cache policy, the response headers
policy, and the `BucketDeployment` custom resource all delete cleanly.

### CloudFront: disable, then delete

CloudFormation disables the distribution and then deletes it. Both operations are slow — the
disable propagates to every edge location before the delete is allowed to start — and the
whole thing typically takes **15-20 minutes**. Two things follow:

- **Do not cancel it.** A cancelled delete leaves the stack in `DELETE_IN_PROGRESS` and the
  distribution in an inconsistent state that takes longer to unpick than waiting did.
- **If CloudFormation times out**, disable it manually and delete it manually, then retry the
  stack delete:

```powershell
# Find the distribution
aws cloudfront list-distributions --profile platform `
  --query "DistributionList.Items[?contains(Aliases.Items, 'josephkan.ca')].[Id,Status,Enabled]" `
  --output table

# Fetch the config and its ETag
aws cloudfront get-distribution-config --id <DIST_ID> --profile platform > dist.json
$etag = (Get-Content dist.json | ConvertFrom-Json).ETag
(Get-Content dist.json | ConvertFrom-Json).DistributionConfig |
  ForEach-Object { $_.Enabled = $false; $_ } |
  ConvertTo-Json -Depth 20 | Set-Content disabled.json

aws cloudfront update-distribution --id <DIST_ID> `
  --distribution-config file://disabled.json --if-match $etag --profile platform

# Wait until Status is Deployed. This is the 15-20 minutes.
aws cloudfront wait distribution-deployed --id <DIST_ID> --profile platform

# Delete needs the NEW ETag from the update, not the old one
aws cloudfront delete-distribution --id <DIST_ID> --if-match <NEW_ETAG> --profile platform
```

A distribution cannot be deleted while `Enabled` is `true`. `PreconditionFailed` means a stale
ETag; re-fetch it.

### The site bucket survives

RETAIN. Expected. Record the name now — it is easier to read from the stack output than to
find later:

```powershell
aws cloudformation describe-stacks --stack-name PersonalSiteStack --profile platform `
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text
```

Handled in step 5.

---

## Step 3 — `DnsStack`

```powershell
cd ../../infrastructure/dns
npx cdk destroy DnsStack --profile platform
```

### The ACM certificate blocks on CloudFront

`Certificate is in use` means the distribution from step 2 is not fully gone. ACM tracks
associations and the tracking lags the deletion by a few minutes even after the distribution
has disappeared from `list-distributions`.

Wait, confirm, retry:

```powershell
aws cloudfront list-distributions --profile platform `
  --query "DistributionList.Items[].Id" --output text     # must not include the old ID

aws acm describe-certificate --certificate-arn <CERT_ARN> --region us-east-1 `
  --profile platform --query "Certificate.InUseBy"        # must be []
```

`InUseBy` must be empty. If it still lists a distribution that no longer exists, wait 10-15
minutes; it clears on its own. There is no way to force it.

### The hosted zone blocks on records CDK does not own

`HostedZoneNotEmpty` means the zone holds records this stack did not create. SOA and NS at the
apex are fine — Route53 deletes those with the zone. Anything else must go first:

```powershell
aws route53 list-resource-record-sets --hosted-zone-id <ZONE_ID> --profile platform `
  --query "ResourceRecordSets[?Type != 'NS' && Type != 'SOA'].[Name,Type]" --output table
```

Likely culprits: an ACM validation CNAME left behind by a certificate that was replaced rather
than deleted, a record added by hand during Stage D debugging, or a TXT record for a service
verification. Delete each with a `DELETE` change batch, then retry the destroy.

**Consider not destroying this zone at all.** See [What to keep](#what-to-keep) — a deleted
zone gets a new delegation set if recreated, which means another 24-48h nameserver
propagation at GoDaddy.

---

## Step 4 — `GovernanceStack` (management account)

```powershell
cd ../org
npx cdk destroy GovernanceStack --profile mgmt `
  -c workloadsOuId=$env:WORKLOADS_OU_ID `
  -c sandboxOuId=$env:SANDBOX_OU_ID
```

The OU IDs are still required: synth runs before destroy and throws without them. They live
in `.env.local`; load it into the session as shown at the top of this runbook.

This removes the three SCPs (detaching them first, including any still attached from trap 2),
the organization CloudTrail, the budget, and the anomaly monitor. It leaves:

- **`OrgTrailBucket`** — RETAIN, and it holds every log the trail ever wrote. Step 5.
- **The organization, the OUs, and both accounts** — created by hand in Stage A, so not
  CloudFormation's to delete. Step 8.

GuardDuty was enabled by hand and is not in this stack. Disable it separately or it keeps
billing:

```powershell
aws guardduty list-detectors --profile platform
aws guardduty delete-detector --detector-id <ID> --profile platform
```

---

## Step 5 — `BootstrapStack`

**This is the point of no return for CI.** After this the three `gha-*` roles are gone and
nothing can deploy except an SSO admin session. Do it last among the stacks.

```powershell
cd ../bootstrap
npx cdk destroy BootstrapStack --profile platform
```

Note on the OIDC provider: if `BootstrapStack` was deployed with
`-c existingOidcProviderArn=...` it references a provider it did not create, and destroying
the stack correctly leaves that provider in place. If it created the provider, the provider is
deleted. Either is fine — an unused OIDC provider costs nothing. It only matters if another
repo is still using it, in which case verify it survived:

```powershell
aws iam list-open-id-connect-providers --profile platform
```

The `gha-deploy-dev-boundary` managed policy is part of the stack and deletes with it. If the
delete fails because the policy is still attached to something, find the holdout:

```powershell
aws iam list-entities-for-policy `
  --policy-arn arn:aws:iam::<platform-account-id>:policy/gha-deploy-dev-boundary `
  --profile platform
```

---

## Step 6 — The retained buckets

Both are versioned. `aws s3 rm --recursive` deletes current versions only and leaves every
noncurrent version and every delete marker behind, so the bucket still refuses to delete with
`BucketNotEmpty` and still bills for storage. All versions must go.

```powershell
function Clear-VersionedBucket {
  param([string]$Bucket, [string]$Profile)

  do {
    $page = aws s3api list-object-versions --bucket $Bucket --profile $Profile `
      --max-items 500 --output json | ConvertFrom-Json

    $objects = @($page.Versions) + @($page.DeleteMarkers) | Where-Object { $_ }
    foreach ($o in $objects) {
      aws s3api delete-object --bucket $Bucket --key $o.Key `
        --version-id $o.VersionId --profile $Profile | Out-Null
    }
    Write-Host "deleted $($objects.Count)"
  } while ($objects.Count -gt 0)

  aws s3api delete-bucket --bucket $Bucket --profile $Profile
}
```

Then, for each:

```powershell
Clear-VersionedBucket -Bucket "<site bucket name>"  -Profile platform
Clear-VersionedBucket -Bucket "<org trail bucket>"  -Profile mgmt
```

Notes:

- The loop is necessary. `list-object-versions` pages, and a single pass on a bucket with more
  than a page of versions silently leaves the rest.
- **CloudTrail objects transitioned to Glacier still delete normally.** No restore is needed
  to delete an object, only to read it.
- **Do not empty the CloudTrail bucket casually.** It is the audit history for the whole phase
  and it is the one thing here that cannot be recreated. See
  [What to keep](#what-to-keep).
- For a bucket with a very large number of versions, an S3 Lifecycle rule with
  `NoncurrentVersionExpiration: 1` and `ExpiredObjectDeleteMarker: true` empties it in the
  background within about 48h at no API cost. Slower, but free and unattended.

---

## Step 7 — CDK bootstrap

The `CDKToolkit` stack in each account: a staging bucket, an ECR repository, and five roles.
The staging bucket accumulates asset zips and is usually the only thing still costing money.

```powershell
# Empty the staging bucket first — it is versioned too
Clear-VersionedBucket -Bucket "cdk-hnb659fds-assets-<platform-account-id>-us-east-1" -Profile platform
aws cloudformation delete-stack --stack-name CDKToolkit --profile platform

Clear-VersionedBucket -Bucket "cdk-hnb659fds-assets-<mgmt-account-id>-us-east-1" -Profile mgmt
aws cloudformation delete-stack --stack-name CDKToolkit --profile mgmt
```

`hnb659fds` is the default bootstrap qualifier; confirm with
`aws s3 ls --profile platform | Select-String cdk-`.

Only do this if the account is genuinely finished with CDK. Re-bootstrapping is one command,
but doing it needs admin credentials you may not have set up at that moment.

---

## Step 8 — Accounts and the organization

Read all four caveats before touching anything here. This is the part that cannot be undone.

1. **Deleting an `AWS::Organizations::Account` CloudFormation resource does not close the
   account.** It removes the resource from the stack and orphans the account — still open,
   still billable, still holding an email address that can never be reused. Phase 0 creates
   accounts by hand precisely so this cannot happen by accident.

2. **Closure is rate-limited to roughly 10% of the accounts in the organization per month**,
   with a floor. With two accounts this effectively means one at a time, with a wait.

3. **A newly created account cannot be closed immediately.** There is a waiting period after
   creation. If the Platform account is days old, closure will simply refuse.

4. **Account emails are permanently consumed.** Even after closure the address cannot be
   reused for a new AWS account, ever. This is why Stage A specifies plus-addressing on a
   mailbox you control forever.

The sequence, if you are certain:

```powershell
# Remove Platform from the OU / organization first
aws organizations list-accounts --profile mgmt
aws organizations remove-account-from-organization --account-id <platform-account-id> --profile mgmt
```

A member account can only leave the organization if it has completed the full sign-up
information (payment method, contact details, and accepted agreement). If it has not, this
fails and the account must be closed from within itself instead — which requires signing in as
its root user, one of the few legitimate root uses (see `break-glass.md`).

Then close:

```powershell
aws organizations close-account --account-id <platform-account-id> --profile mgmt
```

A closed account enters a 90-day post-closure window during which it can be reopened by AWS
Support. It is not gone immediately.

**Consider stopping before this step.** Two empty accounts with no resources cost $0. Closing
them buys nothing and forecloses reusing them.

---

## What to keep

Even in a full teardown, these should almost certainly survive.

| Keep | Why |
| --- | --- |
| **The `josephkan.ca` registration at GoDaddy** | Losing a domain is permanent and someone else can take it. Confirm auto-renew and transfer lock are still ON while you are in there. |
| **The Route53 hosted zone** | $0.50/mo. Deleting and recreating it produces a **new delegation set**, which means changing nameservers at GoDaddy again and waiting another 24-48h for `.ca` registry propagation. Keeping it means the domain keeps resolving and a future rebuild is same-day. |
| **The CloudTrail bucket and its objects** | The only record of what was done in these accounts. Log file validation makes it tamper-evident, which is worthless if the logs are gone. Storage for a phase this small is cents per month. |
| **The Identity Center instance** | Its region is effectively permanent (§10). Deleting it deletes every user, permission set and assignment, and recreating it is not a small job. |
| **The OANDA SSM SecureString parameters** | Free, and reseeding them means going back to OANDA for a new token. |

If cost is the reason for teardown: the zone, the parameters and a small log bucket together
are well under a dollar a month. The expensive things — CloudFront, the distribution, GuardDuty
after its trial — are all destroyed in steps 2 and 4.

---

## Step 9 — Verify nothing is still billing

Do this the day *after* teardown. Cost Explorer data lags roughly 24 hours, so checking
immediately shows yesterday's spend and proves nothing.

```powershell
# Yesterday's spend by service, per account
aws ce get-cost-and-usage --profile mgmt `
  --time-period Start=<yyyy-MM-dd>,End=<yyyy-MM-dd> `
  --granularity DAILY --metrics UnblendedCost `
  --group-by Type=DIMENSION,Key=SERVICE
```

Expect only what [What to keep](#what-to-keep) explains: Route53 hosted zone, a little S3.
Anything else is a leftover.

Then sweep directly for the things that survive stack deletion and are easy to miss:

```powershell
aws cloudformation list-stacks --profile platform `
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE
aws s3 ls --profile platform
aws s3 ls --profile mgmt
aws cloudfront list-distributions --profile platform --query "DistributionList.Quantity"
aws route53 list-hosted-zones --profile platform
aws acm list-certificates --region us-east-1 --profile platform
aws logs describe-log-groups --profile platform --query "logGroups[].logGroupName"
aws guardduty list-detectors --profile platform
aws lambda list-functions --profile platform --query "Functions[].FunctionName"
aws scheduler list-schedules --profile platform
```

Log groups are the classic straggler: a `LogGroup` declared in a stack deletes with it, but
any group AWS auto-created for a Lambda does not, and it retains data at its default
(infinite) retention. `LogRetentionAspect` exists to prevent that class of leak while the
platform is alive; it does nothing after teardown.

Finally, confirm the budget alarm is either deleted with `GovernanceStack` or set to something
that will notice a resurrection:

```powershell
aws budgets describe-budgets --account-id <mgmt-account-id> --profile mgmt
```

---

## Uncertainties in this procedure

Stated honestly, because a runbook that pretends to certainty it does not have is worse than
one that flags the gaps.

- **CloudFront delete timing varies.** 15-20 minutes is typical; it can be longer. The manual
  disable-then-delete path above is the reliable fallback, not the primary route.
- **ACM `InUseBy` clearing has no documented SLA.** Waiting is the only remedy.
- **`remove-account-from-organization` fails on accounts that have not completed sign-up**, and
  the error does not always say so plainly. The fallback (close from within the account, as
  root) has not been exercised here.
- **The exact closure rate limit** is documented by AWS as approximately 10% of accounts per
  month with a minimum, and the newly-created waiting period is not published as a fixed
  number. Treat both as "it may simply refuse, and that is normal."
- **Whether `GovernanceStack` deletes cleanly with SCPs still attached** has not been tested
  here. CloudFormation should detach before deleting each policy; trap 2 detaches the two
  risky ones early regardless, which sidesteps the question for the cases that matter.
