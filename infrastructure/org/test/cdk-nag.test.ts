/**
 * ADR-0007. The one suppression in this stack is AwsSolutions-S1 on the access
 * log bucket, and the assertion that matters is that it is attached to that
 * bucket alone: an S1 acknowledgment at stack scope would also silence the
 * organization trail bucket, which is the audit destination this whole stack
 * exists to create.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { GovernanceStack } from "../lib/governance-stack.js";
import type { IConstruct } from "constructs";

const ACKNOWLEDGED_RULES = Validations.ACKNOWLEDGED_RULES_METADATA_KEY;

function build(): { app: App; stack: GovernanceStack } {
  const app = new App();
  const stack = new GovernanceStack(app, "NagGovernanceStack", {
    env: { account: "111111111111", region: "us-east-1" },
    workloadsOuId: "ou-abcd-11111111",
    sandboxOuId: "ou-abcd-22222222",
    alertEmail: "alerts@example.com",
    organizationId: "o-abcdefghij",
    budgetAccountId: "222222222222",
  });
  return { app, stack };
}

/**
 * cdk-nag suppressions attached directly to a construct, ignoring its children.
 *
 * Filtered to `AwsSolutions-*` because aws-cdk-lib records acknowledgments of
 * its own deprecation warnings through the same metadata key — the log bucket
 * picks one up from `objectOwnership` — and those are not policy suppressions.
 */
function acknowledgedRules(scope: IConstruct): Array<[string, string]> {
  return scope.node.metadata
    .filter((entry) => entry.type === ACKNOWLEDGED_RULES)
    .flatMap((entry) => Object.entries(entry.data as Record<string, string>))
    .filter(([id]) => id.startsWith("AwsSolutions-"));
}

describe("cdk-nag AwsSolutionsChecks", () => {
  test("reports zero unsuppressed findings of any severity", () => {
    const { app } = build();
    const result = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app);

    expect(result.violations.map((violation) => violation.ruleName)).toEqual([]);
    expect(result.success).toBe(true);
  });

  test("the S1 suppression is on the access log bucket, never the trail bucket", () => {
    const { stack } = build();

    expect(acknowledgedRules(stack.trailAccessLogBucket).map(([id]) => id)).toEqual([
      "AwsSolutions-S1",
    ]);
    expect(acknowledgedRules(stack.trailBucket)).toEqual([]);
    expect(acknowledgedRules(stack)).toEqual([]);
  });

  test("the suppression reason cites an ADR or a cost figure (ADR-0007)", () => {
    const { stack } = build();
    const reasons = acknowledgedRules(stack.trailAccessLogBucket).map(([, reason]) => reason);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/ADR-\d{4}|\$\d/);
  });
});
