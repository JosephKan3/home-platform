# Platform Overview

The single reference document for the platform. Consolidates the design goals, the current
architecture, every decision made and why, the rejected alternatives, and the open
questions.

Where this document and an ADR disagree, the ADR wins — it is the narrower, more carefully
scoped statement. This document exists to make the whole thing legible in one read.

- **Status:** design complete, nothing built
- **Last revised:** 2026-08-05

---

## 1. What this is

A personal AWS platform with four simultaneous jobs:

| Goal | What it demands |
| --- | --- |
| **Portfolio artifact** | Recognizable enterprise patterns, visible reasoning, something demoable in five minutes |
| **Startup foundation** | Multiple independent applications, reusable infrastructure, room to grow |
| **Personal hosting** | Public and private apps, internal dashboards, AI tooling, utilities |
| **AI-operated infrastructure** | APIs and automation surfaces rather than manual administration |

Cost is the primary constraint. Complexity is acceptable *only* where it buys architectural
value.

### The reframe that drove every decision

The original design described a target end state and implicitly proposed building all of it:
EKS, four VPCs, self-hosted Temporal, a self-hosted LGTM observability stack, eight MCP
servers. That is roughly $300-500/mo and many months of work, and — critically — the
expensive parts are the *least* differentiating. Every platform engineer has run EKS.

**You are not building a platform. You are building evidence that you can build a platform.**

Those optimize differently. Evidence favors breadth of correct patterns, documented
tradeoffs, and things a reviewer can actually see. It does not favor idle infrastructure.

The near-free items — a multi-account org with OU-attached SCPs, an ADR log, a paved-road
scaffolding CLI, SLOs with burn-rate alerts, a tested restore with a measured RTO, canary
deploys with automated rollback, a custom MCP server over a durable-workflow API with human
approval gates — are what almost nobody has. That is where the budget goes.

**Steady-state target: under $80/mo, with a written justification for every cost decision.**

---

## 2. Architecture at a glance

```
                          AWS Organization
                                 │
              ┌──────────────────┴──────────────────┐
     Management account                      Platform account
     ─────────────────                       ────────────────
     Organizations, OUs, SCPs                Everything that runs.
     IAM Identity Center                     Dev + Prod, separated by
     Consolidated billing, Budgets           CDK Stage + tag-scoped IAM.
     Org CloudTrail, GuardDuty admin
     No workloads.

     OUs (structured for growth):
       Security  ─ empty, reserved
       Workloads ─ contains Platform
       Sandbox   ─ empty, reserved
```

Inside the Platform account, one VPC:

```
  VPC 10.20.0.0/16 · dual-stack IPv4+IPv6 · 2 AZs
  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │  PUBLIC subnets            ──► Internet Gateway (free)         │
  │  ├─ Application Load Balancer                                  │
  │  ├─ ECS Fargate tasks   (strict SG: inbound from ALB SG only)  │
  │  └─ Tailscale subnet router (t4g.nano)                         │
  │                                                                │
  │  ISOLATED subnets          ──► Egress-only IGW, IPv6 (free)    │
  │  ├─ RDS Postgres + pgvector   (no internet route at all)       │
  │  └─ VPC-attached Lambdas                                       │
  │       └─► Gateway endpoints: S3, DynamoDB (free)               │
  │                                                                │
  │  NO NAT Gateway · NO NAT instance · NO Transit Gateway         │
  │  NO interface endpoints by default                             │
  └────────────────────────────────────────────────────────────────┘

  Lambdas that don't need RDS live OUTSIDE the VPC entirely
  → free unmetered internet egress, no ENI cold-start penalty
```

Access and delivery:

