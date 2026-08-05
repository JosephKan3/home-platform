# ADR-0002: One VPC per account per environment

- Status: Proposed
- Date: 2026-08-05
- Supersedes: the "bounded-context VPC" and "one VPC per application" proposals

## Context

The handoff considered three topologies: one shared VPC, bounded-context VPCs (Shared
Services / Public Applications / AI Platform / Sandbox), and one VPC per application. It
leaned toward bounded-context VPCs on the reasoning that VPCs are free.

VPCs are free. Connecting them is not, and every VPC needs its own egress path.

## Decision

**One VPC per account per environment.** Dual-stack IPv4 + IPv6, 3 AZs, three subnet tiers:

| Tier | Route | Contents |
| --- | --- | --- |
| Public | IGW | ALB/NLB, NAT instance, Tailscale subnet router |
| Private | NAT instance (dev) / NAT GW (prod), EIGW for IPv6 | EKS nodes, ECS tasks, Lambdas needing egress |
| Isolated | none, gateway endpoints only | RDS, ElastiCache, anything with no egress need |

CIDR plan, non-overlapping so any future peering/TGW is possible without renumbering:

```
10.10.0.0/16  Dev
10.20.0.0/16  Prod
10.30.0.0/16  Shared-Services
10.40.0.0/16  Sandbox
```

Segmentation *within* a VPC uses security groups referencing other security groups by ID
(free, dynamic, self-documenting) and Kubernetes namespaces + NetworkPolicy. Not subnets,
not NACLs, not additional VPCs.

Egress by environment:
- Dev/Sandbox: `fck-nat` NAT instance, `t4g.nano`, ASG desired=1. ~$3/mo. SPOF accepted.
- Prod: single-AZ NAT Gateway. ~$33/mo. Add second AZ only if an SLO demands it.
- Both: gateway endpoints for S3 and DynamoDB always (free). Interface endpoints only when
  a specific workload's data volume justifies $7.30/AZ/mo, or when a workload must run in
  an isolated subnet with no egress at all.
- Egress-only IGW for IPv6 in every VPC (free).

## Rationale

- Four bounded-context VPCs that all need to reach shared Postgres, Authentik, Grafana, and
  ECR require a full mesh. Transit Gateway is $36/mo per attachment: $144/mo before traffic.
  Peering avoids the fee but is non-transitive and creates route-table sprawl.
- Each VPC needs independent egress. 4 × NAT = $132/mo, or 4 NAT instances to patch.
- "AI Platform" and "Public Applications" are the same trust tier on the same nodes. The
  boundary is conceptual, not a security control.
- Environment isolation is a real requirement with real consequences; that boundary is
  already provided by the account split in ADR-0001, and a VPC per account falls out for free.
- Security groups provide finer-grained, cheaper, more dynamic segmentation than VPCs.

## Consequences

- Blast radius within an environment is larger. Mitigated by SGs, namespaces, NetworkPolicy,
  and per-app IAM roles (IRSA / Pod Identity).
- Dev NAT instance is a single point of failure. Acceptable; documented; ASG restores it.
- If a genuinely different trust boundary appears — running untrusted third-party code,
  a compliance scope, a customer-dedicated deployment — the answer is a **new account**,
  and peering or TGW can be added at that point without renumbering.
- IPv6 requires per-workload verification; not every AWS service or third-party endpoint
  is dualstack yet.

## Alternatives considered

- **Bounded-context VPCs.** Rejected on cost ($144+/mo in TGW attachments and duplicated
  egress) for a boundary that security groups already provide.
- **One VPC per application.** Rejected. Recurring cost scales linearly with app count via
  egress and load balancers, not via the VPC itself.
- **Single VPC across all environments.** Rejected. Dev must not be able to reach Prod data.
