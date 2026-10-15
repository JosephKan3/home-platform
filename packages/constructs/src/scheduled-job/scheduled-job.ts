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
 *
 * `progressiveDelivery` is a fifth thing, opt-in: a CodeDeploy canary in
 * front of the schedule's invoke target (Phase 2, roadmap's "highest-signal
 * item"). See that prop's own doc comment for the mechanics — the short
 * version is that nothing here is reusable without the caller's own
 * CloudWatch alarm, since "did this job fail" is always application-
 * specific and this construct has no opinion on it.
 */

import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import { flattenForNagId, suppressNagRules } from "../nag/index.js";
import type { EnvProfile } from "@josephkan3/config";

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

  /**
   * The directory `NodejsFunction` treats as the project root for dependency
   * resolution and lockfile lookup.
   *
   * `NodejsFunction` defaults to walking up from `entry` to find a lockfile
   * and requires `entry` to live under that directory
   * (`PathNotUnderRoot` otherwise). That default assumes the handler lives
   * inside this monorepo. A job whose `entry` lives in a separate, checked-
   * out-at-deploy-time application repo (the `personal-website`/
   * `NewNotams.Net` pattern — see ADR-0004) needs this set explicitly to
   * that repo's own root, or synth fails outright before bundling is even
   * attempted. Omit it for a job whose entry is already inside this
   * monorepo.
   */
  readonly projectRoot?: string;

  /**
   * Path to the lockfile `NodejsFunction` resolves dependency versions
   * against.
   *
   * Like `projectRoot`, this must live under `projectRoot` or synth fails
   * with `PathNotUnderRoot`. Defaults to this monorepo's own lockfile,
   * which is correct for a job whose `entry` is inside this monorepo and
   * wrong otherwise — a job in a separate application repo needs this set
   * to that repo's own lockfile.
   */
  readonly depsLockFilePath?: string;

  /** How often the job runs. */
  readonly schedule: ScheduledJobSchedule;

  /** Drives log retention. See `@josephkan3/config`. */
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

  /**
   * Enable a CodeDeploy canary in front of the schedule's invoke target.
   *
   * Without this, a deploy that breaks the handler goes live for every
   * future invocation instantly — CloudFormation just repoints
   * EventBridge at the new `$LATEST` code with no gap. With it: a new
   * `Version` is published, an `Alias` (named `"live"`) is what the
   * schedule actually targets, and `UpdatePolicy: codeDeployLambdaAliasUpdate`
   * on that alias means CloudFormation hands the traffic shift to
   * CodeDeploy instead of doing it itself. `deploymentConfig` controls how
   * gradual that shift is (default: 10% for 5 minutes, then the rest).
   *
   * Requires `deploymentAlarm`: a canary with no alarm attached shifts
   * traffic on a timer and never rolls back on its own, which is a canary
   * in name only. Synth throws if this is `true` without one, rather than
   * silently deploying unmonitored — this is deliberately not a silent
   * default for the same reason `ScheduledJob` has no ambient grants.
   *
   * Expected on `profile.progressiveDelivery` (prod: true, dev: false) —
   * see `@josephkan3/config`'s `EnvProfile`. Passed explicitly rather than
   * read from `profile` directly inside this construct, because a future
   * job might reasonably want this off in prod too (e.g. one with no
   * sensible canary alarm) — the profile sets the default a caller should
   * follow, not a mandate this construct enforces.
   */
  readonly progressiveDelivery?: boolean;

  /**
   * The alarm CodeDeploy watches during the canary window.
   *
   * Optional even when `progressiveDelivery` is true: omitted, this
   * construct builds its own default from `fn.metricErrors()` — threshold
   * 1 in one evaluation period, matching the schedule's own interval
   * (`props.schedule`, converted to seconds), on the theory that "this
   * invocation threw" is the right default definition of "this job is
   * broken" for the overwhelming majority of scheduled jobs, including
   * the one this prop was built for (`NewNotamsStack`'s notify sweep).
   *
   * There is no *ordering* problem building this internally the way there
   * would be for a caller: `fn` already exists by the time this prop is
   * read, inside this construct's own constructor — unlike a caller, who
   * would need `fn` before `ScheduledJob` exists to build the same alarm,
   * a real chicken-and-egg this design deliberately avoids forcing on
   * every consumer.
   *
   * Pass an explicit alarm only when the default's definition of "broken"
   * is wrong for a specific job — e.g. a job whose real failure signal is
   * a custom metric, not an uncaught throw. `NewNotamsStack`'s own
   * `NotifyFailureAlarm` (the one that pages a human, via SNS) is
   * deliberately NOT the same CloudFormation resource as this one: they
   * watch the identical metric and threshold, so they fire at the same
   * real-world moment, but conflating "the thing that pages a human" with
   * "the thing CodeDeploy watches during a 5-minute canary window" would
   * make each harder to reason about alone than two alarms with one
   * shared cause.
   */
  readonly deploymentAlarm?: cloudwatch.IAlarmRef;

  /**
   * How the canary shifts traffic. Default
   * `LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES` (CodeDeploy's own
   * default for `LambdaDeploymentGroup` — stated explicitly here so it is
   * discoverable from this construct's props rather than only from
   * aws-cdk-lib's).
   */
  readonly deploymentConfig?: codedeploy.ILambdaDeploymentConfig;
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

  /**
   * Present only when `progressiveDelivery` is true. The alias EventBridge
   * actually targets — not `fn` directly. A deploy that changes the
   * handler publishes a new `Version` and repoints this alias; CodeDeploy
   * owns the traffic shift from there.
   */
  readonly liveAlias?: lambda.Alias;

  /** Present only when `progressiveDelivery` is true. */
  readonly deploymentGroup?: codedeploy.LambdaDeploymentGroup;

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
      projectRoot: props.projectRoot,
      depsLockFilePath: props.depsLockFilePath,
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

    if (props.progressiveDelivery) {
      const { alias, deploymentGroup } = this.createProgressiveDelivery(props);
      this.liveAlias = alias;
      this.deploymentGroup = deploymentGroup;
    }

    this.schedule = this.createSchedule(props, this.liveAlias);
  }

  /**
   * `fn.currentVersion` + an `Alias` + a `LambdaDeploymentGroup` watching
   * `deploymentAlarm`. The alias is what `createSchedule` targets instead
   * of `fn` — CodeDeploy only intercepts an alias's traffic shift, never a
   * bare function's.
   *
   * Named `"live"` rather than something environment-specific: there is
   * exactly one alias per `ScheduledJob` instance, and the instance itself
   * already lives inside whichever stack/environment deployed it.
   */
  private createProgressiveDelivery(
    props: ScheduledJobProps,
  ): { alias: lambda.Alias; deploymentGroup: codedeploy.LambdaDeploymentGroup } {
    const alias = new lambda.Alias(this, "LiveAlias", {
      aliasName: "live",
      version: this.fn.currentVersion,
    });

    const deploymentAlarm = props.deploymentAlarm ?? this.createDefaultDeploymentAlarm(props.schedule);

    const deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, "DeploymentGroup", {
      alias,
      deploymentConfig: props.deploymentConfig ?? codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [deploymentAlarm],
    });

    // `LambdaDeploymentGroup`'s constructor unconditionally attaches
    // `AWSCodeDeployRoleForLambdaLimited` to the service role it creates for
    // itself — confirmed by reading aws-cdk-lib's own source
    // (deployment-group.js: `this.role.addManagedPolicy(...)`), not a choice
    // this construct makes or could avoid through any prop. It is AWS's own
    // purpose-built, scoped-down managed policy for exactly this job
    // (CodeDeploy driving a Lambda alias's traffic shift), not a broad
    // administrative one — the "Limited" in its name is AWS's own
    // acknowledgment of the same scoping concern AwsSolutions-IAM4 raises.
    suppressNagRules(deploymentGroup.role, [
      {
        id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited]",
        reason:
          "aws-cdk-lib's LambdaDeploymentGroup attaches this unconditionally in its own " +
          "constructor; there is no prop to replace it with an inline policy. It is AWS's " +
          "purpose-scoped policy for CodeDeploy-driven Lambda alias traffic shifting, not a " +
          "broad administrative grant (ADR-0007).",
      },
    ]);

    return { alias, deploymentGroup };
  }

  /**
   * Built only when `progressiveDelivery` is true and the caller did not
   * pass their own `deploymentAlarm` — see that prop's doc comment for why
   * this exists and what it deliberately does not try to be (the alarm
   * that pages a human, which is the consuming stack's own concern).
   *
   * Mirrors the shape `NewNotamsStack.createNotifyFailureAlarm` already
   * hand-rolled before this construct could build it internally: Lambda's
   * own `Errors` metric, summed, threshold 1 — the first failed invocation
   * trips it, not a pattern. The period is `props.schedule` converted to
   * seconds when it is a plain interval (`Duration`); a `ScheduleExpression`
   * (cron, or a fixed-rate string) has no `Duration` to convert, so those
   * fall back to one minute — CloudWatch's shortest period — rather than
   * guessing an interval from an expression this construct does not parse.
   */
  private createDefaultDeploymentAlarm(schedule: ScheduledJobSchedule): cloudwatch.Alarm {
    const period = schedule instanceof Duration ? schedule : Duration.minutes(1);
    return new cloudwatch.Alarm(this, "DeploymentAlarm", {
      metric: this.fn.metricErrors({ period, statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
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
   *
   * Targets `liveAlias` instead of `fn` when progressive delivery is on —
   * CodeDeploy only intercepts a traffic shift on an alias's `UpdatePolicy`,
   * never a bare function's, so a schedule that kept targeting `fn` would
   * bypass the canary entirely and defeat the whole point of this prop.
   */
  private createSchedule(props: ScheduledJobProps, liveAlias?: lambda.Alias): scheduler.Schedule {
    const stack = Stack.of(this);

    // aws-cdk-lib creates the target's invoke role at *stack* scope, with an ID
    // derived from a hash of the resolved function ARN, and hands back no
    // reference to it. Diffing the stack's children across the Schedule
    // constructor is the only way to reach the node that needs the suppression
    // below without hardcoding that hash.
    const before = new Set(stack.node.children.map((child) => child.node.id));

    const schedule = new scheduler.Schedule(this, "Schedule", {
      schedule: toScheduleExpression(props.schedule),
      target: new LambdaInvoke(liveAlias ?? this.fn, {
        retryAttempts: props.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
        maxEventAge: props.maxEventAge ?? DEFAULT_MAX_EVENT_AGE,
      }),
      description: props.scheduleDescription ?? props.description,
    });

    this.suppressTargetRoleFinding(stack, before, liveAlias);

    return schedule;
  }

  /**
   * `Function.resourceArnsForGrantInvoke` grants `[functionArn, functionArn + ":*"]`
   * — the wildcard covers every alias/version, which is unavoidable when
   * the target is the bare function. `Alias`'s own `resourceArnsForGrantInvoke`
   * (via `QualifiedFunctionBase`) grants only `[aliasArn]` — a single,
   * concrete ARN, no wildcard — since an alias has no further
   * sub-resources to cover. Confirmed by reading both implementations
   * directly rather than assumed: the suppression below only applies to
   * the bare-function path, and is skipped entirely when `liveAlias` is
   * the target, because there is no finding to suppress.
   */
  private suppressTargetRoleFinding(
    stack: Stack,
    before: ReadonlySet<string>,
    liveAlias?: lambda.Alias,
  ): void {
    if (liveAlias !== undefined) {
      return;
    }

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
