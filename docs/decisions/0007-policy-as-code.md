# ADR-0007: cdk-nag at synth, with every suppression citing an ADR or a price

- Status: Accepted
- Date: 2026-08-06
- Fulfils: action plan §4 C3, `architecture/overview.md` "policy as code: cdk-nag at synth"
- Depends on: ADR-0003 (no Kubernetes, therefore no admission controller)

## Context

The action plan and the architecture overview both claim cdk-nag runs in CI. Neither was
true: the dependency was not installed, no pack was registered, and the "synth" step in
`ci.yml` would have passed against a stack with a public bucket. A prior review flagged
this rather than adding a step that did nothing, which was the right call — a policy gate
that reports zero findings because it is not wired in is worse than no gate, because it
also produces a green check.

Three custom Aspects already fail synth: `NoManagedEgressAspect` (ADR-0002),
`RequiredTagsAspect`, and `LogRetentionAspect`. Each encodes a decision specific to this
platform. None of them knows that an S3 bucket should have server access logging or that a
Lambda should not sit on a deprecated runtime, because those are not decisions this
platform made — they are general AWS practice, and writing them by hand is how a
guardrail library turns into a worse copy of something that already exists.

ADR-0003 dropped Kubernetes and listed **Kyverno / OPA Gatekeeper → cdk-nag at synth** as
the replacement for admission control. That row is the obligation this ADR discharges.

## Decision

### 1. `AwsSolutionsChecks` runs on every app, and errors fail synth

Every `bin/app.ts` registers the pack against the `App`:

```ts
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
```

`verbose: true` because the terse message names the rule but not the remedy, and the
person reading it is usually meeting the rule for the first time.

Note the shape: in cdk-nag **3.x a pack is an `IPolicyValidationPlugin`, not an
`IAspect`**, and is registered through `Validations.addPlugins` rather than
`Aspects.of(app).add`. This matters for the ordering question that bit
`RequiredTagsAspect`, which must run at `AspectPriority.READONLY` so it sees the tags the
mutating `Tags` aspects apply. cdk-nag has no equivalent hazard: validation plugins run
after the entire Aspect pass has completed against the finalized tree, so there is no
priority to set and no race to lose. `AspectPriority.READONLY` was nonetheless added to
`infrastructure/bootstrap/bin/app.ts`, which was the one entrypoint still missing it.

A violation at `error` severity fails `cdk synth` with a non-zero exit. Warnings do not,
but see §3: a warning nobody has decided about is treated as an unfinished decision.

### 2. Suppressions are per-rule, per-resource, and justified in writing

cdk-nag 3.x also removed `NagSuppressions`. The supported path is CDK core's
`Validations.of(scope).acknowledge()`, which validates the rule ID against a
`prefix::RuleName` grammar and therefore rejects every granular finding — the ones shaped
`AwsSolutions-IAM5[Resource::arn:...]` contain `::` inside the bracket and always throw.
Since the granular findings are precisely the ones worth suppressing individually,
`packages/constructs/src/nag/suppressions.ts` provides `suppressNagRules` and
`suppressNagRulesAtPath`, which write the same acknowledged-rules metadata directly.

The helper is not a thin wrapper. It **enforces the suppression policy at synth**:

- The reason must match `/ADR-\d{4}|\$\d/` — an ADR reference or a dollar figure.
- The reason must be at least 40 characters.
- `suppressNagRulesAtPath` throws when the construct path does not resolve, so a
  suppression left behind by a CDK upgrade or a rename fails the build instead of quietly
  silencing nothing.

"Not applicable" and "accepted risk" do not compile. That is deliberate: the failure mode
this ADR exists to prevent is not a missing suppression, it is a suppression whose reason
nobody can evaluate two years later.

**Stack-level suppressions are forbidden** unless the finding is genuinely stack-wide, and
none currently qualifies. A stack-scoped acknowledgment silences the rule for every
resource added to that stack from then on, including ones nobody has reviewed — which
turns a policy gate into a policy hole with a comment on it. Tests in
`infrastructure/bootstrap` and `infrastructure/org` assert that no acknowledgment is
attached at stack scope.

