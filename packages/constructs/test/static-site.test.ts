/**
 * StaticSite's guarantees, asserted independently of any consuming stack.
 *
 * The point of extracting the construct (ADR-0008) is that a second site gets
 * the same posture without re-deriving it, so these tests assert the posture
 * against a bare synthetic stack rather than against personal-site.
 */

import { App, Duration, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { AwsSolutionsChecks } from "cdk-nag";
import { profileFor, synthesizerFor } from "@platform/config";
import { StaticSite } from "../src/index.js";
import type { StaticSiteProps } from "../src/index.js";
import type { PolicyViolation } from "aws-cdk-lib";

const ENV = { account: "222222222222", region: "us-east-1" };
const CERT_ARN = "arn:aws:acm:us-east-1:222222222222:certificate/abc-123";

function newSite(props: Partial<StaticSiteProps> = {}): { stack: Stack; site: StaticSite } {
  const app = new App();
  const stack = new Stack(app, "TestStack", { env: ENV, synthesizer: synthesizerFor("prod") });
  const site = new StaticSite(stack, "Site", {
    domainNames: ["example.test", "www.example.test"],
    certificate: CERT_ARN,
    profile: profileFor("prod"),
    sourcePath: "/definitely/not/a/real/export/directory",
    usePlaceholderSource: true,
    ...props,
  });
  return { stack, site };
}

function synth(props: Partial<StaticSiteProps> = {}): Template {
  return Template.fromStack(newSite(props).stack);
}

const template = synth();

describe("origin bucket", () => {
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

  test("is encrypted at rest and versioned", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  test("denies non-TLS access in its bucket policy", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });

  test("logs to a separate bucket, not into the key space CloudFront serves", () => {
    const logging = Object.values(template.findResources("AWS::S3::Bucket"))
      .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
      .map((properties) => properties["LoggingConfiguration"])
      .filter((config): config is Record<string, unknown> => config !== undefined);

    expect(logging).toHaveLength(1);
    expect(JSON.stringify(logging[0])).toContain("AccessLogBucket");
  });

  test("the profile drives the removal policy", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    synth({ profile: profileFor("dev") }).hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
    });
  });
});

describe("access log bucket", () => {
  test("expires its objects so the logs cannot grow without bound", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: "ExpireAccessLogs", Status: "Enabled", ExpirationInDays: 90 }),
        ]),
      },
    });
  });

  test("honours ACLs so the S3 log-delivery group can write to it", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] },
    });
  });

  test("is not itself public", () => {
    const logBucket = Object.entries(template.findResources("AWS::S3::Bucket")).find(
      ([logicalId]) => logicalId.startsWith("SiteAccessLogBucket"),
    );
    expect(logBucket).toBeDefined();

    const properties = (logBucket?.[1] as { Properties: Record<string, unknown> }).Properties;
    expect(properties["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });
});

describe("CloudFront", () => {
  test("uses Origin Access Control and not the legacy OAI", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    expect(JSON.stringify(template.toJSON())).not.toContain("origin-access-identity");
  });

  test("serves every requested alias", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: Match.arrayWith(["example.test", "www.example.test"]),
      }),
    });
  });

  test("redirects HTTP to HTTPS, compresses, and has a default root object", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
          Compress: true,
        }),
      }),
    });
  });

  test("writes access logs to the shared log bucket (AwsSolutions-CFR3)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Logging: {
          Bucket: {
            "Fn::GetAtt": [Match.stringLikeRegexp("^SiteAccessLogBucket"), "RegionalDomainName"],
          },
          Prefix: "cloudfront/",
          IncludeCookies: false,
        },
      }),
    });
  });

  test("maps 403 and 404 to the export's 404.html, not to index.html", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html" }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 404, ResponsePagePath: "/404.html" }),
        ]),
      }),
    });
  });

  test("has no extra cache behaviours when none are asked for", () => {
    const config = (
      Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
        Properties: { DistributionConfig: Record<string, unknown> };
      }
    ).Properties.DistributionConfig;

    expect(config["CacheBehaviors"]).toBeUndefined();
  });
});

