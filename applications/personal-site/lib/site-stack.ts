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
 */

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import {
  DEFAULT_OWNER,
  applyPlatformTags,
  bootstrapQualifierFor,
  domains,
  profileFor,
  ssmPaths,
} from "@platform/config";
import { flattenForNagId, suppressNagRules, suppressNagRulesAtPath } from "@platform/constructs";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Env } from "@platform/config";
import type { StackProps } from "aws-cdk-lib";
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
 * Fetcher runtime. Node 24 is the newest runtime CDK 2.263 knows about, which
 * is what `AwsSolutions-L1` checks against; Node 20 was deprecated 2026-04-30.
 * The handler uses only native `fetch` and `AbortSignal.timeout`, both of which
 * predate Node 20, so nothing in it is version-sensitive.
 */
export const FETCHER_RUNTIME = lambda.Runtime.NODEJS_24_X;

/** esbuild target, kept in lockstep with FETCHER_RUNTIME. */
const FETCHER_BUNDLE_TARGET = "node24";

/**
 * How long S3 server access logs are kept before deletion.
 *
 * 90 days is long enough to investigate an incident and short enough that the
 * log objects stay a rounding error against the $0.023/GB storage price. S3
 * has no per-bucket fixed charge, so the log bucket itself costs nothing.
 */
const ACCESS_LOG_RETENTION_DAYS = 90;

/** Prefix the site bucket's server access logs are written under. */
export const ACCESS_LOG_PREFIX = "s3/";