### 3. Standing suppressions

| Rule | Where | Why |
| --- | --- | --- |
| `AwsSolutions-IAM4[Policy::.../ReadOnlyAccess]` | `GhaPlanRole` | Intended design. The PR plan role must describe any resource type the repo might add without being edited first; a customer-managed equivalent is a hand-maintained copy of an AWS policy that drifts and fails closed on new services. No write action, and it can assume only the CDK lookup role. |
| `AwsSolutions-IAM5[Resource::...role/cdk-*-<kind>-*]` | `GhaPlanRole`, `GhaDeployDevRole`, `GhaDeployProdRole` | The wildcard is inherent to CDK's bootstrap role naming: the qualifier and the region suffix are chosen at `cdk bootstrap`, not here. Bounded to this account and to the four CDK-owned role names. The alternative is `AdministratorAccess` on the GitHub-assumable role, which this indirection exists to avoid. |
| `AwsSolutions-IAM5[Action::*]`, `[Resource::*]` | `DevPermissionsBoundary` | The rule's premise is inverted here. A permissions boundary grants nothing; effective permissions are the intersection of the boundary and the principal's own policies. The unrestricted `Allow` is the ceiling and the two `Deny` statements are the control. Narrowing it would break dev deploys without granting anything less. Mechanism ADR-0001 relies on. |
| `AwsSolutions-S1` | `AccessLogBucket`, `OrgTrailAccessLogBucket` | These *are* the access log destinations. Logging them to themselves is a write-per-write feedback loop that grows without bound at $0.023/GB; logging them to the bucket they log makes each depend on the other. Reads are still captured by the organization CloudTrail. |
| `AwsSolutions-CFR1` | `Distribution` | Geo restriction deliberately off. A personal site and portfolio artifact whose purpose is to be reachable from anywhere, serving only public-by-intent static content. There is no jurisdiction whose traffic is safer blocked than served. |
| `AwsSolutions-CFR2` | `Distribution` | **Cost.** See "What was deferred" below. |
| `AwsSolutions-IAM5[Resource::<SiteBucket.Arn>/data/*]` | `OandaFetcherServiceRole` | The wildcard *is* the control. Scoping the fetcher to `data/*` is what stops a compromised fetcher rewriting `index.html` on a live domain. A literal two-key list would drop future data files out of the grant and fail at runtime rather than at synth. Asserted by test. |
| `AwsSolutions-IAM5[Resource::<OandaFetcherLogs.Arn>:log-stream:*]` | `OandaFetcherServiceRole` | Lambda names log streams itself, so the segment cannot be enumerated at synth. Bounded to this function's own log group — strictly narrower than the `AWSLambdaBasicExecutionRole` this role replaces. |
| `AwsSolutions-IAM5[Resource::<OandaFetcher.Arn>:*]` | `SchedulerRoleForTarget` | The `:*` covers one function's versions and aliases and is generated by `aws-cdk-lib`'s `LambdaInvoke` target with no prop to narrow it. Widest reading: "may invoke an older copy of the same handler". |
| `AwsSolutions-IAM4`, `IAM5` (7 findings), `L1` | `Custom::CDKBucketDeployment.../ServiceRole` and its function | Generated by `aws-cdk-lib`'s BucketDeployment singleton handler. Runtime, role and inline policy are fixed by the CDK version with no configurable prop, so each finding tracks the aws-cdk-lib upgrade cadence rather than a decision made here. Runs only during a CloudFormation deploy. Re-evaluate on each aws-cdk-lib major upgrade. |

Everything else was fixed. See "Consequences".

### 4. Why synth time is the right layer

ADR-0003 removed the cluster, and with it the admission controller. Kyverno or OPA
Gatekeeper would have evaluated policy at `kubectl apply`, between intent and creation.
Without Kubernetes there is no admission point — CloudFormation is the only thing that
creates resources, and it has no pre-flight policy hook.

