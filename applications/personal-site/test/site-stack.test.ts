/**
 * The highest-value assertions in this file are the two IAM ones.
 *
 * The site bucket holds both the static export and the OANDA JSON. A
 * bucket-wide `s3:PutObject` grant would let a compromised fetcher rewrite
 * index.html on a live domain, and a `parameter/personal-site/*` grant would
 * hand it every future secret this application acquires. Neither failure is
 * visible in a diff without a test that names the scope.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CLOUDFRONT_CERT_REGION, domains } from "@platform/config";
import {
  ACCESS_LOG_PREFIX,
  APP_NAME,
  CLOUDFRONT_LOG_PREFIX,
  DATA_PREFIX,
  FETCHER_RUNTIME,
  SiteStack,
  oandaParameterNames,
} from "../lib/site-stack.js";
import type { SiteStackProps } from "../lib/site-stack.js";

const ENV = { account: "222222222222", region: CLOUDFRONT_CERT_REGION };

function synth(props: Partial<SiteStackProps> = {}): Template {
  const app = new App();
  return Template.fromStack(
    new SiteStack(app, "TestSiteStack", {
      env: ENV,
      envName: "prod",
      usePlaceholderSource: true,
      ...props,
    }),
  );
}

const template = synth();

describe("site bucket", () => {
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

  test("prod retains the bucket", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  test("writes server access logs to the separate log bucket (AwsSolutions-S1)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LoggingConfiguration: {
        DestinationBucketName: { Ref: Match.stringLikeRegexp("^AccessLogBucket") },
        LogFilePrefix: ACCESS_LOG_PREFIX,
      },
    });
  });

  test("the log bucket is a different bucket, not the site bucket", () => {
    // Logging into the site bucket would put log objects inside the key space
    // CloudFront serves.
    const logging = Object.values(template.findResources("AWS::S3::Bucket"))
      .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
      .map((properties) => properties["LoggingConfiguration"])
      .filter((config): config is Record<string, unknown> => config !== undefined);

    expect(logging).toHaveLength(1);
    expect(JSON.stringify(logging[0])).not.toContain("SiteBucket");
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

  test("is not itself public and still enforces TLS", () => {
    const logBucket = Object.entries(template.findResources("AWS::S3::Bucket")).find(
      ([logicalId]) => logicalId.startsWith("AccessLogBucket"),
    );
    expect(logBucket).toBeDefined();

    const properties = (logBucket?.[1] as { Properties: Record<string, unknown> }).Properties;
    expect(properties["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });

    // enforceSSL renders as a Deny statement on the bucket policy, not a
    // bucket property, so it is asserted against the policy for this bucket.
    const denies = Object.values(template.findResources("AWS::S3::BucketPolicy"))
      .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
      .filter((props) => JSON.stringify(props["Bucket"]).includes("AccessLogBucket"));
    expect(JSON.stringify(denies)).toContain("aws:SecureTransport");
  });
});

describe("CloudFront", () => {
  test("uses Origin Access Control and not the legacy OAI", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    expect(JSON.stringify(template.toJSON())).not.toContain("origin-access-identity");
  });

  test("serves both the apex and www", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: Match.arrayWith([domains.platform, `www.${domains.platform}`]),
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

  test("has a /data/* behaviour with a 300s TTL matching the write cadence", () => {
    const distribution = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )[0] as { Properties: { DistributionConfig: Record<string, unknown> } };
    const behaviors = distribution.Properties.DistributionConfig["CacheBehaviors"] as Array<
      Record<string, unknown>
    >;

    const dataBehavior = behaviors.find((b) => b["PathPattern"] === `/${DATA_PREFIX}/*`);
    expect(dataBehavior).toBeDefined();
    expect(dataBehavior?.["ViewerProtocolPolicy"]).toBe("redirect-to-https");

    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({ DefaultTTL: 300, MaxTTL: 300, MinTTL: 0 }),
    });
  });

  test("the /data/* behaviour uses a different cache policy from the default", () => {
    const config = (
      Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
        Properties: { DistributionConfig: Record<string, unknown> };
      }
    ).Properties.DistributionConfig;
    const behaviors = config["CacheBehaviors"] as Array<Record<string, unknown>>;
    const dataBehavior = behaviors.find((b) => b["PathPattern"] === `/${DATA_PREFIX}/*`);
    const defaultBehavior = config["DefaultCacheBehavior"] as Record<string, unknown>;

    expect(dataBehavior?.["CachePolicyId"]).not.toEqual(defaultBehavior["CachePolicyId"]);
  });

  test("writes access logs to the shared log bucket (AwsSolutions-CFR3)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Logging: {
          Bucket: {
            "Fn::GetAtt": [Match.stringLikeRegexp("^AccessLogBucket"), "RegionalDomainName"],
          },
          Prefix: CLOUDFRONT_LOG_PREFIX,
          IncludeCookies: false,
        },
      }),
    });
  });

  test("logs under a different prefix from the S3 access logs", () => {
    // Sharing a prefix would interleave two log formats in one key space.
    expect(CLOUDFRONT_LOG_PREFIX).not.toEqual(ACCESS_LOG_PREFIX);
  });

  test("maps 403 and 404 to the static export's 404.html, not to index.html", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
          }),
        ]),
      }),
    });
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

  test("sets nosniff, a referrer policy and a CSP", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: {
            ReferrerPolicy: "strict-origin-when-cross-origin",
            Override: true,
          },
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'"),
          }),
        }),
      }),
    });
  });

  test("the CSP allows no third-party script origin and no inline script", () => {
    const policy = Object.values(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    )[0] as { Properties: Record<string, Record<string, Record<string, Record<string, string>>>> };
    const csp =
      policy.Properties["ResponseHeadersPolicyConfig"]?.["SecurityHeadersConfig"]?.[
        "ContentSecurityPolicy"
      ]?.["ContentSecurityPolicy"] ?? "";

    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("fetcher Lambda", () => {
  test("is ARM64 on the newest Node runtime CDK knows about (AwsSolutions-L1)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: FETCHER_RUNTIME.name,
      Architectures: ["arm64"],
      Handler: "index.handler",
    });
  });

  test("is told which bucket, keys and parameters to use", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          RETURNS_KEY: `${DATA_PREFIX}/oanda-returns.json`,
          TRADES_KEY: `${DATA_PREFIX}/oanda-trades.json`,
          OANDA_ACCOUNT_ID_PARAMETER: oandaParameterNames.accountId,
          OANDA_ACCESS_TOKEN_PARAMETER: oandaParameterNames.accessToken,
        }),
      },
    });
  });

  test("has an explicit log group retention — LogRetentionAspect fails synth without one", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
  });
});

/**
 * `PolicyDocument.Statement` entries as plain objects, from the inline policies
 * attached to a given role. Working at this level rather than with `Match` is
 * deliberate: these tests assert what is *absent* from a resource list, and a
 * partial matcher cannot express that.
 *
 * The role filter matters. BucketDeployment's own handler legitimately holds a
 * bucket-wide grant — it deploys the site — so an unfiltered scan would either
 * fail or have to be weakened into meaninglessness. What is being asserted is
 * that the *fetcher* is narrower than the deployer.
 */
