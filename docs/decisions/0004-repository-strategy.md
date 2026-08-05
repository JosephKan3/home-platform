# ADR-0004: Single monorepo

- Status: Accepted
- Date: 2026-08-05
- Revised: GitOps manifest repo dropped following ADR-0003 (no Kubernetes)

## Context

The handoff proposes a GitHub Organization with separate repos for `platform`,
`automation`, `platform-api`, `platform-libraries`, per-application repos, and templates —
six-plus repos before any code exists, for a single operator.

An earlier version of this ADR kept a separate GitOps manifest repo for ArgoCD. ADR-0003
dropped Kubernetes, so there are no manifests and no ArgoCD. That repo is no longer needed.

## Decision

**One monorepo** (pnpm workspaces + Turborepo).

```
home-platform/
├── infra/
│   ├── org/                Organization, OUs, SCPs, Identity Center, account definitions
│   ├── bootstrap/          CDK bootstrap config, GitHub OIDC provider + deploy roles
│   ├── network/            VPC, subnets, IGW, EIGW, gateway endpoints, security groups
│   └── platform/           shared RDS, ALB, Route53, ECR, observability, Tailscale router
├── packages/
│   ├── constructs/         reusable CDK L3s: Vpc, Alb, Postgres, ServerlessApi, Site, FargateService
│   ├── config/             dev/prod profiles, tagging Aspects, cdk-nag rules, accounts.ts
│   ├── telemetry/          OTel setup, structured logging, SLO helpers
│   └── sdk/                typed Platform API client
├── services/
│   ├── platform-api/       operations API (Step Functions backed)
│   ├── platform-mcp/       custom MCP server fronting platform-api
│   └── deploy-bot/         GitHub App
├── apps/
│   ├── newnotams/
│   ├── portfolio/
│   └── receipts/
├── cli/                    `platform new-service` paved-road scaffolding
├── docs/                   ADRs, diagrams, runbooks
└── .github/workflows/
```

Split an application into its own repo only when it has a genuinely independent release
cadence or different collaborators. Document the split as an ADR when it happens.

## Rationale

- Multi-repo exists to decouple teams. There is one team.
- Atomic cross-cutting changes: updating a shared construct and every consumer in one PR
  and one CI run.
- Turborepo affected-graph builds mean only changed projects deploy; the "monorepos are
  slow" objection doesn't apply at this scale.
- One dependency graph, one lockfile, one Renovate config, one CI setup.
- With no Kubernetes there is no ArgoCD write-back loop, so the original reason to separate
  a manifest repo is gone. CDK + CloudFormation is the desired-state document.

## Consequences

- CI must implement path/graph filtering from day one or every push runs everything.
- Repo-scoped GitHub OIDC trust policies are coarser; compensate by scoping on
  `environment:` and using GitHub Environments with required reviewers for prod.
- Extracting a repo later requires history surgery (`git subtree split`) if history matters.
- Local folder structure mirrors the monorepo, not an org of repos — simpler than the
  `Projects/Platform|Automation|Libraries|Applications|Sandbox` layout proposed.

## Alternatives considered

- **Polyrepo as originally proposed.** Rejected: cross-repo version coordination and no
  atomic changes, for benefits that only materialize with multiple teams.
- **Separate GitOps repo.** Withdrawn. Was correct while Kubernetes was in scope; ADR-0003
  removed the manifests it would have held.