describe("additionalBehaviors", () => {
  function withDataBehavior(): Template {
    const app = new App();
    const stack = new Stack(app, "TestStack", { env: ENV, synthesizer: synthesizerFor("prod") });
    new StaticSite(stack, "Site", {
      domainNames: ["example.test"],
      certificate: CERT_ARN,
      profile: profileFor("prod"),
      sourcePath: "/nowhere",
      usePlaceholderSource: true,
      additionalBehaviors: {
        "/data/*": new cloudfront.CachePolicy(stack, "DataCachePolicy", {
          defaultTtl: Duration.minutes(5),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.minutes(5),
        }),
      },
    });
    return Template.fromStack(stack);
  }

  const dataTemplate = withDataBehavior();

  test("renders the extra behaviour with the caller's cache policy and TTL", () => {
    const config = (
      Object.values(dataTemplate.findResources("AWS::CloudFront::Distribution"))[0] as {
        Properties: { DistributionConfig: Record<string, unknown> };
      }
    ).Properties.DistributionConfig;
    const behaviors = config["CacheBehaviors"] as Array<Record<string, unknown>>;
    const dataBehavior = behaviors.find((behavior) => behavior["PathPattern"] === "/data/*");

    expect(dataBehavior).toBeDefined();
    expect(dataBehavior?.["CachePolicyId"]).not.toEqual(
      (config["DefaultCacheBehavior"] as Record<string, unknown>)["CachePolicyId"],
    );

    dataTemplate.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({ DefaultTTL: 300, MaxTTL: 300, MinTTL: 0 }),
    });
  });

  test("the extra behaviour keeps the secure defaults the caller cannot weaken", () => {
    const behaviors = (
      Object.values(dataTemplate.findResources("AWS::CloudFront::Distribution"))[0] as {
        Properties: { DistributionConfig: { CacheBehaviors: Array<Record<string, unknown>> } };
      }
    ).Properties.DistributionConfig.CacheBehaviors;
    const dataBehavior = behaviors.find((behavior) => behavior["PathPattern"] === "/data/*");

    expect(dataBehavior?.["ViewerProtocolPolicy"]).toBe("redirect-to-https");
    expect(dataBehavior?.["Compress"]).toBe(true);
    expect(dataBehavior?.["ResponseHeadersPolicyId"]).toBeDefined();
  });
});

describe("security headers", () => {
  test("HSTS is one year, includes subdomains and is preloaded", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          },
        }),
      }),
    });
  });

  test("sets nosniff, a referrer policy, frame options and a CSP", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: {
            ReferrerPolicy: "strict-origin-when-cross-origin",
            Override: true,
          },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'"),
          }),
        }),
      }),
    });
  });

  test("the default CSP allows no third-party script origin and no inline script", () => {
    expect(cspOf(template)).toContain("script-src 'self'");
    expect(cspOf(template)).not.toContain("'unsafe-eval'");
    expect(cspOf(template)).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(cspOf(template)).toContain("frame-ancestors 'none'");
  });

  test("the CSP is overridable without disturbing the other headers", () => {
    const overridden = synth({ contentSecurityPolicy: "default-src 'none'" });
    expect(cspOf(overridden)).toBe("default-src 'none'");
    overridden.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ Preload: true }),
        }),
      }),
    });
  });
});

function cspOf(from: Template): string {
  const policy = Object.values(from.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0] as {
    Properties: Record<string, Record<string, Record<string, Record<string, string>>>>;
  };
  return (
    policy.Properties["ResponseHeadersPolicyConfig"]?.["SecurityHeadersConfig"]?.[
      "ContentSecurityPolicy"
    ]?.["ContentSecurityPolicy"] ?? ""
  );
}

describe("deployment", () => {
  test("invalidates the distribution and does not prune out-of-band objects", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/*"],
      Prune: false,
    });
  });

  test("the placeholder synthesizes with no export directory on disk", () => {
    // The whole point: CI validates the real template without ever building the
    // site. `template` above already proves it, so this asserts the deployment
    // is present rather than silently skipped.
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
  });

  test("a missing real source directory fails with an actionable message", () => {
    expect(() => synth({ usePlaceholderSource: false })).toThrow(/Static export not found/);
    expect(() => synth({ usePlaceholderSource: false })).toThrow(/usePlaceholderSource/);
  });
});

describe("handles for the consuming stack", () => {
  test("exposes the bucket, log bucket and distribution", () => {
    const { site } = newSite();
    expect(site.bucket.bucketArn).toBeDefined();
    expect(site.logBucket.bucketArn).toBeDefined();
    expect(site.distribution.distributionDomainName).toBeDefined();
  });
});

/**
 * cdk-nag. CFR1 and CFR2 are warnings and are deliberately *not* suppressed
 * inside the construct — they are judgements about a particular site's threat
 * model and budget (ADR-0007), so a consuming stack must make them itself.
 * Errors, though, must be zero for any stack that uses this construct.
 */
describe("cdk-nag AwsSolutionsChecks", () => {
  function violations(): PolicyViolation[] {
    const app = new App();
    const stack = new Stack(app, "NagStack", { env: ENV, synthesizer: synthesizerFor("prod") });
    new StaticSite(stack, "Site", {
      domainNames: ["example.test"],
      certificate: CERT_ARN,
      profile: profileFor("prod"),
      sourcePath: "/nowhere",
      usePlaceholderSource: true,
    });
    return new AwsSolutionsChecks(app, { verbose: true }).validateScope(app).violations;
  }

  const reported = violations();

  test("reports zero unsuppressed errors", () => {
    const errors = reported
      .filter((violation) => violation.severity === "error")
      .map(
        (violation) =>
          `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath ?? ""}`,
      );

    expect(errors).toEqual([]);
  });

  test("leaves the site-specific CloudFront cost warnings for the caller to decide", () => {
    const warnings = reported
      .filter((violation) => violation.severity === "warning")
      .map((violation) => violation.ruleName);

    expect(warnings.sort()).toEqual(["AwsSolutions-CFR1", "AwsSolutions-CFR2"]);
  });
});