```
  josephkan.ca      →  Route53 ALIAS  →  CloudFront  →  S3 (personal site)
  newnotams.net     →  Route53 ALIAS  →  CloudFront  →  Lambda (OpenNext)
  internal.*.ca     →  PRIVATE zone   →  Tailscale Split DNS  →  10.20.0.2
                       (NXDOMAIN publicly — nothing discoverable)

  Admin traffic     →  Tailscale  →  subnet router  →  entire VPC
                       (no public SSH, no public DB ports, ever)
  Deployment        →  GitHub  →  OIDC  →  scoped role  →  CDK  →  CloudFormation
  Progressive       →  CodeDeploy canary  →  CloudWatch alarm  →  auto-rollback
  AI operations     →  MCP  →  Platform API  →  Step Functions  →  approval gate  →  scoped role
```

---

## 3. Decisions

Each row links to the ADR holding the full reasoning, consequences, and rejected alternatives.

| # | Decision | Core reason |
| --- | --- | --- |
| [0001](../decisions/0001-multi-account-organization.md) | Two accounts, OUs structured for more | Accounts are the only hard boundary in AWS, and they're free |
| [0002](../decisions/0002-network-topology.md) | One dual-stack VPC, zero NAT, zero TGW | Avoided ~$70/mo of pure recurring cost with no architectural loss |
| [0003](../decisions/0003-compute-progression.md) | Lambda + Fargate. Kubernetes dropped | ~$200/mo for workloads that fit in Lambda; every capability has a managed replacement |
| [0004](../decisions/0004-repository-strategy.md) | Single monorepo, enforced internal layering | Multi-repo decouples *teams*; there is one team |
| [0005](../decisions/0005-ai-automation-boundary.md) | Durable-workflow Platform API with approval gates | A Platform API is not a security control by itself; workflows + scoped roles + gates are |
| [0006](../decisions/0006-domains.md) | `josephkan.ca` as the platform domain, DNS delegated to Route53 | Already owned; apex-on-CloudFront requires Route53 ALIAS records |

### 3.1 Accounts and identity

Two accounts. Management holds Organizations, SCPs, Identity Center, billing, the org
CloudTrail, and GuardDuty delegated admin — and no workloads. Platform holds everything else.

`Security` and `Sandbox` OUs are created empty. Since SCPs attach to OUs, any future account
inherits every guardrail on creation. Account IDs live in a single `accounts.ts` map, so
adding one is a config change and a `cdk bootstrap`, not a redesign.

**Dev and prod share the Platform account.** This is the largest deliberate compromise in
the design. Three free mechanisms substitute for the account boundary:

1. **CDK Stages** — `DevStage` and `ProdStage`, separate stacks, separate resource names.
2. **Tag-scoped IAM** — the dev deploy role carries a permissions boundary with an explicit
   `Deny` on any action where `aws:ResourceTag/env = prod`. The prod role sits behind a
   GitHub Environment with required reviewers.
3. **Security groups** — dev SGs and prod SGs never reference each other.

This is weaker than an account boundary and is documented as such rather than hidden. A CI
test asserts the dev role is actually denied a prod-tagged action, so the claim is verified
rather than assumed. Graduating prod to its own account is a config uncomment plus a
bootstrap; the stack code does not change.

Identity is IAM Identity Center only. No IAM users, no access keys, anywhere — enforced by
SCP. GitHub Actions authenticates via OIDC with `sub` scoped to
`repo:ORG/REPO:environment:*`, never `repo:ORG/*`.

### 3.2 Networking, and the no-NAT problem

The interesting constraint. NAT Gateway ($33/mo/AZ), NAT instance (~$3/mo but an EC2 box in
the data path), and Transit Gateway ($36/mo/attachment) are all excluded. IGW and
Egress-only IGW are free and permitted.

Everything reduces to: **how does a workload reach the internet without NAT?** Four answers,
all used:

| # | Strategy | Cost | Use for |
| --- | --- | --- | --- |
| 1 | **Lambda with no VPC config** | $0 | Default. Free unmetered egress, no ENI penalty. |
| 2 | **Public subnet + public IP + strict SG** | $3.60/mo per IPv4 | Fargate tasks needing egress |
| 3 | **Egress-only IGW over IPv6** | $0 | Isolated workloads reaching dualstack destinations |
| 4 | **Gateway endpoints (S3, DynamoDB)** | $0 | Always on. Removes the most common egress reasons. |