/** Prefix CloudFront's standard access logs are written under. */
export const CLOUDFRONT_LOG_PREFIX = "cloudfront/";

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
  readonly bucket: s3.Bucket;
  readonly accessLogBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly fetcher: NodejsFunction;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const profile = profileFor(props.envName);

    this.accessLogBucket = this.createAccessLogBucket(profile.removalPolicy);

    this.bucket = new s3.Bucket(this, "SiteBucket", {
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: ACCESS_LOG_PREFIX,
      // Nothing reaches this bucket except CloudFront via OAC and the fetcher
      // Lambda via its execution role.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The static export is fully reproducible from source, but `data/` is
      // not: it is the only copy of a transformation over an OANDA history
      // that only grows. Versioning makes a bad write recoverable.
      versioned: true,
      removalPolicy: profile.removalPolicy,
      autoDeleteObjects: profile.removalPolicy === RemovalPolicy.DESTROY,
    });

    // ADR-0004: the certificate ARN crosses the platform/application seam via
    // SSM, never a CloudFormation export. An export would make DnsStack
    // undeletable and force lockstep deploys of DNS and this stack.
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "PlatformCertificate",
      ssm.StringParameter.valueForStringParameter(this, ssmPaths.certificateArn(domains.platform)),
    );

    const origin = S3BucketOrigin.withOriginAccessControl(this.bucket);

    const securityHeaders = this.createResponseHeadersPolicy();

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domains.platform, `www.${domains.platform}`],
      certificate,
      // AwsSolutions-CFR3. Logging reuses the bucket S3 access logs already go
      // to, so this adds no new always-on resource — only log object storage,
      // capped by the 90-day lifecycle rule. Without it there is no record of
      // who requested what: the S3 access log sees only CloudFront's OAC
      // fetches on cache misses, not viewer requests.
      enableLogging: true,
      logBucket: this.accessLogBucket,
      logFilePrefix: CLOUDFRONT_LOG_PREFIX,
      // Cookies are not used anywhere on this site, so logging them would
      // record nothing and only widen what the log file contains.
      logIncludesCookies: false,
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: `${domains.platform} — static export plus scheduled OANDA JSON.`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        // The whole design assumes the edge serves fresh-ish data. A default
        // long TTL here would mean the hourly Lambda writes into a cache that
        // ignores it for a day.
        [`/${DATA_PREFIX}/*`]: {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: new cloudfront.CachePolicy(this, "DataCachePolicy", {
            comment: "Short TTL matching the hourly OANDA write cadence.",
            defaultTtl: DATA_CACHE_TTL,
            minTtl: Duration.seconds(0),
            maxTtl: DATA_CACHE_TTL,
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
          }),
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
      errorResponses: [
        // `/404.html`, not `/index.html`. This is a Next.js *static export*,
        // not an SPA: every route is a real prerendered HTML file, and Next
        // emits a real `404.html`. Rewriting 404s to `/index.html` would serve
        // the homepage with HTTP 200 for every typo'd URL, which is worse for
        // both users and search engines.
        //
        // 403 is included because S3 returns AccessDenied rather than NoSuchKey
        // for a missing object when the caller has no `s3:ListBucket` — which
        // is exactly the case here, since OAC grants `s3:GetObject` only.
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: Duration.minutes(5) },
      ],
    });

    this.suppressDistributionFindings();

    this.fetcher = this.createFetcher(profile.logRetention);
    this.scheduleFetcher();
    this.deploySite(props);

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
   * Server access logs for the site bucket, and for CloudFront if that is ever
   * enabled (AwsSolutions-S1).
   *
   * A separate bucket rather than a prefix in the site bucket, because S3
   * refuses to let a bucket log to itself when the logging destination is also
   * served publicly through OAC — and because a log object landing under the
   * site's own key space would be reachable through the distribution.
   *
   * Cost: S3 has no per-bucket charge, so this adds only the storage for the
   * log objects themselves. At this traffic volume that is well under $0.10/mo
   * against the $3-8 Phase 0 budget, and the lifecycle rule below caps it.
   */
  private createAccessLogBucket(removalPolicy: RemovalPolicy): s3.Bucket {
    const bucket = new s3.Bucket(this, "AccessLogBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // S3 server access logging writes with the log-delivery group, which
      // requires ACLs to be honoured on the destination bucket.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "ExpireAccessLogs",
          enabled: true,
          expiration: Duration.days(ACCESS_LOG_RETENTION_DAYS),
        },
      ],
    });

    suppressNagRules(bucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "This is the access log destination. Enabling server access logging on " +
          "it would make it log its own writes, which is a feedback loop that " +
          "grows without bound and bills at $0.023/GB for no investigative value " +
          "(ADR-0007). Reads of this bucket are still recorded by the organization " +
          "CloudTrail in the management account (ADR-0001).",
      },
    ]);

    return bucket;
  }

  /**
   * The fetcher: SSM in, OANDA out, two JSON objects into `data/`.
   *
   * ARM64 because it is ~20% cheaper per GB-second and this workload has no
   * native dependencies. Node 24 because the handler uses native `fetch` and
   * `AbortSignal.timeout`, so there is no axios and no HTTP client to bundle.
   */
  private createFetcher(logRetention: logs.RetentionDays): NodejsFunction {
    // An explicit LogGroup rather than the deprecated `logRetention` prop: that
    // prop renders a custom resource with a Lambda of its own, and the group it
    // creates is not a CfnLogGroup that LogRetentionAspect can see. Declaring
    // it here means the aspect actually checks the thing it exists to check.
    const logGroup = new logs.LogGroup(this, "OandaFetcherLogs", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fetcher = new NodejsFunction(this, "OandaFetcher", {
      entry: path.join(__dirname, "..", "lambda", "oanda-fetcher", "index.ts"),
      handler: "handler",
      runtime: FETCHER_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // The OANDA history call is the slow part and it is retried up to three
      // times; 60s leaves room for that without letting a hung socket burn
      // fifteen minutes of billed time.
      timeout: Duration.seconds(60),
      logGroup,
      role: this.createFetcherRole(logGroup),
      description: "Hourly OANDA fetch. Writes data/*.json to the site bucket.",
      environment: {
        SITE_BUCKET: this.bucket.bucketName,
        RETURNS_KEY,
        TRADES_KEY,
        OANDA_ACCOUNT_ID_PARAMETER: oandaParameterNames.accountId,
        OANDA_ACCESS_TOKEN_PARAMETER: oandaParameterNames.accessToken,
      },
      bundling: { minify: true, sourceMap: false, target: FETCHER_BUNDLE_TARGET },
    });

    return fetcher;
  }

  /**
   * An explicit execution role rather than the CDK default.
   *
   * The default attaches the AWS managed `AWSLambdaBasicExecutionRole`, which
   * grants `logs:CreateLogGroup` plus stream and event writes across every log
   * group in the account (AwsSolutions-IAM4). This function already has a log
   * group declared above it, so it needs neither the group-creation right nor
   * access to anyone else's logs. Scoping to the one group is a strict
   * narrowing and costs nothing.
   */
  private createFetcherRole(logGroup: logs.LogGroup): iam.Role {
    // Construct ID, not the CDK default path: the tests identify the fetcher's
    // policies by matching this string against the policy's Roles list.
    const role = new iam.Role(this, "OandaFetcherServiceRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the OANDA fetcher. Writes data/* and one log group.",
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        // Lambda creates one stream per concurrent execution under this group,
        // so the stream segment cannot be named ahead of time.
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
      }),
    );

    // Least privilege, and asserted in the tests. The bucket also holds the
    // whole static site; a bucket-wide grant would let a compromised fetcher
    // rewrite index.html. It can only write the two files it produces.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`${DATA_PREFIX}/*`)],
      }),
    );

    // Named parameters only. `/personal-site/*` would be tidier and would also
    // grant every future secret this application ever has.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          this.parameterArn(oandaParameterNames.accountId),
          this.parameterArn(oandaParameterNames.accessToken),
        ],
      }),
    );

    suppressNagRules(role, [
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
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, logGroup.logGroupArn)}:log-stream:*]`,
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
   * EventBridge Scheduler, not an `events.Rule`.
   *
   * The `aws-scheduler` L2 is stable in this CDK version (2.263), and Scheduler
   * is the right service: it is the same primitive NewNotams needs in Phase 1,
   * it has a built-in retry and dead-letter configuration per schedule rather
   * than per target, and `applications.md` calls it out as a first-class
   * platform construct. It costs nothing at this volume.
   */
  private scheduleFetcher(): void {
    new scheduler.Schedule(this, "OandaFetchSchedule", {
      schedule: scheduler.ScheduleExpression.rate(FETCH_INTERVAL),
      target: new LambdaInvoke(this.fetcher, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(30),
      }),
      description: "Hourly OANDA fetch for josephkan.ca. Trading history; not real-time.",
    });

    // The `<arn>:*` form is how the aws-scheduler-targets L2 grants invoke
    // across a function's aliases and versions. Not configurable from here.
    suppressNagRulesAtPath(this, `${this.node.path}/SchedulerRoleForTarget-25413b`, [
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, this.fetcher.functionArn)}:*]`,
        reason:
          "The trailing :* covers this one function's versions and aliases, which " +
          "is what aws-cdk-lib's LambdaInvoke target generates and cannot be " +
          "narrowed through any prop. The grant is lambda:InvokeFunction on a " +
          "single function that reads SSM and writes two S3 keys, so the widest " +
          "reading of the wildcard is 'may invoke an older copy of the same " +
          "handler' (ADR-0007).",
      },
    ]);
  }

  /**
   * The static export, plus a CloudFront invalidation.
   *
   * `distributionPaths` is `/*` deliberately. A deploy replaces hashed assets
   * and HTML together, and invalidation is free up to 1,000 paths per month —
   * far more than this site will ever deploy. Enumerating paths would risk
   * serving a new index.html against stale chunks.
   */
  private deploySite(props: SiteStackProps): void {
    const source = this.resolveSiteSource(props);

    const deployment = new s3deploy.BucketDeployment(this, "SiteDeployment", {
      sources: [source],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      // `data/` is written by the Lambda, not by this deployment. Pruning would
      // delete both JSON files on every site deploy and blank the charts until
      // the next scheduled run.
      prune: false,
    });

    this.suppressDeploymentHandlerFindings(deployment, bootstrapQualifierFor(props.envName));
  }

  /**
   * BucketDeployment's handler is a CDK-owned singleton Lambda, shared by every
   * BucketDeployment in the stack. Its runtime, its role and its policy are all
   * generated by aws-cdk-lib and cannot be configured from here, so each of
   * these findings is a property of the CDK version in use rather than of this
   * stack. They are addressed by construct path because there is no handle to
   * the generated role.
   */
  private suppressDeploymentHandlerFindings(
    deployment: s3deploy.BucketDeployment,
    qualifier: string,
  ): void {
    const handler = deployment.node.scope;
    if (handler === undefined) {
      throw new Error("BucketDeployment has no enclosing scope.");
    }

    const cdkOwned =
      "This resource is generated by aws-cdk-lib's BucketDeployment singleton " +
      "handler, not declared here. Its runtime, execution role and inline policy " +
      "are all fixed by the CDK version and are not configurable through any " +
      "prop, so the finding tracks the aws-cdk-lib upgrade cadence rather than " +
      "anything this stack decides (ADR-0007). The handler runs only during a " +
      "CloudFormation deploy, holds no standing invoke path, and is scoped to " +
      "the site bucket and the CDK asset bucket. Re-evaluate on each aws-cdk-lib " +
      "major upgrade.";

    const handlerRolePath = `${this.node.path}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole`;
    const handlerPath = `${this.node.path}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C`;

    suppressNagRulesAtPath(this, handlerRolePath, [
      {
        id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        reason: cdkOwned,
      },
      ...[
        "Action::s3:GetBucket*",
        "Action::s3:GetObject*",
        "Action::s3:List*",
        "Action::s3:Abort*",
        "Action::s3:DeleteObject*",
        "Resource::*",
      ].map((finding) => ({ id: `AwsSolutions-IAM5[${finding}]`, reason: cdkOwned })),
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, this.bucket.arnForObjects("*"))}]`,
        reason: cdkOwned,
      },
      {
        // The asset bucket name embeds the bootstrap qualifier, which is
        // per-environment (ADR-0001, packages/config/src/bootstrap.ts), so this
        // finding ID cannot be a literal.
        id:
          "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::" +
          `cdk-${qualifier}-assets-${this.account}-${this.region}/*]`,
        reason: cdkOwned,
      },
    ]);

    suppressNagRulesAtPath(this, handlerPath, [
      { id: "AwsSolutions-L1", reason: cdkOwned },
    ]);
  }

  private resolveSiteSource(props: SiteStackProps): s3deploy.ISource {
    if (props.usePlaceholderSource) {
      // Inline placeholder: no file needs to exist on disk, so synth works in a
      // clean CI checkout and in unit tests. Deploying this would put a real
      // page live, so it is opt-in via context and never the default.
      return s3deploy.Source.data(
        "index.html",
        "<!doctype html><title>josephkan.ca</title>" +
          "<p>Placeholder. The Next.js static export has not been deployed to this bucket yet.",
      );
    }

    const sourcePath = props.siteSourcePath ?? defaultSiteSourcePath();
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Static export not found at ${sourcePath}. Build it first ` +
          "(`next build && next export`, output in `out/`), pass siteSourcePath, " +
          "or synthesize with -c sitePlaceholder=true to render the stack without a site checkout.",
      );
    }

    return s3deploy.Source.asset(sourcePath);
  }

  /**
   * Response headers applied to every behaviour.
   *
   * The CSP is tight because the site earns it: after the OANDA restructure the
   * page makes exactly one kind of network call — same-origin `fetch` of
   * `/data/*.json` — and loads no third-party script, font or analytics.
   *
   *   default-src 'self'      everything defaults to same-origin
   *   script-src  'self'      Chart.js is bundled by Next, not loaded from a CDN
   *   style-src   'self' 'unsafe-inline'
   *                           required: Next.js injects inline <style> for its
   *                           CSS-in-JS runtime and next/image emits inline
   *                           style attributes. Removing it needs a nonce,
   *                           which needs request-path compute — exactly what
   *                           this design removed. Inline *style* is a far
   *                           weaker vector than inline script.
   *   img-src 'self' data:    next/image emits data: URI blur placeholders
   *   connect-src 'self'      the only fetch target is /data/*.json
   *   frame-ancestors 'none'  clickjacking; also covers X-Frame-Options
   *   base-uri / form-action 'self', object-src 'none' — no plugins, no forms
   *   upgrade-insecure-requests — belt and braces alongside the HTTPS redirect
   */
  private createResponseHeadersPolicy(): cloudfront.ResponseHeadersPolicy {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    return new cloudfront.ResponseHeadersPolicy(this, "SecurityHeadersPolicy", {
      comment: `Security headers for ${domains.platform}.`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          // `internal.josephkan.ca` is a private zone and `api.` will be HTTPS
          // only, so includeSubdomains costs nothing. Preload is a one-way
          // door for the whole domain — accepted deliberately, since every
          // name under it is HTTPS by construction.
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });
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
