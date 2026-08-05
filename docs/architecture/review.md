# Design Review

Review of the handoff document. Organized as: what's right, what's wrong, what's missing.

---

## Verdict

The technology selections are almost all correct. The **sequencing and scoping are not**.

The design describes a target end state and implicitly proposes building it. That end state
is roughly 8-12 months of full-time platform work and $300-500/mo, and the parts that are
hardest to build are also the parts that demonstrate the least skill. Meanwhile the single
biggest gap — there is no AWS Organization, no account strategy, and no security baseline
anywhere in the document — is the thing an actual platform engineering interviewer asks
about first.

The core reframe: **you are not building a platform, you are building evidence that you can
build a platform.** Those optimize differently. Evidence favors breadth of correct patterns,
strong documentation of tradeoffs, and things a reviewer can see working in five minutes.
The current plan favors depth in expensive infrastructure that mostly sits idle.

---

## What's right — keep without changes

| Decision | Why it's correct |
| --- | --- |
| **CDK + TypeScript** | Right call over Serverless Framework and over Terraform *for you*. One language, real programmatic abstraction, native L2/L3 constructs, testable with jest. |
| **GitHub OIDC, no static keys** | Non-negotiable and correct. Just scope the trust policy tightly (see below). |
| **Tailscale subnet router** | Exactly right, and the "don't install it everywhere" instinct is correct. Cheapest and best private access story available. |
| **Postgres + pgvector before Qdrant** | Correct. pgvector handles millions of vectors fine. Qdrant is a premature dependency. |
| **Temporal for business workflows, not infra orchestration** | Correct distinction, and one most people get wrong. |
| **ArgoCD / GitOps, infra pipeline separate from app pipeline** | Correct separation. |
| **Applications own their infrastructure** | Your pushback on the original centralized proposal was right. Team-topology-correct: platform ships paved roads, product owns its resources. |
| **Shared constructs as libraries, not shared infrastructure** | This is the single best idea in the document. It's the actual definition of a platform. |
| **Route53, ACM, OIDC-everywhere via Authentik** | Fine. Authentik is the right pick over Keycloak for a solo operator. |
| **Parameterization / configuration-driven architecture** | Right instinct, with a caveat below. |

---

## What's wrong

### 1. There is no account strategy. This is the biggest gap.

The document never mentions AWS Organizations, multiple accounts, IAM Identity Center,
CloudTrail, GuardDuty, Security Hub, or SCPs. It jumps straight to VPCs.

No enterprise AWS environment is single-account. The account is the only hard security,
blast-radius, quota, and billing boundary AWS provides. VPCs are a *soft* boundary by
comparison — a mistaken IAM policy crosses VPCs trivially, but cannot cross accounts.

And critically for your constraints: **accounts are free, and cross-account IAM is free.**
Multi-account gives you the enterprise-architecture portfolio story at $0/mo. Multi-VPC
costs $36/mo per Transit Gateway attachment to achieve a weaker boundary.

Minimum viable structure:

```
Root (management) — billing, SCPs, no workloads
├── Security          CloudTrail org trail, GuardDuty admin, Security Hub, Config
├── Shared Services   Route53 public zones, ECR, Tailscale, CI runners
├── Dev               everything experimental
├── Prod              everything real
└── Sandbox           SCP-restricted, auto-nuked, budget-capped
```

Control Tower gives you this in an afternoon and adds an audit story, but its guardrails
add Config costs. `aws-organizations` + CDK + IAM Identity Center manually is cheaper and
demonstrates more. Either is defensible; document which and why.

### 2. Bounded-context VPCs are the wrong axis to cut on

"Shared Services / Public Applications / AI Platform / Sandbox" reads well but does not
survive contact with the cost model:

- Every VPC needs its own egress. 4 VPCs × NAT = $132/mo, or 4 NAT instances to manage.
- The AI Platform VPC needs Postgres, which lives in Shared Services. That's cross-VPC.
- The Public Applications VPC needs Authentik and Grafana, in Shared Services. Cross-VPC.
- Every app needs ECR, S3, Secrets Manager. Cross-VPC or duplicated endpoints.
- Full connectivity ⇒ Transit Gateway ⇒ $144/mo in attachments alone.