Strategy 2 is not the same as being publicly reachable — the security group has zero inbound
rules except from the ALB's SG, so unsolicited inbound is dropped exactly as with NAT.

**Two traps worth stating plainly:**

- **Public IPv4 has cost $0.005/hr since Feb 2024** = $3.60/mo per always-on task. Still 10×
  cheaper than a NAT Gateway, free if IPv6-only, but it scales with task count.
- **Docker Hub and `git clone` from github.com are IPv4-only.** Mitigation: pull base images
  from ECR (dualstack) and use the GitHub API over IPv6. Phase 1 has an explicit task to
  verify IPv6 coverage per dependency and record results.

Interface endpoints default to **none** — five across two AZs is $73/mo, more than the NAT
Gateway being avoided.

**Enforcement is two-layered**, because either alone is insufficient:

- A CDK Aspect (`NoManagedEgressAspect`) fails `cdk synth` on NAT Gateway, Transit Gateway,
  or `PRIVATE_WITH_EGRESS`, with an error message naming the actual cause. Fast, local,
  readable. Unit-tested so the guardrail can't silently rot.
- An SCP denies `ec2:CreateNatGateway` and `ec2:CreateTransitGateway`. Backstop for console
  clicks, local deploys, and anything bypassing CI.

The `PRIVATE_WITH_EGRESS` case is caught free: that subnet type is *what constructs* the
`CfnNatGateway`, so the first rule fires.

CIDRs are pre-allocated non-overlapping (`10.10` dev, `10.20` platform, `10.30` shared,
`10.40` sandbox) so any future account can peer without renumbering. Peering, never TGW —
TGW only becomes correct past roughly five VPCs.

### 3.3 Compute

Kubernetes is out of scope. Selection is by workload shape:

| Shape | Runtime |
| --- | --- |
| Static sites, SPAs | S3 + CloudFront (OAC) |
| HTTP APIs, events, cron, glue | **Lambda (ARM)** — the default |
| Always-on services, persistent connections, off-the-shelf containers | **ECS Fargate (ARM)**, Spot in dev |
| Anything stateful | RDS / DynamoDB / S3 — managed, never self-hosted |

Everything stays containerized regardless, so the migration path remains open at zero cost.

**What dropping EKS displaced, and the replacement:**

| Was going to be | Now | Assessment |
| --- | --- | --- |
| ArgoCD (GitOps) | CDK → CloudFormation + scheduled drift detection | Fine — without manifests there's no desired-state doc for ArgoCD to reconcile; CDK already is one |
| **Argo Rollouts** (canary + auto-rollback) | **CodeDeploy** (Lambda + ECS, alarm-triggered rollback) | **Fully preserved** — this was the highest-signal roadmap item |
| Karpenter | Fargate Spot | Fine — no nodes, so no node provisioning problem |
| ALB Controller / Ingress | One shared ALB, host/path listener rules | Fine, same $17/mo |
| cert-manager | ACM | Fine, free and auto-renewing |
| external-dns | CDK Route53 records | Fine |
| Kyverno / OPA | cdk-nag + SCPs | Fine, and shifts policy left — blocks at synth, not admission |
| IRSA / Pod Identity | Lambda execution roles, ECS task roles | Fine, same least-privilege story |
| Self-hosted Temporal | Step Functions | Fine — see 3.5 |
| Self-hosted LGTM | CloudWatch + OTel → Grafana Cloud free tier | Fine, and weeks saved |
| Qdrant | pgvector | Already the plan |

**Nothing critical is lost.** The two things Kubernetes uniquely brought were a GitOps
control loop and progressive delivery. Progressive delivery survives via CodeDeploy; GitOps
largely evaporates without manifests.

