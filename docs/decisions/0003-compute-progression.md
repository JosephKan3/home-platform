# ADR-0003: Serverless and containers only. Kubernetes dropped.

- Status: Accepted
- Date: 2026-08-05
- Revises: earlier "EKS in Phase 2" position

## Context

EKS is $73/mo for the control plane before a single pod runs, plus nodes, plus an ALB,
plus the operational cost of running and upgrading ArgoCD, cert-manager, external-dns,
Karpenter, the AWS Load Balancer Controller, and every self-hosted platform service that
was going to live on it. Realistic floor: $200-280/mo.

With one workload account and no NAT, the workloads that actually exist are: a few HTTP
APIs, some background jobs, a couple of static sites, and eventually AI/workflow services.
None of these need Kubernetes.

## Decision

Kubernetes is **out of scope**. Compute is chosen by workload shape:

| Workload shape | Runtime | Notes |
| --- | --- | --- |
| Static sites, SPAs | S3 + CloudFront (OAC) | No compute. Effectively free. |
| HTTP APIs, event handlers, cron, glue | **Lambda (ARM)** | Default. No VPC unless it needs RDS. |
| Long-running / always-on services, anything needing a full container runtime | **ECS Fargate (ARM)** | Public subnet + strict SG per ADR-0002. |
| Bursty batch, non-urgent jobs | Fargate Spot | ~70% discount, dev especially. |
| Anything stateful | RDS / ElastiCache / S3 / DynamoDB | Managed. Never self-host a database. |

**Default to Lambda.** Reach for Fargate only when Lambda genuinely doesn't fit: >15 min
runtime, persistent connections (WebSocket servers, Temporal workers), a process that must
stay warm, or an off-the-shelf container (Authentik, Grafana) that isn't packaged as a Lambda.

Containerize everything anyway. A Fargate task definition and a Kubernetes Deployment
describe the same thing; keeping images clean preserves the option without paying for it.

## What dropping Kubernetes displaces

This is the part that needs checking, because several Phase 2/3 items assumed a cluster.

| Was going to run on EKS | Replacement | Verdict |
| --- | --- | --- |
| **ArgoCD** (GitOps) | CDK Pipelines / GitHub Actions → CloudFormation | Fine. Infra was always CDK-deployed; ArgoCD only ever covered app manifests, which no longer exist. The GitOps repo from ADR-0004 is no longer needed. |
| **Argo Rollouts** (canary + auto-rollback) | **CodeDeploy** for Lambda (linear/canary traffic shifting with CloudWatch alarm rollback) and for ECS (blue/green with automatic rollback) | **Fine, arguably better.** This was the highest-signal item on the roadmap and it survives intact — CodeDeploy does canary-with-automatic-rollback-on-alarm natively for both Lambda and ECS. |
| **Karpenter** (spot, bin-packing) | Fargate Spot | Fine. The problem Karpenter solves — node provisioning — doesn't exist without nodes. |
| **AWS Load Balancer Controller / Ingress** | One shared ALB with host- and path-based listener rules across ECS services; Lambda behind API Gateway or a Function URL | Fine. One ALB, many targets, same $17/mo. |
| **cert-manager** | ACM | Fine. ACM public certs are free and auto-renew. |
| **external-dns** | CDK Route53 records | Fine. |
| **Kyverno / OPA Gatekeeper** (admission policy) | **cdk-nag** at synth time + SCPs at runtime | Fine, and shifts policy left. Blocks the bad resource before it's created rather than at admission. |
| **EKS Pod Identity / IRSA** | Lambda execution roles, ECS task roles | Fine. Same least-privilege story, less machinery. |
| **Authentik** (container) | Single Fargate task, or Cognito | Fine. Authentik on one Fargate task is ~$12/mo. |
| **Temporal** (self-hosted) | Temporal Cloud free tier, or **Step Functions** | Fine. See below. |
| **Self-hosted LGTM stack** | CloudWatch + OTel → Grafana Cloud free tier | Fine, and was already the Phase 1 recommendation. |
| **Qdrant** (container) | pgvector | Already the plan. |

**Nothing critical is lost.** The two things Kubernetes uniquely provided were a GitOps
control loop and progressive delivery. Progressive delivery is fully replaced by CodeDeploy.
GitOps largely evaporates, because without Kubernetes manifests there is no desired-state
document for ArgoCD to reconcile — CDK + CloudFormation already is that document, and
CloudFormation drift detection covers the reconciliation gap.

### Temporal, specifically

Temporal workers need persistent connections, so they are Fargate, not Lambda. Options:

1. **Step Functions** — no infrastructure, pay per transition, native AWS. Sufficient for
   OCR pipelines and retry orchestration. Weaker for the human-approval-signal pattern in
   ADR-0005, though `waitForTaskToken` covers it directly.
2. **Temporal Cloud free tier** — real Temporal semantics, no servers to run.
3. **Self-hosted Temporal** — 3 Fargate tasks + a Postgres database. ~$50/mo. Only if the
   operational experience is itself the goal.

Start with Step Functions. `waitForTaskToken` gives durable human-approval gates, which is
the property ADR-0005 actually depends on. Move to Temporal only if workflow complexity
genuinely outgrows it.

## Rationale

- The workloads that exist do not need a cluster. Running one would be paying $200+/mo to
  demonstrate a skill rather than to serve a need.
- Every capability EKS provided has a managed, cheaper AWS-native equivalent that
  demonstrates equivalent judgment.
- Choosing Lambda/Fargate *and being able to explain precisely why not Kubernetes* is a
  stronger signal than running an idle cluster. "I evaluated EKS, priced it at $200/mo
  against workloads that fit in Lambda, chose Fargate + CodeDeploy, and kept everything
  containerized so the migration stays open" is a better interview answer than "I run EKS."

## Consequences

- **The Kubernetes line item on a résumé is not covered by this project.** If that specific
  keyword matters for a target role, the cheapest fix is a local `kind`/`k3d` cluster or a
  time-boxed EKS spike that is torn down the same week — not a permanently running cluster.
- ADR-0004's separate GitOps manifest repo is **no longer needed**. Everything collapses
  into the monorepo.
- No Helm charts. No Kubernetes manifests. Roadmap Phase 2 shrinks substantially.
- Reintroduction path if it's ever needed: workloads are already containerized; EKS Auto
  Mode removes most of the node-management work; ALB and ACM carry over unchanged.
