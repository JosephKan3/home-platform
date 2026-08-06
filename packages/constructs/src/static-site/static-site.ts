/**
 * StaticSite — the S3 + CloudFront + OAC + security-headers pattern, once.
 *
 * ADR-0008 accepted CDK-only IaC and recorded the debt this construct repays:
 * a single-site stack had grown to ~660 lines to declare one bucket, one
 * distribution and one function. Everything in here is a property of "a static
 * site served securely from S3", not of any particular site — the domain names,
 * the certificate and the source directory come in as props, and nothing about
 * the caller leaks in.
 *
 * The security posture is not optional. There is no prop that turns off public
 * access blocking, TLS enforcement, OAC, HSTS or access logging, because a knob
 * that weakens a control is a knob someone eventually turns.
 */

import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { bootstrapQualifierFor } from "@platform/config";
import * as fs from "node:fs";
import { Construct } from "constructs";
import { flattenForNagId, suppressNagRules, suppressNagRulesAtPath } from "../nag/index.js";
import type { EnvProfile } from "@platform/config";

/** Prefix the site bucket's S3 server access logs are written under. */
export const ACCESS_LOG_PREFIX = "s3/";

/**
 * Prefix CloudFront's standard access logs are written under.
 *
 * Deliberately different from ACCESS_LOG_PREFIX: the two services write
 * different log formats, and sharing a prefix would interleave them in one key
 * space and break any downstream parser.
 */
export const CLOUDFRONT_LOG_PREFIX = "cloudfront/";

/**
 * How long access logs are kept before deletion.
 *
 * 90 days is long enough to investigate an incident and short enough that the
 * log objects stay a rounding error against the $0.023/GB storage price. S3 has
 * no per-bucket fixed charge, so the log bucket itself costs nothing.
 */
export const ACCESS_LOG_RETENTION_DAYS = 90;

/**
 * Default Content-Security-Policy.
 *
 * Tight because a prerendered static export earns it: no third-party script,
 * font or analytics, and the only network call a page makes is same-origin.
 *
 *   default-src 'self'      everything defaults to same-origin
 *   script-src  'self'      bundlers emit local chunks, not CDN <script> tags
 *   style-src   'self' 'unsafe-inline'
 *                           required: Next.js injects inline <style> for its
 *                           CSS-in-JS runtime and next/image emits inline style
 *                           attributes. Removing it needs a nonce, which needs
 *                           request-path compute — which this whole design
 *                           exists to avoid. Inline *style* is a far weaker
 *                           vector than inline script.
 *   img-src 'self' data:    next/image emits data: URI blur placeholders
 *   connect-src 'self'      same-origin fetch only
 *   frame-ancestors 'none'  clickjacking; also covers X-Frame-Options
 *   base-uri / form-action 'self', object-src 'none' — no plugins, no forms
 *   upgrade-insecure-requests — belt and braces alongside the HTTPS redirect
 */