**The one real cost:** the Kubernetes keyword isn't covered. If that matters for a target
role, a local `kind` cluster or a time-boxed EKS spike torn down the same week is far
cheaper than a permanently running one.

### 3.4 Repository layout

One monorepo (pnpm workspaces + Turborepo), four top-level layers:

```
infrastructure/   platform-owned, slow-changing, deployed deliberately
applications/     app-owned, fast-changing, deployed continuously
automation/       Platform API, MCP server, deploy bot, paved-road CLI
packages/         shared CDK constructs, config, telemetry, SDK
```

Directory layout alone doesn't create independence, so it's enforced three ways:

1. **pnpm workspaces** — undeclared dependencies don't resolve
2. **`eslint-plugin-boundaries`** in CI with the dependency matrix encoded
3. **No cross-stack CDK exports across the seam** — the load-bearing rule. Applications read
   platform resources via **SSM parameter lookup**, never `Fn::ImportValue`. A CloudFormation
   export makes the exporting stack undeletable and forces lockstep deploys, which is exactly
   the coupling the layout is meant to prevent.

The real seam is the SSM contract:

```
/platform/{env}/vpc/id
/platform/{env}/alb/listener-arn
/platform/{env}/rds/endpoint
/platform/{env}/rds/secret-arn
```

Turborepo's affected graph means an application change deploys only that application.
Pipelines differ per layer: `infrastructure/**` requires approval; `applications/**`
auto-deploys to dev and canaries to prod; `packages/**` runs the full downstream graph.

The separate GitOps repo was dropped along with Kubernetes.

### 3.5 AI automation

The instinct to interpose a Platform API was right; the stated reasoning wasn't. **A Platform
API is not a security control** — whatever serves it holds the IAM permissions, so an
over-permissioned API is exactly as dangerous as an over-permissioned agent, with a worse
property: it feels safe.

The actual threat is prompt injection. An agent reading GitHub issue text, PR comments, or
log lines is reading attacker-controllable input. A filesystem MCP or write-capable database
MCP in that same context is an injection-to-RCE path.

**Trust tiers:**

| Tier | Capability | Controls |
| --- | --- | --- |
| Read | logs, metrics, status, git history | Read-only IAM. Unrestricted agent use. |
| Propose | open PR, draft change, file issue | Git writes only. Never touches AWS. Human merges. |
| Act | deploy, rollback, restart, scale | Durable workflow + approval gate + scoped role + audit |

**What makes the Act tier safe:**

- Every mutation is a **Step Functions execution**, not a synchronous handler — durable
  retries, permanent queryable history, `Catch` blocks invoking real compensating rollback
- Human approval via **`waitForTaskToken`** — execution blocks until a Slack/GitHub
  interaction returns the token; timeout defaults to abort
- **Scoped role per step** (`deploy-newnotams-dev`), tag-scoped, no god role. Dev-scoped
  roles carry the `env=prod` deny boundary — this is what makes the single-account
  compromise survivable under automation
- **Kill switch** — every workflow reads an SSM parameter first and fails closed
- Prod mutations always require approval; destructive operations always require approval
  regardless of environment
- Structured audit events: actor, agent identity, prompt hash, operation, target, approval,
  outcome

**MCP servers: build exactly one.** `platform-mcp`, wrapping the Platform API, inheriting all
of the above. Plus the official read-only GitHub and CloudWatch servers. **No filesystem,
Docker, database-write, or generic AWS-write MCP** in any agent context that also reads
third-party content. The original eight-server list was a shopping list, and several entries
were actively dangerous.

**Portability without a facade.** A generic `WorkflowEngine { start, signal, cancel }`
interface was considered and rejected: it collapses to the lowest common denominator, leaks
anyway (ASL retry semantics and Temporal determinism have no shared abstraction), and the
expensive parts of a migration — orchestration topology, retry policy, compensation wiring —
sit outside those three methods.

