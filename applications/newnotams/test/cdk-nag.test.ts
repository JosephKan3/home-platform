/**
 * Proves the policy-as-code layer is actually wired in (ADR-0007). Same
 * discipline as personal-site/test/cdk-nag.test.ts — see its header comment.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { CLOUDFRONT_CERT_REGION, synthesizerFor } from "@platform/config";
import { NewNotamsStack } from "../lib/newnotams-stack.js";
import type { PolicyViolation } from "aws-cdk-lib";

const ENV = { account: "222222222222", region: CLOUDFRONT_CERT_REGION };

/**
 * Warnings cdk-nag still reports, and which the stack has consciously left
 * in place. Empty, like personal-site/test/cdk-nag.test.ts's identical
 * list: CFR1/CFR2 are explicitly suppressed via `suppressNagRules` in
 * NewNotamsStack.suppressDistributionFindings (with a reason citing the
 * threat-model/cost judgement, per ADR-0007), which removes them from
 * `validateScope`'s violations report entirely — "acknowledged" in
 * cdk-nag's own terminology means gone from this list, not present in it
 * as an accepted entry.
 */
const ACCEPTED_WARNINGS: string[] = [];

function violations(): PolicyViolation[] {
  const app = new App();
  new NewNotamsStack(app, "NagNewNotamsStack", {
    env: ENV,
    // Must match bin/app.ts — see personal-site/test/cdk-nag.test.ts's
    // identical comment on why the synthesizer choice changes granular
    // IAM5 finding IDs.
    synthesizer: synthesizerFor("prod"),
    envName: "prod",
    usePlaceholderSource: true,
  });

  return new AwsSolutionsChecks(app, { verbose: true }).validateScope(app).violations;
}

const reported = violations();

describe("cdk-nag AwsSolutionsChecks", () => {
  test("reports zero unsuppressed errors", () => {
    const errors = reported
      .filter((violation) => violation.severity === "error")
      .map((violation) => `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath}`);

    expect(errors).toEqual([]);
  });

  test("reports no unacknowledged warnings either", () => {
    const warnings = reported
      .filter((violation) => violation.severity === "warning")
      .map((violation) => violation.ruleName);

    expect(warnings.sort()).toEqual([...ACCEPTED_WARNINGS].sort());
  });

  test("the pack actually runs — an unsuppressed violation is still caught", () => {
    const app = new App();
    const stack = new Stack(app, "Dirty", { env: ENV });
    new Bucket(stack, "Bare");

    const report = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app);
    expect(report.success).toBe(false);
    expect(report.violations.map((violation) => violation.ruleName)).toContain("AwsSolutions-S1");
  });
});
