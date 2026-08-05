# ADR-0001: AWS Organization with multi-account isolation

- Status: Proposed
- Date: 2026-08-05

## Context

The original design has no account strategy and treats the VPC as the primary isolation
boundary. Requirements include enterprise-grade architecture, blast-radius control between
experimental and real workloads, and low cost.

## Decision

Adopt AWS Organizations with separate accounts as the primary isolation boundary.

```
Root (management)   billing, SCPs, Organizations. No workloads. MFA-enforced, rarely used.
├── Security        org CloudTrail, GuardDuty delegated admin, Security Hub, Config, backup vault
├── Shared-Services Route53 public zones, ECR, Tailscale subnet router, self-hosted CI runners
├── Dev             all non-production workloads
├── Prod            all production workloads
└── Sandbox         SCP-restricted, hard budget cap, periodically nuked
```

Access via IAM Identity Center with permission sets, not IAM users. Zero long-lived access
keys anywhere. GitHub Actions authenticates by OIDC into per-account, per-repo roles.

## Rationale

- Accounts are the only hard boundary in AWS for IAM, quotas, billing, and blast radius.
- Accounts and cross-account IAM cost **$0**. Multi-VPC costs $36/mo per TGW attachment
  for a strictly weaker boundary.
- Per-account billing makes cost attribution trivial without tag discipline.
- Sandbox can be aggressively restricted and destroyed without touching anything real.
- Directly demonstrates the account/landing-zone patterns interviewers ask about.

## Consequences

- Cross-account role assumption is required for CI/CD and for any shared resource access.
- ECR images live in Shared-Services with cross-account pull policies.
- Route53 public zone lives in Shared-Services; workload accounts get a cross-account
  role for record management, or use delegated subdomain zones per account (preferred).
- CDK must be bootstrapped in every account with `--trust` pointing at the deployment
  account; this is a known one-time source of confusion.
- Some AWS service quotas are per-account and will need individual increase requests.

## Guardrails to apply at the org level

- SCP: deny all regions except the primary + `us-east-1` (global services).
- SCP: deny leaving the organization, disabling CloudTrail, GuardDuty, or Config.
- SCP: deny expensive EC2 families (`p*`, `g*`, `x*`, `u-*`, `*.metal`) outside Prod.
- SCP on Sandbox: deny IAM user creation, deny public S3, deny RDS Multi-AZ.
- Budgets + Cost Anomaly Detection per account, alerting to email and SNS.

## Alternatives considered

- **Single account with tag-based separation.** Rejected: no real blast-radius or IAM
  boundary, and cost attribution requires perfect tag hygiene.
- **AWS Control Tower.** Viable and faster, and provides an audit story out of the box.
  Rejected for now because its mandatory Config recorders add ongoing cost and it obscures
  the underlying mechanics that are worth learning and demonstrating. Revisit if the manual
  org becomes a maintenance burden.
