/**
 * ADR-0007. This stack holds no suppressions at all, which is the assertion
 * worth making: Route53 zones, records and an ACM certificate trip no
 * AwsSolutions rule, so any finding that appears here is a real regression
 * rather than a known tradeoff.
 *
 * Both origin modes are checked, because the apex cutover (Stage G1) changes
 * which records render and is the highest-risk change this stack makes.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { CLOUDFRONT_CERT_REGION } from "@platform/config";
import { DnsStack } from "../lib/dns-stack.js";
import type { DnsStackProps } from "../lib/dns-stack.js";

function ruleNames(props: Partial<DnsStackProps> = {}): string[] {
  const app = new App();
  new DnsStack(app, "NagDnsStack", {
    env: { account: "222222222222", region: CLOUDFRONT_CERT_REGION },
    ...props,
  });

  return new AwsSolutionsChecks(app, { verbose: true })
    .validateScope(app)
    .violations.map((violation) => violation.ruleName);
}

describe("cdk-nag AwsSolutionsChecks", () => {
  test("the live vercel origin mode is clean", () => {
    expect(ruleNames()).toEqual([]);
  });

  test("the cloudfront cutover mode is clean", () => {
    expect(
      ruleNames({ origin: "cloudfront", cloudFrontDomainName: "d111111abcdef8.cloudfront.net" }),
    ).toEqual([]);
  });

  test("the optional zones are clean", () => {
    expect(ruleNames({ createProductZone: true, internalZoneVpcId: "vpc-0123456789abcdef0" })).toEqual(
      [],
    );
  });
});
