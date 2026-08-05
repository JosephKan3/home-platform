# ADR-0005: AI operates through a Temporal-backed Platform API with approval gates

- Status: Proposed
- Date: 2026-08-05

## Context

The design wants AI to automate large portions of development and operations, via eight
MCP servers (GitHub, AWS, Kubernetes, Docker, CDK, CloudWatch, filesystem, database) and a
Platform API exposing `POST /deploy`, `/rollback`, `/restart`, `GET /logs`, `/metrics`.

The instinct to interpose a Platform API is correct. But a Platform API is not a security
control on its own — whatever process serves it holds the IAM permissions. An
over-permissioned Platform API is exactly as dangerous as an over-permissioned agent, with
a worse property: it feels safe.

The real threat is prompt injection. An agent that reads GitHub issue text, PR comments,
log lines, or web content is reading attacker-controllable input. A filesystem MCP or a
read-write database MCP in that same context is an injection-to-RCE path.

## Decision

**Trust tiers.**

| Tier | Capability | Controls |
| --- | --- | --- |
| Read | logs, metrics, deployment status, git history | Read-only IAM. Unrestricted agent use. |
| Propose | open PR, draft manifest change, file issue | Writes to git only. Never touches AWS. Human merges. |
| Act | deploy, rollback, restart, scale | Temporal workflow + approval signal + scoped role + audit. |

**Every mutating operation is a Temporal workflow**, not a synchronous handler:

- Durable execution with free retries and a permanent, queryable audit trail.
- Human approval implemented as a Temporal signal — the workflow blocks on a Slack or
  GitHub interaction before proceeding, with a timeout that defaults to abort.
- Compensating activities give real rollback, not best-effort cleanup.
- A global kill switch: every workflow checks an SSM parameter before its first activity.

**Least privilege per operation.** The Platform API holds no standing AWS power. Each
activity assumes a narrowly scoped role (`deploy-newnotams-dev`, `restart-service-prod`)
scoped by resource tag. No god role.

**Prod mutations always require human approval.** Dev may auto-approve non-destructive
operations. Destructive operations (delete, scale-to-zero, DB modification) always require
approval regardless of environment.

**MCP servers.** Build exactly one — `platform-mcp`, wrapping the Platform API, inheriting
all of the above. Use the official read-only GitHub and CloudWatch servers. Do **not**
deploy filesystem, Docker, database-write, or generic AWS-write MCP servers in any agent
context that also reads third-party content.

**Every agent action emits a structured audit event**: actor, agent identity, prompt hash,
operation, target, approval record, outcome. Shipped to CloudTrail-adjacent storage,
retained, and dashboarded.

## Rationale

- Durable execution turns "the agent did a thing" into an inspectable, resumable,
  reversible record.
- Scoped-role-per-operation means a compromised or confused agent has bounded reach.
- Approval gates keep a human in the loop exactly where the cost of a mistake is highest,
  without slowing down the 90% of operations that are read-only or dev-scoped.
- This is a materially better portfolio artifact than an off-the-shelf MCP configuration:
  it demonstrates security thinking, durable execution, and least privilege, not integration.

## Consequences

- Temporal becomes a hard dependency of the Platform API. Start on Temporal Cloud's free
  tier or a single-container dev server; self-host in Phase 3 if at all.
- Every new operation costs more to build than a plain endpoint would. This is the point.
- Approval fatigue is a real risk. Tune by keeping the read and propose tiers wide and
  frictionless, so approvals stay rare and meaningful.
