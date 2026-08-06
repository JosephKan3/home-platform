/**
 * ADR-0007. See applications/personal-site/test/cdk-nag.test.ts for why this
 * uses `validateScope` rather than `Annotations.fromStack(...).findError()`:
 * cdk-nag 3.x is a validation plugin, not an Aspect, so it writes a report
 * instead of node annotations.
 *
 * This stack is where the suppressions carry the most weight — it is the only
 * one holding IAM roles GitHub can assume — so the accepted rule IDs are listed
 * explicitly rather than merely counted.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { GitHubOidcStack } from "../lib/github-oidc-stack.js";
import type { IConstruct } from "constructs";

function report(): { success: boolean; ruleNames: string[] } {
  const app = new App();
  new GitHubOidcStack(app, "NagBootstrapStack", {
    env: { account: "222222222222", region: "us-east-1" },
  });

  const result = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app);
  return {
    success: result.success,
    ruleNames: result.violations.map((violation) => violation.ruleName),
  };
}

describe("cdk-nag AwsSolutionsChecks", () => {
  test("reports zero unsuppressed findings of any severity", () => {
    const { success, ruleNames } = report();
    expect(ruleNames).toEqual([]);
    expect(success).toBe(true);
  });

  test("no suppression is attached at stack scope", () => {
    // A stack-level acknowledgment would silence the rule for every resource
    // added to this stack from now on, including ones nobody has reviewed.
    const app = new App();
    const stack = new GitHubOidcStack(app, "ScopeCheckStack", {
      env: { account: "222222222222", region: "us-east-1" },
    });

    expect(acknowledgedRules(stack)).toEqual([]);
  });

  test("the ReadOnlyAccess suppression is attached to the plan role only", () => {
    // A deploy role that quietly acquired an AWS managed policy must still
    // fail, so IAM4 is deliberately not acknowledged anywhere but on gha-plan.
    const app = new App();
    const stack = new GitHubOidcStack(app, "Iam4ScopeStack", {
      env: { account: "222222222222", region: "us-east-1" },
    });

    const iam4 = (scope: IConstruct): string[] =>
      acknowledgedRules(scope)
        .map(([id]) => id)
        .filter((id) => id.startsWith("AwsSolutions-IAM4"));

    expect(iam4(stack.planRole)).toHaveLength(1);
    expect(iam4(stack.deployDevRole)).toEqual([]);
    expect(iam4(stack.deployProdRole)).toEqual([]);
  });

  test("every suppression cites an ADR or a dollar figure (ADR-0007)", () => {
    const app = new App();
    const stack = new GitHubOidcStack(app, "ReasonCheckStack", {
      env: { account: "222222222222", region: "us-east-1" },
    });

    const reasons = stack.node.findAll().flatMap((node) => acknowledgedRules(node));

    expect(reasons.length).toBeGreaterThan(0);
    for (const [, reason] of reasons) {
      expect(reason).toMatch(/ADR-\d{4}|\$\d/);
    }
  });
});

const ACKNOWLEDGED_RULES = Validations.ACKNOWLEDGED_RULES_METADATA_KEY;

/**
 * cdk-nag suppressions attached directly to a construct, ignoring its children.
 *
 * Filtered to `AwsSolutions-*` because aws-cdk-lib records acknowledgments of
 * its own deprecation warnings through the same metadata key, and those are not
 * policy suppressions.
 */
function acknowledgedRules(scope: IConstruct): Array<[string, string]> {
  return scope.node.metadata
    .filter((entry) => entry.type === ACKNOWLEDGED_RULES)
    .flatMap((entry) => Object.entries(entry.data as Record<string, string>))
    .filter(([id]) => id.startsWith("AwsSolutions-"));
}
