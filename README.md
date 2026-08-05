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
| **`docs/architecture/overview.md`** | **Start here. The complete reference.** |
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

## Reading order

1. `docs/architecture/overview.md` — everything, in one read
2. `docs/decisions/` — the full reasoning behind each commitment
3. `docs/architecture/roadmap.md` — execution order
4. `docs/cost/cost-model.md` — the numbers
5. `docs/architecture/review.md` — background critique of the original design
