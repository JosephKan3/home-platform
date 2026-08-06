# @platform/infra-bootstrap

The GitHub Actions OIDC handoff (Phase 0 action plan §4).

**This is the one stack deployed by hand.** It is what creates the identity CI uses, so it
cannot be deployed by CI. Deploy it once with Identity Center admin credentials; every stack
after it deploys through the roles created here.

## Contents

- A GitHub OIDC identity provider for `https://token.actions.githubusercontent.com`
  (audience `sts.amazonaws.com`). No thumbprint is pinned — AWS manages it.
- Three roles in the Platform account:

| Role | `sub` condition | May assume |
| --- | --- | --- |
| `gha-plan` | `repo:JosephKan3/home-platform:pull_request` | `ReadOnlyAccess` + the `cdk-hnbdev-lookup-role-*` and `cdk-hnbprod-lookup-role-*` roles |
| `gha-deploy-dev` | `repo:JosephKan3/home-platform:environment:dev` | `cdk-hnbdev-*` bootstrap roles **only** |
| `gha-deploy-prod` | `repo:JosephKan3/home-platform:environment:prod` | `cdk-hnbprod-*` bootstrap roles **only** |

- `cdk-dev-permissions-boundary`, a managed policy with a **fixed name**. It is created here
  but **attached nowhere in this stack**. `cdk bootstrap --custom-permissions-boundary`
  attaches it to `cdk-hnbdev-cfn-exec-role-<account>-<region>`.

Trust policies use `StringEquals` on both `aud` and the full `sub`. Never `StringLike` — a
wildcard such as `repo:JosephKan3/*` would grant every repository the owner has, forever,
including ones not yet created.

## Why there are two bootstrap qualifiers

ADR-0001 puts dev and prod in one account and relies on an IAM permissions boundary to make
that survivable. Two facts determine where that boundary has to live:

1. **A permissions boundary caps a principal and does not follow a role chain.** Attaching it
   to `gha-deploy-dev` constrains nothing: that role holds only `sts:AssumeRole`. Every
   mutation a `cdk deploy` performs is executed by CloudFormation under
   `cdk-<qualifier>-cfn-exec-role-<account>-<region>`, a separate role with its own
   `AdministratorAccess`.
2. **`cdk bootstrap --custom-permissions-boundary` attaches the boundary to exactly that CFN
   execution role, and to nothing else.** Verified against the bootstrap template shipped in
   `aws-cdk@2.1135.0` (`lib/api/bootstrap/bootstrap-template.yaml`): the `PermissionsBoundary`
   property appears once, on the `CloudFormationExecutionRole` resource. The deploy role, the
   lookup role and the publishing roles are unbounded.

One bootstrap per account therefore cannot give dev and prod different ceilings — they would
share one execution role. Two qualifiers give two independent sets of bootstrap roles in the
same account, and only the dev set carries the boundary:

| Qualifier | Account | Boundary on `cfn-exec-role` |
| --- | --- | --- |
| `hnbdev` | Platform | `cdk-dev-permissions-boundary` |
| `hnbprod` | Platform | none |
| `hnbmgmt` | Management | none (no workloads, no dev/prod split) |

Qualifiers are defined once in `packages/config/src/bootstrap.ts` and consumed by both this
stack and every app's synthesizer, so the two cannot drift. The bootstrap template caps a
qualifier at **10 characters** of `[A-Za-z0-9_-]`, because
`cdk-<qualifier>-image-publishing-role-<account>-<region>` must fit IAM's 64-character role
name limit. `bootstrapQualifierFor()` enforces that at synth rather than at bootstrap.

> The qualifier passed to `cdk bootstrap` and the qualifier a stack synthesizes with must be
> identical. Nothing validates them against each other: a mismatch surfaces at deploy time as
> an `AssumeRole` failure naming a role that was never created.

## Bootstrap and deploy, in order

