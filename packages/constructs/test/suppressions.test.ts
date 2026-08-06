import { App, RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { flattenForNagId, suppressNagRules, suppressNagRulesAtPath } from "../src/index.js";

const ACKNOWLEDGED_RULES = Validations.ACKNOWLEDGED_RULES_METADATA_KEY;
const GOOD_REASON =
  "Accepted deliberately: the alternative costs $5/mo against a $3-8 budget (ADR-0002).";

function newStack(): Stack {
  const app = new App();
  return new Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
}

function ruleNames(scope: App): string[] {
  return new AwsSolutionsChecks(scope, { verbose: true })
    .validateScope(scope)
    .violations.map((violation) => violation.ruleName);
}

describe("suppressNagRules", () => {
  it("stops cdk-nag reporting the suppressed rule", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

    expect(ruleNames(stack.node.root as App)).toContain("AwsSolutions-S1");

    suppressNagRules(bucket, [{ id: "AwsSolutions-S1", reason: GOOD_REASON }]);
    expect(ruleNames(stack.node.root as App)).not.toContain("AwsSolutions-S1");
  });

  it("leaves other rules on the same resource reporting", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });
    suppressNagRules(bucket, [{ id: "AwsSolutions-S1", reason: GOOD_REASON }]);

    // S10 (SSL enforcement) is a different finding on the same bucket and must
    // survive: a suppression is per-rule, never per-resource.
    expect(ruleNames(stack.node.root as App)).toContain("AwsSolutions-S10");
  });

  it("records the reason so a reviewer can find it later", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });
    suppressNagRules(bucket, [{ id: "AwsSolutions-S1", reason: GOOD_REASON }]);

    const recorded = bucket.node.metadata
      .filter((entry) => entry.type === ACKNOWLEDGED_RULES)
      .flatMap((entry) => Object.entries(entry.data as Record<string, string>));

    expect(recorded).toEqual([["AwsSolutions-S1", GOOD_REASON]]);
  });

  it("rejects a reason that cites neither an ADR nor a cost", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

    expect(() =>
      suppressNagRules(bucket, [
        { id: "AwsSolutions-S1", reason: "Not applicable to this workload, accepted risk." },
      ]),
    ).toThrow(/must cite an ADR/);
  });

  it("rejects a reason too short to tell a reviewer anything", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

    expect(() =>
      suppressNagRules(bucket, [{ id: "AwsSolutions-S1", reason: "ADR-0002." }]),
    ).toThrow(/too short/);
  });
});

describe("suppressNagRulesAtPath", () => {
  it("suppresses on a construct addressed by path", () => {
    const stack = newStack();
    new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

    suppressNagRulesAtPath(stack, "TestStack/Bucket", [
      { id: "AwsSolutions-S1", reason: GOOD_REASON },
    ]);

    expect(ruleNames(stack.node.root as App)).not.toContain("AwsSolutions-S1");
  });

  it("throws on a stale path rather than silently silencing nothing", () => {
    const stack = newStack();

    expect(() =>
      suppressNagRulesAtPath(stack, "TestStack/Renamed", [
        { id: "AwsSolutions-S1", reason: GOOD_REASON },
      ]),
    ).toThrow(/No construct at path/);
  });
});

describe("flattenForNagId", () => {
  it("renders a GetAtt-backed ARN the way cdk-nag renders it in a finding", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

    const flattened = flattenForNagId(stack, bucket.arnForObjects("data/*"));

    expect(flattened).toMatch(/^<Bucket[0-9A-F]+\.Arn>\/data\/\*$/);
  });

  it("renders a Ref as angle brackets", () => {
    const stack = newStack();
    expect(flattenForNagId(stack, `arn:${stack.partition}:iam::aws:policy/ReadOnlyAccess`)).toBe(
      "arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess",
    );
  });

  it("leaves a plain string untouched", () => {
    const stack = newStack();
    expect(flattenForNagId(stack, "arn:aws:s3:::literal-bucket/*")).toBe(
      "arn:aws:s3:::literal-bucket/*",
    );
  });
});
