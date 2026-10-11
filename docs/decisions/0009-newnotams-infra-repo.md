# ADR-0009: NewNotams' CDK stack moves into its own repo

- Status: Accepted
- Date: 2026-10-11

## Context

ADR-0004 put every application's CDK stack inside this monorepo, at
`applications/<name>/`, with the app's own source code living in a separate repo (the
`personal-site`/`personal-website` split is the working precedent: CDK here, Next.js source
there, joined only at deploy time via a checkout step). NewNotams followed that same pattern
through Phase 1: `applications/newnotams/` held `NewNotamsStack`, `OpenNextSite`, and
`ScheduledJob` wiring, while `JosephKan3/NewNotams.Net` held the Next.js app.

ADR-0004 also names the actual threshold for splitting a repo out of the monorepo: "only when
it has a genuinely independent release cadence or different collaborators." That threshold
was never explicitly checked against NewNotams — the app simply inherited the default layout
without anyone asking whether the default still applied.

It does not. `NewNotams.Net` (née `v0-notam-search-app`) **predates this project entirely** —
a second, stale local clone at `reactProjects/v0-notam-search-app` with commit history back
to well before Phase 0 started confirms this is not a repo this project created and could
reasonably fold into a shared layout; it is a pre-existing, independently-released application
this project is migrating the *hosting* of, not the *ownership* of. `docs/architecture/review.md`'s
own answer to "infrastructure ownership" is explicit: "Apps own everything above the
network: their Lambda/Fargate compute, their database, their queues, their DNS records,
**their alarms**." NewNotams' CDK stack is exactly that list. Having it live in a different
repo than the app it deploys, maintained by the same single person as everything else here,
served no purpose except matching a default that was written before this specific app's
history was accounted for.

## Decision

**`NewNotamsStack` (and everything under the old `applications/newnotams/`) moves into
`JosephKan3/NewNotams.Net`.** The app owns its own infrastructure-as-code, in its own repo,
alongside its own source. `home-platform` stops containing any NewNotams-specific code.

This is a repo-location decision only. It does not reopen ADR-0004's broader claims about
monorepo-vs-polyrepo for the platform's own infrastructure and for applications that *do*
share this repo's default layout (the personal site's CDK stays in `applications/personal-site/`
— that app has no independent history or repo of its own, so ADR-0004's default still applies
to it cleanly). It also does not reopen ADR-0008's choice of CDK as the only IaC tool —
`NewNotams.Net` still uses CDK, still applies the same guardrail Aspects, still runs the same
cdk-nag checks. See "What does not change" below.

## What this actually requires — the dependency problem

`NewNotamsStack` imports `@platform/config` (profiles, tagging, `ssmPaths`, `domains`) and
`@platform/constructs` (`OpenNextSite`, `ScheduledJob`, `suppressNagRules`, the three
guardrail Aspects). Those exist today only as `workspace:*` packages inside this monorepo's
pnpm workspace — they cannot be imported from a different repo as-is.

**Resolved by publishing both packages to GitHub Packages** (npm registry, scoped to
`@platform`, authenticated via `GITHUB_TOKEN`/a PAT — free for a private registry under a
personal account's usage, and these packages contain no secrets, same posture as the rest of
this public repo). `NewNotams.Net` installs them like any other npm dependency, pinned to a
real published version, not `workspace:*`.

This was chosen over the alternative — copying `OpenNextSite`/`ScheduledJob`/the Aspects
directly into `NewNotams.Net` with no shared dependency at all — because that alternative
creates exactly the problem ADR-0008 rejected Serverless Framework over: two copies of the
guardrail logic that can silently drift apart. A real published package, versioned, is the
same mechanism any other npm dependency uses to stay in sync deliberately (a version bump)
rather than accidentally (a copy nobody remembers to update).

**Cost of this choice, stated plainly:** `packages/config` and `packages/constructs` now need
a publish step whenever either changes — not just a `pnpm build` inside this monorepo. This
is new process, not automated as of this ADR. Until it is, a change to either package needs
a manual `npm publish` (or a CI job added for it) before `NewNotams.Net` can pick it up. This
is accepted as a real, recorded cost of the split, not quietly absorbed.

