# Development

How to work in this repo day to day. Written for someone coming from Serverless Framework
who is about to read the CDK docs for the first time.

ADR-0008 dropped Serverless Framework and claimed `cdk watch` / `cdk deploy --hotswap`
replaces `serverless dev`. That claim is partly true. This document makes it concrete and
says where it is false.

Everything below was checked against the versions actually installed:

| Tool | Version |
| --- | --- |
| `aws-cdk` (CLI) | 2.1135.0 |
| `aws-cdk-lib` | 2.263.0 |
| `cdk-nag` | 3.0.2 |
| `turbo` | 2.10.8 |
| `pnpm` | 10.34.3 |

---

## 1. The inner loop

### `cdk synth` is the command you will run most

This is the single most useful command in the repo, and it is the one that has no
Serverless Framework equivalent worth the comparison.

```powershell
$env:MGMT_ACCOUNT_ID     = "<12 digits>"
$env:PLATFORM_ACCOUNT_ID = "<12 digits>"

pnpm --filter @platform/personal-site synth
pnpm --filter @platform/infra-dns     synth
```

What it does, in one pass, with **no AWS API calls and no credentials**:

| Layer | What it catches |
| --- | --- |
| TypeScript compile (`ts-node`) | Type errors in stack code |
| `NoManagedEgressAspect` | NAT Gateway, Transit Gateway (ADR-0002) |
| `RequiredTagsAspect` | Missing `app` / `env` / `owner` |
| `LogRetentionAspect` | Log group with no `retentionInDays` |
| `AwsSolutionsChecks` (cdk-nag) | ~200 AWS practice rules (ADR-0007) |
| `suppressNagRules*` | Unjustified or stale suppressions |

An error in any of these exits non-zero. This is the infrastructure equivalent of a
typecheck: it runs locally, in seconds after warm-up, and tells you the whole story before
you have touched an account.

Timing measured on this machine: a cold `cdk synth` of `@platform/personal-site` (the
heaviest stack — CloudFront, esbuild bundling of the fetcher, BucketDeployment) takes
about 22 seconds. Through turbo with a warm cache it is under 100 ms.

The only inputs it needs are `MGMT_ACCOUNT_ID` and `PLATFORM_ACCOUNT_ID`. Without them
`packages/config/src/accounts.ts` throws:

```
Error: Missing PLATFORM_ACCOUNT_ID. Set it in your shell or as a CI repository variable.
See docs/phase-0-action-plan.md §0.
```

`cdk synth` is also what CI runs as the cdk-nag gate (`ci.yml`, the
"Synth + cdk-nag" steps). If it passes locally, that gate will pass.

### Turborepo filtering

`pnpm run synth` at the root runs the whole graph. Narrow it:

```powershell
# One package, plus rebuilding its workspace dependencies first.
pnpm --filter @platform/personal-site synth

# Through turbo, with caching and the ^build dependency:
pnpm run synth -- --filter=@platform/infra-dns

# Everything except the management-account stack (what CI does — GovernanceStack
# needs OU IDs as context, not env vars).
pnpm run synth -- --filter='!@platform/infra-org'

# Everything changed on this branch plus its dependents (what CI does for tests).
pnpm run test -- --filter=...[origin/main]
```

`turbo.json` declares `synth` as `dependsOn: ["^build"]`, so `@platform/config` and
`@platform/constructs` are compiled first if they changed and skipped if they did not. A
change under `packages/` invalidates everything downstream, by design (ADR-0004).

Two subtleties:

- `pnpm --filter <pkg> synth` runs the package script directly and **bypasses turbo**, so
  it bypasses turbo's env filtering (see §6) and its cache. Useful when you want the raw
  output.
- `pnpm run <task> -- --filter=...` goes **through** turbo. The `--` is required or pnpm
  eats the flag.

### `cdk watch`

```powershell
cd applications/personal-site
npx cdk watch PersonalSiteStack
```

`cdk watch` is a shortcut for `cdk deploy --watch`. Verified in the installed CLI's
command config: **it implies `--hotswap` by default**, and `--logs` defaults to `true`,
so it also tails CloudWatch Logs for log groups it finds in the stack.

The files it watches come from the `watch` block in each `cdk.json`. For
`applications/personal-site`:

```json
"watch": {
  "include": ["**"],
  "exclude": ["README.md", "cdk*.json", "dist", "node_modules", "test"]
}
```

`lambda` was originally in the *exclude* list, which meant editing
`lambda/oanda-fetcher/index.ts` did **not** trigger a watch redeploy — defeating the point
of the loop. It has been removed. `test` stays excluded deliberately: test edits should run
jest, not a deploy.

### `cdk deploy --hotswap` and what it actually does

Hotswap skips CloudFormation entirely. Instead of a change set, the CLI diffs the
synthesized template against the deployed one, decides which changes it knows how to
apply with a direct service API call, and makes those calls itself.

For a Lambda code change that means one `UpdateFunctionCode` call instead of a
CloudFormation stack update. Seconds instead of a minute or more.

**The CLI warns about this on every hotswap deploy.** Exact strings from the installed
CLI:

```
⚠️ Hotswap deployments deliberately introduce CloudFormation drift to speed up deployments
⚠️ They should only be used for development - never use them for your production Stacks!
```

That is not boilerplate. It is the actual consequence:

- The CloudFormation stack's stored template still describes the **old** code asset. The
  running function has the new one.
- `cdk diff` compares against the deployed template, so after a hotswap it can show "no
  changes" while the running code differs from what the repo says. Or the reverse.