Synth is strictly earlier than admission would have been. It runs locally, before any AWS
call, on a template that is the complete description of what will exist. A developer sees
the failure in the same terminal as the typo that caused it, with no credentials involved
and nothing to roll back. An admission controller, by contrast, rejects halfway through a
rollout.

The runtime layer is still there and is still needed: SCPs (ADR-0001, ADR-0002) deny
`ec2:CreateNatGateway`, static credentials and audit tampering regardless of what
synthesized them. That is the same two-layer argument ADR-0002 makes for
`NoManagedEgressAspect` — a fast readable failure in front, an unbypassable one behind —
and it applies unchanged. cdk-nag is layer one for general AWS practice; SCPs are layer two.

### 5. Relationship to the three custom Aspects

Both are needed, and they are not substitutes.

| | cdk-nag `AwsSolutionsChecks` | `NoManagedEgressAspect`, `RequiredTagsAspect`, `LogRetentionAspect` |
| --- | --- | --- |
| Encodes | General AWS best practice, maintained by AWS | *This platform's* decisions: no NAT (ADR-0002), mandatory `app`/`env`/`owner` tags, explicit log retention |
| Source of truth | The AWS Solutions security matrix | The ADRs in this directory |
| Fails on | ~200 rules across every service | Four specific resource shapes |
| Would catch a public S3 bucket | Yes | No |
| Would catch a `$33/mo` NAT Gateway | No — a NAT Gateway is a perfectly good AWS practice | Yes, with a message naming `PRIVATE_WITH_EGRESS` as the cause |
| Would catch an untagged resource | No | Yes |

cdk-nag has no opinion about cost, because cost is not a security property. The Aspects
have no opinion about encryption at rest, because that is not a decision this platform
made. Deleting either would leave a real hole.

## Rationale

- The gap was a documentation lie. Two documents claimed a control existed. Closing it
  was not optional once noticed.
- A suppression policy enforced by a lint rule is a suppression policy. Enforced by
  convention, it is a suggestion, and the first person under deadline pressure discovers
  that a one-word reason compiles fine.
- Requiring an ADR or a price in every reason forces the tradeoff to be named. Most of the
  suppressions in the table above turned out to be genuinely correct — but writing "the
  wildcard is the control, and here is the test that proves it" is a different activity
  from writing "accepted risk", and only one of them is reviewable.
- Fixing rather than suppressing was the default. Eight findings were fixed; the rest are
  in the table with reasons.

## Consequences

### What was fixed rather than suppressed

- **S3 server access logging** on both the site bucket and the organization trail bucket.
  Each now logs to a dedicated log bucket with a lifecycle expiry (90 days for the site,
  365 for the trail). On the bucket holding the organization's only audit trail, knowing
  who *read* it is the point — CloudTrail records the writes, not the reads, and
  CloudTrail data events would cost $0.10 per 100k events to capture the same thing.
- **CloudFront standard access logging**, reusing the log bucket S3 logging already
  created, so no new always-on resource. Without it the only record of a viewer request
  was the S3 access log's view of CloudFront's OAC fetches on cache misses — which is to
  say, no record at all for anything cached.
- **The fetcher Lambda's execution role.** It previously used the CDK default, which
  attaches `AWSLambdaBasicExecutionRole` — `logs:CreateLogGroup` plus stream and event
  writes across every log group in the account. It now has an explicit role scoped to the
  one log group declared for it. This is a strict narrowing at zero cost, and the S3 and
  SSM statements are unchanged.
- **The fetcher Lambda's runtime**, `nodejs20.x` → `nodejs24.x`. Node 20 was deprecated
  2026-04-30 with creation disabled 2027-02-01. The handler uses only native `fetch` and
  `AbortSignal.timeout`, both of which predate Node 20, so nothing in it is version
  sensitive. `FETCHER_RUNTIME` is exported and asserted by test, so the assertion tracks
  the constant rather than a string literal that goes stale.

### What was deferred, because it costs money