You've created four networks that all need to talk to each other, then paid to reconnect
them. The "bounded context" framing is a domain-modeling concept being applied to a
network-topology problem where the actual constraint is egress cost and route-table
complexity.

**Environment is the boundary that pays for itself.** Dev and Prod must be isolated —
that's a real requirement with real consequences. "AI Platform vs Public Applications" is
not; they're the same trust tier running on the same nodes.

Recommendation: **one VPC per account per environment.** Dual-stack, 3 AZs, isolated +
private + public subnet tiers. Segment with security groups (free, dynamic, referenceable
by SG ID) and Kubernetes namespaces + NetworkPolicy (free) rather than VPCs. If you later
need a genuinely separate trust boundary — say, running untrusted customer code — that
justifies a new *account*, and you can add a peering connection or a TGW then.

See ADR-0002.

### 3. Kubernetes is sequenced too early

EKS is $73/mo for the control plane before a single pod runs, plus nodes, plus an ALB,
plus the operational tax of upgrades, IRSA/Pod Identity, CNI IP exhaustion, and the fact
that ArgoCD, Authentik, Grafana, Prometheus, Loki, Tempo, and Temporal all become
your problem to run and upgrade.

Realistically that's a $200-280/mo floor and a large fraction of your build time spent on
YAML that doesn't distinguish you from anyone else with an EKS cluster.

But **do not drop it.** "I run EKS with ArgoCD, Karpenter, and IRSA" is a genuine hiring
signal. The fix is ordering, not exclusion: Lambda/ECS Fargate first for real workloads,
EKS in Phase 2 once you have applications worth putting on it and a cost baseline you trust.

When you do build it: single cluster, Karpenter with spot + graviton, no managed node
groups beyond a tiny 2-node on-demand baseline for Karpenter/CoreDNS itself.

### 4. "One VPC per application" — dead, correctly

The document already reached this conclusion. Recording why so it stays dead: the per-app
recurring cost is not the VPC, it's the egress path, the ALB, and the endpoints. 10 apps ×
(NAT + ALB) = $500/mo. Share the ALB via host/path rules and Ingress; share the cluster;
share the egress.

### 5. Parameterization will become the problem it's meant to solve

"Dedicated vs shared networking / dedicated vs shared DB / enable-disable Kubernetes /
enable-disable Temporal" as config flags is 2^n untested combinations. In practice you'll
run two: dev and prod. Everything else is dead code paths that break silently.

Constrain it to a small set of named, tested profiles:

```ts
type Profile = 'dev' | 'prod';
// dev:  Lambda + Fargate Spot, shared RDS t4g.micro, NAT instance, 14d logs, no Multi-AZ
// prod: EKS + Karpenter, dedicated RDS, NAT GW, 30d logs, Multi-AZ, deletion protection
```

Add a third profile only when a real third case exists. This is still "configuration-driven
architecture" — it just doesn't have a combinatorial explosion behind it.

### 6. "AI should not directly operate AWS — expose a Platform API" is right, but the risk is misplaced

Correct conclusion, slightly wrong reasoning. A Platform API is good because it gives you
stable, idempotent, auditable, testable operations. It is **not** a security control by
itself — whatever runs the API holds the IAM permissions, so an over-permissioned Platform
API is exactly as dangerous as an over-permissioned agent, with a false sense of safety.

What actually makes it safe:

- Every mutating endpoint is a **Temporal workflow**, not a synchronous call. Free retries,
  durable audit trail, human-approval signals, and compensating rollback.
- The API assumes a **narrowly scoped role per operation**, not one god role.
- Destructive operations (prod deploy, rollback, delete, scale-down) require an approval
  signal — a Slack/GitHub interaction — before the workflow proceeds.
- Everything writes a structured audit event. Who, what, which agent, which prompt hash.
- Rate limits and a global kill switch (an SSM parameter the workflow checks) per agent.

That combination *is* a strong portfolio artifact. "I built an AI ops layer with durable
execution, per-operation least privilege, and mandatory human approval on destructive
actions" is a much better sentence than "I gave Claude an AWS MCP server."