- The next full `cdk deploy` reconciles it, because CloudFormation deploys the template
  it was given. Any hotswapped state that is not in the template is silently reverted.
- `cdk drift` (a real command in this CLI version) will report the divergence.

**Never use it on anything tagged `env=prod`.** Every stack in this repo is currently
tagged `env: prod` (see `docs/open-issues.md` issue 2), so today the honest answer is:
hotswap has nothing to be safely used against here yet. It becomes useful the moment a
dev-scoped stack exists.

### `--hotswap` versus `--hotswap-fallback`

These behave differently and the difference matters.

| Flag | Non-hotswappable change | Use when |
| --- | --- | --- |
| `--hotswap` | **Ignored.** Not deployed at all. | You know only code changed |
| `--hotswap-fallback` | Falls back to a full CloudFormation deploy | You are not sure |

From the installed CLI's own help text for `--hotswap`: *"does not fall back to a full
deployment if that is not possible. Instead, changes to any non-hotswappable properties
are ignored."*

That silent-ignore is the sharp edge. You change a Lambda's `timeout` and its handler
code, run `--hotswap`, and only the code lands. The CLI does print the rejected changes:

```
⚠️ The following non-hotswappable changes were found. To reconcile these using
   CloudFormation, specify --hotswap-fallback
```

Read that line. `--hotswap-fallback` is the safer default for interactive work.

### What hotswap can and cannot handle

Verified by reading the `RESOURCE_DETECTORS` map in the installed `aws-cdk@2.1135.0`
bundle rather than repeating blog knowledge. This list is version-specific and will grow.

**Hotswappable resource types in 2.1135.0:**

| Resource type | Notes |
| --- | --- |
| `AWS::Lambda::Function` | Only the `Code`, `Environment`, `Description` properties |
| `AWS::Lambda::Version`, `AWS::Lambda::Alias` | Handled alongside the function |
| `AWS::ECS::TaskDefinition` | Only `ContainerDefinitions`, and only if an ECS service references it |
| `AWS::AppSync::Resolver` / `FunctionConfiguration` / `GraphQLSchema` / `ApiKey` | |
| `AWS::CodeBuild::Project` | |
| `Custom::CDKBucketDeployment` | This is what makes a static-site content change hotswappable |
| `AWS::StepFunctions::StateMachine` | Via Cloud Control API |
| `AWS::Events::Rule` | Via Cloud Control API |
| `AWS::DynamoDB::Table` / `GlobalTable` | Via Cloud Control API |
| `AWS::SQS::Queue` | Via Cloud Control API |
| `AWS::CloudWatch::Alarm` / `CompositeAlarm` / `Dashboard` | Via Cloud Control API |
| `AWS::ApiGateway::RestApi` / `Deployment` / `Method` | Via Cloud Control API |
| `AWS::ApiGatewayV2::Api` / `Integration` | Via Cloud Control API |
| `AWS::Bedrock::Agent`, `AWS::BedrockAgentCore::Runtime` | Via Cloud Control API |
| `AWS::QuickSight::*` | Via Cloud Control API |
| `AWS::IAM::Policy` | **Only** the BucketDeployment custom resource's own policy — everything else is explicitly rejected |

The Cloud Control API entries are newer than most documentation online describes. They
only hotswap properties the CCAPI patch operation can express; anything else falls
through as non-hotswappable.

**Always forces a full CloudFormation deploy:**

- Any new resource, or any deleted resource (`RESOURCE_CREATION`, `RESOURCE_DELETION`).
- Any IAM role or policy other than the BucketDeployment one. Adding an `addToPolicy`
  statement to the fetcher's role is a full deploy.
- Tag changes (`TAGS` is an explicit non-hotswappable reason in the CLI).
- Lambda properties other than code, environment and description — `timeout`,
  `memorySize`, `runtime`, `architecture`, `logGroup`, `role`.
- CloudFormation `Outputs` changes (`OUTPUT`).
- Anything where the physical resource name cannot be resolved from the template.
- Any resource type not in the table above — S3 buckets, CloudFront distributions,
  Route53 records, ACM certificates, EventBridge Scheduler schedules.

For this repo specifically: the OANDA fetcher's **handler code** is hotswappable. Its
timeout, its memory, its role, its schedule and everything in `SiteStack` around it are
not.

---

## 2. Honest comparison to the Serverless Framework loop

| Task | Serverless Framework | CDK, in this repo | Verdict |
| --- | --- | --- | --- |
| Validate config before deploying | `sls package` (renders CFN, no policy) | `pnpm --filter <pkg> synth` — types, three Aspects, cdk-nag, all offline | **Better.** Not close. SLS has no synth-time policy layer at all; this is the whole basis of ADR-0008 |
| Deploy one function's code | `sls deploy function -f x` | `npx cdk deploy --hotswap` | **Roughly equivalent.** Both are one API call. SLS is slightly more direct because it targets a function by name; CDK diffs the whole template first |
| Deploy the whole service | `sls deploy` | `npx cdk deploy <Stack>` | **Equivalent.** Both are CloudFormation underneath |
| See what a deploy will change | `sls deploy --noDeploy` then read the template | `npx cdk diff <Stack>` | **Better.** `cdk diff` is a resource-level diff against deployed state, and CI posts it on every PR (`ci.yml`) |
| Live-reload while editing | `sls dev` — proxies invocations to a local process, sub-second | `npx cdk watch` — redeploys the asset to AWS on save | **Worse, and not the same thing.** See below |
| Run a handler locally | `sls invoke local -f x` | *No CDK equivalent.* | **Worse.** See below |
| Tail logs | `sls logs -f x -t` | *No CDK equivalent for a running service.* `cdk watch` tails logs, but only while it is watching | **Worse.** Use `aws logs tail` |
| Remove everything | `sls remove` | `npx cdk destroy <Stack>` | **Equivalent** |
| Terse Lambda config | `functions:` block in YAML | `new NodejsFunction(...)` — see `site-stack.ts:331` | **Worse today.** ADR-0008's answer is to write an L3 construct. That is real work you have not done yet |
| Bundling | SLS packaging / esbuild plugin | `NodejsFunction` runs esbuild natively | **Equivalent** |
| Multi-service composition | Cross-stack via CFN outputs or SSM | SSM contract, enforced (ADR-0004) | **Better,** but that is a repo decision, not a CDK one |