**AWS WAF on the CloudFront distribution (`AwsSolutions-CFR2`), ~$5-8/mo.** A web ACL is
$5/mo base plus $1/rule plus $0.60/M requests, against a Phase 0 budget of **$3-8/mo
total** (`docs/cost/cost-model.md`) — it would roughly double platform spend, and would
breach the $10/mo budget alarm this repo's own `GovernanceStack` configures.

It would also be protecting very little. The distribution fronts a bucket of prerendered
HTML: no request-path compute, no form, no login, no database, no user input reaching any
interpreter. The injection and account-takeover classes a WAF addresses have no target
here. Rate limiting is the one genuinely applicable capability, and CloudFront's 1 TB/mo
free tier plus a cache-everything policy already bounds the damage from volumetric abuse.

**This is suppressed, not fixed, and it is flagged for the user to overturn.** The moment
the first authenticated or dynamic endpoint ships (ADR-0003 Phase 2), the same $5/mo buys
something real and this should be revisited.

The two new log buckets are the only resources added. S3 carries no per-bucket charge, so
they cost only the storage for the log objects — well under $0.10/mo at this traffic, and
capped by lifecycle rules.

### Ongoing

- **cdk-nag findings are now a merge blocker.** `cdk synth` exits non-zero on an error,
  and CI's existing synth steps already propagate that, so `ci.yml` needed only a comment
  making the dependency explicit rather than a new step. This is intentional: a policy
  gate implemented as its own optional job is a policy gate someone eventually marks
  `continue-on-error`.
- **A CDK upgrade can introduce findings that did not exist before**, particularly `L1`
  when a new runtime ships and the `Custom::CDKBucketDeployment` suppressions when its
  generated policy changes. The path-addressed suppressions throw rather than rot, so this
  surfaces as a build failure with a clear cause.
- **The four `test/cdk-nag.test.ts` files assert zero unsuppressed errors** and, in three
  packages, zero unacknowledged warnings. They also assert that suppressions sit at the
  narrowest scope and that every reason carries a citation. A guardrail with no test
  silently rots (action plan §3 B3), and that applies to the guardrail library itself.
- **`Annotations.fromStack(...).findError()` does not work for this.** cdk-nag 3.x reports
  through a validation report rather than node annotations, so an assertion written that
  way passes regardless of compliance. The tests use `validateScope` and each includes a
  case proving the pack still fires on a deliberately non-compliant resource, so the
  suite cannot start passing vacuously.

## Alternatives considered

- **A second pack (`ServerlessChecks`, `NIST80053R5Checks`, `PciDss321Checks`).** Rejected
  for now. `AwsSolutionsChecks` is the general-practice pack; the compliance packs encode
  regimes that do not apply to a personal platform and would generate a suppression list
  longer than this ADR, which is the failure mode where nobody reads any of them.
  `ServerlessChecks` is the plausible future addition once there is more Lambda.
- **Failing CI on warnings as well as errors.** Rejected as a blanket rule, but the intent
  is preserved: two of the three packages assert zero *unacknowledged* warnings in tests,
  so a new warning still fails the build and has to be either fixed or written down. That
  gets the discipline without making a future advisory rule an emergency.
- **Suppressions in a central YAML or JSON file.** Rejected. A suppression list separated
  from the code it excuses drifts immediately: the resource gets renamed, the entry stays,
  and nobody notices because the file still parses. Co-locating the suppression with the
  construct means the diff that introduces the wildcard and the diff that justifies it are
  the same diff.
- **Writing the S3/Lambda/CloudFront rules as custom Aspects instead.** Rejected. That is
  a worse, unmaintained copy of a pack AWS updates. The custom Aspects exist for decisions
  no third party could know about; everything else should come from the pack.
- **`writeSuppressionsToCloudFormation: true`.** Considered. It emits `cdk_nag` metadata
  into the template for v2-era audit tooling. No such tooling is in use here, and it adds
  noise to every `cdk diff` — which is read on every PR. Revisit if an external auditor
  ever needs the template to be self-describing.
