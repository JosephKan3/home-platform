# Open Issues

Problems found while building Phase 0 that are not yet resolved. Each names the blocking
work and whether it gates the Phase 0 exit criteria.

---

## 1. The dev permissions boundary does not actually constrain `cdk deploy`

**Severity: high. Gates a Phase 0 exit criterion.**

ADR-0001 leans on a permissions boundary as the mechanism that makes sharing one account
between dev and prod survivable. `infrastructure/bootstrap` creates that boundary and
attaches it to `gha-deploy-dev`, denying any action where `aws:ResourceTag/env = prod`.

It does not work as intended, for two compounding reasons:

1. **`gha-deploy-dev` holds no direct AWS permissions.** Its only statement is
   `sts:AssumeRole` on the `cdk-*` bootstrap roles. So the boundary caps a role that has
   nothing to cap.
2. **A permissions boundary does not follow a role chain.** The actual mutations happen
   inside `cdk-<qualifier>-deploy-role-<account>-<region>`, which is a separate role with
   its own (broad) policy and no boundary. Nothing dev CI does is constrained by it.

Additionally, `aws:ResourceTag` only evaluates on API calls against resources that
*already* carry the tag. It cannot prevent creating untagged resources, and it does not
apply during creation. `RequiredTagsAspect` closes that at synth time, but synth-time
enforcement is bypassed by anyone calling the AWS API directly.

**The Phase 0 exit criterion "a CI test proves `gha-deploy-dev` is denied an action on an
`env=prod` tagged resource" is therefore not currently satisfiable in a meaningful way.**
A test asserting the denial would pass for the wrong reason — proving the absence of an
Allow, not the presence of a boundary.

**Fix:** re-bootstrap with a custom permissions boundary so the CDK execution role itself
carries it:

```
cdk bootstrap --custom-permissions-boundary dev-boundary
```

This requires a separate bootstrap qualifier per environment (`--qualifier dev` /
`--qualifier prod`) so the two get different execution roles, and corresponding changes to
`infrastructure/bootstrap` to grant each GitHub role only its own qualifier's roles.

**Until then:** treat dev and prod separation as convention, not control, and say so
plainly rather than claiming a boundary that isn't load-bearing. Do not let the design doc
overstate it.

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

**Decide in Phase 1**, alongside issue 1, since the boundary fix and the first real dev
stack should land together.

---

## 3. `GovernanceStack` cannot be deployed by CI

**Severity: low. Working as designed, but the plan didn't say so.**

`infrastructure/org` targets the management account. `infrastructure/bootstrap` creates
GitHub OIDC roles only in the Platform account — correctly, because ADR-0001 says nothing
runs in management and SCPs do not apply there anyway.

Consequence: the governance stack must be deployed by hand via SSO admin. The
`deploy-prod` job contains the step with an explicit `exit 1` and an explanation rather
than silently skipping it.

This is the right tradeoff — creating a deploy role in the management account would
undermine the reason management is kept empty — but the Phase 0 action plan §6 implies it
is CI-deployed. **The action plan is wrong on this point; this file is correct.**

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

## 7. Next.js 12 is past end of life

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