### `sls dev` is genuinely a different thing, and hotswap is not a replacement

`serverless dev` runs your handler **on your machine** and proxies real AWS invocations
to it over a websocket. Edit, save, invoke, see the result. No upload. Sub-second.
Breakpoints work in your local debugger against real event payloads.

`cdk watch --hotswap` bundles the handler with esbuild, uploads the asset to S3, and
calls `UpdateFunctionCode`. That is a few seconds, not sub-second, and the code runs in
Lambda, not locally. No local breakpoints.

ADR-0008 §4 says "`serverless dev` is good. So is `cdk watch`." The first half is right.
The second half compares two things that are not the same. Be clear-eyed about this: you
have traded a local-execution loop for a fast-remote-deploy loop. For the workloads in
this repo (an hourly scheduled fetcher with no request path) the trade barely costs
anything. For a request-path service in Phase 1 it will cost something real.

### The best available CDK-side substitutes

**For `sls invoke local` — run the handler directly.**

The fetcher's business logic already lives in a separately importable module
(`lambda/oanda-fetcher/oanda-client.ts`) and is tested that way in
`test/oanda-fetcher.test.ts` — 59 tests in that package, none of which need AWS. That is
the pattern: keep the pure logic out of the handler, test it under jest, and the "invoke
local" need mostly disappears.

For an actual end-to-end local invoke with a real event payload:

```powershell
npx tsx applications/personal-site/lambda/oanda-fetcher/index.ts
```

You will need the environment variables the handler reads (`SITE_BUCKET`, `RETURNS_KEY`,
`TRADES_KEY`, `OANDA_ACCOUNT_ID_PARAMETER`, `OANDA_ACCESS_TOKEN_PARAMETER`, `AWS_REGION`)
and valid credentials. `tsx` is not currently a dependency; add it if you want this.

**AWS SAM CLI** (`sam local invoke -t cdk.out/PersonalSiteStack.template.json`) is the
closest true equivalent, running the handler in a Lambda-like Docker container against
the synthesized template. It is a separate tool with a Docker dependency and is not set
up here. It is the right answer if local invoke becomes important.

**For `sls logs -t` — use the AWS CLI.**

```powershell
aws logs tail /aws/lambda/<function-name> --follow --profile platform

# Structured logs make this actually useful — the handler emits JSON:
aws logs tail /aws/lambda/<function-name> --follow --format short --profile platform `
  --filter-pattern '{ $.level = "error" }'
```

The fetcher writes structured JSON deliberately (`lambda/oanda-fetcher/index.ts`), so
CloudWatch Logs Insights and `--filter-pattern` work on real fields rather than string
matching.

`cdk watch` does tail logs (`--logs` defaults true), but only for the stack it is
watching and only while it is running. It is not a replacement for `aws logs tail` on a
deployed service.

---

## 3. Testing infrastructure

Five packages, 267 tests. Three distinct flavours, and they are not interchangeable.

### Flavour 1 — fine-grained assertions

`Template.hasResourceProperties` and friends. Use these when a specific property is
load-bearing and its absence would be invisible in a diff.

**Best example: `applications/personal-site/test/site-stack.test.ts`.** Its header states
the point directly: the two IAM assertions exist because a bucket-wide `s3:PutObject`
grant would let a compromised fetcher rewrite `index.html` on a live domain, and no diff
review reliably catches that.

Shape to copy:

```ts
// Env vars first — the module graph reads them at import time.
process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SiteStack } from "../lib/site-stack.js";   // note the .js specifier

