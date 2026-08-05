# ADR-0005: AI operates through a durable-workflow Platform API with approval gates

- Status: Accepted
- Date: 2026-08-05
- Revised: Step Functions replaces Temporal as the initial workflow engine (ADR-0003)

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
| Act | deploy, rollback, restart, scale | Durable workflow + approval gate + scoped role + audit. |

**Every mutating operation is a durable workflow**, not a synchronous handler. The engine is
**AWS Step Functions** (see ADR-0003); Temporal remains the upgrade path if workflow
complexity outgrows it. The required properties are engine-independent:

- Durable execution with built-in retries and a permanent, queryable execution history.
- Human approval implemented as a **`waitForTaskToken` state** — the execution blocks until
  a Slack or GitHub interaction posts the token back, with a `HeartbeatSeconds` timeout that
  defaults to abort.
- `Catch` blocks invoking compensating states give real rollback, not best-effort cleanup.
- A global kill switch: every workflow reads an SSM parameter as its first state and fails
  closed if it is set.
- Execution history is retained and queryable, which is the audit trail.

**Least privilege per operation.** The Platform API holds no standing AWS power. Each
workflow step assumes a narrowly scoped role (`deploy-newnotams-dev`, `restart-service-prod`)
scoped by resource tag. No god role. Because dev and prod share one account (ADR-0001), these
roles carry a permissions boundary with an explicit `Deny` on `aws:ResourceTag/env = prod`
for anything dev-scoped — this is the mechanism that makes the single-account compromise
survivable under automation.

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

## Portability: keep the activities pure, not a `WorkflowEngine` facade

The migration risk is real and worth designing against, but a generic
`WorkflowEngine { start, signal, cancel }` interface is the wrong shape for it. Such a
facade collapses to the lowest common denominator of both engines, leaks anyway (ASL
retry/catch semantics and Temporal's determinism constraints do not have a shared
abstraction), and the parts most expensive to port — orchestration topology, retry policy,
compensation wiring — sit *outside* those three methods.

**The portable boundary is the activity, not the engine.** Enforce two rules:

1. **Every activity is a plain, engine-agnostic async function.** Typed input, typed
   output, no SDK imports, no `Context`, no task tokens, no ASL awareness. These hold all
   the business logic — the code that would be genuinely painful to rewrite.

   ```ts
   // services/platform-api/activities/deploy.ts — knows nothing about any engine
   export async function deployService(
     input: { app: string; env: Env; imageTag: string },
   ): Promise<{ deploymentId: string }> { /* ... */ }
   ```

2. **A thin adapter layer per engine wraps them.** Today: a Lambda handler per activity,
   invoked by a Step Functions task state. Under Temporal: the same functions registered as
   activities on a worker. The adapter is a few lines each and is *expected* to be rewritten.

   ```ts
   // adapters/stepfunctions/deploy.handler.ts
   export const handler = async (event: DeployInput) => deployService(event);
   ```

Orchestration itself — the state machine or the workflow function — is written natively for
whichever engine is in use. It is deliberately *not* abstracted, because that is where the
engine's actual value lives and where a facade would force you to give it up.

The one thing worth keeping engine-neutral at the API surface is the **workflow ID**: the
Platform API returns an opaque `operationId` rather than a Step Functions execution ARN, so
callers, the MCP server, and the deploy bot never encode engine specifics. Status lookup is
a table mapping `operationId` → engine + native handle.

This gives the real migration benefit — the business logic ports unchanged — at close to
zero design cost, and without a speculative interface that would need maintaining forever.

## Consequences

- Step Functions is serverless: no workers, no cluster, no idle cost. Pay per state
  transition, which at this volume is cents.
- Step Functions' ASL is more awkward than Temporal's code-as-workflow, and long-running
  human approvals are capped by task-token timeouts (max 1 year, ample here). If workflow
  authoring becomes the bottleneck, migrate to Temporal Cloud — the trust tiers, scoped
  roles, approval gates, and audit requirements above are unchanged by that swap.
- Every new operation costs more to build than a plain endpoint would. This is the point.
- Approval fatigue is a real risk. Tune by keeping the read and propose tiers wide and
  frictionless, so approvals stay rare and meaningful.
- Because dev and prod share an account, the permissions-boundary discipline is doing work
  that an account boundary would otherwise do for free. Verify it with an explicit CI test
  that asserts a dev role is denied a prod-tagged action.
