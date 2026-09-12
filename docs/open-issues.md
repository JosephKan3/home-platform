# Open Issues

Problems found while building Phase 0 that are not yet resolved. Each names the blocking
work and whether it gates the Phase 0 exit criteria.

---

## 1. The dev permissions boundary did not constrain `cdk deploy`

**Severity: was high. Resolved in code; one manual step remains before the exit criterion
can be signed off.**

### What was broken, and why it matters

ADR-0001 leans on a permissions boundary as the mechanism that makes sharing one account
between dev and prod survivable. `infrastructure/bootstrap` created that boundary and
attached it to `gha-deploy-dev`, denying any action where `aws:ResourceTag/env = prod`.

It did not work, for two compounding reasons:

1. **`gha-deploy-dev` holds no direct AWS permissions.** Its only statement is
   `sts:AssumeRole` on the `cdk-*` bootstrap roles. So the boundary capped a role that had
   nothing to cap.
2. **A permissions boundary does not follow a role chain.** The actual mutations happen
   further down the chain, in a separate role with its own broad policy and no boundary.
   Nothing dev CI did was constrained by it.

This reasoning is kept because it is the whole reason the fix looks the way it does. The
failure mode was not a missing statement — the policy was correct — it was a correct policy
attached to a principal where it could not do anything. That is invisible in a diff and
would have passed any review that checked the policy document.

A test asserting the denial would have passed for the wrong reason: proving the absence of
an Allow, not the presence of a boundary. Such a test existed and was deleted rather than
kept as false assurance.

### What actually fixed it

Verified against `aws-cdk@2.1135.0`'s bootstrap template
(`lib/api/bootstrap/bootstrap-template.yaml`): `--custom-permissions-boundary` sets
`PermissionsBoundary` on the `CloudFormationExecutionRole` resource and on **nothing else**.
Not the deploy role, not the lookup role, not the publishing roles. So the boundary has to
live on `cdk-<qualifier>-cfn-exec-role-*`, and dev and prod need different ones — which means
different bootstrap qualifiers, since one bootstrap per account produces one execution role.

Changed:

- `packages/config/src/bootstrap.ts` — qualifiers defined once (`hnbdev`, `hnbprod`,
  `hnbmgmt`), validated against the template's 10-character limit, and exposed as
  `synthesizerFor(env)` / `managementSynthesizer()` so bootstrap and synth cannot drift.
- `infrastructure/bootstrap` — the boundary is now a fixed-name managed policy
  (`cdk-dev-permissions-boundary`), attached to no role in the stack, plus Denies on editing
  the boundary policy itself and on creating principals without it. Each `gha-*` role's
  `sts:AssumeRole` is scoped to its own qualifier: `gha-deploy-dev` can no longer reach the
  prod qualifier's unbounded execution role, which would have been a complete bypass.
- All four apps pass an explicit synthesizer; `infrastructure/org` uses the management
  qualifier rather than defaulting into a Platform-account one.
- `docs/phase-0-action-plan.md` §2 A6 — the bootstrap order, which is not the obvious one:
  the boundary policy must exist before `cdk bootstrap --custom-permissions-boundary`
  references it, so §4 C1 lands *between* the prod and dev bootstraps.

### What is still true

`aws:ResourceTag` only evaluates on API calls against resources that *already* carry the tag.
It cannot prevent creating untagged resources, and it does not apply during creation.
`RequiredTagsAspect` closes that at synth time, but synth-time enforcement is bypassed by
anyone calling the AWS API directly. This is unchanged and is a property of tag-based IAM, not
of this fix.

Prod remains deliberately unbounded. Its control is the GitHub Environment review gate.

### What remains manual

`infrastructure/bootstrap/test/dev-permissions-boundary.test.ts` asserts every offline
precondition and states in its own header what it cannot prove. It cannot prove the denial,
because IAM evaluation happens in AWS against roles created by the CDK CLI's template.

The live probe in `infrastructure/bootstrap/README.md` ("Verify the boundary is load-bearing")
is what closes the loop, and it is deliberately a two-call probe: tagging an untagged bucket
must **succeed** while tagging an `env=prod` bucket is **denied**. Without the control call
the result is indistinguishable from the original bug.