The order below is not the usual one. Normally `cdk bootstrap` comes first. Here
`--custom-permissions-boundary` takes a policy **name**, resolves it to
`arn:aws:iam::<account>:policy/<name>` inside the bootstrap template, and **does not check the
policy exists** — the CLI only regex-validates the string. If the policy is missing, the
bootstrap stack fails while creating the CFN execution role. So the policy must exist first,
and the policy lives in this stack.

That is broken by bootstrapping **prod first**, deploying this stack through prod, then
bootstrapping dev.

Requires an SSO session (`aws sso login --profile platform`) and `PLATFORM_ACCOUNT_ID` set.

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
$env:MGMT_ACCOUNT_ID     = "<management account id>"
```

### 1. Bootstrap the management account

Separate account, separate qualifier, no boundary. Nothing else depends on this step.

```powershell
npx cdk bootstrap aws://$env:MGMT_ACCOUNT_ID/us-east-1 --profile mgmt --qualifier hnbmgmt
```

### 2. Bootstrap the Platform account's prod qualifier

No boundary, so nothing has to exist first.

```powershell
npx cdk bootstrap aws://$env:PLATFORM_ACCOUNT_ID/us-east-1 --profile platform --qualifier hnbprod
```

### 3. Deploy this stack

Creates the OIDC provider, the three roles, and `cdk-dev-permissions-boundary`. It is tagged
`env=prod` and synthesizes against `hnbprod`, which step 2 just created.

```powershell
npx cdk deploy BootstrapStack --profile platform
```

If the account already has a GitHub OIDC provider (an account may hold only one per issuer
URL), reference it instead of creating a second:

```powershell
npx cdk deploy BootstrapStack --profile platform `
  -c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

Confirm the policy landed before continuing — step 4 fails opaquely if it did not:

```powershell
aws iam get-policy --profile platform `
  --policy-arn "arn:aws:iam::$($env:PLATFORM_ACCOUNT_ID):policy/cdk-dev-permissions-boundary"
```

### 4. Bootstrap the Platform account's dev qualifier, with the boundary

```powershell
npx cdk bootstrap aws://$env:PLATFORM_ACCOUNT_ID/us-east-1 --profile platform `
  --qualifier hnbdev `
  --custom-permissions-boundary cdk-dev-permissions-boundary
```

The CLI prints `Adding new permissions boundary cdk-dev-permissions-boundary`. Confirm it is
actually attached:

```powershell
aws iam get-role --profile platform `
  --role-name "cdk-hnbdev-cfn-exec-role-$($env:PLATFORM_ACCOUNT_ID)-us-east-1" `
  --query "Role.PermissionsBoundary"
```

Expected: `PermissionsBoundaryArn` ending in `policy/cdk-dev-permissions-boundary`. The prod
role must show `null`:

```powershell
aws iam get-role --profile platform `
  --role-name "cdk-hnbprod-cfn-exec-role-$($env:PLATFORM_ACCOUNT_ID)-us-east-1" `
  --query "Role.PermissionsBoundary"
```

> **Bootstrap before SCPs (§2 A6, §10).** A region-lock SCP applied first can block all four
> steps above and produces a confusing failure.

## Verify the boundary is load-bearing — manual, not automated

**This is a manual verification. It is not run by CI and cannot be.**

`infrastructure/bootstrap/test/dev-permissions-boundary.test.ts` asserts every offline
precondition: that dev and prod resolve to different CFN execution roles, that the boundary
carries the fixed name the bootstrap command passes, that the Deny uses `StringEquals` on
`aws:ResourceTag/env` with value `prod`, and that `gha-deploy-dev` cannot reach the prod
qualifier's roles. It cannot prove the denial happens, because IAM evaluation happens in AWS
against roles created by the CDK CLI's own template.

The probe below is what closes that loop. Run it once after step 4, with SSO admin
credentials, and record the result.

**1. Create a throwaway prod-tagged resource.** An empty S3 bucket costs nothing.

```powershell
$probe = "boundary-probe-$(Get-Random)"
aws s3api create-bucket --profile platform --bucket $probe --region us-east-1
aws s3api put-bucket-tagging --profile platform --bucket $probe `
  --tagging 'TagSet=[{Key=env,Value=prod}]'