## What does not change

- **The guardrails still apply, with no exception.** `NewNotams.Net`'s own `bin/app.ts`
  (wherever CDK's entrypoint lives in that repo) applies `NoManagedEgressAspect`,
  `RequiredTagsAspect`, `LogRetentionAspect`, and `AwsSolutionsChecks` exactly as
  `applications/newnotams/bin/app.ts` did here — the same three Aspects and the same cdk-nag
  validation plugin, imported from the same published `@platform/constructs` package. ADR-0008's
  decisive rationale ("Serverless Framework bypasses every guardrail... a platform whose
  stated policy posture applies to some resources and not others is worse than one that makes
  no such claim") applies with equal force to a second CDK repo that skips them. It must not
  skip them.
- **CDK remains the only IaC tool.** This ADR does not adopt SST, Serverless Framework, or
  anything else for NewNotams. `NewNotams.Net`'s infra directory is still CDK, still
  TypeScript, still tested with the same jest + `Template.fromStack` pattern as every other
  stack in this platform.
- **The platform/application seam stays SSM-lookup-only.** `NewNotamsStack` already read the
  ACM certificate ARN via `ssm.StringParameter.valueForStringParameter` against a well-known
  path (`ssmPaths.certificateArn`), never a CloudFormation export. That contract crosses repo
  boundaries exactly as cleanly as it crossed stack boundaries — nothing about it assumed a
  shared monorepo.
- **Deploy credentials and environments are unaffected.** `NewNotamsStack` already deployed
  into the Platform AWS account via the `platform` SSO profile, independent of which repo
  issues the `cdk deploy`.

## Consequences

- `applications/newnotams/` is deleted from `home-platform` once the move is verified working
  from the new location — not left behind as a stale duplicate.
- `infrastructure/dns`'s `DnsStack` still lives here (it is platform-owned: the Route53 zone,
  per ADR-0004/review.md's own ownership line — "DNS zones" are listed under platform, not
  app, ownership, which is why `createProductZone`/`productOrigin` context flags stay in
  `infrastructure/dns`, not move with the stack). Only the **records and certificate that are
  specific to serving NewNotams through CloudFront** conceptually belong to the app; the zone
  itself remains platform infrastructure. This ADR does not relitigate that split.
- CI: `home-platform`'s `.github/workflows/deploy.yml` had never been wired to deploy
  `NewNotamsStack` at all (a real, separate gap — every deploy this phase was manual). That
  gap moves with the stack: `NewNotams.Net` needs its own CI deploy workflow, written fresh,
  not inherited from this repo's.
- `docs/phase-1-action-plan.md` and `infrastructure/dns/README.md`'s references to
  `applications/newnotams/lib/newnotams-stack.ts` become stale pointers into history; they are
  not rewritten retroactively (the actions they describe already happened, in that location,
  at the time), but new work from this point references the new location.
- The personal site's CDK stack is **not** moved by this decision. It has no independent
  repo, no history predating this project, and no stated reason to split — ADR-0004's default
  still applies to it. Revisit only if the same "does this have independent history or
  collaborators" question gets a different answer for it later.

## Alternatives considered

- **Leave `NewNotamsStack` in `home-platform`, as originally built.** Rejected once the
  app's pre-existing, independent repo history was actually checked against ADR-0004's own
  stated threshold — the threshold was met, just never checked.
- **Copy the needed construct/config code into `NewNotams.Net` with no package dependency.**
  Rejected: recreates the exact drift risk ADR-0008 already rejected Serverless Framework
  over, just one layer down (duplicated guardrail logic instead of duplicated IaC tooling).
- **Git submodule pointing `NewNotams.Net` at `home-platform`'s `packages/`.** Rejected as
  more operationally fragile than a published package for a single-operator setup — submodule
  update discipline is a known source of "forgot to update the pointer" bugs, and a real
  npm package version pin is both more standard and more visible when stale.
