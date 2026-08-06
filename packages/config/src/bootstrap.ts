/**
 * CDK bootstrap qualifiers — the single place they are defined.
 *
 * ## Why per-environment qualifiers exist
 *
 * ADR-0001 puts dev and prod in one account and leans on an IAM permissions
 * boundary to make that survivable. A boundary caps a *principal*, and it does
 * not follow a role chain: capping `gha-deploy-dev` constrains nothing, because
 * every mutation a `cdk deploy` performs is executed by CloudFormation under
 * `cdk-<qualifier>-cfn-exec-role-<account>-<region>`, a different role.
 *
 * `cdk bootstrap --custom-permissions-boundary <name>` attaches a boundary to
 * exactly that CFN execution role (bootstrap template v32, `PermissionsBoundary`
 * on the `CloudFormationExecutionRole` resource — and on nothing else). One
 * bootstrap per account therefore cannot give dev and prod different ceilings.
 * Two qualifiers give two independent sets of bootstrap roles in the same
 * account, and only the dev set carries the boundary.
 *
 * ## The 10-character limit
 *
 * The bootstrap template constrains `Qualifier` to `[A-Za-z0-9_-]{1,10}`,
 * because `cdk-<qualifier>-image-publishing-role-<account>-<region>` must stay
 * within the 64-character IAM role name limit. Every qualifier here is checked
 * against that at module load rather than discovered at bootstrap time.
 *
 * ## The qualifier must match on both sides
 *
 * The value passed to `cdk bootstrap --qualifier` and the value a stack
 * synthesizes with must be identical. They are not validated against each other
 * anywhere: a mismatch surfaces as an `AssumeRole` failure naming a role that
 * was never created. That is why stacks derive theirs from the environment
 * profile via `synthesizerFor()` instead of hardcoding a string per app.
 */

import { DefaultStackSynthesizer } from "aws-cdk-lib";
import type { Env } from "./environments.js";
import { profileFor } from "./environments.js";

/** Bootstrap template constraint: `cdk-<q>-image-publishing-role-<12>-<region>` must fit in 64 chars. */
const QUALIFIER_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

/**
 * Qualifier for the management account (ADR-0001 root).
 *
 * Management is a *different account*, bootstrapped separately, and holds no
 * workloads — so it has no dev/prod split and no permissions boundary. It gets
 * its own named qualifier rather than the CDK default so that a stack targeting
 * management can never silently synthesize against the Platform account's dev
 * or prod bootstrap roles.
 */
export const MANAGEMENT_BOOTSTRAP_QUALIFIER = "hnbmgmt";

/**
 * Name of the managed policy attached as the permissions boundary to the dev
 * CFN execution role.
 *
 * `cdk bootstrap --custom-permissions-boundary` takes a *name*, not an ARN, and
 * resolves it to `arn:<partition>:iam::<account>:policy/<name>` inside the
 * bootstrap template. The CLI does not check that the policy exists (it only
 * regex-validates the name), so the policy must be created before bootstrap or
 * the CFN execution role fails to create. The name is therefore fixed here and
 * must not be a CDK-generated one.
 *
 * Deliberately not `cdk-<qualifier>-permissions-boundary`: that is the name the
 * CLI reserves for the policy it generates under `--example-permissions-boundary`,
 * and colliding with it would make `cdk bootstrap` adopt or overwrite ours.
 */
export const DEV_PERMISSIONS_BOUNDARY_NAME = "cdk-dev-permissions-boundary";

function assertValidQualifier(qualifier: string, source: string): string {
  if (!QUALIFIER_PATTERN.test(qualifier)) {
    throw new Error(
      `Invalid CDK bootstrap qualifier "${qualifier}" (${source}). The bootstrap ` +
        "template allows at most 10 characters of [A-Za-z0-9_-], because " +
        "cdk-<qualifier>-image-publishing-role-<account>-<region> must fit in the " +
        "64-character IAM role name limit.",
    );
  }
  return qualifier;
}

/** The bootstrap qualifier a stack in `env` deploys through. */
export function bootstrapQualifierFor(env: Env): string {
  return assertValidQualifier(profileFor(env).bootstrapQualifier, `profiles.${env}`);
}

/** Every qualifier this repo bootstraps, for docs and tests to enumerate. */
export const BOOTSTRAP_QUALIFIERS = {
  dev: bootstrapQualifierFor("dev"),
  prod: bootstrapQualifierFor("prod"),
  management: assertValidQualifier(MANAGEMENT_BOOTSTRAP_QUALIFIER, "MANAGEMENT_BOOTSTRAP_QUALIFIER"),
} as const;

/**
 * Synthesizer pinned to an environment's bootstrap qualifier.
 *
 * Every CDK app in this repo passes one of these rather than relying on the
 * `@aws-cdk/core:bootstrapQualifier` context key. Context is set per app in
 * `cdk.json` and would have to be duplicated and kept in sync in four files; a
 * stack that acquires a different `env` later would keep the old qualifier
 * silently. Deriving it from the environment profile makes the two move
 * together.
 */
export function synthesizerFor(env: Env): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: bootstrapQualifierFor(env) });
}

/**
 * Synthesizer for the management account.
 *
 * Separate from `synthesizerFor` on purpose: management has no `Env`, and
 * defaulting it to prod would point `infrastructure/org` at the Platform
 * account's prod bootstrap roles, which do not exist in management.
 */
export function managementSynthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: BOOTSTRAP_QUALIFIERS.management });
}
