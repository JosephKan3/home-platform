/**
 * The Phase 0 §9 exit criterion: "a CI test proves `gha-deploy-dev` is denied an
 * action on an `env=prod` tagged resource."
 *
 * ## What this file can and cannot prove, stated plainly
 *
 * It CANNOT prove the denial happens. IAM evaluation happens in AWS, against
 * roles this repo does not create — the `cdk-*-cfn-exec-role-*` roles are
 * created by `cdk bootstrap`, from a template inside the CDK CLI. No offline
 * assertion can execute an IAM policy evaluation.
 *
 * A previous version of this suite was deleted because it asserted a denial that
 * would have occurred anyway: `gha-deploy-dev` holds no permissions except
 * `sts:AssumeRole`, so any API call it makes is denied by the absence of an
 * Allow, boundary attached or not. That test passed for the wrong reason and is
 * not reinstated here.
 *
 * What this file DOES prove is the set of load-bearing preconditions, each of
 * which silently breaks the mechanism if it regresses:
 *
 *   1. Dev and prod synthesize against different CFN execution roles. If they
 *      share one, no boundary can distinguish them and the mechanism is dead.
 *   2. The boundary policy has a fixed name. `cdk bootstrap
 *      --custom-permissions-boundary` takes a name and never verifies it exists;
 *      a generated name cannot be passed to a command that runs first.
 *   3. The Deny uses `StringEquals` on `aws:ResourceTag/env` with value `prod`.
 *      `StringLike`, a different key, or a `NotResource` would leave a policy
 *      that looks right and denies nothing.
 *   4. `gha-deploy-dev` cannot reach the prod qualifier's roles. If it could, it
 *      would route around the bounded execution role entirely.
 *
 * The remaining step — that the boundary is actually attached to the dev CFN
 * execution role — is asserted by `cdk bootstrap` itself and verified by the
 * manual live probe in infrastructure/bootstrap/README.md ("Verify the boundary
 * is load-bearing"). That probe, not this file, is what closes the loop.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { suppressNagRules } from "@platform/constructs";
import {
  BOOTSTRAP_QUALIFIERS,
  DEV_PERMISSIONS_BOUNDARY_NAME,
  bootstrapQualifierFor,
  managementSynthesizer,
  synthesizerFor,
} from "@platform/config";
import { GitHubOidcStack } from "../lib/github-oidc-stack.js";
import type { IStackSynthesizer } from "aws-cdk-lib";
import type { Env } from "@platform/config";

const ACCOUNT = "222222222222";
const REGION = "us-east-1";

interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action: string | string[];
  readonly Resource: string | string[];
  readonly Condition?: Record<string, Record<string, string>>;
}

/**
 * The CFN execution role ARN a stack in `env` would deploy through.
 *
 * Read off the synthesized cloud assembly rather than off the synthesizer
 * object, because the assembly manifest is the artifact the CDK CLI actually
 * reads to decide which role to hand CloudFormation. Asserting the same value
 * from a different source would not prove the deploy uses it.
 */
function cfnExecRoleArn(env: Env): string {
  const app = new App();
  probeStack(app, "Probe", ACCOUNT, synthesizerFor(env));
  const arn = app.synth().getStackByName("Probe").cloudFormationExecutionRoleArn;
  expect(arn).toBeDefined();
  return arn as string;
}

/**
 * An empty stack exists only to read the role ARNs the synthesizer resolves,
 * so its lack of resources is expected rather than a finding.
 */
function probeStack(app: App, id: string, account: string, synthesizer: IStackSynthesizer): Stack {
  const stack = new Stack(app, id, {
    env: { account, region: REGION },
    synthesizer,
  });
  suppressNagRules(stack, [
    {
      id: "CloudFormation-Validate::F0001",
      reason:
        "This stack exists only to read the bootstrap role ARNs the synthesizer " +
        "resolves for an environment (ADR-0001). It deliberately declares no " +
        "resources; it is never deployed.",
    },
  ]);
  return stack;
}

function boundaryStatements(): PolicyStatement[] {
  const app = new App();
  const stack = new GitHubOidcStack(app, "BoundaryStack", {
    env: { account: ACCOUNT, region: REGION },
  });
  const policies = Template.fromStack(stack).findResources("AWS::IAM::ManagedPolicy", {
    Properties: { ManagedPolicyName: DEV_PERMISSIONS_BOUNDARY_NAME },
  });
  const entries = Object.values(policies);
  expect(entries).toHaveLength(1);
  const props = (entries[0] as { Properties: Record<string, unknown> }).Properties;
  return (props["PolicyDocument"] as { Statement: PolicyStatement[] }).Statement;
}

