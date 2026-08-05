# ADR-0003: Serverless first, Kubernetes in Phase 2

- Status: Proposed
- Date: 2026-08-05

## Context

The design calls for EKS + Helm + ArgoCD + Karpenter. EKS is $73/mo for the control plane
alone, before nodes, load balancers, or the operational cost of running ArgoCD, Authentik,
Prometheus, Loki, Tempo, and Temporal as self-managed workloads.

Kubernetes experience is a genuine hiring signal and should not be dropped. The question is
ordering.

## Decision

Three-tier compute progression, gated on real need:

| Workload shape | Runtime | Phase |
| --- | --- | --- |
| Static sites, SPAs | S3 + CloudFront (OAC) | 0 |
| Event-driven, spiky, low-volume APIs | Lambda (ARM, Function URL or API Gateway) | 0-1 |
| Always-on services, containers, background workers | ECS Fargate (ARM, Spot in dev) | 1 |
| Multi-service platform workloads, operators, GitOps | EKS + Karpenter | 2 |

**Gate to enter Phase 2:** two consecutive billing cycles at or under the Phase 1 budget
with no anomaly alerts, AND at least two real applications running in Phase 1 compute that
would concretely benefit from moving.

When EKS is built: one cluster in Dev, one in Prod. EKS Auto Mode or Karpenter with spot +
graviton. A minimal 2-node on-demand baseline only for Karpenter/CoreDNS themselves. EKS
Pod Identity over IRSA (simpler, newer, no OIDC provider juggling). One shared ALB via
AWS Load Balancer Controller with host-based Ingress rules — not one ALB per service.

## Rationale

- Lambda and Fargate cover every workload described in the handoff for the first several
  months, at a fraction of the cost and near-zero operational overhead.
- A Kubernetes cluster with no workloads on it demonstrates nothing. A cluster you migrated
  real services onto, with a documented rationale, demonstrates judgment.
- The GitOps and Helm skills transfer regardless of when the cluster is built.
- Building EKS last means it is built against known requirements rather than guessed ones.

## Consequences

- Some Phase 1 work is migrated later. Mitigated by containerizing everything from the start
  and keeping the Fargate task definition close to what a Deployment would look like.
- ArgoCD, Authentik, Temporal, and the LGTM stack are deferred to Phase 2/3. Interim
  substitutes: Cognito or Authentik on a single Fargate task for auth, Grafana Cloud free
  tier for observability, Step Functions or a Temporal Cloud free namespace for workflows.
- Helm charts written in Phase 2, not before.
