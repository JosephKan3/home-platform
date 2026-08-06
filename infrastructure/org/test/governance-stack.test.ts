process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GovernanceStack } from "../lib/governance-stack.js";

const WORKLOADS_OU = "ou-abcd-11111111";
const SANDBOX_OU = "ou-abcd-22222222";
const ALERT_EMAIL = "alerts@example.com";

function synth(): { template: Template; stack: GovernanceStack } {
  const app = new App();
  const stack = new GovernanceStack(app, "TestGovernanceStack", {
    env: { account: "111111111111", region: "us-east-1" },
    workloadsOuId: WORKLOADS_OU,
    sandboxOuId: SANDBOX_OU,
    alertEmail: ALERT_EMAIL,
    organizationId: "o-abcdefghij",
    budgetAccountId: "222222222222",
  });
  return { template: Template.fromStack(stack), stack };
}

describe("GovernanceStack", () => {
  const { template, stack } = synth();

  describe("service control policies", () => {
    test("every policy is a SERVICE_CONTROL_POLICY", () => {
      const policies = template.findResources("AWS::Organizations::Policy");
      expect(Object.keys(policies).length).toBeGreaterThan(0);
      for (const policy of Object.values(policies)) {
        expect((policy as { Properties: Record<string, unknown> }).Properties["Type"]).toBe(
          "SERVICE_CONTROL_POLICY",
        );
      }
    });

    test("every policy attaches to both OUs and to nothing else", () => {
      const policies = template.findResources("AWS::Organizations::Policy");
      for (const policy of Object.values(policies)) {
        const targets = (policy as { Properties: Record<string, unknown> }).Properties["TargetIds"];
        expect(targets).toEqual([WORKLOADS_OU, SANDBOX_OU]);
      }
    });

    test("no policy is attached to an account ID (ADR-0001: OUs only)", () => {
      const policies = template.findResources("AWS::Organizations::Policy");
      for (const policy of Object.values(policies)) {
        const targets = (policy as { Properties: { TargetIds: string[] } }).Properties.TargetIds;
        for (const target of targets) {
          expect(target).toMatch(/^ou-/);
          expect(target).not.toMatch(/^\d{12}$/);
        }
      }
    });

    test("stays within the 5-policies-per-OU quota, leaving room for FullAWSAccess", () => {
      expect(stack.policies.length).toBeLessThanOrEqual(4);
    });

    test("the region lock exempts the global services and pins us-east-1", () => {
      const policies = template.findResources("AWS::Organizations::Policy", {
        Properties: { Name: "platform-region-lock" },
      });
      const entries = Object.values(policies);
      expect(entries).toHaveLength(1);
      const content = (entries[0] as { Properties: { Content: Record<string, unknown> } }).Properties
        .Content;
      const statement = (content["Statement"] as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;

      expect(statement["Effect"]).toBe("Deny");
      expect(statement["Condition"]).toEqual({
        StringNotEquals: { "aws:RequestedRegion": ["us-east-1"] },
      });
      // Asserted individually rather than with arrayWith, which is order
      // sensitive and would fail for a reason unrelated to the exemption.
      for (const namespace of ["iam:*", "organizations:*", "route53:*", "cloudfront:*", "sts:*"]) {
        expect(statement["NotAction"]).toContain(namespace);
      }
    });

    test("the cost guardrails policy denies NAT and Transit Gateway creation", () => {
      template.hasResourceProperties("AWS::Organizations::Policy", {
        Name: "platform-cost-guardrails",
        Content: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: Match.arrayWith(["ec2:CreateNatGateway", "ec2:CreateTransitGateway"]),
            }),
          ]),
        },
      });
    });

    test("the security guardrails policy denies static credentials and leaving the org", () => {
      template.hasResourceProperties("AWS::Organizations::Policy", {
        Name: "platform-security-guardrails",
        Content: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["iam:CreateUser", "iam:CreateAccessKey"]),
            }),
            Match.objectLike({
              Action: Match.arrayWith(["cloudtrail:StopLogging", "guardduty:DeleteDetector"]),
            }),
            Match.objectLike({ Action: ["organizations:LeaveOrganization"] }),
          ]),
        },
      });
    });

    test("policy content is a JSON object, not a string (drift detection needs it)", () => {
      const policies = template.findResources("AWS::Organizations::Policy");
      for (const policy of Object.values(policies)) {
        const content = (policy as { Properties: Record<string, unknown> }).Properties["Content"];
        expect(typeof content).toBe("object");
      }
    });
  });

  describe("organization CloudTrail", () => {
    test("is an organization trail with log file validation enabled", () => {
      template.hasResourceProperties("AWS::CloudTrail::Trail", {
        IsOrganizationTrail: true,
        EnableLogFileValidation: true,
        IncludeGlobalServiceEvents: true,
        IsMultiRegionTrail: true,
        IsLogging: true,
      });
    });

    test("logs to the governance bucket", () => {
      template.resourceCountIs("AWS::CloudTrail::Trail", 1);
      template.hasResourceProperties("AWS::CloudTrail::Trail", {
        S3BucketName: Match.anyValue(),
        TrailName: "platform-org-trail",
      });
    });
  });

  describe("trail bucket", () => {
    test("blocks all public access", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test("is versioned and server-side encrypted", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Enabled" },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
            }),
          ],
        },
      });
    });

    test("transitions to Glacier after 90 days", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: "Enabled",
              Transitions: [{ StorageClass: "GLACIER", TransitionInDays: 90 }],
            }),
          ]),
        },
      });
    });

    test("enforces SSL via the bucket policy", () => {
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
    });

    test("is retained when the stack is deleted", () => {
      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("records who reads it via server access logging (AwsSolutions-S1)", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LoggingConfiguration: {
          DestinationBucketName: { Ref: Match.stringLikeRegexp("^OrgTrailAccessLogBucket") },
          LogFilePrefix: "org-trail/",
        },
      });
    });
  });

  describe("trail access log bucket", () => {
    test("is a separate bucket, not the trail bucket logging to itself", () => {
      const logging = Object.values(template.findResources("AWS::S3::Bucket"))
        .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
        .map((properties) => properties["LoggingConfiguration"])
        .filter((config): config is Record<string, unknown> => config !== undefined);

      expect(logging).toHaveLength(1);
      expect(JSON.stringify(logging[0])).not.toContain("OrgTrailBucket");
    });

    test("honours ACLs so the S3 log-delivery group can write to it", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] },
      });
    });

    test("expires its objects so the logs cannot grow without bound", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ Id: "ExpireAccessLogs", Status: "Enabled", ExpirationInDays: 365 }),
          ]),
        },
      });
    });

    test("is retained, blocks public access and enforces TLS", () => {
      const entry = Object.entries(template.findResources("AWS::S3::Bucket")).find(([logicalId]) =>
        logicalId.startsWith("OrgTrailAccessLogBucket"),
      );
      expect(entry).toBeDefined();

      const resource = entry?.[1] as {
        DeletionPolicy: string;
        Properties: Record<string, unknown>;
      };
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.Properties["PublicAccessBlockConfiguration"]).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });

      const policies = Object.values(template.findResources("AWS::S3::BucketPolicy"))
        .map((policy) => (policy as { Properties: Record<string, unknown> }).Properties)
        .filter((props) => JSON.stringify(props["Bucket"]).includes("OrgTrailAccessLogBucket"));
      expect(JSON.stringify(policies)).toContain("aws:SecureTransport");
    });
  });

  describe("budget", () => {
    test("is a $10 monthly cost budget", () => {
      template.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: 10, Unit: "USD" },
        }),
      });
    });

    test("has exactly four notifications", () => {
      const budgets = template.findResources("AWS::Budgets::Budget");
      const entries = Object.values(budgets);
      expect(entries).toHaveLength(1);
      const props = (entries[0] as { Properties: Record<string, unknown> }).Properties;
      expect(props["NotificationsWithSubscribers"]).toHaveLength(4);
    });

    test("alerts at 50/80/100% actual and 100% forecasted, all to the context email", () => {
      const budgets = template.findResources("AWS::Budgets::Budget");
      const props = (Object.values(budgets)[0] as { Properties: Record<string, unknown> })
        .Properties;
      const notifications = props["NotificationsWithSubscribers"] as Array<{
        Notification: { NotificationType: string; Threshold: number };
        Subscribers: Array<{ Address: string; SubscriptionType: string }>;
      }>;

      expect(
        notifications.map((entry) => [
          entry.Notification.NotificationType,
          entry.Notification.Threshold,
        ]),
      ).toEqual([
        ["ACTUAL", 50],
        ["ACTUAL", 80],
        ["ACTUAL", 100],
        ["FORECASTED", 100],
      ]);

      for (const entry of notifications) {
        expect(entry.Subscribers).toEqual([
          { Address: ALERT_EMAIL, SubscriptionType: "EMAIL" },
        ]);
      }
    });

    test("is filtered to the platform account", () => {
      template.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({ CostFilters: { LinkedAccount: ["222222222222"] } }),
      });
    });
  });

  describe("cost anomaly detection", () => {
    test("creates a dimensional SERVICE monitor", () => {
      template.hasResourceProperties("AWS::CE::AnomalyMonitor", {
        MonitorType: "DIMENSIONAL",
        MonitorDimension: "SERVICE",
      });
    });

    test("subscribes with a $5 absolute-impact threshold expression", () => {
      const subscriptions = template.findResources("AWS::CE::AnomalySubscription");
      const props = (Object.values(subscriptions)[0] as { Properties: Record<string, unknown> })
        .Properties;
      expect(props["Frequency"]).toBe("DAILY");
      expect(props["Subscribers"]).toEqual([{ Address: ALERT_EMAIL, Type: "EMAIL" }]);
      // The flat Threshold property is deprecated; ThresholdExpression is a
      // JSON-encoded Expression string.
      expect(props["Threshold"]).toBeUndefined();
      expect(JSON.parse(props["ThresholdExpression"] as string)).toEqual({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: ["5"],
        },
      });
    });
  });

  describe("without an alert email", () => {
    const bare = Template.fromStack(
      new GovernanceStack(new App(), "BareGovernanceStack", {
        env: { account: "111111111111", region: "us-east-1" },
        workloadsOuId: WORKLOADS_OU,
        sandboxOuId: SANDBOX_OU,
      }),
    );

    test("still creates the SCPs and the trail", () => {
      expect(Object.keys(bare.findResources("AWS::Organizations::Policy")).length).toBe(3);
      bare.resourceCountIs("AWS::CloudTrail::Trail", 1);
    });

    test("skips the anomaly subscription, which requires a subscriber", () => {
      bare.resourceCountIs("AWS::CE::AnomalyMonitor", 1);
      bare.resourceCountIs("AWS::CE::AnomalySubscription", 0);
    });
  });

  test("carries the governance platform tags", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([
        { Key: "app", Value: "platform-governance" },
        { Key: "env", Value: "prod" },
      ]),
    });
  });
});
