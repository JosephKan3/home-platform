# Home Platform

Design workspace for a personal AWS platform intended to double as a portfolio-grade
platform-engineering artifact and a future startup substrate.

Nothing is built yet. This repo currently holds the design review, decisions, and roadmap.

## Shape

- **2 AWS accounts** — management + one workload account. OUs structured for more.
- **1 VPC**, dual-stack, 2 AZs, public + isolated subnets only.
- **No NAT Gateway, no NAT instance, no Transit Gateway.** IGW, Egress-only IGW, gateway
  endpoints, and VPC-less Lambda instead. Enforced by SCP.
- **No Kubernetes.** Lambda by default, ECS Fargate when Lambda doesn't fit.
- **Steady-state target: under $50/mo.**

## Driving applications

| App | Domain | Phase | Shape |
| --- | --- | --- | --- |
| Personal site | `josephkan.ca` | 0 | Static + scheduled OANDA fetch. The pipeline proof. |
| NewNotams | `newnotams.net` | 1 | Next.js on Lambda, auth, KV store, hourly push job. |

Both domains are already owned. DNS delegates to Route53; registrations stay put.

Neither needs a VPC — both run as VPC-less Lambdas with free egress, which validates the
no-NAT design directly.

## Contents

| Path | Purpose |
| --- | --- |
| **`QUICKSTART.md`** | **Do the manual bootstrap, step by step. Start here.** |
| **`docs/phase-0-action-plan.md`** | **Executable plan for the current phase.** |
| **`docs/open-issues.md`** | **Known gaps found while building. Read before deploying.** |
| **`docs/architecture/overview.md`** | **The complete design reference.** |
| **`docs/development.md`** | **Working in this repo: the inner loop, testing, guardrails, common errors.** |
| `docs/runbooks/` | Teardown, break-glass, DNS rollback |
| `docs/architecture/applications.md` | NewNotams and the personal site — what they need, migration paths |
| `docs/cost/cost-model.md` | AWS unit costs, avoidances, and traps |
| `docs/architecture/roadmap.md` | Phased build plan with exit criteria |
| `docs/architecture/review.md` | Critique of the original design handoff |
| `docs/decisions/0001` | Two-account organization, structured for growth |
| `docs/decisions/0002` | Single dual-stack VPC, zero NAT, zero TGW |
| `docs/decisions/0003` | Serverless + containers, Kubernetes dropped |
| `docs/decisions/0004` | Single monorepo, enforced internal layering |
| `docs/decisions/0005` | AI automation boundary and approval gates |
| `docs/decisions/0006` | Domain strategy and registrar choice |
| `docs/decisions/0007` | Policy as code: cdk-nag and the suppression policy |
| `docs/decisions/0008` | CDK is the only IaC tool; Serverless Framework rejected |

## Current status

**Phase 0 code complete. Nothing deployed to AWS yet.**

All four CDK stacks build, test, and synth clean — 251 tests, zero unsuppressed cdk-nag
errors. What remains is the manual bootstrap (Stage A) and the DNS migration.

**Doing that bootstrap now?** `QUICKSTART.md` is the linear, copy-pasteable version.

```
pnpm install
pnpm -r build && pnpm -r test        # 251 tests
pnpm lint
```

**Working in this repo:** see `docs/development.md`. `cdk synth` is the fast feedback loop —
it runs the three guardrail Aspects and cdk-nag with no AWS calls and no credentials, only
`MGMT_ACCOUNT_ID` and `PLATFORM_ACCOUNT_ID`. That document also covers where CDK's dev loop
is genuinely worse than the Serverless Framework one it replaced (ADR-0008).

**Next actions, in order:**

1. Read `docs/open-issues.md`. Issue 1 (the dev permissions boundary is not load-bearing)
   and issue 6 (live DNS values unverified against GoDaddy) both need a decision before
   they bite.
2. Work `docs/phase-0-action-plan.md` §2 Stage A — the manual AWS Organization bootstrap.
3. At GoDaddy, confirm auto-renew and transfer lock. No TTL change is needed — see the
   correction in the action plan §1.

## What exists

| Package | Contents |
| --- | --- |
| `packages/config` | Accounts, domains, env profiles, tags, SSM path contract |
| `packages/constructs` | Three guardrail Aspects + cdk-nag suppression helpers |
| `infrastructure/bootstrap` | GitHub OIDC provider + three scoped deploy roles |
| `infrastructure/org` | SCPs, org CloudTrail, budgets, cost anomaly detection |
| `infrastructure/dns` | Hosted zones, ACM cert, zero-downtime Vercel→CloudFront cutover |
| `applications/personal-site` | S3 + CloudFront + OAC, hourly OANDA fetcher Lambda |

## Reading order

1. `docs/phase-0-action-plan.md` — what to actually do next
2. `docs/architecture/overview.md` — everything, in one read
3. `docs/decisions/` — the full reasoning behind each commitment
4. `docs/architecture/roadmap.md` — execution order
5. `docs/cost/cost-model.md` — the numbers
6. `docs/architecture/review.md` — background critique of the original design