**Until that probe is run against the real account, the exit criterion is not signed off.**

---

## 2. There are no dev-scoped stacks

**Severity: medium. Cosmetic today, structural later.**

All four stacks are tagged `env: prod` and deploy to the single Platform account. The
`deploy-dev` job in `.github/workflows/deploy.yml` therefore synthesizes but does not
deploy anything meaningful.

This is arguably correct for Phase 0 — the personal site has no dev environment worth
running, and a second CloudFront distribution would cost money for no benefit. But it means
the dev/prod split is untested until Phase 1, when NewNotams arrives with a real staging
need (`staging.newnotams.net` is already in the ADR-0006 namespace plan).

**Decide in Phase 1.** Issue 1's boundary now exists and is attached, so the first real dev
stack inherits it rather than waiting on it. One constraint it must respect: the boundary
denies `iam:CreateRole` unless the new role carries the same boundary, so any dev stack that
creates an IAM role must apply it (`PermissionsBoundary.of(scope).apply(...)`) or its deploy
is denied.

---

## 3. `GovernanceStack` cannot be deployed by CI

**Severity: low. RESOLVED — the documentation now matches reality.**

The behaviour was always correct; only the action plan was wrong. Action plan §6 has been
corrected to say "deploy this by hand" with the reasoning, so the contradiction is gone.
The rest of this entry is retained because the reasoning is worth keeping.

`infrastructure/org` targets the management account. `infrastructure/bootstrap` creates
GitHub OIDC roles only in the Platform account — correctly, because ADR-0001 says nothing
runs in management and SCPs do not apply there anyway.

Consequence: the governance stack must be deployed by hand via SSO admin. The
`deploy-prod` job contains the step with an explicit `exit 1` and an explanation rather
than silently skipping it.

This is the right tradeoff — creating a deploy role in the management account would
undermine the reason management is kept empty. Action plan §6 previously implied CI
deployment; it has been corrected.

---

## 4. cdk-nag v3 has a different API than assumed

**Severity: resolved, recorded for context.**

`cdk-nag@3.x` is not the widely-documented v2 library:

- `AwsSolutionsChecks` is an `IPolicyValidationPlugin`, not an `IAspect`. Registration is
  `Validations.of(app).addPlugins(...)`, not `Aspects.of(app).add(...)`.
- `NagSuppressions` was removed. Its replacement, `Validations.of(scope).acknowledge()`,
  throws on granular finding IDs such as `AwsSolutions-IAM5[Resource::arn:...]` because the
  bracket content contains `::`.

Worked around by `packages/constructs/src/nag/suppressions.ts`, which writes the
acknowledged-rules metadata directly and enforces the suppression policy at synth: reasons
must cite an ADR number or a dollar figure, must be at least 40 characters, and a stale
construct path throws rather than silently suppressing nothing.

Most cdk-nag documentation and examples online describe v2. Consult the installed type
definitions, not the internet, when touching this.

---

## 5. Unverified assumptions in the teardown runbook

**Severity: low. Known-unknowns, documented rather than hidden.**

`docs/runbooks/teardown-phase-0.md` contains procedures that were written from API shapes
rather than executed:

- The versioned-bucket emptying loop's pagination.
- Whether `GovernanceStack` deletes cleanly with SCPs still attached (CloudFormation
  *should* detach first; untested). The runbook sidesteps this by detaching manually.
- `remove-account-from-organization` behaviour for accounts that never completed sign-up.
- Exact AWS account-closure rate limits and the new-account waiting period, neither of
  which AWS publishes as a number.
- CloudFront's 15-20 minute delete window is typical, not guaranteed, and ACM's `InUseBy`
  has no documented clearing SLA.

These only matter if a full teardown is ever executed. Verify before relying on them.

---

## 6. Live DNS values are asserted against config, not against reality

**Severity: medium. Must be checked before the Stage D nameserver switch.**

`infrastructure/dns` tests assert the apex A record equals `vercelRecords.apexIpv4` from
`@platform/config`. That proves the stack agrees with the config — it cannot prove the
config agrees with what GoDaddy is actually serving today.

