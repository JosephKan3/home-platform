/**
 * The trust-policy tests here are the point of this file. A wildcard `sub`
 * claim is the single highest-impact misconfiguration available in this stack,
 * and it is invisible in a code review diff once written.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GitHubOidcStack } from "../lib/github-oidc-stack.js";

const ISSUER = "token.actions.githubusercontent.com";

function synth(): Template {
  const app = new App();
  const stack = new GitHubOidcStack(app, "TestBootstrapStack", {
    env: { account: "222222222222", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

/** The trust policy as rendered into the template, for a role by its roleName. */
function trustPolicy(template: Template, roleName: string): Record<string, unknown> {
  const roles = template.findResources("AWS::IAM::Role", {
    Properties: { RoleName: roleName },
  });
  const entries = Object.values(roles);
  expect(entries).toHaveLength(1);
  return (entries[0] as { Properties: Record<string, unknown> }).Properties;
}

/** The inline default policy document attached to a role, by logical ID prefix. */
function policyForRole(
  template: Template,
  logicalIdPrefix: string,
): { Statement: Array<Record<string, unknown>> } {
  const policies = template.findResources("AWS::IAM::Policy");
  const match = Object.entries(policies).find(([logicalId]) =>
    logicalId.startsWith(`${logicalIdPrefix}DefaultPolicy`),
  );
  expect(match).toBeDefined();
  const props = (match as [string, { Properties: Record<string, unknown> }])[1].Properties;
  return props["PolicyDocument"] as { Statement: Array<Record<string, unknown>> };
}

