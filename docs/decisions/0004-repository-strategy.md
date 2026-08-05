# ADR-0004: Monorepo plus a separate GitOps manifest repo

- Status: Proposed
- Date: 2026-08-05

## Context

The handoff proposes a GitHub Organization with separate repos for `platform`,
`automation`, `platform-api`, `platform-libraries`, per-application repos, and templates —
six-plus repos before any code exists, for a single operator.

## Decision

Start with **one monorepo** (pnpm workspaces + Turborepo) plus **one separate GitOps
manifest repo**.

```
home-platform/
├── infra/
│   ├── bootstrap/          org, SCPs, Identity Center, CDK bootstrap, OIDC roles
│   ├── accounts/           per-account baseline: VPC, egress, DNS, logging
│   └── platform/           cluster, shared RDS, shared Redis, ingress, observability
├── packages/
│   ├── constructs/         reusable CDK L3s: Vpc, Alb, Postgres, Redis, Service, Site
│   ├── config/             environment profiles, tagging Aspects, cdk-nag rules
│   ├── telemetry/          OTel setup, structured logging, SLO helpers
│   └── sdk/                typed Platform API client
├── services/
│   ├── platform-api/       Temporal-backed operations API
│   ├── platform-mcp/       custom MCP server fronting platform-api
│   └── deploy-bot/         GitHub App
├── apps/
│   ├── newnotams/
│   ├── portfolio/
│   └── receipts/
├── cli/                    `platform new-service` paved-road scaffolding
├── docs/                   ADRs, diagrams, runbooks
└── .github/workflows/

home-platform-gitops/       ArgoCD app-of-apps, Helm values, image tags (Phase 2)
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
- The GitOps repo is separate because ArgoCD conventionally expects it, and because
  automated image-tag commits should not pollute source history or trigger source CI.

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
- **Monorepo including GitOps manifests.** Rejected: ArgoCD write-back commits create noisy
  history and CI loops.