describe("dev and prod resolve to different CDK execution roles", () => {
  test("the dev CFN execution role ARN differs from prod's", () => {
    const dev = cfnExecRoleArn("dev");
    const prod = cfnExecRoleArn("prod");

    expect(dev).not.toEqual(prod);
    expect(dev).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.dev}-cfn-exec-role-`);
    expect(prod).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.prod}-cfn-exec-role-`);
  });

  test("neither uses the CDK default qualifier", () => {
    // hnb659fds is the qualifier a plain `cdk bootstrap` creates. Falling back
    // to it would mean both environments share one unbounded execution role
    // while every command in the README still appears to work.
    for (const env of ["dev", "prod"] as const) {
      expect(cfnExecRoleArn(env)).not.toContain("hnb659fds");
    }
  });

  test("the management account uses a third, separate qualifier", () => {
    const app = new App();
    probeStack(app, "MgmtProbe", "111111111111", managementSynthesizer());
    const arn = app.synth().getStackByName("MgmtProbe").cloudFormationExecutionRoleArn ?? "";

    expect(arn).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.management}-cfn-exec-role-`);
    expect(arn).not.toContain(BOOTSTRAP_QUALIFIERS.dev);
    expect(arn).not.toContain(BOOTSTRAP_QUALIFIERS.prod);
  });

  test("every qualifier fits the bootstrap template's 10-character limit", () => {
    for (const qualifier of Object.values(BOOTSTRAP_QUALIFIERS)) {
      expect(qualifier).toMatch(/^[A-Za-z0-9_-]{1,10}$/);
    }
  });

  test("an invalid qualifier fails at synth rather than at bootstrap", () => {
    expect(() => bootstrapQualifierFor("nope" as Env)).toThrow();
  });
});

describe("the boundary policy is referencable by cdk bootstrap", () => {
  test("carries the exact name the bootstrap command passes", () => {
    // --custom-permissions-boundary takes a NAME and the CLI does not check the
    // policy exists; it only regex-validates the string. A generated name would
    // produce a bootstrap that succeeds and a cfn-exec-role that fails to create.
    expect(DEV_PERMISSIONS_BOUNDARY_NAME).toBe("cdk-dev-permissions-boundary");

    const app = new App();
    const stack = new GitHubOidcStack(app, "NameStack", {
      env: { account: ACCOUNT, region: REGION },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: DEV_PERMISSIONS_BOUNDARY_NAME,
    });
  });

  test("does not collide with the name cdk bootstrap generates itself", () => {
    // `--example-permissions-boundary` creates cdk-<qualifier>-permissions-boundary.
    // Reusing that name would let the CLI adopt or overwrite this policy.
    expect(DEV_PERMISSIONS_BOUNDARY_NAME).not.toBe(
      `cdk-${BOOTSTRAP_QUALIFIERS.dev}-permissions-boundary`,
    );
  });
});

describe("the boundary's env=prod Deny is written correctly", () => {
  const statements = boundaryStatements();
  const deny = statements.find((statement) => statement.Sid === "DenyProdTaggedResources");

  test("exists", () => {
    expect(deny).toBeDefined();
  });

  test("uses the StringEquals operator, not StringLike", () => {
    // StringLike with the literal value "prod" behaves identically until someone
    // adds a wildcard; more importantly StringNotEquals here would invert the
    // control while still reading as a Deny on env.
    expect(Object.keys(deny?.Condition ?? {})).toEqual(["StringEquals"]);
  });

  test("keys on aws:ResourceTag/env with the value prod", () => {
    expect(deny?.Condition?.["StringEquals"]).toEqual({ "aws:ResourceTag/env": "prod" });
  });

  test("denies every action on every resource, so no service is exempt", () => {
    expect(deny?.Effect).toBe("Deny");
    expect(deny?.Action).toBe("*");
    expect(deny?.Resource).toBe("*");
  });

  test("the ceiling Allow is unrestricted, since a boundary caps rather than grants", () => {
    const allow = statements.find((statement) => statement.Sid === "AllowAllAsBoundaryCeiling");
    expect(allow?.Effect).toBe("Allow");
    expect(allow?.Action).toBe("*");
    expect(allow?.Resource).toBe("*");
    expect(allow?.Condition).toBeUndefined();
  });

  test("the boundary cannot be detached or rewritten by a role that carries it", () => {
    // A boundary a principal can remove from itself is not a boundary. This is
    // the difference between a control and a comment.
    const escape = statements.find((statement) => statement.Sid === "DenyBoundaryEscape");
    expect(escape?.Effect).toBe("Deny");
    for (const action of [
      "iam:DeleteRolePermissionsBoundary",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteUserPermissionsBoundary",
      "iam:PutUserPermissionsBoundary",
      "iam:CreateUser",
      "iam:CreateAccessKey",
    ]) {
      expect(escape?.Action).toContain(action);
    }

    const alteration = statements.find(
      (statement) => statement.Sid === "DenyBoundaryPolicyAlteration",
    );
    expect(alteration?.Effect).toBe("Deny");
    for (const action of [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicy",
    ]) {
      expect(alteration?.Action).toContain(action);
    }
    expect(JSON.stringify(alteration?.Resource)).toContain(DEV_PERMISSIONS_BOUNDARY_NAME);
  });

  test("a new role created under the boundary must itself carry the boundary", () => {
    const statement = statements.find(
      (entry) => entry.Sid === "DenyCreatingUnboundedPrincipals",
    );
    expect(statement?.Effect).toBe("Deny");
    expect(statement?.Action).toContain("iam:CreateRole");
    expect(Object.keys(statement?.Condition ?? {})).toEqual(["StringNotEquals"]);
    expect(
      JSON.stringify(statement?.Condition?.["StringNotEquals"]?.["iam:PermissionsBoundary"]),
    ).toContain(DEV_PERMISSIONS_BOUNDARY_NAME);
  });
});

describe("gha-deploy-dev cannot route around the bounded execution role", () => {
  const template = Template.fromStack(
    new GitHubOidcStack(new App(), "ScopeStack", {
      env: { account: ACCOUNT, region: REGION },
    }),
  );

  function assumableRoles(logicalIdPrefix: string): string {
    const policies = template.findResources("AWS::IAM::Policy");
    const match = Object.entries(policies).find(([logicalId]) =>
      logicalId.startsWith(`${logicalIdPrefix}DefaultPolicy`),
    );
    expect(match).toBeDefined();
    const props = (match as [string, { Properties: Record<string, unknown> }])[1].Properties;
    return JSON.stringify(props["PolicyDocument"]);
  }

  test("the dev role may assume only the dev qualifier's bootstrap roles", () => {
    const rendered = assumableRoles("GhaDeployDevRole");
    expect(rendered).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.dev}-deploy-role-`);
    // The whole mechanism rests on this: the prod qualifier's cfn-exec-role has
    // no boundary, so reaching its deploy role is a complete bypass.
    expect(rendered).not.toContain(BOOTSTRAP_QUALIFIERS.prod);
    expect(rendered).not.toContain("cdk-*-");
  });

  test("the prod role may assume only the prod qualifier's bootstrap roles", () => {
    const rendered = assumableRoles("GhaDeployProdRole");
    expect(rendered).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.prod}-deploy-role-`);
    expect(rendered).not.toContain(BOOTSTRAP_QUALIFIERS.dev);
    expect(rendered).not.toContain("cdk-*-");
  });

  test("no GitHub role can reach the management account's qualifier", () => {
    // Management holds the organization and the SCPs. Nothing in CI deploys
    // there (docs/open-issues.md issue 3), and the roles do not exist anyway.
    for (const prefix of ["GhaDeployDevRole", "GhaDeployProdRole", "GhaPlanRole"]) {
      expect(assumableRoles(prefix)).not.toContain(BOOTSTRAP_QUALIFIERS.management);
    }
  });

  test("the plan role gets both lookup roles and no deploy or publishing role", () => {
    const rendered = assumableRoles("GhaPlanRole");
    expect(rendered).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.dev}-lookup-role-`);
    expect(rendered).toContain(`cdk-${BOOTSTRAP_QUALIFIERS.prod}-lookup-role-`);
    expect(rendered).not.toContain("deploy-role");
    expect(rendered).not.toContain("publishing-role");
  });
});
