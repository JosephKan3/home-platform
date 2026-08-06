# ADR-0008: CDK is the only IaC tool. Serverless Framework rejected.

- Status: Accepted
- Date: 2026-08-06

## Context

The original handoff proposed a mix: "CDK should own the platform, Serverless Framework can
still be used for Lambda-heavy applications if desired." That reflected existing familiarity
with Serverless Framework and a preference for its terser Lambda configuration and its
`serverless dev` loop.

The question was revisited after Phase 0 was built. By then the repo had four CDK stacks,
251 tests, three synth-time guardrail Aspects, and cdk-nag policy enforcement (ADR-0007).

## Decision

**AWS CDK is the only infrastructure-as-code tool.** Serverless Framework is not adopted,
now or in Phase 1.

Lambda-centric services are expressed as CDK constructs. Where terser configuration is
wanted, the answer is a purpose-built L3 construct in `packages/constructs/`, not a second
framework.

## Rationale

### 1. Serverless Framework bypasses every guardrail in this platform

This is the decisive reason. The platform's policy enforcement is **synth-time**:

| Guardrail | Mechanism | Runs during |
| --- | --- | --- |
| `NoManagedEgressAspect` | CDK Aspect (ADR-0002) | `cdk synth` |
| `RequiredTagsAspect` | CDK Aspect | `cdk synth` |
| `LogRetentionAspect` | CDK Aspect | `cdk synth` |
| `AwsSolutionsChecks` | cdk-nag validation plugin (ADR-0007) | `cdk synth` |

Serverless Framework generates CloudFormation directly and never passes through CDK synth.
Every SLS-deployed resource would therefore be unguarded:

- **No tag enforcement.** With a single workload account (ADR-0001), cost allocation tags
  *are* the billing breakdown. Untagged resources are invisible in Cost Explorer.
- **No log retention enforcement.** CloudWatch defaults to never-expire, documented in the
  cost model as the most common silent cost leak in an AWS account.
- **No cdk-nag.** ADR-0007's policy-as-code claim would hold for only part of the estate.
- **No egress detection.** The SCP remains, but the readable synth-time layer is lost.

A platform whose stated policy posture applies to some resources and not others is worse
than one that makes no such claim, because the gap is invisible until it matters.

### 2. The licensing model conflicts with the platform's premise

Serverless Framework v4 requires authentication for all users. v3 has been unmaintained
since December 2024, so pinning to it is not viable.

- The CLI **fails if it cannot reach Serverless Inc. servers**. A 5xx is tolerated; no
  connectivity is not. This places a third-party availability dependency in the deploy path.
- Every deploy sends telemetry including service name, region, stage, **AWS account ID**,
  and CloudFormation stack ID.
- A license key must be provisioned, conventionally at SSM `/serverless-framework/license-key`.

Cost is not the objection — the free tier is honor-system under $2M annual revenue, which
applies here. The objection is that an IaC-first, self-sufficient platform should not have a
vendor gate between a commit and a deployment.

### 3. The actual workloads are not Serverless-Framework-shaped

The assumption that NewNotams would justify Serverless Framework did not survive inspection.
NewNotams deploys via OpenNext, which produces:

- a server function, an image-optimization function, a revalidation queue, a warmer function
- S3 static assets
- a multi-behavior CloudFront distribution routing between them

That is a CDK/SST-shaped problem. In Serverless Framework it would be written as raw
CloudFormation under `resources:`, discarding every advantage the tool offers.

The only genuinely SLS-shaped component is the hourly notify job — a scheduled Lambda, which
is roughly fifteen lines of CDK using a pattern already working in
`applications/personal-site`.

### 4. The development loop is worse, and that is an accepted cost

An earlier draft of this ADR claimed `cdk watch` / `cdk deploy --hotswap` is equivalent to
`serverless dev`. **That was an overstatement and is corrected here**, because the decision
should rest on the guardrail argument rather than on a convenient claim.

They are different mechanisms:

| | `serverless dev` | `cdk watch --hotswap` |
| --- | --- | --- |
| Where code runs | **Your machine.** Real invocations are proxied to it. | **AWS.** Bundled, uploaded to S3, `UpdateFunctionCode`. |
| Latency | Sub-second | Seconds |
| Breakpoints | Native, local debugger | No |

`serverless invoke local` and `serverless logs -t` have **no CDK equivalent at all**. The
available substitutes are `aws logs tail --follow`, running handlers directly under a test
runner, or adopting SAM CLI as a separate tool with a Docker dependency.

What CDK does match: `NodejsFunction` performs esbuild bundling, covering most of what SLS
packaging provides. And `cdk synth` — which runs every guardrail and cdk-nag with no AWS
calls — is a faster and stricter feedback loop for *infrastructure* than anything SLS offers.

**Accepted cost.** For the current workloads — a scheduled fetcher, static sites — the
difference is close to zero. For a request-path service in Phase 1 it will be real. The
mitigation is the one already applied in `applications/personal-site`: keep business logic
in pure, testable functions outside the handler, so the fast loop is jest rather than any
deploy. See `docs/development.md` for the full comparison.

### 5. The portfolio argument runs the other way

Familiarity with Serverless Framework is already claimed elsewhere. Demonstrating that
Lambda services can be built properly in CDK — with guardrails, tests, and least-privilege
IAM — is the stronger signal. "I built an L3 construct that makes declaring a service ten
lines and applies our policy automatically" beats "I used a tool that does that."

## Consequences

- One toolchain, one language, one test strategy, one CI pipeline shape.
- Guardrails and cdk-nag apply to **every** resource without exception. ADR-0007 holds
  without a footnote.
- Terse service definitions must be earned by writing L3 constructs. This is real work, it
  is **not yet done**, and until it is, verbosity is a debt rather than a feature —
  `applications/personal-site/lib/site-stack.ts` is ~660 lines for one bucket, one
  distribution, and one function. Writing a `ServerlessApi` L3 is the platform-engineering
  deliverable that repays it.
- The local development loop is worse than Serverless Framework's. See rationale 4.
- No `services/` workspace layer is added. The four-layer structure in ADR-0004
  (`infrastructure/`, `applications/`, `automation/`, `packages/`) stands unchanged.
- If a future workload genuinely fits Serverless Framework better, this ADR is superseded
  rather than quietly violated — and any adoption must state how the guardrail gap is closed.

## Alternatives considered

- **Mixed CDK + Serverless Framework, split by layer.** The original proposal. Rejected on
  the guardrail gap above. A narrower variant — SLS confined to pure-Lambda services under
  `services/` — was considered and rejected for the same reason, since the gap is a property
  of the tool rather than of its scope.
- **SST.** Genuinely interesting: it is CDK underneath, so Aspects and cdk-nag would still
  apply, and it has a strong dev loop plus first-class OpenNext support. Rejected for now
  because it is another abstraction layer over infrastructure that is already written and
  working. **Reconsider in Phase 1** specifically for the NewNotams OpenNext deployment,
  where its `NextjsSite` component solves a real problem that would otherwise be built by
  hand.
- **Terraform / CDKTF.** Rejected. No advantage over CDK here, and it would abandon a
  working codebase, the guardrail Aspects, and the single-language property.

## Related

- Phase 1 constraint discovered alongside this decision: **OpenNext does not fully support
  Windows.** Its maintainers recommend WSL, a Linux VM, or building only in CI on Linux
  runners. This is independent of the IaC choice and is recorded in `docs/open-issues.md`.