describe("GitHubOidcStack", () => {
  const template = synth();

  test("creates the GitHub OIDC provider with the correct URL and audience", () => {
    template.hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  test("does not pin a thumbprint (AWS manages it)", () => {
    const providers = template.findResources("Custom::AWSCDKOpenIdConnectProvider");
    for (const provider of Object.values(providers)) {
      const props = (provider as { Properties: Record<string, unknown> }).Properties;
      expect(props["ThumbprintList"]).toBeUndefined();
    }
  });

  test("creates exactly the three GitHub Actions roles", () => {
    for (const roleName of ["gha-plan", "gha-deploy-dev", "gha-deploy-prod"]) {
      trustPolicy(template, roleName);
    }
  });

  describe.each([
    ["gha-plan", `repo:JosephKan3/home-platform:pull_request`],
    ["gha-deploy-dev", `repo:JosephKan3/home-platform:environment:dev`],
    ["gha-deploy-prod", `repo:JosephKan3/home-platform:environment:prod`],
  ])("%s trust policy", (roleName, expectedSub) => {
    const props = trustPolicy(template, roleName);
    const doc = props["AssumeRolePolicyDocument"] as {
      Statement: Array<Record<string, unknown>>;
    };
    const statement = doc.Statement[0] as Record<string, unknown>;
    const condition = statement["Condition"] as Record<string, unknown>;

    test("uses StringEquals and not StringLike", () => {
      expect(Object.keys(condition)).toEqual(["StringEquals"]);
      expect(condition["StringLike"]).toBeUndefined();
    });

    test("pins the audience and the exact sub claim", () => {
      expect(condition["StringEquals"]).toEqual({
        [`${ISSUER}:aud`]: "sts.amazonaws.com",
        [`${ISSUER}:sub`]: expectedSub,
      });
    });

    test("is a web identity assume-role against the GitHub provider", () => {
      expect(statement["Action"]).toBe("sts:AssumeRoleWithWebIdentity");
    });
  });

  test("no StringLike condition appears in any trust policy", () => {
    const roles = template.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const [logicalId, role] of Object.entries(roles)) {
      const doc = (role as { Properties: Record<string, unknown> }).Properties[
        "AssumeRolePolicyDocument"
      ];
      expect(`${logicalId}:${JSON.stringify(doc)}`).not.toContain("StringLike");
    }
  });

  test("the dev role carries a permissions boundary and the prod role does not", () => {
    expect(trustPolicy(template, "gha-deploy-dev")["PermissionsBoundary"]).toBeDefined();
    expect(trustPolicy(template, "gha-deploy-prod")["PermissionsBoundary"]).toBeUndefined();
    expect(trustPolicy(template, "gha-plan")["PermissionsBoundary"]).toBeUndefined();
  });

  test("the boundary denies every action on env=prod tagged resources", () => {
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "gha-deploy-dev-boundary",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "*",
            Resource: "*",
            Condition: { StringEquals: { "aws:ResourceTag/env": "prod" } },
          }),
        ]),
      },
    });
  });

  test("the boundary denies the actions that would let a role escape it", () => {
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "gha-deploy-dev-boundary",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: Match.arrayWith([
              "iam:CreateUser",
              "iam:CreateAccessKey",
              "iam:DeleteUserPermissionsBoundary",
              "iam:PutUserPermissionsBoundary",
              "iam:DeleteRolePermissionsBoundary",
              "iam:PutRolePermissionsBoundary",
            ]),
          }),
        ]),
      },
    });
  });

  test("the boundary allows everything as its ceiling", () => {
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "gha-deploy-dev-boundary",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Allow", Action: "*", Resource: "*" }),
        ]),
      },
    });
  });

  test("deploy roles get power by assuming CDK bootstrap roles, not directly", () => {
    for (const roleLogicalIdPrefix of ["GhaDeployDevRole", "GhaDeployProdRole"]) {
      const policy = policyForRole(template, roleLogicalIdPrefix);
      const statement = policy.Statement[0] as Record<string, unknown>;
      expect(statement["Action"]).toBe("sts:AssumeRole");
      expect(statement["Effect"]).toBe("Allow");
      const rendered = JSON.stringify(statement["Resource"]);
      for (const suffix of [
        "deploy-role",
        "file-publishing-role",
        "image-publishing-role",
        "lookup-role",
      ]) {
        expect(rendered).toContain(`:role/cdk-*-${suffix}-*`);
      }
      // Nothing but sts:AssumeRole. The power lives in the bootstrap roles.
      expect(policy.Statement).toHaveLength(1);
    }
  });

  test("the plan role is read-only and may assume only the CDK lookup role", () => {
    const props = trustPolicy(template, "gha-plan");
    expect(JSON.stringify(props["ManagedPolicyArns"])).toContain("ReadOnlyAccess");

    const policy = policyForRole(template, "GhaPlanRole");
    expect(policy.Statement).toHaveLength(1);
    const statement = policy.Statement[0] as Record<string, unknown>;
    expect(statement["Action"]).toBe("sts:AssumeRole");
    const rendered = JSON.stringify(statement["Resource"]);
    expect(rendered).toContain(":role/cdk-*-lookup-role-*");
    expect(rendered).not.toContain("deploy-role");
    expect(rendered).not.toContain("publishing-role");
  });

  test("outputs all three role ARNs", () => {
    const outputs = template.findOutputs("*");
    for (const name of ["PlanRoleArn", "DeployDevRoleArn", "DeployProdRoleArn"]) {
      expect(outputs[name]).toBeDefined();
    }
  });

  test("can reference an OIDC provider that already exists in the account", () => {
    const app = new App();
    const stack = new GitHubOidcStack(app, "ImportedProviderStack", {
      env: { account: "222222222222", region: "us-east-1" },
      existingOidcProviderArn:
        "arn:aws:iam::222222222222:oidc-provider/token.actions.githubusercontent.com",
    });
    const imported = Template.fromStack(stack);
    expect(Object.keys(imported.findResources("Custom::AWSCDKOpenIdConnectProvider"))).toHaveLength(
      0,
    );
    const doc = trustPolicy(imported, "gha-deploy-prod")["AssumeRolePolicyDocument"] as {
      Statement: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(doc.Statement[0]?.["Principal"])).toContain(
      "oidc-provider/token.actions.githubusercontent.com",
    );
  });

  test("uses the configured GitHub owner and repo in every sub claim", () => {
    const app = new App();
    const stack = new GitHubOidcStack(app, "CustomRepoStack", {
      env: { account: "222222222222", region: "us-east-1" },
      githubOwner: "SomeOrg",
      githubRepo: "other-repo",
    });
    const custom = Template.fromStack(stack);
    const doc = trustPolicy(custom, "gha-deploy-dev")["AssumeRolePolicyDocument"] as {
      Statement: Array<Record<string, unknown>>;
    };
    const condition = doc.Statement[0]?.["Condition"] as Record<
      string,
      Record<string, string>
    >;
    expect(condition["StringEquals"]?.[`${ISSUER}:sub`]).toBe(
      "repo:SomeOrg/other-repo:environment:dev",
    );
  });
});
