/**
 * ADR-0007. Unlike DnsStack (zero suppressions), this stack carries several
 * documented, justified suppressions — EC2/EC23 inbound from any peer,
 * IAM4's AmazonSSMManagedInstanceCore, EC28's monitoring granularity. This
 * test asserts those are the *only* findings: anything beyond them is a real
 * regression, not a known tradeoff already accepted.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { NetworkStack } from "../lib/network-stack.js";

const ENV = { account: "222222222222", region: "us-east-1" };

test("no unsuppressed AwsSolutions findings", () => {
  const app = new App();
  new NetworkStack(app, "NagNetworkStack", { env: ENV });

  const errors = new AwsSolutionsChecks(app, { verbose: true })
    .validateScope(app)
    .violations.filter((violation) => violation.severity === "error")
    .map(
      (violation) =>
        `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath ?? ""}`,
    );

  expect(errors).toEqual([]);
});
