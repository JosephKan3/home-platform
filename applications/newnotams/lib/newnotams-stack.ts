/**
 * NewNotamsStack — newnotams.net on Lambda + CloudFront via OpenNext, plus
 * the hourly notification sweep (Phase 1 action plan §3).
 *
 * The app's own source (`JosephKan3/NewNotams.Net`) stays a separate repo,
 * checked out at deploy time — the same pattern Phase 0 used for the
 * personal site. What lives here is CDK only: `OpenNextSite` for the app
 * itself, `ScheduledJob` for the cron replacement, and the grants that make
 * this *this* application rather than a generic OpenNext deployment.
 *
 * Two Lambdas, not one. OpenNext's server function (inside `OpenNextSite`)
 * handles HTTP requests; the notify sweep has no HTTP request behind it at
 * all — EventBridge Scheduler invokes it directly — so it is its own small
 * function that imports the app's `lib/notify.ts`/`lib/push.ts` directly,
 * rather than a warm-path invocation of the full Next.js server bundle for
 * a job that was never a request. See the Phase 1 action plan §2 (B2) for
 * why this split was confirmed against OpenNext's own docs rather than
 * assumed, and lambda/notify/index.ts (app repo) for the handler itself.
 */

import { CfnOutput, Duration, Fn, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { DEFAULT_OWNER, applyPlatformTags, domains, profileFor, ssmPaths } from "@platform/config";
import { OpenNextSite, ScheduledJob, suppressNagRules } from "@platform/constructs";
import * as path from "node:path";
import type { Env, EnvProfile } from "@platform/config";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** The application name, used for tags and the SSM parameter namespace. */
export const APP_NAME = "newnotams";

/**
 * How often the notify sweep runs. Matches the hour-granularity schedule
 * design already stored per user (`ScheduleConfig.notifyHours`, app repo
 * `lib/notify.ts`) — running more often would invoke the Lambda for
 * nothing every time, since `getSchedulesDueAt` only ever matches once per
 * hour per user; running less often would miss some users' chosen hours
 * entirely.
 */
export const NOTIFY_INTERVAL = Duration.hours(1);

/**
 * SSM parameters, seeded out of band (Phase 1 action plan §3, C1).
 * `CRON_SECRET` is deliberately absent — it has no AWS equivalent, since
 * EventBridge invokes the Lambda directly and there is no public endpoint
 * for it to protect.
 *
 * All eight are `String`, **not `SecureString`**, except `vapidPrivateKey`
 * — this needed two real, live-deploy failures to arrive at, not a single
 * design decision, so the history is worth keeping:
 *
 * 1. They were seeded as `SecureString` initially (the action plan's own
 *    §3 C1 commands said so for six of the eight).
 * 2. `StringParameter.valueForStringParameter` — the obvious way to read
 *    them into a Lambda environment variable — fails synth outright for
 *    anything stored as `SecureString`: "Parameters [...] referenced by
 *    template have types not supported by CloudFormation." Hit this on
 *    the first real deploy, before any resource was created.
 * 2. `SecretValue.ssmSecure(...).unsafeUnwrap()` looked like the fix — it
 *    is `SecretValue`'s own documented, intended use case — but
 *    CloudFormation's actual change-set creation rejects `ssm-secure`
 *    dynamic references in `Lambda::Function`'s `Environment.Variables`
 *    specifically; that resource/property pair is not on the short, fixed
 *    allowlist AWS documents for where `ssm-secure` works at all (RDS
 *    `MasterUserPassword`, IAM User `LoginProfile.Password`, a few others
 *    — never Lambda). Hit this on the second real deploy.
 * 3. `StringParameter.valueFromLookup` — a real `ssm:GetParameter` call
 *    made *during synth*, baking the result into the template as a
 *    literal — actually deploys. But it does not decrypt: for a
 *    `SecureString` parameter this bakes in the **raw KMS ciphertext**,
 *    not the plaintext, silently. Nothing in CDK warns about this. The
 *    resulting Lambda ran with `AUTH_GOOGLE_ID` set to an encrypted blob
 *    instead of a real client ID — Google's OAuth endpoint correctly
 *    rejected it (`Error 401: invalid_client`), which is how this was
 *    caught: a real end-to-end sign-in attempt, not a unit test or a
 *    code read, surfaced it. `valueForSecureStringParameter` (the
 *    version-pinned alternative) is itself deprecated in favor of
 *    `SecretValue.ssmSecure()` — the same dead end as step 2.
 *
 * No CDK/CloudFormation-level mechanism gets a `SecureString`'s real,
 * decrypted value into a Lambda environment variable, full stop. The only
 * two working alternatives are: re-seed as plain `String` (accepted here
 * — IAM already restricts which roles can `ssm:GetParameter` on these
 * names regardless of type, so the practical access-control difference is
 * small, and this app's threat model does not call for KMS-at-rest on top
 * of that), or have the Lambda fetch and decrypt the parameter itself at
 * runtime (`oanda-fetcher`'s pattern, rejected here because `auth.ts`
 * reads `process.env` synchronously at module load, before any runtime
 * code this construct controls would get a chance to inject a value).
 *
 * `vapidPrivateKey` is still `SecureString` as of this writing — re-seeding
 * it was the one step not yet done when this was fixed, since it affects
 * only push notifications, not sign-in. It will hit the exact ciphertext
 * problem above the next time `cdk.context.json` is cleared and this stack
 * is redeployed; re-seed it as `String` before that happens, or push
 * notifications will silently fail with a garbled key rather than erroring
 * clearly.
 */
export const newNotamsParameterNames = {
  googleClientId: `/${APP_NAME}/auth/google-id`,
  googleClientSecret: `/${APP_NAME}/auth/google-secret`,
  authSecret: `/${APP_NAME}/auth/secret`,
  vapidPublicKey: `/${APP_NAME}/push/vapid-public-key`,
  vapidPrivateKey: `/${APP_NAME}/push/vapid-private-key`,
  vapidSubject: `/${APP_NAME}/push/vapid-subject`,
  kvUrl: `/${APP_NAME}/kv/url`,
  kvToken: `/${APP_NAME}/kv/token`,
} as const;

export interface NewNotamsStackProps extends StackProps {
  readonly envName: Env;

  /**
   * Directory holding `npx open-next build`'s output for the app repo.
   *
   * Defaults to a sibling checkout of the app repo, the same convention
   * `SiteStack.siteSourcePath` uses for the personal site. A prop, not a
   * constant, because CI synthesizes this stack without the app checked
   * out at all.
   */
  readonly openNextOutputPath?: string;

  /** Path to the app repo's root. Used to locate `lambda/notify/index.ts`. */
  readonly appRepoPath?: string;

  /** See `OpenNextSiteProps.usePlaceholderSource`. */
  readonly usePlaceholderSource?: boolean;

  /**
   * Where the notify-failure alarm (Phase 1 action plan §5) sends email.
   *
   * Same convention as `GovernanceStack`'s `alertEmail` prop
   * (`josephkan3+aws-alerts@gmail.com` in practice) — optional so a test or
   * CI synth doesn't need a real inbox, but every real deploy should set it,
   * since an alarm with no subscriber is a missed hourly sweep nobody is
   * ever told about.
   */
  readonly alertEmail?: string;
}

export class NewNotamsStack extends Stack {
  readonly site: OpenNextSite;
  readonly bucket: s3.Bucket;
  readonly accessLogBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly notifyJob: ScheduledJob;
  readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: NewNotamsStackProps) {
    super(scope, id, props);

    const profile = profileFor(props.envName);
    const appRepoPath = props.appRepoPath ?? defaultAppRepoPath();

    this.site = new OpenNextSite(this, "Site", {
      domainNames: [domains.product, `www.${domains.product}`],
      // ADR-0004: the certificate ARN crosses the platform/application seam
      // via SSM, never a CloudFormation export — see SiteStack's identical
      // comment.
      certificate: ssm.StringParameter.valueForStringParameter(
        this,
        ssmPaths.certificateArn(domains.product),
      ),
      profile,
      openNextOutputPath: props.openNextOutputPath ?? defaultOpenNextOutputPath(appRepoPath),
      usePlaceholderSource: props.usePlaceholderSource,
      comment: `${domains.product} — Next.js on Lambda (OpenNext) plus hourly notify sweep.`,
    });

    this.bucket = this.site.bucket;
    this.accessLogBucket = this.site.logBucket;
    this.distribution = this.site.distribution;

    this.suppressDistributionFindings();
    this.grantServerSecrets();

    this.notifyJob = this.createNotifyJob(
      profile,
      appRepoPath,
      props.usePlaceholderSource === true,
    );
    this.grantNotifyJobSecrets(this.notifyJob);

    this.alertTopic = this.createNotifyFailureAlarm(this.notifyJob, props.alertEmail);

    applyPlatformTags(this, { app: APP_NAME, env: profile.env, owner: DEFAULT_OWNER });

    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description:
        "Pass this to the newnotams.net DnsStack as -c cloudFrontDomainName=... for the apex cutover (Phase 1 action plan §4, D5).",
    });
  }

  /**
   * Same two cost/threat-model judgement calls `SiteStack` makes for
   * josephkan.ca, re-made here rather than inherited: a product with
   * sign-in, saved searches and a database-backed schedule is a different
   * threat model than a static portfolio page, so neither finding gets a
   * blanket "same as the other site" suppression.
   */
  private suppressDistributionFindings(): void {
    suppressNagRules(this.distribution, [
      {
        id: "AwsSolutions-CFR1",
        reason:
          "Geo restriction is off. NewNotams serves Canadian aviation weather/NOTAM " +
          "data to pilots who may be planning flights from anywhere; there is no " +
          "jurisdiction whose traffic is safer blocked than served, and the data " +
          "behind it (NOTAMs, METARs, TAFs) is already public via Nav Canada's own " +
          "API (ADR-0007).",
      },
      {
        id: "AwsSolutions-CFR2",
        reason:
          "No WAF yet. A web ACL is ~$5/mo base plus $1/rule and $0.60/M requests, " +
          "against a Phase 1 budget of $8-15/mo total (docs/phase-1-action-plan.md) — " +
          "a large fraction of the whole phase's budget for one app. This app does " +
          "have real attack surface a WAF would address (sign-in, an open weather " +
          "proxy at /api/weather pending its own rate limit — Phase 1 action plan " +
          "§6) that josephkan.ca's CFR2 suppression explicitly says does not apply " +
          "to a static site. Revisit this suppression once real traffic volume is " +
          "observed; it is accepted for the initial migration, not indefinitely.",
      },
    ]);
  }

  /**
   * The app's own secrets (Google OAuth, VAPID, Upstash) — `OpenNextSite`
   * owns none of this; see its "What it does not own" doc comment.
   *
   * Populated as Lambda environment variables at deploy time, not fetched
   * by the handler at runtime the way oanda-fetcher fetches its OANDA
   * credentials. That alternative was considered and rejected for this
   * function specifically: Auth.js/next-auth read these values
   * *synchronously at module load* inside `auth.ts` (`process.env.AUTH_GOOGLE_ID`
   * evaluated as the module is first imported, not inside any async handler
   * this construct controls), so they must already be present as plain
   * environment variables before the Next.js server code runs at all —
   * there is no hook to inject an awaited SSM call into someone else's
   * module-load code path.
   *
   * All of these are `String` parameters, which is itself the result of a
   * real, hard-won finding — see `newNotamsParameterNames`'s doc comment
   * for the three things tried and failed before arriving at "seed as
   * `String`, not `SecureString`." `valueForStringParameter` is the
   * ordinary, correct API for a plain `String` parameter and has none of
   * `valueFromLookup`'s caveats (no synth-time AWS call, no
   * `cdk.context.json` entry, no stale-cache risk across redeploys).
   *
   * `vapidPrivateKey` is the one exception: it is still `SecureString` as
   * of this writing (re-seeding it was the one step not yet done when the
   * rest of this was fixed — see its own prop in `newNotamsParameterNames`),
   * so it still uses `valueFromLookup` and will bake in raw ciphertext
   * rather than the real key the next time `cdk.context.json` is cleared
   * and this stack redeploys, exactly as `googleClientId` did before it was
   * re-seeded. Re-seed it as `String` before that happens.
   */
  private grantServerSecrets(): void {
    const fn = this.site.serverFunction;

    fn.addEnvironment(
      "AUTH_GOOGLE_ID",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.googleClientId),
    );
    fn.addEnvironment(
      "AUTH_GOOGLE_SECRET",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.googleClientSecret),
    );
    fn.addEnvironment(
      "AUTH_SECRET",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.authSecret),
    );
    fn.addEnvironment(
      "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.vapidPublicKey),
    );
    fn.addEnvironment(
      "VAPID_PRIVATE_KEY",
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.vapidPrivateKey),
    );
    fn.addEnvironment(
      "VAPID_SUBJECT",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.vapidSubject),
    );
    fn.addEnvironment(
      "KV_REST_API_URL",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.kvUrl),
    );
    fn.addEnvironment(
      "KV_REST_API_TOKEN",
      ssm.StringParameter.valueForStringParameter(this, newNotamsParameterNames.kvToken),
    );

    this.grantSsmRead(fn.role!, "ServerFunction", [
      newNotamsParameterNames.googleClientId,
      newNotamsParameterNames.googleClientSecret,
      newNotamsParameterNames.authSecret,
      newNotamsParameterNames.vapidPublicKey,
      newNotamsParameterNames.vapidPrivateKey,
      newNotamsParameterNames.vapidSubject,
      newNotamsParameterNames.kvUrl,
      newNotamsParameterNames.kvToken,
    ]);
  }

  /**
   * The notify sweep: schedule lookup, Nav Canada fetch, push send. Needs
   * only the Upstash and VAPID parameters — it never touches Auth.js at
   * all (no sign-in happens inside a cron invocation), so it gets a
   * strictly smaller grant than the server function.
   */
  private createNotifyJob(
    profile: EnvProfile,
    appRepoPath: string,
    usePlaceholderSource: boolean,
  ): ScheduledJob {
    // See placeholder-notify-handler.ts's doc comment: ScheduledJob.entry
    // always resolves a real file on disk, unlike OpenNextSite, which has
    // its own usePlaceholderSource branch internally. This stack supplies
    // the equivalent behavior at the call site instead.
    //
    // projectRoot must point at whichever repo the entry file actually
    // lives in — NodejsFunction requires entry to be under projectRoot
    // (PathNotUnderRoot otherwise) and defaults to this monorepo's own
    // lockfile directory, which is wrong for the real (non-placeholder)
    // entry: it lives in the separate NewNotams.Net app repo, checked out
    // as a sibling, not under this monorepo at all. See
    // ScheduledJobProps.projectRoot's doc comment.
    const entry = usePlaceholderSource
      ? path.join(__dirname, "placeholder-notify-handler.ts")
      : path.join(appRepoPath, "lambda", "notify", "index.ts");
    const projectRoot = usePlaceholderSource ? undefined : appRepoPath;
    // The app repo is npm-based (its own package-lock.json, not this
    // monorepo's pnpm-lock.yaml), and that lockfile must live under
    // projectRoot the same as entry does.
    const depsLockFilePath = usePlaceholderSource
      ? undefined
      : path.join(appRepoPath, "package-lock.json");

    return new ScheduledJob(this, "Notify", {
      entry,
      projectRoot,
      depsLockFilePath,
      schedule: NOTIFY_INTERVAL,
      profile,
      description: "Hourly NOTAM notification sweep — direct invoke, no public endpoint.",
      scheduleDescription: "Hourly NewNotams notify sweep. Not real-time; matches notifyHours.",
      // See grantServerSecrets's comment for the full account of why these
      // are String parameters, not SecureString, and why vapidPrivateKey
      // alone still uses valueFromLookup (it has not been re-seeded yet).
      environment: {
        KV_REST_API_URL: ssm.StringParameter.valueForStringParameter(
          this,
          newNotamsParameterNames.kvUrl,
        ),
        KV_REST_API_TOKEN: ssm.StringParameter.valueForStringParameter(
          this,
          newNotamsParameterNames.kvToken,
        ),
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: ssm.StringParameter.valueForStringParameter(
          this,
          newNotamsParameterNames.vapidPublicKey,
        ),
        VAPID_PRIVATE_KEY: ssm.StringParameter.valueFromLookup(
          this,
          newNotamsParameterNames.vapidPrivateKey,
        ),
        VAPID_SUBJECT: ssm.StringParameter.valueForStringParameter(
          this,
          newNotamsParameterNames.vapidSubject,
        ),
      },
    });
  }

  private grantNotifyJobSecrets(job: ScheduledJob): void {
    this.grantSsmRead(job.role, "Notify", [
      newNotamsParameterNames.kvUrl,
      newNotamsParameterNames.kvToken,
      newNotamsParameterNames.vapidPublicKey,
      newNotamsParameterNames.vapidPrivateKey,
      newNotamsParameterNames.vapidSubject,
    ]);
  }

  /**
   * "One alarm that matters more than the rest" (Phase 1 action plan §5):
   * the notify job's own `lambda/notify/index.ts` only throws when every
   * user's notification failed this sweep (a partial failure is logged as
   * a warning but does not fail the invocation, on purpose — see that
   * file's own comment on why a retry-everyone response to a partial
   * failure would be worse than the partial failure itself). An uncaught
   * throw is exactly what Lambda's own `Errors` metric counts, so alarming
   * on it directly needs no custom metric filter or EventBridge rule — the
   * signal already exists.
   *
   * This does not, by itself, cover "the schedule failed to invoke the
   * Lambda at all" (an IAM or EventBridge-side failure, not a Lambda
   * error) — `ScheduledJob` does not expose the underlying
   * `scheduler.CfnSchedule` to alarm on its own invocation-failure metric
   * separately, and CDK wires the schedule's IAM permission itself, making
   * that failure mode unlikely enough that it is out of scope for the
   * minimum viable version this stage is asking for (Phase 1 action plan
   * §5: "the basic... alarm", not the full SLO/burn-rate machinery).
   *
   * A hard-coded threshold of 1 error in a 1-hour period, matching
   * `NOTIFY_INTERVAL` exactly: each invocation either throws (1) or does
   * not (0), so this alarms on the very first failed sweep rather than
   * waiting for a pattern — a missed weather brief is exactly the kind of
   * thing the roadmap says should not fail silently even once.
   */
  private createNotifyFailureAlarm(job: ScheduledJob, alertEmail?: string): sns.Topic {
    const topic = new sns.Topic(this, "AlertTopic", {
      displayName: `${APP_NAME} alerts`,
      // AwsSolutions-SNS3: denies Publish over plain HTTP via a topic policy
      // condition. CloudWatch's own alarm-to-SNS publish already uses TLS;
      // this only closes off anyone else trying to publish insecurely.
      enforceSSL: true,
    });
    if (alertEmail !== undefined) {
      topic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail));
    }

    const alarm = new cloudwatch.Alarm(this, "NotifyFailureAlarm", {
      alarmDescription:
        "The hourly NOTAM notify sweep failed outright (every user's notification failed) " +
        "for at least one invocation. See lambda/notify/index.ts (app repo) for what counts " +
        "as a full failure versus a logged partial one.",
      metric: job.fn.metricErrors({ period: NOTIFY_INTERVAL, statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // A period with no invocation at all (nothing scheduled, or the
      // schedule itself never fired) reports no datapoints, not a zero —
      // treating that as "not breaching" is correct here: EventBridge
      // Scheduler invokes hourly unconditionally, so a true "did not run"
      // is a different, rarer failure mode (see this method's own doc
      // comment) that this alarm does not claim to cover.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
    alarm.addOkAction(new cloudwatchActions.SnsAction(topic));

    return topic;
  }

  /**
   * Named parameters only, exactly like `SiteStack.grantFetcher`'s identical
   * comment: `/newnotams/*` would be tidier and would also grant every
   * future secret this application ever has.
   */
  private grantSsmRead(role: iam.IRole, idPrefix: string, parameterNames: string[]): void {
    const arns = parameterNames.map((name) => this.parameterArn(name));
    role.attachInlinePolicy(
      new iam.Policy(this, `${idPrefix}SsmReadPolicy`, {
        statements: [
          new iam.PolicyStatement({
            sid: "ReadNamedParameters",
            actions: ["ssm:GetParameter", "ssm:GetParameters"],
            resources: arns,
          }),
        ],
      }),
    );
  }

  private parameterArn(parameterName: string): string {
    return Fn.join("", [
      `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter`,
      parameterName,
    ]);
  }
}

/**
 * Where the app repo lives before any `git subtree`-style migration: a
 * sibling checkout, matching `SiteStack.defaultSiteSourcePath`'s identical
 * convention. The directory name is `newnotams`, not `NewNotams.Net` — it
 * predates the GitHub repo rename (Phase 1 action plan §0/Stage A) and was
 * never renamed locally; this default matches the real checkout, not the
 * current repo name.
 */
function defaultAppRepoPath(): string {
  return path.join(__dirname, "..", "..", "..", "..", "newnotams");
}

function defaultOpenNextOutputPath(appRepoPath: string): string {
  return path.join(appRepoPath, ".open-next");
}