If GoDaddy holds any record not captured in ADR-0006 — a domain-verification TXT, a CAA
record, anything Vercel added automatically — then replicating an incomplete zone means
**step D3 is not a no-op and the site breaks on delegation.**

**Before D3, run the side-by-side comparison in `infrastructure/dns/README.md`** against
both GoDaddy's and Route53's nameservers and diff the full record sets. This is the single
most important manual verification in Phase 0.

---

## 7. OpenNext does not fully support Windows

**Severity: medium. Blocks the Phase 1 NewNotams migration on this machine.**

The Phase 1 plan deploys NewNotams as Next.js on Lambda via OpenNext. The OpenNext
maintainers state Windows support is not guaranteed: Next.js tooling itself has Windows
issues, OpenNext is built on that tooling, and the team explicitly deprioritizes Windows
testing.

Their recommended options are WSL, a Linux VM, or developing with standard Next.js tooling
locally and running the OpenNext build **only in CI on Linux runners**.

**Likely answer:** the third. Develop with `next dev` on Windows, and let GitHub Actions
(`ubuntu-latest`) run `open-next build` and the deploy. This costs nothing, matches how the
personal site already deploys, and avoids maintaining a WSL toolchain — but it means the
OpenNext output cannot be inspected locally, so build failures surface only in CI.

**Decide before starting Phase 1.** If local OpenNext iteration turns out to be necessary,
WSL is the fallback. Independent of the IaC choice in ADR-0008.

---

## 8. Next.js 12 is past end of life

**Severity: low. Deliberately deferred.**

The personal site runs Next.js 12 (EOL). It is fully static, so `next export` works and
there is no request-path exposure. Upgrading is worth doing but must not block Phase 0 —
recorded so it isn't forgotten rather than because it needs action now.

The site repo also needs these cleanups before `git subtree` migration, all documented in
`applications/personal-site/README.md`:

- Both `next.config.js` and `next.config.mjs` exist; Next silently ignores one.
- A stray `add` dependency in `package.json` (an accidental `npm install add`).
- ~35 lines of commented-out code in `pages/api/oandaReturn.ts`.
- Both API routes get deleted once the OANDA Lambda is live.

---

## 9. The dev permissions boundary did not deny a live `env=prod` S3 call

**Severity: high. The mechanism ADR-0001 relies on to share one account between dev and prod
is unverified — the one probe designed to prove it works instead showed it does not, for at
least one action.**

### What happened

