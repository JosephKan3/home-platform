/**
 * GovernanceStack — organization guardrails as code (Phase 0 action plan §6).
 *
 * Deploys to the **management account**. It is the only stack in this repo that
 * does, because Organizations, the organization CloudTrail, Budgets and Cost
 * Anomaly Detection are all management-account APIs.
 *
 * ## SCPs do not apply to the management account
 *
 * Nothing in this stack constrains the account it is deployed into. Every
 * policy created here is attached to the `Workloads` and `Sandbox` OUs, and
 * AWS exempts the management account from SCP evaluation entirely. That is not
 * a gap to be closed — it is the escape hatch that makes a mistaken SCP
 * recoverable — and it is precisely why no workload is ever allowed to run in
 * the management account (action plan §2 A1, §10).
 *
 * ## What this stack does not create
 *
 * The organization, the three OUs, and the Platform account are created by hand
 * in Stage A. Account creation requires email verification, and deleting an
 * `AWS::Organizations::Account` resource does **not** close the account — it
 * orphans it, still billable, with an email address that can never be reused
 * (§10). OU IDs are therefore inputs, passed as props from CDK context.
 *
 * ## Deploy order
 *
 * Deploy this only after `cdk bootstrap` and the OIDC stack. A region-lock SCP
 * applied first can block the very operations that establish the ability to
 * deploy (§2 A6, §6).
 */

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as organizations from "aws-cdk-lib/aws-organizations";
import * as s3 from "aws-cdk-lib/aws-s3";
import { DEFAULT_OWNER, applyPlatformTags } from "@platform/config";
import { suppressNagRules } from "@platform/constructs";
import {
  assertPolicySize,
  denyExpensiveComputePolicy,
  denyManagedEgressPolicy,
  denyStaticCredentialsPolicy,
  mergePolicies,
  protectAuditPolicy,
  protectOrganizationPolicy,
  regionLockPolicy,
} from "./service-control-policies.js";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { PolicyDocument } from "./service-control-policies.js";

const SERVICE_CONTROL_POLICY = "SERVICE_CONTROL_POLICY";

/** Monthly cost budget on the Platform account, in USD (§6 E3). */
const BUDGET_LIMIT_USD = 10;

/** Absolute dollar impact an anomaly must reach before it is emailed (§6 E3). */
const ANOMALY_THRESHOLD_USD = 5;

/** Days before CloudTrail logs move to Glacier (§6 E2). */
const LOG_ARCHIVE_AFTER_DAYS = 90;

/** Prefix the trail bucket's server access logs are written under. */
const TRAIL_ACCESS_LOG_PREFIX = "org-trail/";

/**
 * Days before trail access logs expire. Long enough to reconstruct who read
 * the audit trail during an investigation, short enough to stay negligible
 * against the $10/mo budget.
 */
const TRAIL_ACCESS_LOG_RETENTION_DAYS = 365;

export interface GovernanceStackProps extends StackProps {
  /** ID of the `Workloads` OU, created by hand in Stage A. Format `ou-xxxx-xxxxxxxx`. */
  readonly workloadsOuId: string;
  /** ID of the `Sandbox` OU, created by hand in Stage A. */
  readonly sandboxOuId: string;
  /** Account the $10/mo budget is filtered to. Defaults to every account in the org. */
  readonly budgetAccountId?: string;
  /** Address for budget and cost anomaly notifications. */
  readonly alertEmail?: string;
  /**
   * Organization ID (`o-xxxxxxxxxx`).
   *
   * Only used to scope the CloudTrail bucket policy to the organization. Without
   * it CDK cannot write the bucket policy that lets member accounts deliver
   * logs, and warns at synth.
   */
  readonly organizationId?: string;
}

