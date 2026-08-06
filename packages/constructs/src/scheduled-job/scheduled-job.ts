/**
 * ScheduledJob — a bundled Node Lambda that EventBridge Scheduler invokes on an
 * interval, with the log group and the execution role that a scheduled job
 * should always have and almost never gets.
 *
 * The construct owns exactly four things: the function, its log group, its
 * execution role, and the schedule. It owns no grant beyond "write my own
 * logs". Everything a particular job needs — a bucket, a parameter, a queue —
 * is added by the caller through `role` or `fn`, because the moment this
 * construct knows about S3 it stops being reusable.
 *
 *   const job = new ScheduledJob(this, "Notify", {
 *     entry: path.join(__dirname, "..", "lambda", "notify", "index.ts"),
 *     schedule: Duration.hours(1),
 *     profile,
 *     description: "Hourly NOTAM notification sweep.",
 *   });
 *   job.role.addToPolicy(new iam.PolicyStatement({ ... }));
 */

import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import { flattenForNagId, suppressNagRules } from "../nag/index.js";
import type { EnvProfile } from "@platform/config";

/**
 * Runtime for every scheduled job on the platform.
 *
 * Node 24 is the newest runtime aws-cdk-lib 2.263 knows about, which is what
 * `AwsSolutions-L1` checks against; Node 20 was deprecated 2026-04-30. Pinned
 * here rather than exposed as a prop so a runtime bump is one edit for the
 * whole platform, and so no service can quietly sit on a deprecated runtime.
 */
export const SCHEDULED_JOB_RUNTIME = lambda.Runtime.NODEJS_24_X;

/** esbuild target, kept in lockstep with SCHEDULED_JOB_RUNTIME. */
const BUNDLE_TARGET = "node24";

/**
 * The SDK ships inside the Lambda runtime image. Bundling it would add tens of
 * megabytes to the asset and pin a version that AWS already patches for us.
 * Stated explicitly rather than left to the aws-cdk-lib default, which varies
 * with the `sdkV3ExcludeSmithyPackages` feature flag.
 */
const SDK_EXTERNALS = ["@aws-sdk/*", "@smithy/*"];

/** Construct ID prefix aws-cdk-lib gives the role it creates for a target. */
const SCHEDULER_TARGET_ROLE_PREFIX = "SchedulerRoleForTarget-";

const DEFAULT_TIMEOUT = Duration.seconds(60);
const DEFAULT_MEMORY_SIZE = 512;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_MAX_EVENT_AGE = Duration.minutes(30);

/**
 * A `ScheduleExpression`, or a plain interval the construct turns into
 * `rate(...)`. The interval form covers the overwhelmingly common case; the
 * expression form is there for cron and for timezone-pinned schedules.
 */
export type ScheduledJobSchedule = scheduler.ScheduleExpression | Duration;

export interface ScheduledJobProps {
  /** Path to the handler source. Bundled with esbuild; must export `handler`. */
  readonly entry: string;

  /** How often the job runs. */
  readonly schedule: ScheduledJobSchedule;

  /** Drives log retention. See `@platform/config`. */
  readonly profile: EnvProfile;

  /** Environment variables for the handler. */
  readonly environment?: Record<string, string>;

  /** Default 60s — long enough for a retried HTTP call, short enough that a
   * hung socket does not burn fifteen minutes of billed time. */
  readonly timeout?: Duration;

  /** Default 512 MB. */
  readonly memorySize?: number;

  /** Description on the function. */
  readonly description?: string;

  /** Description on the schedule. Defaults to `description`. */
  readonly scheduleDescription?: string;

  /** Scheduler-side retries before the invocation is dropped. Default 2. */
  readonly retryAttempts?: number;

  /** How long Scheduler keeps retrying. Default 30 minutes. */
  readonly maxEventAge?: Duration;
}

export class ScheduledJob extends Construct {
  /** The function. Use `fn.addToRolePolicy` or `role` to grant it anything. */
  readonly fn: NodejsFunction;

  /** The function's log group. Explicit — see the comment in the constructor. */
  readonly logGroup: logs.LogGroup;

  /** The execution role. Callers add their own least-privilege statements here. */
  readonly role: iam.Role;