export const DEFAULT_CONTENT_SECURITY_POLICY = [
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

export interface StaticSiteProps {
  /** Aliases on the distribution. The first is used in generated comments. */
  readonly domainNames: string[];

  /**
   * ACM certificate for `domainNames`, in us-east-1.
   *
   * A plain string is treated as an ARN, which is the common case: the ARN
   * crosses the platform/application seam through SSM (ADR-0004) and arrives as
   * an unresolved token, so the caller has nothing to import an `ICertificate`
   * from.
   */
  readonly certificate: acm.ICertificate | string;

  /** Drives removal policy and object auto-deletion. */
  readonly profile: EnvProfile;

  /**
   * Directory holding the built static export.
   *
   * Read only when `usePlaceholderSource` is false, so a caller may pass a path
   * that does not exist as long as it also asks for the placeholder.
   */
  readonly sourcePath: string;

  /**
   * Deploy a generated placeholder instead of the real export.
   *
   * Synth must work with no site checkout: PR validation, cdk-nag and the unit
   * tests all run in an environment that has never built the site. The
   * alternative — skipping BucketDeployment when the directory is absent —
   * would mean CI validates a template that differs from the deployed one,
   * which defeats the point of validating it.
   */
  readonly usePlaceholderSource?: boolean;

  /**
   * Extra cache behaviours, keyed by path pattern, each with its own cache
   * policy. Everything else about the behaviour — the origin, the HTTPS
   * redirect, the security headers, compression — is the same secure default
   * the site behaviour gets, and is not caller-configurable.
   *
   * This exists for paths whose freshness requirement differs from the site's,
   * such as a JSON feed written out of band on a schedule.
   */
  readonly additionalBehaviors?: Record<string, cloudfront.ICachePolicy>;

  /** Distribution comment. Shown in the CloudFront console. */
  readonly comment?: string;

  /**
   * Replaces {@link DEFAULT_CONTENT_SECURITY_POLICY}.
   *
   * The CSP is the one header whose correct value depends on what the site
   * actually loads, so it is a prop. The rest of the policy — HSTS, nosniff,
   * referrer policy, frame options — is not overridable, because there is no
   * static site for which relaxing them is right.
   */
  readonly contentSecurityPolicy?: string;
}

export class StaticSite extends Construct {
  /** The origin bucket. Grant to this to let something else write into it. */
  readonly bucket: s3.Bucket;
  /** Destination for both S3 server access logs and CloudFront standard logs. */
  readonly logBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    const { profile } = props;
    const primaryDomain = props.domainNames[0] ?? "static site";

    this.logBucket = this.createLogBucket(profile.removalPolicy);

    this.bucket = new s3.Bucket(this, "Bucket", {
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: ACCESS_LOG_PREFIX,
      // Nothing reaches this bucket except CloudFront via OAC, and whatever the
      // caller explicitly grants.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The export is reproducible from source, but anything written into the
      // bucket out of band is not. Versioning makes a bad write recoverable.
      versioned: true,
      removalPolicy: profile.removalPolicy,
      autoDeleteObjects: profile.removalPolicy === RemovalPolicy.DESTROY,
    });

    // Origin Access Control, never the legacy Origin Access Identity: OAC signs
    // with SigV4, works with SSE-KMS, and is the only one AWS still develops.
    const origin = S3BucketOrigin.withOriginAccessControl(this.bucket);

    this.responseHeadersPolicy = this.createResponseHeadersPolicy(
      primaryDomain,
      props.contentSecurityPolicy ?? DEFAULT_CONTENT_SECURITY_POLICY,
    );

    const behavior = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: this.responseHeadersPolicy,
      compress: true,
    };

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: props.domainNames,
      certificate: this.resolveCertificate(props.certificate),
      // AwsSolutions-CFR3. Logging reuses the bucket S3 access logs already go
      // to, so this adds no new always-on resource — only log object storage,
      // capped by the lifecycle rule below. Without it there is no record of
      // who requested what: the S3 access log sees only CloudFront's OAC
      // fetches on cache misses, not viewer requests.
      enableLogging: true,
      logBucket: this.logBucket,
      logFilePrefix: CLOUDFRONT_LOG_PREFIX,
      // A static site sets no cookies, so logging them would record nothing and
      // only widen what the log file contains.
      logIncludesCookies: false,
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: props.comment ?? `${primaryDomain} — static site.`,
      defaultBehavior: {
        ...behavior,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: Object.fromEntries(
        Object.entries(props.additionalBehaviors ?? {}).map(([pattern, cachePolicy]) => [
          pattern,
          { ...behavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD, cachePolicy },
        ]),
      ),
      errorResponses: [
        // `/404.html`, not `/index.html`. A static export is not an SPA: every
        // route is a real prerendered file and the generator emits a real
        // `404.html`. Rewriting 404s to `/index.html` would serve the homepage
        // with HTTP 200 for every typo'd URL, which is worse for both users and
        // search engines.
        //
        // 403 is included because S3 returns AccessDenied rather than NoSuchKey
        // for a missing object when the caller has no `s3:ListBucket` — which
        // is exactly the case here, since OAC grants `s3:GetObject` only.
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html", ttl: Duration.minutes(5) },
      ],
    });

    this.deploy(props, primaryDomain);
  }

  /**
   * Access log destination for the site bucket and the distribution
   * (AwsSolutions-S1).
   *
   * A separate bucket rather than a prefix in the site bucket, because a log
   * object landing under the site's own key space would be reachable through
   * the distribution.
   *
   * Cost: S3 has no per-bucket charge, so this adds only the storage for the
   * log objects themselves — well under $0.10/mo at small-site traffic, and the
   * lifecycle rule below caps it.
   */
  private createLogBucket(removalPolicy: RemovalPolicy): s3.Bucket {
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
   * The static export, plus a CloudFront invalidation.
   *
   * `distributionPaths` is `/*` deliberately. A deploy replaces hashed assets
   * and HTML together, and invalidation is free up to 1,000 paths per month —
   * far more than a static site will ever deploy. Enumerating paths would risk
   * serving a new index.html against stale chunks.
   */
  private deploy(props: StaticSiteProps, primaryDomain: string): void {
    const deployment = new s3deploy.BucketDeployment(this, "SiteDeployment", {
      sources: [this.resolveSource(props, primaryDomain)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      // Anything written into this bucket out of band — a scheduled job's JSON,
      // for instance — is not part of the export. Pruning would delete it on
      // every site deploy.
      prune: false,
    });

    this.suppressDeploymentHandlerFindings(deployment, bootstrapQualifierFor(props.profile.env));
  }

  private resolveSource(props: StaticSiteProps, primaryDomain: string): s3deploy.ISource {
    if (props.usePlaceholderSource === true) {
      // Inline placeholder: no file needs to exist on disk, so synth works in a
      // clean CI checkout and in unit tests. Deploying this would put a real
      // page live, so it is opt-in and never the default.
      return s3deploy.Source.data(
        "index.html",
        `<!doctype html><title>${primaryDomain}</title>` +
          "<p>Placeholder. The static export has not been deployed to this bucket yet.",
      );
    }

    if (!fs.existsSync(props.sourcePath)) {
      // Checked here rather than left to BucketDeployment, which fails deep in
      // an asset-staging stack trace that does not name the missing directory
      // as the cause.
      throw new Error(
        `Static export not found at ${props.sourcePath}. Build the site first, ` +
          "pass a different sourcePath, or set usePlaceholderSource to render " +
          "the stack without a site checkout.",
      );
    }

    return s3deploy.Source.asset(props.sourcePath);
  }

  /**
   * BucketDeployment's handler is a CDK-owned singleton Lambda, shared by every
   * BucketDeployment in the stack — so it lives at stack scope, not under this
   * construct. Its runtime, its role and its policy are all generated by
   * aws-cdk-lib and cannot be configured, so each of these findings is a
   * property of the CDK version in use rather than of anything declared here.
   * They are addressed by construct path because there is no handle to the
   * generated role.
   */
  private suppressDeploymentHandlerFindings(
    deployment: s3deploy.BucketDeployment,
    qualifier: string,
  ): void {
    const stack = Stack.of(this);

    const cdkOwned =
      "This resource is generated by aws-cdk-lib's BucketDeployment singleton " +
      "handler, not declared here. Its runtime, execution role and inline policy " +
      "are all fixed by the CDK version and are not configurable through any " +
      "prop, so the finding tracks the aws-cdk-lib upgrade cadence rather than " +
      "anything this stack decides (ADR-0007). The handler runs only during a " +
      "CloudFormation deploy, holds no standing invoke path, and is scoped to " +
      "the site bucket and the CDK asset bucket. Re-evaluate on each aws-cdk-lib " +
      "major upgrade.";

    // The singleton lives at *stack* scope, not under this construct, and its
    // ID embeds a UUID that changes with the handler source. Finding it by
    // prefix means a CDK upgrade that renames it fails the build in
    // suppressNagRulesAtPath rather than leaving a suppression attached to
    // nothing.
    const handler = stack.node.children.find((child) =>
      child.node.id.startsWith("Custom::CDKBucketDeployment"),
    );
    if (handler === undefined) {
      throw new Error(
        `No Custom::CDKBucketDeployment* handler found under ${stack.node.path} for ` +
          `${deployment.node.path}. aws-cdk-lib has renamed the BucketDeployment ` +
          "singleton; the cdk-nag suppressions for it need updating (ADR-0007).",
      );
    }
    const handlerPath = handler.node.path;

    suppressNagRulesAtPath(stack, `${handlerPath}/ServiceRole`, [
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
          `cdk-${qualifier}-assets-${stack.account}-${stack.region}/*]`,
        reason: cdkOwned,
      },
    ]);

    suppressNagRulesAtPath(stack, handlerPath, [{ id: "AwsSolutions-L1", reason: cdkOwned }]);
  }

  private createResponseHeadersPolicy(
    primaryDomain: string,
    contentSecurityPolicy: string,
  ): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, "SecurityHeadersPolicy", {
      comment: `Security headers for ${primaryDomain}.`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          // Preload is a one-way door for the whole registrable domain: every
          // present and future subdomain must be HTTPS. Accepted deliberately —
          // a site behind CloudFront with a redirect-to-HTTPS viewer policy has
          // no HTTP path to lose.
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: { contentSecurityPolicy, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });
  }

  private resolveCertificate(certificate: acm.ICertificate | string): acm.ICertificate {
    return typeof certificate === "string"
      ? acm.Certificate.fromCertificateArn(this, "Certificate", certificate)
      : certificate;
  }
}