function synth(props = {}): Template {
  const app = new App();
  return Template.fromStack(new SiteStack(app, "TestSiteStack", {
    env: { account: "222222222222", region: "us-east-1" },
    envName: "prod",
    usePlaceholderSource: true,
    ...props,
  }));
}
```

Assert against **exported constants**, not string literals. `site-stack.test.ts` imports
`FETCHER_RUNTIME`, `DATA_PREFIX`, `ACCESS_LOG_PREFIX` from the stack so the assertion
tracks the constant instead of going stale. `dns-stack.test.ts` does the same with
`vercelRecords`.

### Flavour 2 — snapshot tests

Used in exactly one place: `infrastructure/dns/test/dns-stack.test.ts`.

```ts
test("full template snapshot — any change to live-serving DNS shows up in review", () => {
  expect(template.toJSON()).toMatchSnapshot();
});
```

The reason is specific to that stack. `DnsStack` edits DNS for a domain that is serving
live traffic. A record that changes without anyone noticing takes the site down. The
snapshot makes **every** template change appear in the PR diff, including ones nobody
wrote an assertion for.

Do not copy this pattern by default. A snapshot on a churning stack becomes a file people
regenerate without reading, which is worse than no test. Add one when the blast radius of
an unnoticed change is a live-traffic outage.

Regenerate deliberately: `pnpm --filter @platform/infra-dns test -- -u`, then read the diff.

### Flavour 3 — Aspect and cdk-nag assertions

These use two different mechanisms, and mixing them up produces a test that passes
vacuously.

**Aspects report through node annotations, so use `Annotations.fromStack`.**

`packages/constructs/test/required-tags.test.ts` is the model:

```ts
Annotations.fromStack(stack).hasError(
  "*",
  Match.stringLikeRegexp("Missing required tag\\(s\\): owner"),
);
```

The custom Aspects call `Annotations.of(node).addError(...)`. That writes a metadata entry
on the construct, which is exactly what `Annotations.fromStack` reads. There is no
template involved, so this works even for errors that prevent a template rendering.

Note the helper in that file — it applies the aspect at `AspectPriority.READONLY`, for the
reason in §4.

**cdk-nag does NOT report through annotations. `Annotations.fromStack` finds nothing.**

cdk-nag 3.x is an `IPolicyValidationPlugin`, not an `IAspect`. It runs after the whole
Aspect pass and returns a validation report. A test written with `Annotations.fromStack`
against cdk-nag passes regardless of compliance — ADR-0007 records this. Use
`validateScope`:

```ts
const violations = new AwsSolutionsChecks(app, { verbose: true })
  .validateScope(app)
  .violations;
```

`applications/personal-site/test/cdk-nag.test.ts` is the model. Copy its third test too —
the one that builds a deliberately non-compliant bucket and asserts the pack still fires.
Without it the suite can start passing for the wrong reason.

### Writing a test for a new stack

1. Copy `infrastructure/dns/test/dns-stack.test.ts` for the behavioural tests.
2. Copy `applications/personal-site/test/cdk-nag.test.ts` for the policy test, and set
   `ACCEPTED_WARNINGS` to `[]`.
3. Set the two `process.env` lines at the top, **before any import**. `accounts.ts` reads
   them lazily but the stack constructor triggers that read.
4. Pass the same `synthesizer` your `bin/app.ts` passes. `cdk-nag.test.ts` explains why:
   omitting it falls back to the default `hnb659fds` qualifier, which changes the CDK
   asset bucket name and therefore the granular `AwsSolutions-IAM5[...]` finding IDs the
   stack suppresses. The test would then report findings that cannot occur in a real
   deploy.

---

## 4. The guardrails, from a developer's perspective

Three Aspects, applied in every `bin/app.ts`. They are the reason a bad change fails in
your terminal instead of in a rollback.

### What each one rejects

| Aspect | Triggers on | Severity |
| --- | --- | --- |
| `NoManagedEgressAspect` | `CfnNatGateway`, `CfnTransitGateway`, `CfnTransitGatewayAttachment` | Error |
| `NoManagedEgressAspect` | Interface `CfnVPCEndpoint` not in `allowedInterfaceEndpoints` | Warning |
| `RequiredTagsAspect` | Any taggable `CfnResource` missing `app`, `env` or `owner` | Error |
| `LogRetentionAspect` | Any `CfnLogGroup` with no `retentionInDays` | Error |

Exact messages, captured by synthesizing a deliberately bad stack:

```
ERROR Missing required tag(s): app, env, owner. Every taggable resource must carry
app, env, owner. Apply them with applyPlatformTags() from @platform/config.
(Construct Annotations)
   ProbeStack/Untagged/Resource
   Rule Construct-Annotations::error-annotation

ERROR Log group has no explicit retentionInDays. CloudWatch defaults to "never
expire", which is the most common silent cost leak in an AWS account. Set retention
from the environment profile in @platform/config. (Construct Annotations)
   ProbeStack/NoRetention
   Rule Construct-Annotations::error-annotation

Synthesis finished with errors
```

The NAT one names the likely cause rather than just the resource:

```
NAT Gateway blocked (ADR-0002, ~$33/mo per gateway plus $0.045/GB). The likely cause
is a Vpc using SubnetType.PRIVATE_WITH_EGRESS, which is what constructs this NAT
Gateway. Use SubnetType.PUBLIC with a strict security group,
SubnetType.PRIVATE_ISOLATED with an IPv6 egress-only internet gateway, or a Lambda
with no VPC attachment.
```

Fixes:

- Missing tags → `applyPlatformTags(this, { app, env, owner })` at the end of the stack
  constructor, as `site-stack.ts:224` does.
- Log retention → pass an explicit `LogGroup` with `retention: profile.logRetention`, as
  `site-stack.ts:326` does. Do **not** use the deprecated `logRetention` prop on
  `Function`: it renders a custom resource whose log group is not a `CfnLogGroup` the
  Aspect can see, so the guardrail silently stops guarding.

### The `AspectPriority.READONLY` gotcha

Every `bin/app.ts` has this line, and it is not decoration:

```ts
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
```

`Tags.of(...).add()` is itself implemented as an Aspect. `RequiredTagsAspect` reads the
tags those aspects write. If it runs first, it sees an untagged resource and fails synth
on resources that are correctly tagged.

Priorities in `aws-cdk-lib@2.263.0`: `MUTATING = 200`, `DEFAULT = 500`, `READONLY = 1000`.
Lower runs first. An Aspect added with no priority gets `DEFAULT`.

The confusing part is that **it depends on a feature flag**. With
`@aws-cdk/core:aspectPrioritiesMutating: true` in `cdk.json`, CDK's own `Tags` aspects are
registered at `MUTATING` (200), which is lower than your `DEFAULT` (500) — so a
priority-less `RequiredTagsAspect` happens to work. Turn the flag off, or omit it from a
new package's `cdk.json`, and `Tags` also gets `DEFAULT`, ordering becomes
tree-position-dependent, and the aspect fires on tagged resources.

Measured directly:

| `aspectPrioritiesMutating` | Aspect priority | Result on a correctly tagged stack |
| --- | --- | --- |
| `true` | none (DEFAULT) | 0 errors — works by luck |
| `true` | `READONLY` | 0 errors — works by design |
| absent from context | none (DEFAULT) | **1 error** — false failure |
| absent from context | `READONLY` | 0 errors |

So: a new package whose `cdk.json` is missing the flag *and* whose `bin/app.ts` omits the
priority fails synth with "Missing required tag(s)" on resources that are visibly tagged.
That is the confusing failure. **Always pass `AspectPriority.READONLY`.** It is correct
under every flag combination.

### cdk-nag suppressions

Never write suppressions by hand. Use the helpers in
`packages/constructs/src/nag/suppressions.ts`.

```ts
import { flattenForNagId, suppressNagRules, suppressNagRulesAtPath } from "@platform/constructs";

