/**
 * Proves the policy-as-code layer is actually wired in (ADR-0007).
 *
 * The value of this file is not that it re-runs cdk-nag — CI already does that
 * at synth. It is that a suppression added in six months to silence a real
 * problem has to be written down here as an accepted rule ID, next to the
 * count, rather than disappearing into a construct somewhere.
 *
 * cdk-nag 3.x is an `IPolicyValidationPlugin`, not an `IAspect`: it walks the
 * finalized construct tree once and returns a report, rather than writing
 * `Annotations` onto individual nodes. `Annotations.fromStack(...).findError()`
 * therefore finds nothing regardless of compliance, and asserting against it
 * would be a test that passes for the wrong reason. `validateScope` is the
 * documented entry point for direct invocation.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { CLOUDFRONT_CERT_REGION, synthesizerFor } from "@platform/config";
import { SiteStack } from "../lib/site-stack.js";
import type { PolicyViolation } from "aws-cdk-lib";

const ENV = { account: "222222222222", region: CLOUDFRONT_CERT_REGION };

/**
 * Warnings cdk-nag still reports, and which the stack has consciously left in
 * place. Errors are not listed because there must be none.
 */
const ACCEPTED_WARNINGS: string[] = [];

function violations(): PolicyViolation[] {
  const app = new App();
  new SiteStack(app, "NagSiteStack", {
    env: ENV,
    // The synthesizer must match bin/app.ts. Omitting it falls back to the
    // default hnb659fds qualifier, which changes the CDK asset bucket name and
    // therefore the granular IAM5 finding IDs the stack suppresses — the test
    // would then report findings that cannot occur in a real deploy.
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
    // Guards against the failure mode where the checks silently stop firing and
    // every assertion above starts passing vacuously.
    const app = new App();
    const stack = new Stack(app, "Dirty", { env: ENV });
    new Bucket(stack, "Bare");

    const report = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app);
    expect(report.success).toBe(false);
    expect(report.violations.map((violation) => violation.ruleName)).toContain("AwsSolutions-S1");
  });
});
