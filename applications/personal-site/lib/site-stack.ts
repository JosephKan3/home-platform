/**
 * SiteStack — josephkan.ca on S3 + CloudFront, with the OANDA data path moved
 * off the request path entirely (Phase 0 action plan §7, Stage F).
 *
 * The shape of this stack follows from one decision: the OANDA JSON is written
 * into the *same bucket the site is served from*, under `data/`. That makes
 * the browser's fetch same-origin, so there is no CORS configuration, no
 * second origin, and no second distribution. The cost is that the bucket has
 * two writers — BucketDeployment for the static export, and the fetcher Lambda
 * for `data/*` — which is why the Lambda's write permission is scoped to the
 * `data/` prefix rather than the bucket.
 *
 * Everything generic about "a static site served securely from S3" now lives in
 * `StaticSite` (ADR-0008). What remains here is the part that is specific to
 * this site: the OANDA fetcher, its schedule, and the `/data/*` behaviour that
 * matches the fetcher's cadence.
 */

import { CfnOutput, Duration, Fn, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { DEFAULT_OWNER, applyPlatformTags, domains, profileFor, ssmPaths } from "@platform/config";
import {
  ACCESS_LOG_PREFIX,
  CLOUDFRONT_LOG_PREFIX,
  SCHEDULED_JOB_RUNTIME,
  ScheduledJob,
  StaticSite,
  flattenForNagId,
  suppressNagRules,
} from "@platform/constructs";
import * as path from "node:path";
import type { Env, EnvProfile } from "@platform/config";
import type { StackProps } from "aws-cdk-lib";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

/** The application name, used for tags and the SSM parameter namespace. */
export const APP_NAME = "personal-site";

/** Object keys the Lambda writes and the page fetches. Same bucket, same origin. */
export const DATA_PREFIX = "data";
export const RETURNS_KEY = `${DATA_PREFIX}/oanda-returns.json`;
export const TRADES_KEY = `${DATA_PREFIX}/oanda-trades.json`;

/**
 * How often the fetcher runs, and therefore how long `/data/*` may be cached.
 * These two must agree: a TTL longer than the schedule serves data that has
 * already been superseded, and a TTL shorter than it just adds origin requests
 * that return the same bytes.
 */
export const FETCH_INTERVAL = Duration.hours(1);
export const DATA_CACHE_TTL = Duration.minutes(5);

/**
 * Fetcher runtime, pinned platform-wide by `ScheduledJob` (ADR-0008). Node 24
 * is the newest runtime CDK 2.263 knows about, which is what `AwsSolutions-L1`
 * checks against; Node 20 was deprecated 2026-04-30. The handler uses only
 * native `fetch` and `AbortSignal.timeout`, both of which predate Node 20, so
 * nothing in it is version-sensitive. Re-exported so the test asserts a
 * constant rather than a string literal that goes stale.
 */
export const FETCHER_RUNTIME = SCHEDULED_JOB_RUNTIME;

// Log prefixes are owned by StaticSite. Re-exported so tests and any downstream
// log reader name them from one place.
export { ACCESS_LOG_PREFIX, CLOUDFRONT_LOG_PREFIX };

/** SSM SecureString parameters, seeded out of band. See the README. */
export const oandaParameterNames = {
  accountId: `/${APP_NAME}/oanda/account-id`,
  accessToken: `/${APP_NAME}/oanda/access-token`,
} as const;

export interface SiteStackProps extends StackProps {
  readonly envName: Env;

  /**
   * Directory holding the Next.js static export (`out/`).
   *
   * Defaults to a sibling checkout of the site repo, which is where it lives
   * until the `git subtree` migration. It is a prop rather than a constant
   * because CI synthesizes this stack without the site checked out at all.
   */
  readonly siteSourcePath?: string;

  /**
   * Deploy a generated placeholder instead of the real export.
   *
   * Synth must work with no site checkout: PR validation, cdk-nag and the unit
   * tests all run in an environment that has never built the Next.js app. The
   * alternative — skipping BucketDeployment when the directory is absent —
   * would mean CI validates a template that differs from the deployed one,
   * which defeats the point of validating it.
   */
  readonly usePlaceholderSource?: boolean;
}

export class SiteStack extends Stack {
  readonly site: StaticSite;
  readonly bucket: s3.Bucket;
  readonly accessLogBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly fetcherJob: ScheduledJob;
  readonly fetcher: NodejsFunction;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const profile = profileFor(props.envName);

    this.site = new StaticSite(this, "Site", {
      domainNames: [domains.platform, `www.${domains.platform}`],
      // ADR-0004: the certificate ARN crosses the platform/application seam via
      // SSM, never a CloudFormation export. An export would make DnsStack
      // undeletable and force lockstep deploys of DNS and this stack.
      certificate: ssm.StringParameter.valueForStringParameter(
        this,
        ssmPaths.certificateArn(domains.platform),
      ),
      profile,
      sourcePath: props.siteSourcePath ?? defaultSiteSourcePath(),
      usePlaceholderSource: props.usePlaceholderSource,
      comment: `${domains.platform} — static export plus scheduled OANDA JSON.`,
      additionalBehaviors: {
        // The whole design assumes the edge serves fresh-ish data. The default
        // long TTL would mean the hourly Lambda writes into a cache that
        // ignores it for a day.
        [`/${DATA_PREFIX}/*`]: new cloudfront.CachePolicy(this, "DataCachePolicy", {
          comment: "Short TTL matching the hourly OANDA write cadence.",
          defaultTtl: DATA_CACHE_TTL,
          minTtl: Duration.seconds(0),
          maxTtl: DATA_CACHE_TTL,
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
      },
    });

    this.bucket = this.site.bucket;
    this.accessLogBucket = this.site.logBucket;
    this.distribution = this.site.distribution;

    this.suppressDistributionFindings();

    this.fetcherJob = this.createFetcher(profile);
    this.fetcher = this.fetcherJob.fn;
    this.grantFetcher(this.fetcherJob);

    applyPlatformTags(this, { app: APP_NAME, env: profile.env, owner: DEFAULT_OWNER });

    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description:
        "Pass this to DnsStack as -c cloudFrontDomainName=... to perform the Stage G1 apex cutover.",
    });
    new CfnOutput(this, "SiteBucketName", { value: this.bucket.bucketName });
  }

  /**
   * The two CloudFront findings that are cost decisions rather than defects.
   *
   * Left here rather than inside StaticSite: both are judgements about *this*
   * site's threat model and budget, not properties of the pattern. A second
   * site behind a login would answer CFR2 differently.
   *
   * Both are cdk-nag warnings, so neither fails synth today. They are
   * acknowledged explicitly anyway: a warning nobody has decided about is
   * indistinguishable from one everybody has stopped reading.
   */
  private suppressDistributionFindings(): void {
    suppressNagRules(this.distribution, [
      {
        id: "AwsSolutions-CFR1",
        reason:
          "Geo restriction is deliberately off. This is a personal site and a " +
          "portfolio artifact whose entire purpose is to be reachable from " +
          "anywhere; there is no jurisdiction whose traffic would be safer " +
          "blocked than served, and no regulated data behind it. Every object is " +
          "public-by-intent static content (ADR-0007).",
      },
      {
        id: "AwsSolutions-CFR2",
        reason:
          "No WAF. A web ACL is ~$5/mo base plus $1/rule and $0.60/M requests, " +
          "against a Phase 0 budget of $3-8/mo total (docs/cost/cost-model.md) — " +
          "it would roughly double platform spend. It would also be protecting " +
          "nothing: this distribution fronts a bucket of prerendered HTML with no " +
          "request-path compute, no form, no login and no database, so the " +
          "injection and account-takeover classes a WAF addresses have no target. " +
          "Revisit when the first authenticated or dynamic endpoint ships " +
          "(ADR-0003 Phase 2), where the same $5/mo buys something real.",
      },
    ]);
  }

  /**
   * The fetcher: SSM in, OANDA out, two JSON objects into `data/`.
   *
   * `ScheduledJob` owns the runtime, the ARM64 architecture, the explicit log
   * group, the schedule, and an execution role scoped to that log group and
   * nothing else (ADR-0008). Everything below is what makes this job *this*
   * job.
   */
  private createFetcher(profile: EnvProfile): ScheduledJob {
    return new ScheduledJob(this, "OandaFetcher", {
      entry: path.join(__dirname, "..", "lambda", "oanda-fetcher", "index.ts"),
      schedule: FETCH_INTERVAL,
      profile,
      // The OANDA history call is the slow part and it is retried up to three
      // times; 60s leaves room for that without letting a hung socket burn
      // fifteen minutes of billed time.
      timeout: Duration.seconds(60),
      description: "Hourly OANDA fetch. Writes data/*.json to the site bucket.",
      scheduleDescription:
        "Hourly OANDA fetch for josephkan.ca. Trading history; not real-time.",
      environment: {
        SITE_BUCKET: this.bucket.bucketName,
        RETURNS_KEY,
        TRADES_KEY,
        OANDA_ACCOUNT_ID_PARAMETER: oandaParameterNames.accountId,
        OANDA_ACCESS_TOKEN_PARAMETER: oandaParameterNames.accessToken,
      },
    });
  }

  /**
   * The two grants the OANDA job needs beyond writing its own logs.
   *
   * These stay here rather than in `ScheduledJob`: a construct that knows about
   * S3 prefixes and SSM parameter names is not reusable by NewNotams.
   */
  private grantFetcher(job: ScheduledJob): void {
    // Least privilege, and asserted in the tests. The bucket also holds the
    // whole static site; a bucket-wide grant would let a compromised fetcher
    // rewrite index.html. It can only write the two files it produces.
    job.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`${DATA_PREFIX}/*`)],
      }),
    );

    // Named parameters only. `/personal-site/*` would be tidier and would also
    // grant every future secret this application ever has.
    job.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          this.parameterArn(oandaParameterNames.accountId),
          this.parameterArn(oandaParameterNames.accessToken),
        ],
      }),
    );

    suppressNagRules(job.role, [
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(
          this,
          this.bucket.arnForObjects(`${DATA_PREFIX}/*`),
        )}]`,
        reason:
          "The wildcard is the point of this grant, not an oversight. This bucket " +
          "holds both the static export and the OANDA JSON; scoping the fetcher to " +
          `${DATA_PREFIX}/* is what stops a compromised fetcher from rewriting ` +
          "index.html on a live domain (ADR-0007). The two object keys are fixed " +
          "today, but a literal pair would silently drop future data files out of " +
          "the grant and fail at runtime rather than at synth. A test asserts this " +
          "statement covers no key outside the prefix.",
      },
    ]);
  }

  private parameterArn(parameterName: string): string {
    return Fn.join("", [
      `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter`,
      parameterName,
    ]);
  }
}

/**
 * Where the site lives before the `git subtree` migration: a sibling checkout
 * of the personal-website repo. After the migration this becomes a path inside
 * this package and the default stops being a guess.
 */
function defaultSiteSourcePath(): string {
  return path.resolve(__dirname, "..", "..", "..", "..", "personal-page", "out");
}