suppressNagRules(this.distribution, [
  {
    id: "AwsSolutions-CFR1",
    reason:
      "Geo restriction is deliberately off. This is a personal site and a portfolio " +
      "artifact whose entire purpose is to be reachable from anywhere (ADR-0007).",
  },
]);
```

The exact rule ID comes from the synth output. When cdk-nag fires it prints the line to
copy:

```
ERROR The S3 Bucket has server access logs disabled. ... (AwsSolutions)
   ProbeStack/Bare/Resource aws-cdk-lib.aws_s3.CfnBucket
   Acknowledge with 'AwsSolutions::AwsSolutions-S1'
```

Rules the helper enforces **at synth**, not at review:

| Rule | Enforced by | Failure |
| --- | --- | --- |
| Reason must match `/ADR-\d{4}\|\$\d/` | `assertJustified` | `must cite an ADR (ADR-0002) or a cost figure ($5/mo)` |
| Reason must be ≥ 40 characters | `assertJustified` | `reason is too short to be useful to a reviewer` |
| Construct path must resolve | `suppressNagRulesAtPath` | `No construct at path "..." under "..."` — **throws**, does not silently no-op |
| Suppression is per-rule, not per-resource | The metadata shape | Suppressing `AwsSolutions-S1` leaves `AwsSolutions-S10` reporting |

"Not applicable" and "accepted risk" do not compile. That is deliberate.

Three more things:

- **Granular finding IDs must be built, not typed.** IDs like
  `AwsSolutions-IAM5[Resource::<Bucket123.Arn>/data/*]` embed a resolved logical ID that
  changes on rename. Use `flattenForNagId(this, someArn)` to render it the way cdk-nag
  does. See `site-stack.ts:409`.
- **Stack-level suppressions are forbidden** (ADR-0007 §2). A stack-scoped acknowledgment
  silences the rule for every resource added later, including ones nobody has reviewed.
  `infrastructure/org/test/cdk-nag.test.ts` asserts none exists.
- **Suppressions are reviewed, not routine.** ADR-0007 fixed eight findings and suppressed
  the rest with a written reason each. The default is to fix. If you are reaching for a
  suppression, the first question is whether the finding is right.

A CDK upgrade can invalidate a suppression — a construct ID changes, and
`suppressNagRulesAtPath` throws. That is intended: it fails the build with a clear cause
rather than quietly silencing nothing.

---

## 5. Adding a new package

### Where it goes (ADR-0004)

| Layer | Contains | May import |
| --- | --- | --- |
| `infrastructure/*` | Platform-owned, slow-changing, deployed deliberately | `packages/*`, `infrastructure/*` |
| `applications/*` | App-owned, fast-changing, deployed continuously | `packages/*` only |
| `automation/*` | The AI/ops layer (ADR-0005) | `packages/*` only |
| `packages/*` | Shared code | `packages/*` only |

`pnpm-workspace.yaml` already globs all four, so a new directory is picked up by
`pnpm install`.

### Checklist

**1. `package.json`** — copy `infrastructure/dns/package.json`:

```json
{
  "name": "@platform/<name>",
  "private": true,
  "main": "dist/lib/<stack>.js",
  "types": "dist/lib/<stack>.d.ts",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "lint": "eslint bin lib --no-ignore",
    "test": "jest --passWithNoTests",
    "synth": "cdk synth"
  },
  "dependencies": {
    "@platform/config": "workspace:*",
    "@platform/constructs": "workspace:*"
  },
  "devDependencies": {
    "aws-cdk-lib": "^2.173.2",
    "cdk-nag": "^3.0.2",
    "constructs": "^10.4.2"
  },
  "peerDependencies": {
    "aws-cdk-lib": "^2.173.2",
    "constructs": "^10.4.2"
  }
}
```

Do **not** add a `"type": "module"` field. No package here has one; adding one turns
NodeNext into strict-ESM mode and every relative import in the package starts failing
`TS2835` unless it carries an explicit `.js` extension.

**2. `tsconfig.json`** — project references matter, or `tsc -b` will not build
dependencies:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist" },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts"],
  "exclude": ["cdk.out", "dist"],
  "references": [
    { "path": "../../packages/config" },
    { "path": "../../packages/constructs" }
  ],
  "ts-node": { "preferTsExts": true, "experimentalResolver": true }
}
```

`references` must match `dependencies`. The `ts-node` block is what makes
`npx ts-node --prefer-ts-exts bin/app.ts` resolve `.ts` over stale `.js` in `dist/`.

**3. `jest.config.js`** — one line, the `moduleNameMapper` is required:

```js
const preset = require("../../jest.preset.js");
module.exports = { ...preset, moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" } };
```

The base preset already sets this, but every package restates it because a package that
overrides `moduleNameMapper` and forgets it fails with `Cannot find module '../src/index.js'`.

**4. `cdk.json`** — copy `infrastructure/dns/cdk.json`. Two context flags are
load-bearing:

| Flag | Without it |
| --- | --- |
| `@aws-cdk/core:aspectPrioritiesMutating: true` | CDK's `Tags` aspects run at `DEFAULT` instead of `MUTATING`. Combined with a `bin/app.ts` that omits `AspectPriority.READONLY`, `RequiredTagsAspect` fires on correctly tagged resources. Verified: 1 false error |
| `@aws-cdk/core:aspectStabilization: true` | Aspects run in a single pass. Aspects that create nodes, and nodes created by other Aspects, are not visited. Guardrail coverage silently develops holes |

The other flags in that file are standard CDK behaviour flags. Keep them aligned across
packages; a `cdk diff` that differs only because one package has a different flag set is
noise.

**5. `bin/app.ts`** — copy `infrastructure/dns/bin/app.ts`:

```ts
new MyStack(app, "MyStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor("prod"),   // or managementSynthesizer() for the mgmt account
  ...
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
```

Synthesizer choice is not optional and not a default:

| Target | Use | Qualifier |
| --- | --- | --- |
| Platform account, prod | `synthesizerFor("prod")` | `hnbprod` |
| Platform account, dev | `synthesizerFor("dev")` | `hnbdev` (carries the permissions boundary) |
| Management account | `managementSynthesizer()` | `hnbmgmt` |

Omitting it falls back to CDK's default `hnb659fds`, which was never bootstrapped here.
The failure is an `AssumeRole` error at deploy time naming a role that does not exist.

A dev-scoped stack that creates an IAM role must also apply the boundary
(`PermissionsBoundary.of(scope).apply(...)`) or the deploy is denied by
`DenyCreatingUnboundedPrincipals` (`infrastructure/bootstrap/README.md`).

**6. `turbo.json`** — only if the new task needs environment variables. See §6.

**7. eslint boundaries** — `.eslintrc.json` already encodes the ADR-0004 matrix, and the
element type is derived from the directory, so a new package under `applications/` is
classified automatically. Violating it produces:

```
error  ADR-0004: applications must not import infrastructure. Applications and
infrastructure are independent layers; consume platform resources via SSM parameter
lookup, never cross-stack export  boundaries/element-types
```

**Caveat, verified by experiment.** `boundaries/element-types` only fires when it can
resolve the import to a file it can classify. A cross-layer import written as
`../../../infrastructure/dns/lib/dns-stack.js` resolves to nothing on disk (the file is
`.ts`), so boundaries logs it as "unknown type" and — because `boundaries/no-unknown` is
`"off"` in this config — says nothing. The lint rule reliably catches an explicit
`.ts`-extension import; it does not catch the `.js`-specifier form the NodeNext style
guide requires.

That gap is covered by two other layers, both of which do fire:

- **TypeScript**: `TS6059 File ... is not under 'rootDir'` and `TS6307 ... not listed
  within the file list of project`.
- **pnpm workspaces**: importing `@platform/infra-dns` by package name gives
  `TS2307 Cannot find module`, because it is not in `dependencies`.

So the rule is enforced, just not by the layer you would expect. Worth knowing before you
trust a green lint run.

---

## 6. Environment variables and credentials

### `MGMT_ACCOUNT_ID` and `PLATFORM_ACCOUNT_ID`

They are environment variables rather than committed constants so that no real AWS account
ID lands in a public repo. Account IDs are not secrets, but they are free reconnaissance.
In CI they are GitHub repository **variables**, not secrets (`ci.yml`).

`packages/config/src/accounts.ts` reads them lazily through a getter and validates the
12-digit shape, so synthesizing one stack does not require every account ID to be present.

Locally:

```powershell
$env:MGMT_ACCOUNT_ID     = "<12 digits>"
$env:PLATFORM_ACCOUNT_ID = "<12 digits>"
```

Put these in your shell profile. You will need them for every synth, diff and deploy.

### The turbo `env` allowlist

Turborepo defaults to **strict** environment mode. A task only sees environment variables
listed in its `env` array (or `globalEnv`). Everything else is stripped — not warned
about, stripped.

Confirmed by experiment on turbo 2.10.8: a task with no `env` array, run with
`PLATFORM_ACCOUNT_ID` exported in the shell, reads `process.env.PLATFORM_ACCOUNT_ID` as
`undefined`. Adding it to that task's `env` array makes it visible.

This is why `turbo.json` has:

```json
"synth": {
  "dependsOn": ["^build"],
  "outputs": ["cdk.out/**"],
  "env": ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION", "MGMT_ACCOUNT_ID", "PLATFORM_ACCOUNT_ID"]
}
```

**The failure mode is confusing.** `pnpm --filter @platform/infra-dns synth` works, because
that calls the package script directly. `pnpm run synth -- --filter=@platform/infra-dns`
fails with "Missing PLATFORM_ACCOUNT_ID", because that goes through turbo. Same variables,
same shell, different result.

The `test` task deliberately has **no** `env` array. Test files set the values themselves:

```ts
process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
```

That is correct — tests must not depend on ambient account IDs, or they pass on your
machine and fail in a clean checkout. It also means turbo's cache key for tests is not
polluted by an account ID.

If you add a task that reads an environment variable, add it to that task's `env` array.
This also affects cache correctness: a variable in `env` is part of the cache key, so
changing it invalidates the cache. One not in `env` would give you a stale cache hit,
which is the worse failure.

### SSO profiles

Two profiles, set up in the Phase 0 action plan §2 A5 via `aws configure sso`:

| Profile | Account | Used for |
| --- | --- | --- |
| `platform` | Platform | `infrastructure/bootstrap`, `infrastructure/dns`, `applications/personal-site` |
| `mgmt` | Management | `infrastructure/org` (GovernanceStack) only |

```powershell
aws sso login --profile platform
aws sts get-caller-identity --profile platform
```

Sessions expire. An expired session shows up as a credentials error partway through a
`cdk deploy`, not at the start.

Which profile each package deploys with:

| Package | Profile | Synthesizer / qualifier |
| --- | --- | --- |
| `@platform/infra-bootstrap` | `platform` | `synthesizerFor("prod")` → `hnbprod` |
| `@platform/infra-dns` | `platform` | `synthesizerFor("prod")` → `hnbprod` |
| `@platform/personal-site` | `platform` | `synthesizerFor("prod")` → `hnbprod` |
| `@platform/infra-org` | `mgmt` | `managementSynthesizer()` → `hnbmgmt` |

`synth` needs no credentials at all — only the two env vars. `diff` and `deploy` need both.

### The SSM contract, and why no CloudFormation exports

Platform stacks publish to well-known SSM paths. Applications read them. The paths are
defined once, in `packages/config/src/domains.ts`:

```
/platform/dns/{domain}/hosted-zone-id
/platform/dns/{domain}/hosted-zone-name
/platform/acm/{domain}/certificate-arn
/platform/{env}/vpc/id
```

In practice (`site-stack.ts:147`):

```ts
const certificate = acm.Certificate.fromCertificateArn(
  this,
  "PlatformCertificate",
  ssm.StringParameter.valueForStringParameter(this, ssmPaths.certificateArn(domains.platform)),
);
```

**ADR-0004 forbids `Fn::ImportValue` across the platform/application seam.** The reason is
mechanical, not stylistic:

1. A CloudFormation export creates a hard dependency. While `PersonalSiteStack` imports a
   value exported by `DnsStack`, **CloudFormation refuses to delete or modify that export
   in `DnsStack`**. The exporting stack becomes undeletable and the exported value becomes
   unchangeable.
2. That forces lockstep deploys. Changing the exported value means: remove the import from
   the consumer, deploy the consumer, change the export, deploy the producer, re-add the
   import, deploy the consumer. Three deploys in a fixed order for one value.
3. It defeats the point of the layout. ADR-0004 puts platform and applications in separate
   directories so they can be deployed and reasoned about independently. An export
   reintroduces exactly the coupling the directories exist to prevent.

SSM has none of these properties. The producer writes; the consumer reads at synth or
deploy; neither stack knows the other exists. `infrastructure/dns/test/dns-stack.test.ts`
asserts the contract directly — every stack output has no `Export` key.

Two flavours of read, and the difference matters:

| Method | Resolves | Consequence |
| --- | --- | --- |
| `valueForStringParameter` | Deploy time, via a CFN parameter | Template does not embed the value; no credentials needed at synth |
| `valueFromLookup` | Synth time, against live AWS | Caches into `cdk.context.json`; template depends on ambient credentials and cache freshness |

`site-stack.ts` uses `valueForStringParameter` for the certificate ARN. `DnsStack`
deliberately takes the CloudFront domain as an explicit prop rather than a lookup, because
for the highest-risk change in Phase 0 the value should be visible in the commit diff and
identical whether synthesized in CI, locally, or with no credentials (see the comment at
`dns-stack.ts:60`).

---

## 7. Common errors and what they mean

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error: Missing PLATFORM_ACCOUNT_ID. Set it in your shell or as a CI repository variable.` | Env var absent, **or** present but stripped by turbo | Export it. If it is exported and you are running through `pnpm run <task> -- --filter=...`, add it to that task's `env` array in `turbo.json` |
| `MGMT_ACCOUNT_ID must be a 12-digit AWS account ID, got: ...` | Typo, quotes, or a leading zero lost to a numeric conversion | Quote the value as a string |
| `AccessDenied` / `is not authorized to perform: sts:AssumeRole on resource: .../cdk-<qualifier>-deploy-role-...` at deploy | Qualifier mismatch. The stack synthesized against a qualifier that was never bootstrapped | Confirm the stack passes `synthesizerFor(env)` or `managementSynthesizer()`. Check the bootstrapped qualifiers: `hnbdev`, `hnbprod`, `hnbmgmt`. Nothing validates the two sides against each other |
| `Invalid CDK bootstrap qualifier "..."` at synth | Qualifier longer than 10 chars or has illegal characters | `bootstrapQualifierFor()` enforces the bootstrap template's limit at synth. Pick a shorter one |
| Stack files missing from git; `tsc` fails in a fresh clone | The `lib/` gitignore trap. CDK convention puts stack **source** in `<package>/lib/`, so a bare `lib/` ignore pattern silently excludes real code | `.gitignore` uses explicit `packages/*/dist/`, `infrastructure/*/dist/` etc. and carries a comment saying why. Never add a bare `lib/`. Verify with `git status --ignored` before committing a new package |
| `TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean './x.js'?` | NodeNext in ESM mode. Only reachable if a `package.json` gained `"type": "module"` | Either add the `.js` extension or, more likely, remove the `"type": "module"` you just added. No package here has one |
| `Cannot find module '../src/index.js' from 'test/foo.test.ts'` | jest cannot resolve the NodeNext `.js` specifier against the on-disk `.ts` file | The package's `jest.config.js` needs `moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }`. Usually caused by spreading the preset and then overriding `moduleNameMapper` |
| `TS6059: File '...' is not under 'rootDir'` / `TS6307: ... not listed within the file list of project` | A cross-layer relative import (ADR-0004 violation) | Use SSM, not an import. If the value genuinely belongs to both, move it to `packages/config` |
| `TS2307: Cannot find module '@platform/infra-dns'` | Cross-layer import by package name | Same answer. pnpm will not resolve it because it is not in `dependencies`, which is the point |
| `ERROR ... (AwsSolutions)` then `Synthesis finished with errors` | A cdk-nag error-severity finding. Exit code is non-zero, so CI fails here too | Fix it first. If it is a genuine tradeoff, use `suppressNagRules` with a reason citing an ADR or a dollar figure. Copy the exact ID from the `Acknowledge with '...'` line |
| `cdk-nag suppression "..." must cite an ADR (ADR-0002) or a cost figure ($5/mo) in its reason` | The suppression policy, enforced at synth (ADR-0007) | Write a real reason. "Accepted risk" does not compile |
| `No construct at path "..." under "...". cdk-nag suppressions are addressed by construct path; a stale path silences nothing.` | A construct was renamed, or a CDK upgrade changed a generated ID | Run `cdk synth` and copy the current path from the finding. This throwing is intentional |
| `Missing required tag(s): app, env, owner` on resources you can see are tagged | `RequiredTagsAspect` ran before the mutating `Tags` aspects | Add `{ priority: AspectPriority.READONLY }`. Also check `cdk.json` has `@aws-cdk/core:aspectPrioritiesMutating: true` |
| `Cannot invoke Aspect X with priority N on node ...: an Aspect Y with a lower priority ... was already invoked on this node` | Aspect stabilization detected an ordering violation | An Aspect is being added at a lower priority than one already run on that node. Usually means an Aspect is adding another Aspect |
| `UnauthorizedOperation` / `AccessDenied` with no useful detail, inside a `ROLLBACK_IN_PROGRESS` | An SCP denial. SCPs deny at the account boundary and CloudFormation surfaces the raw API error with no mention of the policy | Check `infrastructure/org/lib/service-control-policies.ts`. Likely candidates: region lock (anything outside `us-east-1`), `DenyManagedEgress` (NAT/TGW), `DenyExpensiveInstanceTypes`, `DenyStaticCredentials` (`iam:CreateAccessKey`, `iam:CreateLoginProfile`), `ProtectAuditTrail`. `NoManagedEgressAspect` catches the egress cases at synth with a readable message; the SCP is the layer behind it that does not explain itself |
| `AccessDenied` in a dev deploy on a resource tagged `env=prod` | Working as designed. The dev CFN execution role carries `cdk-dev-permissions-boundary` | ADR-0001. Deploy through prod, or stop touching prod-tagged resources from a dev stack |
| `cdk diff` shows no changes but the deployed behaviour differs | A previous `--hotswap` deploy. The template is unchanged; the live resource is not | Run a full `cdk deploy` (no hotswap flags) to reconcile. `cdk drift` will confirm |
| `The following non-hotswappable changes were found` and part of your change did not deploy | `--hotswap` ignores what it cannot hotswap | Re-run with `--hotswap-fallback`, or a plain `cdk deploy` |
| `Static export not found at ...` from `PersonalSiteStack` | The Next.js `out/` directory is not on disk | Synth with `-c sitePlaceholder=true` (what `pnpm --filter @platform/personal-site synth` does), or pass `siteSourcePath`. Never deploy with the placeholder |
| `Missing required context "workloadsOuId"` | `GovernanceStack` needs OU IDs created by hand in Stage A | `npx cdk synth -c workloadsOuId=ou-... -c sandboxOuId=ou-...` |

---

## Command reference

```powershell
# Full check, as CI runs it
pnpm run check                                    # lint + typecheck + test

# Fast feedback on infrastructure, no AWS
pnpm --filter @platform/personal-site synth
pnpm run synth -- --filter='!@platform/infra-org'

# Tests
pnpm run test                                     # 267 tests
pnpm --filter @platform/infra-dns test -- -u      # regenerate the DNS snapshot

# What will change (needs credentials)
pnpm --filter @platform/infra-dns exec cdk diff DnsStack

# Deploy (needs credentials; normally CI does this)
pnpm --filter @platform/infra-dns exec cdk deploy DnsStack

# Dev loop, once a dev-scoped stack exists. Never against env=prod.
cd applications/personal-site
npx cdk watch PersonalSiteStack                   # implies --hotswap, tails logs
npx cdk deploy PersonalSiteStack --hotswap-fallback

# Logs on a deployed function
aws logs tail /aws/lambda/<name> --follow --profile platform
```

## Where to look next

| Question | File |
| --- | --- |
| Why CDK and not Serverless Framework | `docs/decisions/0008-cdk-only-iac.md` |
| Why the layers and the SSM contract | `docs/decisions/0004-repository-strategy.md` |
| Why cdk-nag and the suppression policy | `docs/decisions/0007-policy-as-code.md` |
| Bootstrap qualifiers and the permissions boundary | `infrastructure/bootstrap/README.md` |
| Known gaps before deploying | `docs/open-issues.md` |
| What to do next | `docs/phase-0-action-plan.md` |
