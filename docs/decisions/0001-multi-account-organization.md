# ADR-0001: AWS Organization, two accounts, structured for growth

- Status: Accepted
- Date: 2026-08-05
- Revises: earlier five-account proposal

## Context

Multi-account is the right boundary (accounts are free; VPC/TGW boundaries are not), but
five accounts multiplies fixed per-account costs — GuardDuty minimums, Config recorders,
duplicated endpoints, duplicated Tailscale routers, and a separate CDK bootstrap in each.
The requirement is a two-account footprint today that can grow without redesign.

## Decision

Two accounts. OU structure sized for more.

```
Root (management account)
│   Organizations, SCPs, IAM Identity Center, consolidated billing, Budgets
│   Org CloudTrail + GuardDuty delegated admin  [temporary — see deviations]
│   NO workloads. Root user MFA'd and locked away.
│
├── Security OU        (empty — reserved)
├── Workloads OU
│   └── Platform       ← the only workload account. Dev + Prod live here.
└── Sandbox OU         (empty — reserved)
```

The **Platform** account holds everything: VPC, Lambda, Fargate, RDS, S3, CloudFront,
Route53 records, ECR, Tailscale router.

### Environment separation inside one account

Dev and Prod are separated by three mechanisms, none of which cost anything:

1. **CDK Stages.** `DevStage` and `ProdStage`, separate stacks, separate resource names.
2. **Tag-based IAM.** Every resource carries `env=dev|prod`. The GitHub Actions *dev*
   deploy role has a permissions boundary with an explicit `Deny` on any action where
   `aws:ResourceTag/env = prod`. The prod role is gated behind a GitHub Environment with
   required reviewers.
3. **Security groups.** Dev SGs and Prod SGs never reference each other. No path exists
   between them even inside the shared VPC.

This is weaker than an account boundary and it is a **deliberate, documented compromise**.
The escape hatch is designed in: see "Growth path".

## Deviations from the ideal, recorded honestly

| Ideal | What we do | Why | Risk accepted |
| --- | --- | --- | --- |
| CloudTrail/GuardDuty in a dedicated Security account | In the management account | No third account | An attacker with management access could tamper with the audit trail. Mitigated by MFA + Identity Center + no standing access. |
| Dev and Prod in separate accounts | Same account, tag + SG separated | Halves fixed cost | A sufficiently broad IAM policy could cross the boundary. Mitigated by permissions boundaries and `cdk-nag`. |
| Dedicated Sandbox account | Sandbox = a tagged stage in the same account, budget-alerted | No fourth account | Less containment. Mitigated by SCP region lock and instance-family denies. |

## Growth path (the "designed for more" part)

Nothing here needs to be rewritten to add accounts. Concretely:

- **SCPs attach to OUs, not accounts.** A new account dropped into `Workloads` inherits
  every guardrail immediately.
- **Account IDs are config, not code.** A single `accounts.ts` map drives every stack:

  ```ts
  export const accounts = {
    management: { id: '...', region: 'us-east-1' },
    platform:   { id: '...', region: 'us-east-1' },
    // prod:    { id: '...', region: 'us-east-1' },   ← uncomment to graduate
  };
  ```

- **CIDRs are pre-allocated and non-overlapping** (ADR-0002), so a future account's VPC can
  peer without renumbering.
- **Accounts are created declaratively** via `AWS::Organizations::Account` in CDK, so
  adding one is a PR, not console clicking.
- **Graduating Prod to its own account** is then: uncomment the config entry, `cdk bootstrap`
  the new account with `--trust`, re-point `ProdStage` at it, redeploy, migrate data. The
  stack code itself does not change.

Trigger for graduating: real user data, a paying customer, or anything where a dev mistake
destroying prod would be genuinely costly.

## Guardrails at the org level (day one)

- SCP: deny every region except the primary + `us-east-1` (global services live there).
- SCP: deny leaving the organization; deny disabling CloudTrail, GuardDuty, or Config.
- SCP: deny `ec2:RunInstances` for `p*`, `g*`, `x*`, `u-*`, `*.metal`, and anything larger
  than `large`. This is the single highest-value cost guardrail.
- SCP: deny creating NAT Gateways and Transit Gateways outright (ADR-0002). If a future
  need is real, removing the SCP is a deliberate, reviewed act.
- SCP: deny IAM user creation and access key creation anywhere. Identity Center only.
- Budgets on the Platform account with 50/80/100% actual + 100% forecast alerts.
  Cost Anomaly Detection monitor.
- Cost allocation tags active from day one: `app`, `env`, `owner`.

## Consequences

- Only two CDK bootstraps. The management account bootstrap exists solely so org-level
  IaC can deploy; it hosts no workloads.
- GuardDuty runs once, not five times.
- Blast radius between dev and prod is IAM-shaped, not account-shaped. This must be stated
  in the portfolio writeup rather than hidden — knowing *why* it's a compromise is the
  signal.
- Billing granularity comes from cost allocation tags rather than per-account rollup.
  Tag enforcement therefore matters more; enforce via a CDK Aspect that fails synth on
  untagged resources.
- **Three CDK bootstraps, not two.** The Platform account is bootstrapped twice, under
  separate qualifiers (`hnbdev`, `hnbprod`), because the permissions boundary in mechanism 2
  above is only load-bearing on the CDK CloudFormation execution role — a boundary caps a
  principal and does not follow a role chain, so attaching it to the GitHub deploy role
  constrained nothing. `cdk bootstrap --custom-permissions-boundary` attaches it to
  `cdk-<qualifier>-cfn-exec-role-*` and nowhere else, so dev and prod need separate execution
  roles. Only the dev one carries the boundary; prod's control is the review gate.
  See `docs/open-issues.md` issue 1 and `infrastructure/bootstrap/README.md`.