  /** The schedule that invokes the function. */
  readonly schedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: ScheduledJobProps) {
    super(scope, id);

    // An explicit LogGroup rather than the deprecated `logRetention` prop: that
    // prop renders a Custom::LogRetention resource with a Lambda of its own,
    // and the group it creates at runtime is not a CfnLogGroup that
    // LogRetentionAspect can see. Declaring it here means the aspect actually
    // checks the thing it exists to check.
    //
    // DESTROY regardless of `profile.removalPolicy`: the profile's policy
    // protects data stores, and a log group is not one. A retained orphan
    // group keeps billing for stored bytes after the stack that explained it
    // is gone.
    this.logGroup = new logs.LogGroup(this, "Logs", {
      retention: props.profile.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.role = this.createExecutionRole(id);

    this.fn = new NodejsFunction(this, "Function", {
      entry: props.entry,
      handler: "handler",
      runtime: SCHEDULED_JOB_RUNTIME,
      // ~20% cheaper per GB-second, and a bundled Node handler has no native
      // dependency that would care.
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? DEFAULT_MEMORY_SIZE,
      timeout: props.timeout ?? DEFAULT_TIMEOUT,
      logGroup: this.logGroup,
      role: this.role,
      description: props.description,
      environment: props.environment,
      bundling: {
        minify: true,
        sourceMap: false,
        target: BUNDLE_TARGET,
        externalModules: SDK_EXTERNALS,
      },
    });

    this.schedule = this.createSchedule(props);
  }

  /**
   * An explicit execution role rather than the CDK default.
   *
   * The default attaches the AWS managed `AWSLambdaBasicExecutionRole`, which
   * grants `logs:CreateLogGroup` plus stream and event writes across *every*
   * log group in the account (AwsSolutions-IAM4). This function already has a
   * log group declared for it, so it needs neither the group-creation right nor
   * access to anyone else's logs. Scoping to the one group is a strict
   * narrowing and costs nothing. Do not replace this with the default to
   * shorten the construct.
   */
  private createExecutionRole(id: string): iam.Role {
    const role = new iam.Role(this, "ServiceRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        `Execution role for the ${id} scheduled job. Writes its own log group; ` +
        "every other grant is added by the consuming stack.",
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        // Lambda creates one stream per concurrent execution under this group,
        // so the stream segment cannot be named ahead of time.
        resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:log-stream:*`],
      }),
    );

    suppressNagRules(role, [
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(
          this,
          this.logGroup.logGroupArn,
        )}:log-stream:*]`,
        reason:
          "Lambda creates one log stream per concurrent execution with a " +
          "service-generated name, so the stream segment cannot be enumerated at " +
          "synth. The wildcard is bounded to this function's own log group, which " +
          "is strictly narrower than the AWSLambdaBasicExecutionRole managed policy " +
          "this role exists to replace (ADR-0007).",
      },
    ]);

    return role;
  }

  /**
   * EventBridge Scheduler, not an `events.Rule`. Scheduler carries retry and
   * dead-letter configuration per schedule rather than per target, and costs
   * nothing at this volume.
   */
  private createSchedule(props: ScheduledJobProps): scheduler.Schedule {
    const stack = Stack.of(this);

    // aws-cdk-lib creates the target's invoke role at *stack* scope, with an ID
    // derived from a hash of the resolved function ARN, and hands back no
    // reference to it. Diffing the stack's children across the Schedule
    // constructor is the only way to reach the node that needs the suppression
    // below without hardcoding that hash.
    const before = new Set(stack.node.children.map((child) => child.node.id));

    const schedule = new scheduler.Schedule(this, "Schedule", {
      schedule: toScheduleExpression(props.schedule),
      target: new LambdaInvoke(this.fn, {
        retryAttempts: props.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
        maxEventAge: props.maxEventAge ?? DEFAULT_MAX_EVENT_AGE,
      }),
      description: props.scheduleDescription ?? props.description,
    });

    this.suppressTargetRoleFinding(stack, before);

    return schedule;
  }

  private suppressTargetRoleFinding(stack: Stack, before: ReadonlySet<string>): void {
    const targetRole = stack.node.children.find(
      (child): child is iam.Role =>
        child instanceof iam.Role &&
        child.node.id.startsWith(SCHEDULER_TARGET_ROLE_PREFIX) &&
        !before.has(child.node.id),
    );

    if (targetRole === undefined) {
      throw new Error(
        `ScheduledJob "${this.node.path}" could not find the ` +
          `${SCHEDULER_TARGET_ROLE_PREFIX}* role aws-cdk-lib creates for a schedule ` +
          "target. Its construct ID is generated by aws-cdk-lib and may have changed " +
          "in an upgrade; the AwsSolutions-IAM5 suppression on the invoke grant has " +
          "nowhere to attach.",
      );
    }

    // The `<arn>:*` form is how the aws-scheduler-targets L2 grants invoke
    // across a function's aliases and versions. Not configurable from here.
    suppressNagRules(targetRole, [
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, this.fn.functionArn)}:*]`,
        reason:
          "The trailing :* covers this one function's versions and aliases, which " +
          "is what aws-cdk-lib's LambdaInvoke target generates and cannot be " +
          "narrowed through any prop. The grant is lambda:InvokeFunction on a " +
          "single function whose own execution role is scoped to its log group plus " +
          "whatever the consuming stack grants it, so the widest reading of the " +
          "wildcard is 'may invoke an older copy of the same handler' (ADR-0007).",
      },
    ]);
  }
}

function toScheduleExpression(schedule: ScheduledJobSchedule): scheduler.ScheduleExpression {
  return schedule instanceof Duration ? scheduler.ScheduleExpression.rate(schedule) : schedule;
}
