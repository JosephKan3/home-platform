/**
 * ScheduledJob asserts three things that are easy to undo by accident and
 * invisible in a diff: the runtime and architecture, the explicit log group
 * (rather than the deprecated `logRetention` prop, which the LogRetentionAspect
 * cannot see), and the custom execution role scoped to that one log group
 * rather than the account-wide AWSLambdaBasicExecutionRole.
 */

import { App, Duration, Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { AwsSolutionsChecks } from "cdk-nag";
import * as path from "node:path";
import { profileFor } from "@platform/config";
import { SCHEDULED_JOB_RUNTIME, ScheduledJob } from "../src/index.js";
import type { ScheduledJobProps } from "../src/index.js";

const ENV = { account: "111111111111", region: "us-east-1" };

/**
 * A real TypeScript file so esbuild has something to bundle. The handler's
 * contents are irrelevant to every assertion here; only the resources CDK
 * renders around it matter.
 */
const ENTRY = path.join(__dirname, "fixtures", "job-handler.ts");

function synth(props: Partial<ScheduledJobProps> = {}): Template {
  // The env must be concrete: the schedule target role's assume-role condition
  // pins aws:SourceAccount, which renders as an unresolved token otherwise.
  const stack = new Stack(new App(), "TestStack", { env: ENV });
  new ScheduledJob(stack, "Job", {
    entry: ENTRY,
    schedule: Duration.hours(1),
    profile: profileFor("prod"),
    description: "Test job.",
    ...props,
  });
  return Template.fromStack(stack);
}

describe("function", () => {
  const template = synth();

  test("is ARM64 on the pinned runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: SCHEDULED_JOB_RUNTIME.name,
      Architectures: ["arm64"],
      Handler: "index.handler",
    });
  });

  test("applies the caller's environment, timeout and memory", () => {
    const custom = synth({
      environment: { FEED_URL: "https://example.invalid/feed" },
      timeout: Duration.seconds(15),
      memorySize: 256,
    });

    custom.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { FEED_URL: "https://example.invalid/feed" } },
      Timeout: 15,
      MemorySize: 256,
    });
  });

  test("defaults to 60s and 512 MB", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60,
      MemorySize: 512,
    });
  });

  test("is the only Lambda in the stack — no custom-resource providers", () => {
    template.resourceCountIs("AWS::Lambda::Function", 1);
  });
});

describe("log group", () => {
  const template = synth();

  test("is an explicit LogGroup with retention from the profile", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 30,
    });
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });

  test("takes retention from whichever profile is passed", () => {
    synth({ profile: profileFor("dev") }).hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 14,
    });
  });

  test("renders no Custom::LogRetention resource", () => {
    // The deprecated `logRetention` prop creates one, along with a provider
    // Lambda whose log group the LogRetentionAspect can never inspect.
    expect(Object.keys(template.findResources("Custom::LogRetention"))).toEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toContain("LogRetention");
  });

  test("the function is wired to that group rather than an implicit one", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("^JobLogs") } },
    });
  });
});

