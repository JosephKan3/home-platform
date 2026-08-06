# Break glass

CI cannot deploy, or you are locked out.

Local `cdk deploy` is a break-glass action, not routine (`docs/phase-0-action-plan.md` §4).
Everything here is something to do once, announce, and then fix properly so it is not needed
again.

## Pick the symptom

| Symptom | Go to |
| --- | --- |
| CI fails at `configure-aws-credentials` with a credentials or AssumeRole error | [OIDC is broken](#oidc-is-broken) |
| CI authenticates but a deploy fails with `AccessDenied` / `UnauthorizedOperation` and you hold admin | [An SCP is denying it](#an-scp-is-denying-it) |
| CI is fine but a deploy must ship now and cannot wait for the pipeline | [Deploy by hand](#deploy-by-hand) |
| `josephkan.ca` is down or serving the wrong thing | [`dns-rollback.md`](dns-rollback.md) — go there first, come back after |
| SSO itself will not log in | [SSO is down](#sso-is-down) |

---

## Get admin

Every procedure below starts here. Identity Center SSO is the only standing path to admin;
there are no IAM users and no access keys in either account, by design (§9 exit criteria).

```powershell
aws sso login --profile platform
aws sts get-caller-identity --profile platform
```

Must return `arn:aws:sts::<platform-account-id>:assumed-role/AWSReservedSSO_AdministratorAccess/<you>`.

For anything involving the organization, SCPs, or the audit trail:

```powershell
aws sso login --profile mgmt
aws sts get-caller-identity --profile mgmt
```

If the profiles do not exist on this machine, recreate them — this needs only the Identity
Center start URL, not any stored secret:

```powershell
aws configure sso
# Start URL: https://d-xxxxxxxxxx.awsapps.com/start
# Region:    us-east-1
# Profile:   platform   (repeat for mgmt)
```

Sessions are 4h for `AdministratorAccess`. An expired session looks like a permissions error;
re-run `aws sso login` before debugging anything else.

---

## Deploy by hand

Only when CI genuinely cannot do it. **Announce it** — in the PR, in a commit message, or in
whatever channel exists. An undocumented manual deploy means the next person reads the repo
and believes something that is not true about the running account.

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"

# Always diff first. A manual deploy skips the PR diff, which is the only review
# the change would otherwise get.
pnpm --filter @platform/infra-dns exec cdk diff DnsStack --profile platform
pnpm --filter @platform/infra-dns exec cdk deploy DnsStack --profile platform
```

The other stacks:

```powershell
pnpm --filter @platform/infra-bootstrap exec cdk deploy BootstrapStack --profile platform
pnpm --filter @platform/personal-site   exec cdk deploy PersonalSiteStack --profile platform

$env:MGMT_ACCOUNT_ID = "<management account id>"
pnpm --filter @platform/infra-org exec cdk deploy GovernanceStack --profile mgmt `
  -c workloadsOuId=ou-xxxx-xxxxxxxx -c sandboxOuId=ou-xxxx-xxxxxxxx
```

`PersonalSiteStack` needs the real Next.js static export on disk. Do **not** pass
`-c sitePlaceholder=true` to a deploy — it publishes a placeholder page to a live domain. That
flag is for synth and CI only.

Afterwards, in order:

1. Confirm the deployed state matches `main`: `cdk diff` should be empty.
2. If it is not, the manual deploy has drifted from the repo. Land the change in `main` before
   doing anything else, or the next CI deploy silently reverts it.
3. Write down what was deployed and why.

---

## An SCP is denying it

The symptom is an `AccessDenied` or `UnauthorizedOperation` on a call you clearly have IAM
permission to make, in an account where you are an administrator. The error does not mention
SCPs.

### The escape hatch

**SCPs do not apply to the management account.** This is not a gap — it is the property that
makes a mistaken SCP recoverable, and it is the entire reason nothing is ever allowed to run in
the management account (`docs/phase-0-action-plan.md` §2 A1, §10;
`infrastructure/org/README.md`). If management held workloads, a bad SCP could lock out the
only place from which it can be removed.

So: the fix is always run from `--profile mgmt`.

### Find and detach

```powershell
# What is attached, and to what
aws organizations list-roots --profile mgmt
aws organizations list-organizational-units-for-parent --parent-id <root-id> --profile mgmt
aws organizations list-policies-for-target `
  --target-id <workloads-ou-id> --filter SERVICE_CONTROL_POLICY --profile mgmt

# Read the one you suspect
aws organizations describe-policy --policy-id <policy-id> --profile mgmt `
  --query "Policy.Content" --output text
```

Detach it:

```powershell
aws organizations detach-policy --policy-id <policy-id> `
  --target-id <workloads-ou-id> --profile mgmt
```

Detaching takes effect immediately. `FullAWSAccess` cannot be detached while it is the only
policy attached, and you would not want to.

The three policies and what each blocks:

| Policy | Blocks |
| --- | --- |
| `platform-region-lock` | Any non-global service action outside `us-east-1` |
| `platform-cost-guardrails` | NAT/Transit Gateway creation, large EC2 instance families |
| `platform-security-guardrails` | `iam:CreateUser`, `iam:CreateAccessKey`, disabling CloudTrail/GuardDuty/Config, leaving the org |

### The one that locks you out hardest

`platform-region-lock` uses `NotAction` with a list of global service namespaces
(`GLOBAL_SERVICE_NAMESPACES` in `infrastructure/org/lib/service-control-policies.ts`). Global
services report an `aws:RequestedRegion` that is not `us-east-1` — IAM and Organizations report
`aws-global`. Dropping a namespace from that list denies, simultaneously:

- every IAM call — no role can be created, read, or repaired;
- every Organizations call — **the SCP cannot be detached from inside the org**;
- every Route53 call — DNS cannot be changed and the site cannot be recovered;
- every CloudFront call — the distribution is frozen;
- every billing, Cost Explorer and Support call — the damage is invisible and Support cannot
  be reached.

If this happens: the management account is still exempt, so `--profile mgmt` still works and
the detach above still succeeds. That is the whole safety net. Treat any diff that shortens
`GLOBAL_SERVICE_NAMESPACES` as a defect.

### After the emergency

Detaching by hand puts the account out of sync with the repo. The next `GovernanceStack` deploy
re-attaches whatever the code says. Fix the policy in
`infrastructure/org/lib/service-control-policies.ts`, land it, and redeploy — do not leave a
detached policy as the permanent state.

---

## OIDC is broken

CI fails at `aws-actions/configure-aws-credentials` with a credentials error, an
`AssumeRoleWithWebIdentity` failure, or `Not authorized to perform sts:AssumeRoleWithWebIdentity`.

### Check the workflow first — it is usually this

1. **`permissions: id-token: write` is missing from the job or workflow.** Without it GitHub
   never mints an OIDC token, and the action fails complaining about credentials rather than
   permissions. Most common cause by a wide margin.
2. **The `environment:` key was removed from a deploy job.** The `gha-deploy-dev` and
   `gha-deploy-prod` trust policies are `StringEquals` on
   `repo:JosephKan3/home-platform:environment:dev` / `:environment:prod`. GitHub only puts
   `environment:<name>` in the `sub` claim when the job declares `environment:`. Remove the key
   and the token's `sub` becomes `repo:JosephKan3/home-platform:ref:refs/heads/main`, which
   matches no trust policy. This is deliberate: the environment key is load-bearing for
   authentication, not just for the review gate.
3. **The role ARN variable is empty.** `vars.AWS_PLAN_ROLE_ARN`,
   `vars.AWS_DEPLOY_DEV_ROLE_ARN`, `vars.AWS_DEPLOY_PROD_ROLE_ARN` are repository *variables*,
   not secrets. An unset variable renders as an empty string and produces a confusing error.

### Check the trust policy

```powershell
aws iam get-role --role-name gha-plan --profile platform `
  --query "Role.AssumeRolePolicyDocument"
aws iam get-role --role-name gha-deploy-dev  --profile platform --query "Role.AssumeRolePolicyDocument"
aws iam get-role --role-name gha-deploy-prod --profile platform --query "Role.AssumeRolePolicyDocument"
```

Each must show `StringEquals` on both claims:

```json
"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
"token.actions.githubusercontent.com:sub": "repo:JosephKan3/home-platform:environment:prod"
```

| Role | Expected `sub` |
| --- | --- |
| `gha-plan` | `repo:JosephKan3/home-platform:pull_request` |
| `gha-deploy-dev` | `repo:JosephKan3/home-platform:environment:dev` |
| `gha-deploy-prod` | `repo:JosephKan3/home-platform:environment:prod` |

If any of these is `StringLike` with a wildcard, that is a security defect, not just a bug —
`repo:JosephKan3/*` grants every repository the owner has, including ones not yet created. Fix
it in code and redeploy.

Also confirm the provider exists:

```powershell
aws iam list-open-id-connect-providers --profile platform
# arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

### Fix it

Trust policies are code. Correct
`infrastructure/bootstrap/lib/github-oidc-stack.ts`, then redeploy by hand with SSO admin —
CI cannot fix the identity it needs in order to run:

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
pnpm --filter @platform/infra-bootstrap exec cdk diff BootstrapStack --profile platform
pnpm --filter @platform/infra-bootstrap exec cdk deploy BootstrapStack --profile platform
```

If the account already holds a GitHub OIDC provider from something else (an account may hold
only one per issuer URL), reference it rather than creating a second:

```powershell
pnpm --filter @platform/infra-bootstrap exec cdk deploy BootstrapStack --profile platform `
  -c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

Then re-run the failed workflow. Do not paste AWS access keys into GitHub secrets as a
workaround — a static credential added under pressure outlives the pressure, and
`platform-security-guardrails` denies creating one anyway.

---

## SSO is down

If Identity Center itself will not authenticate, check the AWS Health Dashboard before
assuming it is your configuration. If it is a real regional Identity Center outage, wait —
there is no correct workaround, and the incorrect one is using root.

---

## Root account use

Root is used **twice per account, ever**: once at creation to set a password, enable MFA, and
remove any access keys; and then never again (§2 A5, §9 exit criteria).

Genuinely requires root:

- **Closing an AWS account** from within itself, when it cannot be removed from the
  organization.
- **Changing or cancelling the support plan.**
- **Changing the account's root email address or the account name.**
- **Restoring access when the Identity Center instance is gone** and no other admin path
  exists.
- A small set of billing operations, notably tax settings and certain payment-method changes.
- Turning off "IAM user and role access to billing information" — the setting that was turned
  *on* during Stage A.

Everything else is a mistake. In particular, root is not the answer to:

- an SCP lockout — use the management account, which SCPs never constrain;
- a broken OIDC role — use SSO admin;
- a failed deploy — use SSO admin;
- an expired session — run `aws sso login` again.

If root is used, treat it as an incident: note the date, what was done, and why no other path
existed. It is one of the Phase 0 exit criteria that root has not been used since Stage A, and
that criterion is only meaningful if exceptions are recorded rather than forgotten.

Never create a root access key. If one exists, delete it now.
