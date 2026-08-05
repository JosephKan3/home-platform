# @platform/infra-bootstrap

The GitHub Actions OIDC handoff (Phase 0 action plan §4).

**This is the one stack deployed by hand.** It is what creates the identity CI uses, so it
cannot be deployed by CI. Deploy it once with Identity Center admin credentials; every stack
after it deploys through the roles created here.

## Contents

- A GitHub OIDC identity provider for `https://token.actions.githubusercontent.com`
  (audience `sts.amazonaws.com`). No thumbprint is pinned — AWS manages it.
- Three roles in the Platform account:

| Role | `sub` condition | Permissions |
| --- | --- | --- |
| `gha-plan` | `repo:JosephKan3/home-platform:pull_request` | `ReadOnlyAccess` + assume the CDK lookup role |
| `gha-deploy-dev` | `repo:JosephKan3/home-platform:environment:dev` | Assume CDK bootstrap roles, under a permissions boundary denying `env=prod` |
| `gha-deploy-prod` | `repo:JosephKan3/home-platform:environment:prod` | Assume CDK bootstrap roles |

- `gha-deploy-dev-boundary`, a permissions boundary that denies any action on resources tagged
  `env=prod` and denies the IAM actions that would let the role remove its own boundary. This
  is what makes ADR-0001's single-account dev/prod compromise survivable.

Trust policies use `StringEquals` on both `aud` and the full `sub`. Never `StringLike` — a
wildcard such as `repo:JosephKan3/*` would grant every repository the owner has, forever,
including ones not yet created.

## Deploy

Requires an SSO session (`aws sso login --profile platform`) and `PLATFORM_ACCOUNT_ID` set.

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
npx cdk deploy BootstrapStack --profile platform
```

If the account already has a GitHub OIDC provider (an account may hold only one per issuer
URL), reference it instead of creating a second:

```powershell
npx cdk deploy BootstrapStack --profile platform `
  -c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

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