describe("execution role", () => {
  const template = synth();

  test("attaches no AWS managed policy (AwsSolutions-IAM4)", () => {
    // AWSLambdaBasicExecutionRole grants logs:CreateLogGroup plus writes to
    // every log group in the account.
    const role = Object.entries(template.findResources("AWS::IAM::Role")).find(([logicalId]) =>
      logicalId.startsWith("JobServiceRole"),
    );
    expect(role).toBeDefined();

    const properties = (role?.[1] as { Properties: Record<string, unknown> }).Properties;
    expect(properties["ManagedPolicyArns"]).toBeUndefined();
    expect(JSON.stringify(properties)).not.toContain("AWSLambdaBasicExecutionRole");
  });

  test("the whole template references AWSLambdaBasicExecutionRole nowhere", () => {
    expect(JSON.stringify(template.toJSON())).not.toContain("AWSLambdaBasicExecutionRole");
  });

  test("its logs statement targets only the construct's own log group", () => {
    const statements = executionRoleStatements(template).filter((statement) => {
      const actions = asArray(statement["Action"]);
      return actions.some((action) => typeof action === "string" && action.startsWith("logs:"));
    });

    expect(statements).toHaveLength(1);
    const statement = statements[0] as Record<string, unknown>;

    expect(statement["Action"]).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    // Creating a group would let it write outside the one declared here.
    expect(JSON.stringify(statement)).not.toContain("logs:CreateLogGroup");
    expect(JSON.stringify(statement)).not.toContain("logs:*");

    for (const resource of asArray(statement["Resource"])) {
      // Every resource resolves off the construct's own log group ARN, either
      // directly or with the stream segment appended.
      expect(JSON.stringify(resource)).toMatch(/JobLogs[0-9A-F]*/);
    }
  });

  test("the construct grants nothing beyond logs — S3 and SSM stay with the caller", () => {
    const actions = executionRoleStatements(template).flatMap((statement) =>
      asArray(statement["Action"]),
    );

    expect(actions).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
  });

  test("is the role the function actually runs as", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Role: { "Fn::GetAtt": [Match.stringLikeRegexp("^JobServiceRole"), "Arn"] },
    });
  });
});

describe("schedule", () => {
  test("renders the interval as a rate expression", () => {
    synth().hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 hour)",
      FlexibleTimeWindow: { Mode: "OFF" },
    });
  });

  test("is not hardcoded hourly — a different interval renders differently", () => {
    synth({ schedule: Duration.minutes(15) }).hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(15 minutes)",
    });
  });

  test("accepts a ScheduleExpression for cron", () => {
    synth({
      schedule: scheduler.ScheduleExpression.cron({ minute: "0", hour: "6" }),
    }).hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
    });
  });

  test("targets the function with the configured retry policy", () => {
    synth({ retryAttempts: 5, maxEventAge: Duration.minutes(10) }).hasResourceProperties(
      "AWS::Scheduler::Schedule",
      {
        Target: Match.objectLike({
          Arn: { "Fn::GetAtt": [Match.stringLikeRegexp("^JobFunction"), "Arn"] },
          RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 600 },
        }),
      },
    );
  });
});

describe("caller-added grants", () => {
  test("fn and logGroup are exposed so a stack can grant without reaching inside", () => {
    const stack = new Stack(new App(), "GrantStack", { env: ENV });
    const job = new ScheduledJob(stack, "Job", {
      entry: ENTRY,
      schedule: Duration.hours(1),
      profile: profileFor("prod"),
    });

    expect(job.fn.functionArn).toBeDefined();
    expect(job.logGroup.logGroupArn).toBeDefined();
    expect(job.role.roleArn).toBeDefined();
  });
});

describe("cdk-nag", () => {
  test("a stack using the construct has zero unsuppressed errors", () => {
    const app = new App();
    const stack = new Stack(app, "NagStack", { env: ENV });
    new ScheduledJob(stack, "Job", {
      entry: ENTRY,
      schedule: Duration.hours(1),
      profile: profileFor("prod"),
      description: "Test job.",
    });

    const errors = new AwsSolutionsChecks(app, { verbose: true })
      .validateScope(app)
      .violations.filter((violation) => violation.severity === "error")
      .map(
        (violation) =>
          `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath ?? ""}`,
      );

    expect(errors).toEqual([]);
  });

  test("no suppression is attached at stack scope (ADR-0007)", () => {
    const stack = new Stack(new App(), "ScopeStack", { env: ENV });
    new ScheduledJob(stack, "Job", {
      entry: ENTRY,
      schedule: Duration.hours(1),
      profile: profileFor("prod"),
    });

    const atStackScope = stack.node.metadata.filter(
      (entry) => entry.type === Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
    );
    expect(atStackScope).toEqual([]);
  });
});

function executionRoleStatements(template: Template): Array<Record<string, unknown>> {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
    .filter((properties) => JSON.stringify(properties["Roles"] ?? []).includes("JobServiceRole"))
    .flatMap((properties) => {
      const document = properties["PolicyDocument"] as {
        Statement?: Array<Record<string, unknown>>;
      };
      return document.Statement ?? [];
    });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