```

**2. Assume the dev CFN execution role.** Its trust policy names
`cloudformation.amazonaws.com`, so add yourself temporarily:

```powershell
$acct = $env:PLATFORM_ACCOUNT_ID
$role = "cdk-hnbdev-cfn-exec-role-$acct-us-east-1"
$caller = (aws sts get-caller-identity --profile platform --query Arn --output text)

aws iam update-assume-role-policy --profile platform --role-name $role --policy-document @"
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"},
  {"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$acct:root"},"Action":"sts:AssumeRole"}]}
"@

$c = aws sts assume-role --profile platform `
  --role-arn "arn:aws:iam::$($acct):role/$role" --role-session-name boundary-probe | ConvertFrom-Json
$env:AWS_ACCESS_KEY_ID     = $c.Credentials.AccessKeyId
$env:AWS_SECRET_ACCESS_KEY = $c.Credentials.SecretAccessKey
$env:AWS_SESSION_TOKEN     = $c.Credentials.SessionToken
```

**3. Prove the denial is caused by the boundary, not by a missing Allow.**

Two calls, and both results matter. The role holds `AdministratorAccess`, so an untagged
bucket must **succeed** — that is what rules out "denied because nothing allowed it".

```powershell
# Control: no env=prod tag. Expect SUCCESS.
$control = "boundary-control-$(Get-Random)"
aws s3api create-bucket --bucket $control --region us-east-1

# The actual test. Expect AccessDenied.
aws s3api put-bucket-tagging --bucket $probe --tagging 'TagSet=[{Key=probe,Value=1}]'
```

| Call | Required result | If it differs |
| --- | --- | --- |
| tag the untagged control bucket | succeeds | The role lacks `AdministratorAccess`; the probe proves nothing. Stop. |
| tag the `env=prod` bucket | `AccessDenied` | The boundary is not attached, or the Deny condition is wrong. Re-run step 4. |

`AccessDenied` on the second call *while the first succeeded* is the evidence: the same role,
the same action, differing only by the target's `env` tag.

**4. Clean up. Do not skip this — step 2 widened a trust policy.**

```powershell
Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN
aws iam update-assume-role-policy --profile platform --role-name $role --policy-document `
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws s3api delete-bucket --profile platform --bucket $probe
aws s3api delete-bucket --profile platform --bucket $control
```

### What the boundary still does not cover

- **`aws:ResourceTag` only evaluates against resources that already carry the tag.** It cannot
  prevent creating an untagged resource, and it does not apply during creation.
  `RequiredTagsAspect` closes that at synth time; a direct AWS API call bypasses synth.
- **Prod is unbounded by design.** `cdk-hnbprod-cfn-exec-role-*` holds `AdministratorAccess`
  with no boundary. Prod's control is the GitHub Environment review gate, not IAM.
- **A dev stack that creates an IAM role must apply this boundary to the role it creates**
  (`PermissionsBoundary.of(scope).apply(...)`), or the deploy is denied by
  `DenyCreatingUnboundedPrincipals`. There are no dev-scoped stacks yet
  (`docs/open-issues.md` issue 2); the first one must do this.

## After deploying

1. Copy the three output ARNs into GitHub repository **variables** (Settings → Secrets and
   variables → Actions → Variables). They are not secrets:
   - `AWS_PLAN_ROLE_ARN`
   - `AWS_DEPLOY_DEV_ROLE_ARN`
   - `AWS_DEPLOY_PROD_ROLE_ARN`
2. Create the GitHub Environments (Settings → Environments):
   - `dev` — no protection rules.
   - `prod` — **required reviewers: yourself.** Without this the `environment:prod` `sub`
     claim is cosmetic; the review gate is what actually separates prod from dev.
3. Workflows authenticate with `permissions: id-token: write` and
   `aws-actions/configure-aws-credentials` pointed at the appropriate role ARN. No AWS access
   keys are stored anywhere.
