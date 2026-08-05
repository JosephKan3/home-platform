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
├── infrastructure/          ← platform-owned. Slow-changing. Deployed deliberately.
│   ├── org/                 Organization, OUs, SCPs, Identity Center, account definitions
│   ├── bootstrap/           CDK bootstrap config, GitHub OIDC provider + deploy roles
│   ├── network/             VPC, subnets, IGW, EIGW, gateway endpoints, base security groups
│   └── platform/            shared RDS, shared ALB, Route53, ECR, observability, Tailscale
│
├── applications/            ← app-owned. Fast-changing. Deployed continuously.
│   ├── newnotams/
│   │   ├── infra/           its own CDK stacks — consumes platform via SSM lookup
│   │   └── src/
│   ├── portfolio/
│   └── receipts/
│
├── automation/              ← the AI/ops layer (ADR-0005)
│   ├── platform-api/        operations API; activities/ is engine-agnostic
│   ├── platform-mcp/        custom MCP server fronting platform-api
│   ├── deploy-bot/          GitHub App
│   └── cli/                 `platform new-service` paved-road scaffolding
│
├── packages/                ← shared code. Published internally, consumed by all of the above.
│   ├── constructs/          reusable CDK L3s: Vpc, Alb, Postgres, ServerlessApi, Site, FargateService
│   ├── config/              dev/prod profiles, accounts.ts, tagging + guardrail Aspects
│   ├── telemetry/           OTel setup, structured logging, SLO helpers
│   └── sdk/                 typed Platform API client
│
├── docs/                    ADRs, diagrams, runbooks
└── .github/workflows/
```

### The dependency rule that keeps the separation real

Directory layout alone does not create independence — it has to be enforced, or
`applications/` will import from `infrastructure/` within a month. The rule:

```
applications/*  →  packages/*          ✅
automation/*    →  packages/*          ✅
infrastructure/*→  packages/*          ✅
applications/*  →  infrastructure/*    ❌  blocked
applications/*  →  applications/*      ❌  blocked
infrastructure/*→  applications/*      ❌  blocked
```

Enforced three ways, not by convention:

1. **pnpm workspaces.** A package can only import what's in its own `dependencies`. Nothing
   in `applications/` lists `infrastructure/` as a dependency, so the import doesn't resolve.
2. **`eslint-plugin-boundaries`** (or `depcruise`) in CI with the matrix above encoded.
3. **No cross-stack CDK exports across the seam.** Applications read platform resources via
   **SSM parameter lookup** (`StringParameter.valueFromLookup`) or `Vpc.fromLookup`, never
   `Fn::ImportValue`. This is the load-bearing one: a CloudFormation export creates a hard
   dependency that makes the exporting stack undeletable and forces lockstep deploys —
   exactly the coupling the layout is meant to prevent.

Platform stacks publish their outputs to well-known SSM paths:

```
/platform/{env}/vpc/id
/platform/{env}/alb/listener-arn
/platform/{env}/rds/endpoint
/platform/{env}/rds/secret-arn
```

That contract is the actual seam between platform and applications. The directories just
make it visible.

### Independent deployability

Turborepo's affected-graph means a change under `applications/newnotams/` deploys only that
application; `infrastructure/network/` is not synthesized or diffed. CI pipelines are split
accordingly:

- `infrastructure/**` → requires approval, deploys to prod behind a GitHub Environment.
- `applications/**` → auto-deploys to dev, canary-deploys to prod via CodeDeploy.
- `packages/**` → runs the full downstream graph, since it can affect everything.

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
- Logical separation between infrastructure and applications is preserved by enforced
  dependency rules and an SSM-parameter contract, not by repository boundaries. This keeps
  the option of extracting an application into its own repo cheap: the seam already exists.

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