### 7. The MCP server list is a shopping list, not a design

Eight MCP servers (GitHub, AWS, K8s, Docker, CDK, CloudWatch, filesystem, database) is
mostly off-the-shelf integration, and several are actively dangerous: a filesystem MCP and
a database MCP with write access, driven by an agent that can read attacker-controlled
GitHub issue text, is a prompt-injection-to-RCE path. Anything the agent reads that a
third party can write is untrusted input.

Build **one** MCP server — yours, wrapping your Platform API — plus the read-only GitHub
and CloudWatch ones. The custom MCP server is the interesting artifact; the rest are
`npx` invocations.

### 8. Observability is over-specified and will be expensive

CloudWatch + OTel + Grafana + Prometheus + Loki + Tempo is a five-component self-hosted
stack. Running the LGTM stack well is a job. Self-hosting it in Phase 1 means you spend
your time on Prometheus retention and Loki object-store config instead of on your platform.

Sequence: CloudWatch + OTel SDK instrumentation from day one (the instrumentation is the
part that matters and is vendor-neutral) → **Grafana Cloud free tier** (10k series, 50 GB
logs, 50 GB traces — genuinely generous, $0) → self-host LGTM in Phase 3 only if you want
the operational experience specifically.

Also missing and more important than any of the above: **SLOs, error budgets, and alert
routing.** "I defined SLIs/SLOs with error budget burn-rate alerts" is a stronger SRE
signal than the name of any tool. Grafana or CloudWatch can both do it.

### 9. Missing: everything about data and failure

Not mentioned anywhere in the document:

- **Backup and restore.** AWS Backup plans, RDS PITR, cross-account backup vault copies,
  and — the part everyone skips — a *tested* restore runbook with a measured RTO/RPO.
- **Disaster recovery.** Even just "single region, RPO 24h, RTO 4h, documented and accepted"
  is a real answer. Silence is not.
- **Secrets rotation.** Secrets Manager rotation Lambdas for RDS. Also: prefer SSM Parameter
  Store SecureString ($0) for non-rotating config over Secrets Manager ($0.40/secret/mo).
- **Testing.** CDK assertions + snapshot tests, `cdk-nag` with documented suppressions,
  Checkov/tfsec-equivalent in CI, contract tests, smoke tests post-deploy.
- **Progressive delivery.** Argo Rollouts or CodeDeploy canaries, automated rollback on
  SLO burn. This is the highest-signal thing on this list.
- **Runbooks and incident response.** A `runbooks/` directory with real procedures.
  Interviewers love this and almost nobody has it.
- **Supply chain.** Image signing (cosign), SBOM generation, ECR scanning, Dependabot/Renovate.
- **DNS/domain plan.** Which domain, and the delegation model for `internal.example.com`
  as a private hosted zone.

### 10. Repository structure has too many repos

Five-plus repos before there's a line of code, with cross-repo versioning to manage and no
atomic changes across platform and apps. For a solo operator this is friction with no
corresponding benefit — the multi-repo model exists to decouple *teams*, and there is one
team.

**Start with a monorepo.** pnpm workspaces + Turborepo/Nx. Split out an application into
its own repo when it genuinely needs an independent release cadence or a different set of
collaborators — and when you do, that split is itself a good thing to write about. The
GitOps manifest repo should be separate from the start (ArgoCD conventionally wants that,
and it keeps automated image-tag commits out of your source history).

See ADR-0004.

### 11. GitHub OIDC trust policy — the detail that's usually wrong

Scope `sub` to `repo:ORG/REPO:ref:refs/heads/main` or `repo:ORG/REPO:environment:prod`,
never `repo:ORG/*`. Verify `aud=sts.amazonaws.com`. Use a GitHub Environment with required
reviewers for the prod role. Separate plan (read-only) and apply roles; PRs get plan only.

---

## Things worth adding that aren't in the document

1. **A developer platform / paved road with a real interface.** A `platform` CLI or Backstage
   template where `platform new-service foo` scaffolds repo + CDK stack + pipeline + dashboard
   + alerts + runbook. This is *the* platform-engineering deliverable, and it's mostly code
   rather than infrastructure — cheap to build, high signal.
