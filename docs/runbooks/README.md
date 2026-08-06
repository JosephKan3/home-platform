# Runbooks

Procedures for the moments when reading the code is too slow.

A runbook is for a situation where someone is under time pressure and possibly tired. It is
not documentation of how a system works — that belongs in the package README next to the
code. A runbook answers "what do I type, in what order, and how do I know it worked."

## Index

| Runbook | When to open it |
| --- | --- |
| [`dns-rollback.md`](dns-rollback.md) | `josephkan.ca` is broken or serving the wrong thing. Fastest path back. |
| [`break-glass.md`](break-glass.md) | CI cannot deploy, or an SCP has locked you out. |
| [`teardown-phase-0.md`](teardown-phase-0.md) | Deliberately destroying what Phase 0 built. Not an emergency. |

## Related, not duplicated here

| Document | Holds |
| --- | --- |
| [`infrastructure/dns/README.md`](../../infrastructure/dns/README.md) | The full Stage D / Stage G DNS procedure, with verification at each step. `dns-rollback.md` references it rather than repeating it. |
| [`infrastructure/bootstrap/README.md`](../../infrastructure/bootstrap/README.md) | The three OIDC roles, their trust conditions, and how to deploy the stack by hand. |
| [`infrastructure/org/README.md`](../../infrastructure/org/README.md) | SCP contents, the region-lock exemption list, and how to brick an account with it. |
| [`docs/phase-0-action-plan.md`](../phase-0-action-plan.md) | The build order and the §10 gotcha table. |

## When to write a new one

Write a runbook when **all three** are true:

1. The procedure is needed under time pressure, or rarely enough to have been forgotten.
2. Getting the order wrong makes things worse, not just slower.
3. The commands are not obvious from the code.

If only (3) is true it is a README section. If none are, it is a comment in the code.

## What a runbook must contain

- **The symptom** that sends someone here, stated as they would observe it.
- **Real commands**, copy-pasteable, with the profile and region already in them.
- **A verification step** after every action that changes state.
- **The rollback**, or an explicit statement that there isn't one.
- **Ordering constraints** stated as constraints, with the failure they prevent.

Prefer a short precise procedure over a long vague one. If a step needs a paragraph of
justification, the justification goes in a note under the step, not in front of it.