function policyStatements(roleLogicalIdPrefix?: string): Array<Record<string, unknown>> {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .map((resource) => (resource as { Properties: Record<string, unknown> }).Properties)
    .filter((properties) => {
      if (roleLogicalIdPrefix === undefined) {
        return true;
      }
      return JSON.stringify(properties["Roles"] ?? []).includes(roleLogicalIdPrefix);
    })
    .flatMap((properties) => {
      const document = properties["PolicyDocument"] as {
        Statement?: Array<Record<string, unknown>>;
      };
      return document.Statement ?? [];
    });
}

function fetcherStatementsWithAction(action: string): Array<Record<string, unknown>> {
  return policyStatements("OandaFetcherServiceRole").filter((statement) => {
    const actions = statement["Action"];
    return Array.isArray(actions) ? actions.includes(action) : actions === action;
  });
}

function resourcesOf(statement: Record<string, unknown>): unknown[] {
  const resource = statement["Resource"];
  return Array.isArray(resource) ? resource : [resource];
}

describe("least privilege (the point of this file)", () => {
  test("the fetcher can write data/* and nothing else in the bucket", () => {
    const puts = fetcherStatementsWithAction("s3:PutObject");
    expect(puts).toHaveLength(1);

    for (const resource of resourcesOf(puts[0] as Record<string, unknown>)) {
      const rendered = JSON.stringify(resource);
      expect(rendered).toContain(`/${DATA_PREFIX}/*`);
      // A bare bucket ARN or a `/*` suffix would cover index.html.
      expect(rendered).not.toMatch(/"\/\*"/);
    }
  });

  test("the fetcher holds no other S3 permission at all", () => {
    const s3Actions = policyStatements("OandaFetcherServiceRole")
      .flatMap((statement) => {
        const actions = statement["Action"];
        return Array.isArray(actions) ? actions : [actions];
      })
      .filter((action) => typeof action === "string" && action.startsWith("s3:"));

    expect(s3Actions).toEqual(["s3:PutObject"]);
  });

  test("no policy grants s3:* or a wildcard action", () => {
    for (const statement of policyStatements()) {
      const actions = statement["Action"];
      const list = Array.isArray(actions) ? actions : [actions];
      expect(list).not.toContain("s3:*");
      expect(list).not.toContain("*");
    }
  });

  test("the fetcher role attaches no AWS managed policy (AwsSolutions-IAM4)", () => {
    // The CDK default attaches AWSLambdaBasicExecutionRole, which grants
    // logs:CreateLogGroup and writes to every log group in the account.
    const role = Object.entries(template.findResources("AWS::IAM::Role")).find(([logicalId]) =>
      logicalId.startsWith("OandaFetcherServiceRole"),
    );
    expect(role).toBeDefined();

    const properties = (role?.[1] as { Properties: Record<string, unknown> }).Properties;
    expect(properties["ManagedPolicyArns"]).toBeUndefined();
  });

  test("the fetcher can write only its own log group", () => {
    const logStatements = policyStatements("OandaFetcherServiceRole").filter((statement) => {
      const actions = statement["Action"];
      const list = Array.isArray(actions) ? actions : [actions];
      return list.some((action) => typeof action === "string" && action.startsWith("logs:"));
    });

    expect(logStatements).toHaveLength(1);
    const rendered = JSON.stringify(logStatements[0]);
    expect(rendered).toContain("OandaFetcherLogs");
    // Creating a group would let it write outside the one declared here.
    expect(rendered).not.toContain("logs:CreateLogGroup");
    expect(rendered).not.toContain("logs:*");
  });

  test("the fetcher reads exactly the two named SSM parameters", () => {
    const reads = fetcherStatementsWithAction("ssm:GetParameters");
    expect(reads).toHaveLength(1);

    const rendered = JSON.stringify(resourcesOf(reads[0] as Record<string, unknown>));
    expect(rendered).toContain(oandaParameterNames.accountId);
    expect(rendered).toContain(oandaParameterNames.accessToken);
    // Not a prefix grant: `/personal-site/*` would include every future secret.
    expect(rendered).not.toContain(`parameter/${APP_NAME}/*`);
    expect(rendered).not.toContain(":parameter/*");
  });
});