**The portable boundary is the activity, not the engine:**

1. Every activity is a plain typed async function with zero engine SDK imports. All business
   logic lives here and ports unchanged.
2. A thin per-engine adapter wraps them (today, a Lambda handler each). Expected to be
   rewritten; it's a few lines.
3. Orchestration is written natively for whichever engine, deliberately un-abstracted,
   because that's where the engine's value lives.
4. The API returns an opaque `operationId`, never an execution ARN, so callers never encode
   engine specifics.

### 3.6 Domains

Two domains, already owned, deliberately separate (ADR-0006). **Nothing new is registered.**

- **`josephkan.ca`** — platform and personal. Apex serves the personal site; `api.` and the
  `internal.` **private** zone (Tailscale-only, no public records) hang off it.
- **`newnotams.net`** — the product. Nothing platform-related, so it can be spun out cleanly.

Both stay registered where they are (GoDaddy for `josephkan.ca`) with **nameservers
delegated to Route53**. Registration and DNS hosting are separable, and only DNS hosting
matters architecturally — transferring incurs a 60-day lock and gains nothing.

**Delegation is mandatory, not a preference.** The apex must point at CloudFront, CloudFront
gives you a hostname rather than a stable IP, and DNS forbids a CNAME at a zone apex. Only
Route53's proprietary **ALIAS record** solves this. Everything else — automated ACM DNS
validation, the private zone, CDK-managed records — follows from the same delegation.

The migration is sequenced so **DNS migration and hosting migration are independent**:
replicate the existing Vercel records into Route53 → verify against the AWS nameservers →
delegate (a no-op, since both sides return identical answers, so no TTL preparation is
needed) → later, flip the apex to an ALIAS. If the AWS deployment misbehaves, that last step
reverts in five minutes without touching nameservers.

`.ca` was previously assumed to be a compromise versus `.com`. It isn't: CIRA has no spam
reputation problem, and a Canadian developer running a Canadian aviation product on a `.ca`
is a signal rather than a concession. A future startup would register its own domain anyway,
which is why personal and company identity should stay separate.

---

## 4. Applications

Full assessments in [applications.md](applications.md). A platform built without a customer
is always wrong, so these define what actually gets built.

### NewNotams (`newnotams.net`) — the driving application

Aviation weather and NOTAM briefing for Canadian airspace. Next.js 16 App Router, React 19,
Auth.js v5 (Google OAuth + credentials), Upstash Redis, Web Push via VAPID, hourly external
cron. Currently on Vercel.

It exercises nearly every platform capability without being trivial: authenticated
server-rendered app, a datastore, a scheduled background job with real state, third-party
API egress, secrets, and a public domain. A weather brief that silently stops arriving is a
genuine incident with a genuine SLO — which is what makes the observability work matter.

Migration: **Phase 1**, Next.js on Lambda via OpenNext + CloudFront, **no VPC attachment**,
Upstash retained initially, external cron → EventBridge Scheduler with direct Lambda invoke
(so the notify path stops being internet-reachable). **Phase 2**, Upstash → DynamoDB, which
fits the access patterns exactly and preserves the no-VPC property.

### Personal site — the first deployment

Next.js 12, fully static (no `getServerSideProps` anywhere), plus two OANDA API routes.

The smallest possible end-to-end proof of the Phase 0 pipeline: GitHub → OIDC → CDK →
CloudFormation → S3 → CloudFront → ACM → Route53, with no database, no VPC, no state.
The OANDA routes become an **EventBridge-scheduled Lambda writing JSON to S3** — removes all
request-path compute, caches at the edge, keeps the OANDA token off any internet-reachable
surface, and survives OANDA outages.

### What reading the real code changed

1. **Neither application needs a VPC.** Both run as VPC-less Lambdas with free unmetered
   egress. This validates the no-NAT decision directly — the constraint costs nothing here.