export class GovernanceStack extends Stack {
  readonly policies: organizations.CfnPolicy[] = [];
  readonly trailBucket: s3.Bucket;
  readonly trailAccessLogBucket: s3.Bucket;
  readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: GovernanceStackProps) {
    super(scope, id, props);

    const targetIds = [props.workloadsOuId, props.sandboxOuId];

    // Attached to OUs, never to accounts (ADR-0001): an account later dropped
    // into Workloads inherits every guardrail the moment it moves.
    //
    // Grouped into three attached documents because AWS permits only five
    // policies per target and the AWS-managed FullAWSAccess consumes one. See
    // the README for the grouping rationale.
    this.addServiceControlPolicy(
      "RegionLock",
      "platform-region-lock",
      "Deny all non-global service actions outside us-east-1.",
      regionLockPolicy(),
      targetIds,
    );

    this.addServiceControlPolicy(
      "CostGuardrails",
      "platform-cost-guardrails",
      "Deny NAT/Transit Gateways (ADR-0002) and expensive EC2 instance families.",
      mergePolicies(denyManagedEgressPolicy(), denyExpensiveComputePolicy()),
      targetIds,
    );

    this.addServiceControlPolicy(
      "SecurityGuardrails",
      "platform-security-guardrails",
      "Deny static credentials, audit tampering, and leaving the organization.",
      mergePolicies(
        denyStaticCredentialsPolicy(),
        protectAuditPolicy(),
        protectOrganizationPolicy(),
      ),
      targetIds,
    );

    this.trailAccessLogBucket = this.createTrailAccessLogBucket();
    this.trailBucket = this.createTrailBucket(this.trailAccessLogBucket);
    this.trail = this.createOrganizationTrail(this.trailBucket, props.organizationId);
    this.createBudget(props.alertEmail, props.budgetAccountId);
    this.createAnomalyDetection(props.alertEmail);

    applyPlatformTags(this, {
      app: "platform-governance",
      env: "prod",
      owner: DEFAULT_OWNER,
    });

    new CfnOutput(this, "TrailBucketName", {
      value: this.trailBucket.bucketName,
      description: "Organization CloudTrail log destination.",
    });
    new CfnOutput(this, "AttachedPolicyCount", {
      value: String(this.policies.length),
      description: "SCPs attached per OU. AWS allows 5, including FullAWSAccess.",
    });
  }

  private addServiceControlPolicy(
    id: string,
    name: string,
    description: string,
    document: PolicyDocument,
    targetIds: string[],
  ): void {
    const policy = new organizations.CfnPolicy(this, id, {
      name,
      description,
      type: SERVICE_CONTROL_POLICY,
      // Size is validated by the Organizations API at deploy time, not by
      // CloudFormation template validation. Failing here turns a mid-deploy
      // rollback into a local error.
      content: assertPolicySize(name, document),
      targetIds,
    });
    this.policies.push(policy);
  }

  /**
   * Log destination for the organization trail.
   *
   * Retained on stack deletion: an audit trail that disappears with the stack
   * that created it is not an audit trail. Versioning plus SSL enforcement plus
   * a full public access block means a deleted or overwritten object is still
   * recoverable and never reachable anonymously.
   */
  private createTrailBucket(accessLogBucket: s3.Bucket): s3.Bucket {
    return new s3.Bucket(this, "OrgTrailBucket", {
      // AwsSolutions-S1. CloudTrail records the API calls that created and
      // modified objects here; server access logging records the reads, which
      // CloudTrail data events would otherwise cost $0.10 per 100k events to
      // capture. On the bucket holding the organization's only audit trail,
      // knowing who read it is the point.
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: TRAIL_ACCESS_LOG_PREFIX,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "ArchiveToGlacier",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(LOG_ARCHIVE_AFTER_DAYS),
            },
          ],
        },
      ],
    });
  }

  /**
   * Access log destination for the trail bucket.
   *
   * Also RETAIN: the record of who read the audit trail is part of the audit
   * trail. S3 carries no per-bucket charge, so at the volume of a two-account
   * organization this adds well under $0.10/mo against the $10/mo budget
   * enforced below, and the lifecycle rule caps it.
   */
  private createTrailAccessLogBucket(): s3.Bucket {
    const bucket = new s3.Bucket(this, "OrgTrailAccessLogBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // S3 server access logging delivers with the log-delivery group, which
      // needs ACLs honoured on the destination bucket.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "ExpireAccessLogs",
          enabled: true,
          expiration: Duration.days(TRAIL_ACCESS_LOG_RETENTION_DAYS),
        },
      ],
    });

    suppressNagRules(bucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "This is the access log destination. Pointing it at itself creates a " +
          "write-per-write feedback loop that grows without bound at $0.023/GB, " +
          "and pointing it at the trail bucket it logs makes each bucket depend " +
          "on the other (ADR-0007). Reads of this bucket are themselves recorded " +
          "by the organization CloudTrail created in this stack.",
      },
    ]);

    return bucket;
  }

  /**
   * Organization-wide trail (§6 E2).
   *
   * `isOrganizationTrail` requires this stack to be deployed in the management
   * account with CloudTrail enabled as a trusted service for Organizations;
   * CloudFormation errors otherwise. See the README for the one-time
   * `enable-aws-service-access` call.
   *
   * ADR-0001 records the deviation honestly: this lives in the management
   * account rather than a dedicated Security account, so an attacker holding
   * management access could tamper with the trail. Log file validation makes
   * such tampering detectable rather than silent.
   */
  private createOrganizationTrail(bucket: s3.Bucket, organizationId?: string): cloudtrail.Trail {
    return new cloudtrail.Trail(this, "OrgTrail", {
      // A name is mandatory for an organization trail: CDK needs it to scope
      // the bucket policy that member accounts write through.
      trailName: "platform-org-trail",
      bucket,
      isOrganizationTrail: true,
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      ...(organizationId ? { orgId: organizationId } : {}),
    });
  }

  /**
   * $10/mo cost budget (§6 E3).
   *
   * Budgets take roughly 24 hours before their first evaluation, so a silent
   * first day is expected rather than a misconfiguration.
   */
  private createBudget(alertEmail?: string, budgetAccountId?: string): void {
    const subscribers: budgets.CfnBudget.SubscriberProperty[] = alertEmail
      ? [{ address: alertEmail, subscriptionType: "EMAIL" }]
      : [];

    const notify = (
      notificationType: "ACTUAL" | "FORECASTED",
      threshold: number,
    ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: {
        notificationType,
        comparisonOperator: "GREATER_THAN",
        threshold,
        thresholdType: "PERCENTAGE",
      },
      subscribers,
    });

    new budgets.CfnBudget(this, "PlatformMonthlyBudget", {
      budget: {
        budgetName: "platform-monthly-cost",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: BUDGET_LIMIT_USD, unit: "USD" },
        // Filtered to the Platform account: the management account holds no
        // workloads, so its spend is noise against a $10 ceiling.
        ...(budgetAccountId ? { costFilters: { LinkedAccount: [budgetAccountId] } } : {}),
      },
      notificationsWithSubscribers: [
        notify("ACTUAL", 50),
        notify("ACTUAL", 80),
        notify("ACTUAL", 100),
        notify("FORECASTED", 100),
      ],
    });
  }

  /**
   * Cost Anomaly Detection (§6 E3).
   *
   * A budget catches a slow drift toward the ceiling; anomaly detection catches
   * a sudden spike in a single service well before the month's total would
   * notice it.
   */
  private createAnomalyDetection(alertEmail?: string): void {
    const monitor = new ce.CfnAnomalyMonitor(this, "ServiceAnomalyMonitor", {
      monitorName: "platform-service-anomalies",
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });

    if (!alertEmail) {
      return;
    }

    new ce.CfnAnomalySubscription(this, "AnomalySubscription", {
      subscriptionName: "platform-anomaly-alerts",
      // DAILY (or WEEKLY) delivers over email. IMMEDIATE requires an SNS topic.
      frequency: "DAILY",
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ address: alertEmail, type: "EMAIL" }],
      // The flat `threshold` property is deprecated in the current CE API in
      // favour of ThresholdExpression, a JSON-encoded Expression. GREATER_THAN_OR_EQUAL
      // is the only match option the API accepts here, and the value must be a string.
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: [String(ANOMALY_THRESHOLD_USD)],
        },
      }),
    });
  }
}