describe("schedule", () => {
  test("runs hourly via EventBridge Scheduler", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 hour)",
      FlexibleTimeWindow: { Mode: "OFF" },
    });
  });

  test("targets the fetcher Lambda", () => {
    const schedule = Object.values(template.findResources("AWS::Scheduler::Schedule"))[0] as {
      Properties: { Target: Record<string, unknown> };
    };
    expect(JSON.stringify(schedule.Properties.Target)).toContain("OandaFetcher");
  });
});

describe("deployment", () => {
  test("invalidates the distribution so a deploy is visible immediately", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/*"],
      Prune: false,
    });
  });

  test("refuses to synthesize when the static export is missing", () => {
    const app = new App();
    expect(
      () =>
        new SiteStack(app, "MissingSourceStack", {
          env: ENV,
          envName: "prod",
          siteSourcePath: "/definitely/not/a/real/export/directory",
        }),
    ).toThrow(/Static export not found/);
  });
});

describe("cross-stack contract", () => {
  test("reads the certificate from SSM and exports nothing (ADR-0004)", () => {
    expect(JSON.stringify(template.toJSON())).toContain(
      `/platform/acm/${domains.platform}/certificate-arn`,
    );
    for (const output of Object.values(
      (template.toJSON()["Outputs"] ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      expect(output["Export"]).toBeUndefined();
    }
  });
});

describe("tagging", () => {
  test("the bucket carries app/env/owner", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([
        { Key: "app", Value: APP_NAME },
        { Key: "env", Value: "prod" },
        { Key: "owner", Value: "josephkan" },
      ]),
    });
  });
});

describe("dev profile", () => {
  test("destroys the bucket rather than retaining it", () => {
    synth({ envName: "dev" }).hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
  });
});