2. **Policy as code.** cdk-nag in CI, plus OPA/Kyverno in the cluster later. Demonstrates
   governance thinking.
3. **An architecture decision record habit.** Already started here. Keep it up; the ADR log
   is often the most impressive artifact in a portfolio because it shows reasoning, not just
   the result.
4. **A public architecture diagram + writeup.** Nobody will clone your repo and read the CDK.
   They will look at one diagram and one page of prose. Budget real effort for this.
5. **Chaos/failure injection.** Even one FIS experiment killing an AZ, with the SLO dashboard
   showing the response, is memorable.
6. **Actually run something users touch.** A platform with no workload is a demo. Pick one
   real app (NewNotams sounds like the one) and drive every platform decision from its needs.
   Platforms built without a customer are always wrong.

---

## Answers to the outstanding questions

**1. Infrastructure ownership — centralized, app-owned, or hybrid?**
Hybrid, and specifically: platform owns *account-level and network-level* resources (VPC,
subnets, egress, cluster, DNS zones, shared observability). Apps own *everything above the
network* (their compute, their database, their queues, their DNS records, their alarms).
The seam is: if destroying it would break another app, platform owns it. Apps consume
platform resources by lookup (SSM parameters / `Vpc.fromLookup`), never by cross-stack
export, which creates undeletable dependency locks.

**2. Networking boundaries — single, bounded-context, or per-app VPC?**
One VPC per account per environment. Accounts are the boundary; VPCs are plumbing.
Security groups and namespaces do the intra-VPC segmentation. See ADR-0002.

**3. Kubernetes now or after a serverless phase?**
After. Lambda + ECS Fargate in Phase 1, EKS in Phase 2. Non-negotiable prerequisite for
Phase 2: two consecutive billing cycles at the Phase 1 budget with no surprises.

**4. How to partition shared services across VPCs?**
Don't partition — that's the multi-VPC problem restated. One shared Postgres instance with
a database and role per app (separate instances only for prod-critical or compliance cases),
one Redis/Valkey, one cluster with namespace isolation. Shared Services *account* holds
cross-environment things: Route53 public zones, ECR, Tailscale router, CI runners.

**5. Should CDK Stages own application deployment structure?**
Yes. `Stage` per environment per app is the right unit — it's what CDK Pipelines consumes
and it makes "deploy app X to env Y" a single object. Inside a stage keep stacks split by
*lifecycle*, not by layer: things that change hourly (compute, config) separate from things
that never change (VPC, RDS). A stack you deploy 50×/day should not contain your database.

**6. Cleanest repository structure?**
Monorepo (pnpm + Turborepo) + a separate GitOps manifests repo. See ADR-0004.

**7. Better patterns that preserve portfolio value without cost/complexity?**
- Multi-account org instead of multi-VPC — better boundary, $0 instead of $144/mo.
- NAT instance instead of NAT Gateway in dev — $3 instead of $33.
- Grafana Cloud free tier instead of self-hosted LGTM — $0 and 3 weeks saved.
- Karpenter + spot + graviton instead of managed node groups — 60-80% off compute.
- ECS Fargate for stateless services instead of a second cluster.
- SSM Parameter Store instead of Secrets Manager where no rotation is needed.
- CloudFront + S3 (OAC) for static sites instead of any always-on compute.
- Aurora Serverless v2 only if it can scale to 0 ACU — otherwise t4g.micro RDS is cheaper.
- **Write about it.** A blog post series on the tradeoffs is worth more in interviews than
  another $100/mo of running infrastructure.

---

## The uncomfortable summary

The parts of this plan that cost the most money and time — EKS, four VPCs, self-hosted LGTM,
Temporal, eight MCP servers — are the *least* differentiating. Every platform engineer has
run EKS.

The parts that are nearly free — multi-account org with SCPs, an ADR log, a paved-road
scaffolding CLI, SLOs with burn-rate alerts, a tested restore runbook, progressive delivery
with automated rollback, a custom MCP server fronting a Temporal-backed Platform API with
human approval gates — are what almost nobody has.

Spend your budget on the second list. Build the first list slowly, and only in service of a
real application.
