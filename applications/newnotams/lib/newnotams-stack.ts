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
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
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
 * Only `vapidPublicKey` and `vapidSubject` are plain `String` parameters —
 * the public VAPID key is, by design, public (it ships to the browser),
 * and the subject is a `mailto:` address, not a secret. Every other name
 * here, **including `googleClientId`**, is `SecureString` and must be read
 * with `StringParameter.valueFromLookup` — see `grantServerSecrets`'s
 * comment for the full account of why neither of the two more obvious APIs
 * works for a `SecureString` baked into a Lambda environment variable.
 * `googleClientId` was deliberately seeded as `SecureString` (the action
 * plan's own §3 C1 commands say so); an earlier version of this comment
 * claimed it was non-secret and safe as plain `String`, which was wrong
 * and caused a real deploy failure — "Parameters [...] referenced by
 * template have types not supported by CloudFormation" — since the actual
 * stored type was `SecureString` all along.
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
}

export class NewNotamsStack extends Stack {
  readonly site: OpenNextSite;
  readonly bucket: s3.Bucket;
  readonly accessLogBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly notifyJob: ScheduledJob;

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
   * Getting the *value itself* into that environment variable turned out to
   * have no good answer, only a real AWS-imposed constraint with one
   * working option. Two were tried and failed, found out via real deploy
   * attempts, not documentation review alone:
   *
   * 1. `StringParameter.valueForStringParameter` — generates a
   *    CloudFormation template *Parameter* of SSM type
   *    `AWS::SSM::Parameter::Value<String>`. CloudFormation rejects this
   *    outright for anything stored as `SecureString`: "Parameters [...]
   *    referenced by template have types not supported by CloudFormation."
   *    Hit this on the first deploy attempt, before any resource was
   *    created.
   * 2. `SecretValue.ssmSecure(...).unsafeUnwrap()` — generates a
   *    `{{resolve:ssm-secure:...}}` dynamic reference. This looks like
   *    exactly the documented, intended way to use a `SecretValue` as a
   *    Lambda environment variable (`SecretValue`'s own doc comment names
   *    this exact case), and CDK's synth-time template validator only
   *    *warns* about it ("can only be used in resource properties" — true,
   *    and `Environment.Variables` on an `AWS::Lambda::Function` *is* a
   *    resource property). But CloudFormation's actual change-set creation
   *    rejects it anyway, with "SSM Secure reference is not supported in:
   *    AWS::Lambda::Function/Properties/Environment/Variables/...". AWS's
   *    own dynamic-references documentation confirms why: `ssm-secure`
   *    dynamic references work only on a short, fixed allowlist of
   *    resource/property pairs (RDS `MasterUserPassword`, IAM User
   *    `LoginProfile.Password`, ElastiCache `AuthToken`, a few others) —
   *    Lambda's `Environment.Variables` is not on that list at all, for
   *    any resource type, full stop. Hit this on the second deploy attempt.
   *
   * What actually works: `StringParameter.valueFromLookup`, which performs
   * a real `ssm:GetParameter` call *during synth* (CDK's own "environmental
   * context provider" mechanism — the same machinery behind `fromLookup`
   * AZ/AMI context lookups) and bakes the resolved plaintext directly into
   * the template as a literal string, before any CloudFormation API call
   * happens at all. This genuinely means the secret value is visible in the
   * synthesized template and in `cdk.context.json` (where CDK caches the
   * looked-up value across runs) — a real, deliberate tradeoff forced by
   * the constraint above, not a security regression chosen for convenience.
   * `cdk.context.json` is gitignored repo-wide specifically because of this.
   *
   * `googleClientId`, `vapidPublicKey` and `vapidSubject` are plain `String`
   * parameters (not `SecureString` — see `newNotamsParameterNames`'s own
   * doc comment on why), so they keep using the ordinary, non-secret
   * `valueForStringParameter`, which has no such restriction.
   */
  private grantServerSecrets(): void {
    const fn = this.site.serverFunction;

    fn.addEnvironment(
      "AUTH_GOOGLE_ID",
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.googleClientId),
    );
    fn.addEnvironment(
      "AUTH_GOOGLE_SECRET",
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.googleClientSecret),
    );
    fn.addEnvironment(
      "AUTH_SECRET",
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.authSecret),
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
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.kvUrl),
    );
    fn.addEnvironment(
      "KV_REST_API_TOKEN",
      ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.kvToken),
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
      // See grantServerSecrets's comment for the full account of why this
      // needs StringParameter.valueFromLookup (a real synth-time
      // ssm:GetParameter call, baked into the template as a literal) rather
      // than either StringParameter.valueForStringParameter (fails synth
      // for SecureString) or SecretValue.ssmSecure (CloudFormation rejects
      // ssm-secure dynamic references in Lambda Environment.Variables
      // specifically — confirmed by an actual deploy failure, not merely a
      // CDK validator warning).
      environment: {
        KV_REST_API_URL: ssm.StringParameter.valueFromLookup(this, newNotamsParameterNames.kvUrl),
        KV_REST_API_TOKEN: ssm.StringParameter.valueFromLookup(
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