2. **RDS is deferred out of Phase 1.** Neither app needs relational storage. Saves ~$12/mo
   and drops the Phase 1 target from $20-35 to **$8-15**.
3. **A shared ALB is deferred out of Phase 2.** Both apps front on CloudFront. The $17/mo ALB
   waits for a genuinely long-running container, which may never appear.
4. **EventBridge Scheduler matters more than expected** — both apps want scheduled work.
   First-class construct.
5. **The paved road's first template writes itself:** "Next.js on Lambda via OpenNext +
   CloudFront." Two real consumers, so the abstraction is validated rather than speculative.

---

## 5. Supporting technology

| Area | Choice | Note |
| --- | --- | --- |
| IaC | **AWS CDK (TypeScript)** | Correct over Serverless Framework and over Terraform for this stack. One language, real abstraction, jest-testable. |
| CI/CD | GitHub Actions + OIDC | No static keys anywhere. Separate read-only plan role from apply role. |
| Private access | **Tailscale subnet router**, `t4g.nano`, advertising the VPC CIDR | The "don't install it everywhere" instinct was right. Tailscale SSH, ACLs by tag. |
| DNS | Route53 hosting for `josephkan.ca` + `newnotams.net`, plus an `internal.` private zone. Registrations stay at their current registrars. | ALIAS records are the reason delegation is mandatory. Tailscale Split DNS → `10.20.0.2` for the private zone. |
| Public certs | ACM, DNS-validated, `us-east-1` for CloudFront | Free, auto-renewing. **Never ACM Private CA — $400/mo.** |
| Database | **DynamoDB first** (fits both apps' access patterns, keeps Lambda out of the VPC). RDS Postgres + pgvector when something needs relational or vector storage. | Deferred out of Phase 1 — neither app needs it. |
| Cache | **None initially** | Lambda memory or DynamoDB. ElastiCache only on measured need. |
| Auth | **Authentik** on one Fargate task, OIDC everywhere | Phase 2. Right pick over Keycloak for a solo operator. No app manages its own users. |
| Workflows | **Step Functions** | Temporal Cloud is the upgrade path; self-hosted Temporal (~$50/mo) only if the ops experience is the goal. |
| Observability | CloudWatch + **OTel instrumentation** → Grafana Cloud free tier | The instrumentation is the part that matters and is vendor-neutral. 10k series / 50 GB logs / 50 GB traces free. |
| Secrets | SSM SecureString ($0) by default; Secrets Manager ($0.40/secret) only where rotation is needed | |
| Policy | cdk-nag at synth + SCPs at runtime | |
| Supply chain | cosign signing, SBOM, ECR scan-on-push, Renovate | Phase 2 |

### Configuration profiles

Not free-form parameterization — "dedicated vs shared networking / enable-disable Kubernetes /
enable-disable Temporal" as independent flags is 2^n untested combinations and dead code paths
that break silently. Two named, tested profiles:

```ts
type Profile = 'dev' | 'prod';
// dev:  Lambda + Fargate Spot, 14d logs, no deletion protection
// prod: Lambda + Fargate, 30d logs, deletion protection, PITR, CodeDeploy canary
```

A third is added only when a real third case exists.

---

## 6. Cost

Full detail in [cost-model.md](../cost/cost-model.md).

**Free, and used:** VPC, subnets, route tables, security groups, IGW, Egress-only IGW,
gateway endpoints, VPC peering, Organizations, accounts, SCPs, Identity Center, ACM public
certs.

**Avoided:**

| Avoided | Would cost | Replaced by |
| --- | --- | --- |
| NAT Gateway | ~$33/mo | IGW + EIGW + VPC-less Lambda |
| Transit Gateway | ~$36/mo per attachment | Single VPC; peering if ever needed |
| EKS control plane | ~$73/mo + nodes + ops | Lambda + Fargate + CodeDeploy |
| Self-hosted Temporal | ~$50/mo | Step Functions |
| Self-hosted LGTM | compute + ops | Grafana Cloud free tier |
| ACM Private CA | $400/mo | ACM public + internal certs |

Roughly **$140-200/mo avoided** against the original design.

**Budget by phase** (revised down after reading the real applications — neither needs RDS
or an ALB):

| Phase | Target | Adds |
| --- | --- | --- |
| 0 — Foundation | **$3-8** | Org, 2 accounts, SCPs, Identity Center, domain, Route53, personal site on S3+CloudFront, OIDC, GuardDuty |
| 1 — NewNotams on AWS | **$8-15** | VPC (free), Tailscale `t4g.nano`, Lambda + OpenNext, EventBridge Scheduler, CloudWatch. **RDS deferred.** |
| 2 — Delivery + data | **$25-50** | CodeDeploy canaries, DynamoDB, Grafana Cloud, identity. **ALB only if needed.** |
| 3 — Automation | **$50-90** | Platform API, Step Functions, MCP server, deploy bot |

**Remaining traps:** public IPv4 at $3.60/mo per address; CloudWatch Logs default retention
is *infinite*; cross-AZ data transfer at $0.01/GB each way; accidental NAT Gateway creation
via `PRIVATE_WITH_EGRESS`.

**Guardrails, all in Phase 0:** Budgets with 50/80/100% actual + 100% forecast alerts; Cost
Anomaly Detection; SCPs for region lock, NAT/TGW denial, instance-family denial, IAM user
denial, CloudTrail/GuardDuty protection; CDK Aspects failing synth on missing tags, missing
log retention, and managed egress; S3 lifecycle rules at creation; cost allocation tags from
day one (with one account, tags *are* the billing breakdown).

---

## 7. Roadmap

Full detail with checklists in [roadmap.md](roadmap.md). Each phase gates on the previous
one's exit criteria plus a clean billing cycle.

| Phase | Focus | Exit criterion |
| --- | --- | --- |
| **0** | Org, accounts, SCPs, identity, domain, CI/CD, **personal site** | **A merge to `main` deploys the personal site to production with nobody touching the console.** Bill under $8. A CI test proves the dev role is denied a prod-tagged action. |
| **1** | **NewNotams off Vercel**, EventBridge cron, OTel, SLOs, VPC, Tailscale | NewNotams serves production traffic on AWS with burn-rate alerts. Vercel switched off. No NAT Gateway exists. |
| **2** | CodeDeploy canaries, Upstash → DynamoDB, identity, supply chain | **A canary has automatically rolled back on an injected failure.** A restore has been performed and timed. |
| **3** | Platform API, MCP server, deploy bot, paved-road CLI, chaos | **A new service goes zero-to-production via one CLI command** with observability, alarms, and a runbook. |

**Continuous:** an ADR for every non-obvious decision; one current architecture diagram;
public writing about the tradeoffs; weekly bill review for two months then monthly; a
teardown runbook per phase.

---

## 8. Gaps closed from the original design

Things absent from the handoff that materially matter:

- **Account strategy** — the single biggest gap. No Organizations, SCPs, Identity Center,
  CloudTrail, or GuardDuty appeared anywhere.
- **Backup and restore** — with a *tested* restore and a measured RTO/RPO. Everyone skips
  the test.
- **Disaster recovery posture** — even "single region, RPO 24h, RTO 4h, documented and
  accepted" is a real answer. Silence is not.
- **SLOs and error budgets** — burn-rate alerting is a stronger SRE signal than any tool name.
- **Progressive delivery with automated rollback** — the highest-signal item in the roadmap.
- **Testing** — CDK assertions, snapshot tests, cdk-nag with documented suppressions, smoke
  tests.
- **Runbooks** — a real `runbooks/` directory. Interviewers love this and almost nobody has it.
- **Supply chain** — cosign, SBOM, ECR scanning, Renovate.
- **Secrets rotation** — plus the SSM-vs-Secrets-Manager cost distinction.
- **A paved road** — `platform new-service` scaffolding repo + stack + pipeline + dashboard +
  alarms + runbook. *The* platform-engineering deliverable, and it's mostly code, so it's cheap.

---

## 9. Deliberate compromises

Recorded so they can be defended rather than discovered.

| Compromise | Risk | Mitigation |
| --- | --- | --- |
| Dev and prod share one account | A broad IAM policy could cross the boundary | Permissions boundary denying `env=prod`, CDK Stages, non-referencing SGs, CI test asserting the denial |
| CloudTrail/GuardDuty in the management account | Management-account compromise could tamper with the audit trail | MFA + Identity Center, no standing access, no workloads there |
| Compute in public subnets | SG misconfiguration is directly exploitable | Inbound only from the ALB SG by SG-reference; cdk-nag `AwsSolutions-EC23` blocking `0.0.0.0/0`; GuardDuty; quarterly SG review. Valuable data sits in isolated subnets with *no* internet route — strictly stronger than private+NAT. |
| No Kubernetes | The EKS keyword isn't demonstrated | Everything containerized; a time-boxed spike or local `kind` cluster if a role demands it |
| 2 AZs, not 3 | Lower availability ceiling | Nothing here is multi-AZ-critical; halves future per-AZ endpoint cost; RDS Multi-AZ still possible within 2 |
| Single VPC across environments | SG hygiene is also the environment boundary | Dev and prod SGs never reference each other |
| IPv6 egress dependency | Docker Hub and github.com git are IPv4-only | Pull base images from ECR (dualstack); verify and document coverage per dependency in Phase 1 |
| No Redis initially | Possible latency ceiling | Lambda memory or DynamoDB; add ElastiCache on measured need |

---

## 10. Open questions

Deliberately unresolved. Answer them when the need is concrete, not before.

1. **IPv6 coverage in practice.** How much actually works over EIGW. Phase 1 answers this
   empirically; the answer determines how many public IPv4 addresses get paid for.
3. **Authentik vs Cognito vs staying on Auth.js.** With only NewNotams needing identity,
   Authentik costs a Fargate task plus an ALB (~$29/mo) to replace something that works.
   Decide in Phase 2 against real requirements, not aesthetics.
4. **Step Functions sufficiency.** Whether ASL expresses the approval and compensation
   workflows comfortably, or whether Temporal Cloud becomes worth the move.
5. **Whether a shared ALB is ever needed.** Both applications front on CloudFront. It may
   simply never be justified.
6. **When prod graduates to its own account.** Trigger: real user data, a paying customer,
   or anything where a dev mistake destroying prod would be genuinely costly. NewNotams
   already stores real user accounts, so this may arrive sooner than expected.
7. **Whether a Kubernetes spike is needed at all.** Purely a function of target-role
   keyword requirements, not of platform need.

**Resolved since the original design:** which application drives the platform (NewNotams),
what gets deployed first (the personal site, as the smallest end-to-end pipeline proof), and
whether RDS belongs in Phase 1 (no).

---

## 11. The summary worth remembering

The original plan's expensive items — EKS, four VPCs, NAT Gateways, self-hosted LGTM,
self-hosted Temporal, eight MCP servers — are the least differentiating things in it.

The near-free items — a multi-account org with OU-attached SCPs, an ADR log, a paved-road
CLI, SLOs with burn-rate alerts, a tested restore with a measured RTO, canary deploys with
automated rollback, and a custom MCP server over a durable-workflow API with human approval
gates — are what almost nobody has.

**A platform running at $80/mo with a written explanation of every cost decision is a
stronger artifact than a $300/mo cluster, because the explanation is the skill.**

The remaining risk is not architectural. It is that this stays a design document. Phase 0's
exit criterion is deliberately concrete and deliberately small: *a merge to `main` deploys to
production with nobody touching the console.* Everything else is downstream of getting that
working once.
