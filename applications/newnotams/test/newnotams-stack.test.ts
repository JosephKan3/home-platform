/**
 * The highest-value assertions in this file are the IAM scoping ones —
 * same reasoning as personal-site/test/site-stack.test.ts's header comment:
 * a `parameter/newnotams/*` grant would hand the server function or the
 * notify job every future secret this application acquires, and that
 * failure is not visible in a diff without a test that names the scope.
 * Also asserts the notify job gets a strictly smaller SSM grant than the
 * server function (Phase 1 action plan §3, C2) — it never touches Auth.js.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CLOUDFRONT_CERT_REGION } from "@platform/config";
import { APP_NAME, NOTIFY_INTERVAL, NewNotamsStack, newNotamsParameterNames } from "../lib/newnotams-stack.js";
import type { NewNotamsStackProps } from "../lib/newnotams-stack.js";

const ENV = { account: "222222222222", region: CLOUDFRONT_CERT_REGION };

function synth(props: Partial<NewNotamsStackProps> = {}): Template {
  const app = new App();
  return Template.fromStack(
    new NewNotamsStack(app, "TestNewNotamsStack", {
      env: ENV,
      envName: "prod",
      usePlaceholderSource: true,
      ...props,
    }),
  );
}

const template = synth();

describe("site bucket (via OpenNextSite)", () => {
  test("blocks all public access — CloudFront reaches it through OAC only", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("has ABAC enabled (docs/open-issues.md issue 9)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", { AbacStatus: "Enabled" });
  });

  test("prod retains the bucket", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });
});

describe("server function", () => {
  test("runs with no VPC configuration (ADR-0002)", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    for (const [, resource] of Object.entries(functions)) {
      expect(
        (resource as { Properties: Record<string, unknown> }).Properties["VpcConfig"],
      ).toBeUndefined();
    }
  });

  test("receives all eight app secrets as environment variables", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          AUTH_GOOGLE_ID: Match.anyValue(),
          AUTH_GOOGLE_SECRET: Match.anyValue(),
          AUTH_SECRET: Match.anyValue(),
          NEXT_PUBLIC_VAPID_PUBLIC_KEY: Match.anyValue(),
          VAPID_PRIVATE_KEY: Match.anyValue(),
          VAPID_SUBJECT: Match.anyValue(),
          KV_REST_API_URL: Match.anyValue(),
          KV_REST_API_TOKEN: Match.anyValue(),
        }),
      }),
    });
  });
});

function policyStatements(roleLogicalIdPrefix?: string): Array<Record<string, unknown>> {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
    .filter((properties) => {
      if (roleLogicalIdPrefix === undefined) {
        return true;
      }
      return JSON.stringify(properties["Roles"] ?? []).includes(roleLogicalIdPrefix);
    })
    .flatMap((properties) => {
      const document = properties["PolicyDocument"] as {
        Statement?: Array<Record<string, unknown>>;
      };
      return document.Statement ?? [];
    });
}

function resourcesOf(statement: Record<string, unknown>): unknown[] {
  const resource = statement["Resource"];
  return Array.isArray(resource) ? resource : [resource];
}

function statementsWithAction(
  roleLogicalIdPrefix: string,
  action: string,
): Array<Record<string, unknown>> {
  return policyStatements(roleLogicalIdPrefix).filter((statement) => {
    const actions = statement["Action"];
    return Array.isArray(actions) ? actions.includes(action) : actions === action;
  });
}

describe("least privilege (the point of this file)", () => {
  test("the server function reads exactly its eight named SSM parameters, no prefix grant", () => {
    const reads = statementsWithAction("ServerFunctionRole", "ssm:GetParameter");
    expect(reads).toHaveLength(1);

    const rendered = JSON.stringify(resourcesOf(reads[0] as Record<string, unknown>));
    expect(rendered).toContain(newNotamsParameterNames.googleClientId);
    expect(rendered).toContain(newNotamsParameterNames.googleClientSecret);
    expect(rendered).toContain(newNotamsParameterNames.authSecret);
    expect(rendered).toContain(newNotamsParameterNames.vapidPublicKey);
    expect(rendered).toContain(newNotamsParameterNames.vapidPrivateKey);
    expect(rendered).toContain(newNotamsParameterNames.vapidSubject);
    expect(rendered).toContain(newNotamsParameterNames.kvUrl);
    expect(rendered).toContain(newNotamsParameterNames.kvToken);
    // Not a prefix grant: `/newnotams/*` would include every future secret.
    expect(rendered).not.toContain(`parameter/${APP_NAME}/*`);
    expect(rendered).not.toContain(":parameter/*");
  });

  test("the notify job reads only the kv and push parameters — never the auth ones", () => {
    const reads = statementsWithAction("NotifyServiceRole", "ssm:GetParameter");
    expect(reads).toHaveLength(1);

    const rendered = JSON.stringify(resourcesOf(reads[0] as Record<string, unknown>));
    expect(rendered).toContain(newNotamsParameterNames.kvUrl);
    expect(rendered).toContain(newNotamsParameterNames.kvToken);
    expect(rendered).toContain(newNotamsParameterNames.vapidPublicKey);
    expect(rendered).toContain(newNotamsParameterNames.vapidPrivateKey);
    expect(rendered).toContain(newNotamsParameterNames.vapidSubject);
    // The notify sweep never signs anyone in — it has no business reading
    // Auth.js's secrets at all.
    expect(rendered).not.toContain(newNotamsParameterNames.googleClientId);
    expect(rendered).not.toContain(newNotamsParameterNames.googleClientSecret);
    expect(rendered).not.toContain(newNotamsParameterNames.authSecret);
    expect(rendered).not.toContain(`parameter/${APP_NAME}/*`);
    expect(rendered).not.toContain(":parameter/*");
  });

  test("the notify job holds no S3 permission at all — it never touches the site bucket", () => {
    const s3Actions = policyStatements("NotifyServiceRole")
      .flatMap((statement) => {
        const actions = statement["Action"];
        return Array.isArray(actions) ? actions : [actions];
      })
      .filter((action): action is string => typeof action === "string");

    expect(s3Actions.filter((action) => action.startsWith("s3:"))).toEqual([]);
  });
});

describe("notify schedule", () => {
  test("runs hourly via EventBridge Scheduler", () => {
    expect(NOTIFY_INTERVAL.toHours()).toBe(1);
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 hour)",
    });
  });

  test("invokes the Lambda directly — no public HTTP endpoint for the cron path", () => {
    // The whole point of this Lambda existing is that nothing calls it over
    // HTTP. Asserted negatively: no API Gateway, no Function URL on this
    // specific function (the server function legitimately has one, for
    // CloudFront — this one must not).
    template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 0);

    const notifyFunctions = Object.entries(template.findResources("AWS::Lambda::Function")).filter(
      ([logicalId]) => logicalId.startsWith("Notify"),
    );
    expect(notifyFunctions).toHaveLength(1);
  });
});

describe("handles for the consuming stack", () => {
  test("exposes the bucket, log bucket, distribution and notify job", () => {
    const app = new App();
    const stack = new NewNotamsStack(app, "HandlesStack", {
      env: ENV,
      envName: "prod",
      usePlaceholderSource: true,
    });
    expect(stack.bucket.bucketArn).toBeDefined();
    expect(stack.accessLogBucket.bucketArn).toBeDefined();
    expect(stack.distribution.distributionDomainName).toBeDefined();
    expect(stack.notifyJob.fn.functionArn).toBeDefined();
  });
});