Ran the manual probe in `infrastructure/bootstrap/README.md` ("Verify the boundary is
load-bearing") for the first time against real infrastructure, immediately after bootstrapping
both qualifiers. Steps taken, in order:

1. Confirmed `cdk-hnbdev-cfn-exec-role-*` carries `PermissionsBoundaryArn` ending in
   `policy/cdk-dev-permissions-boundary` (`aws iam get-role`).
2. Confirmed the boundary's policy document, fetched live, matches what
   `dev-permissions-boundary.test.ts` asserts: `DenyProdTaggedResources` is `Deny` / `*` / `*`
   with `StringEquals: {"aws:ResourceTag/env": "prod"}`.
3. Created an S3 bucket, tagged it `env=prod`.
4. Assumed the dev CFN execution role (temporarily widening its trust policy, per the README).
5. Control call: tagged a **different, untagged** bucket. Succeeded — proves the role holds
   `AdministratorAccess` and isn't failing for unrelated reasons.
6. Test call: called `s3:PutBucketTagging` again on the `env=prod` bucket. **Expected
   `AccessDenied`. Got success (`204`).**
7. Repeated the test call twice more, including after a 60-second wait for any tag-propagation
   delay, and re-verified the `env=prod` tag was still present each time. Same result: success.
8. Ran an unrelated, unconditional Deny in the *same* boundary policy
   (`DenyBoundaryEscape` → `iam:CreateUser`) as a sanity check. **This one denied correctly**,
   proving the boundary is attached and IAM is evaluating it for this role — the failure is
   specific to the tag-conditional statement, not the boundary as a whole.
9. Confirmed via CloudTrail (`lookup-events`) that all three `PutBucketTagging` calls by the
   assumed dev role returned `204`, never `AccessDenied`.
10. Confirmed against AWS's Service Authorization Reference that `s3:PutBucketTagging` does
    list `aws:ResourceTag/${TagKey}` as a supported condition key — so this is not a case of
    the action simply not supporting the key.
11. `aws iam simulate-principal-policy` agreed the call *should* be denied when the `env=prod`
    resource tag was supplied as explicit context (`--context-entries`) — but that tool does
    not fetch live resource tags automatically, and simulating without manually supplied
    context returned `allowed`, matched only by `AdministratorAccess`. The simulator was not
    useful here as an independent confirmation.

Cleaned up fully: probe and control buckets deleted, the widened trust policy restored to
`{"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"}`,
temporary local credential files removed.

### What is confirmed and what is not

Confirmed:
- The boundary is attached to the correct role.
- The boundary policy document is syntactically exactly what the design calls for.
- The boundary is being evaluated at all (the unconditional Deny fired).
- `s3:PutBucketTagging` supports the condition key used.

Not confirmed — this is the open question:
- **Why the tag-conditional Deny did not fire against a live call.** No root cause was
  identified. Candidates not yet ruled out: an S3-specific interaction between
  `aws:ResourceTag` evaluation and permissions boundaries specifically (as opposed to
  identity-based policies, where `aws:ResourceTag` is well-documented and commonly used); some
  form of evaluation caching or eventual consistency on the bucket-level tag-set longer than
  60 seconds; or a nuance of how S3 bucket (as opposed to object) tags are surfaced to the IAM
  authorization request for `PutBucketTagging` specifically.
- Whether this failure is S3-specific or would reproduce on other tag-taggable services
  (untested — the probe only exercises S3, per the README).

### Why this matters

This is not a documentation or process gap — `dev-permissions-boundary.test.ts` already states
plainly that it "cannot prove the denial happens" and that this probe is what "closes that
loop." The probe ran, and it showed the loop does not close, at least for this action. ADR-0001
and `infrastructure/bootstrap/README.md` both describe the boundary as the mechanism making it
safe to share one AWS account between dev and prod. If the tag-conditional Deny does not
actually deny, a dev deploy currently has an unbounded path to mutate a prod-tagged resource's
tags via at least this one action, and possibly others sharing the same condition-key pattern.

### What this does not affect

- The other boundary statements (`DenyBoundaryEscape`, `DenyCreatingUnboundedPrincipals`,
  `DenyBoundaryPolicyAlteration`) are all unconditional and were not tested here, but by the
  same logic that proved `DenyBoundaryEscape` fires, they are not suspect — only the
  tag-conditional statement is in question.
- Prod's own posture is unaffected — prod was never intended to be constrained by this
  boundary; its control is the GitHub Environment review gate (unchanged, unaffected by this).
- Nothing has been deployed into either qualifier yet (`docs/open-issues.md` issue 2 — no
  dev-scoped stacks exist), so no real dev workload has exercised this gap in practice.

### Suggested next steps (not yet done)

- Re-run the probe against a different action/resource type (e.g. an EC2 instance tag, a
  Secrets Manager secret tag) to determine whether this is S3-specific or systemic.
- Search AWS re:Post / known-issues for `aws:ResourceTag` + permissions boundary + S3 bucket
  tagging specifically, since object-tag conditions (`s3:ExistingObjectTag`) have documented
  quirks (see the "not supported for PUT/DELETE Object" note in
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/tagging-and-policies.html) that may
  have a bucket-tag analogue undocumented in the generic condition-key list.
- Consider whether resource-level ARN scoping (e.g. `Resource: "arn:aws:s3:::*"` instead of
  `Resource: "*"`) changes evaluation — the current statement's `Resource: "*"` combined with a
  tag condition is the exact pattern documented as fully supported, so this is a low-probability
  lead but untested.
- Until root-caused, treat the dev/prod account-sharing boundary as **advisory, not
  load-bearing**, for any action pattern not yet individually verified. The Phase 0 exit
  checklist item "the manual probe... shows the dev execution role denied" cannot be checked
  off as currently worded; either the probe needs to pass, or the checklist and ADR-0001 need
  to describe the residual risk explicitly.
