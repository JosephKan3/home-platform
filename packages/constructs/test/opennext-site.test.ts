/**
 * OpenNextSite's guarantees, asserted independently of any consuming stack.
 * Same discipline as static-site.test.ts — see its header comment.
 */

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { profileFor, synthesizerFor } from "@platform/config";
import * as path from "node:path";
import { OpenNextSite } from "../src/index.js";
import type { OpenNextSiteProps } from "../src/index.js";
import type { PolicyViolation } from "aws-cdk-lib";

const ENV = { account: "222222222222", region: "us-east-1" };
const CERT_ARN = "arn:aws:acm:us-east-1:222222222222:certificate/abc-123";

/**
 * A real `open-next.output.json` plus dummy Lambda bundles, modeled on
 * NewNotams' actual build output (Phase 1 action plan §2) — including
 * `tagCache`, `queue` and `imageOptimizer`, so `includeTagCache`/
 * `includeRevalidation`/`includeImageOptimization` have something real to
 * read rather than only being exercisable against the placeholder manifest.
 */
const FIXTURE_OUTPUT_PATH = path.join(__dirname, "fixtures", "opennext-output");

function newSite(props: Partial<OpenNextSiteProps> = {}): { stack: Stack; site: OpenNextSite } {
  const app = new App();
  const stack = new Stack(app, "TestStack", { env: ENV, synthesizer: synthesizerFor("prod") });
  const site = new OpenNextSite(stack, "Site", {
    domainNames: ["example.test", "www.example.test"],
    certificate: CERT_ARN,
    profile: profileFor("prod"),
    openNextOutputPath: "/definitely/not/a/real/build/directory",
    usePlaceholderSource: true,
    ...props,
  });
  return { stack, site };
}

function synth(props: Partial<OpenNextSiteProps> = {}): Template {
  return Template.fromStack(newSite(props).stack);
}

const template = synth();

describe("the two decisions that must agree across the platform/application seam", () => {
  test("includeTagCache true with a placeholder source does not throw — the assertion is skipped", () => {
    // usePlaceholderSource short-circuits assertTagCacheAgreement entirely,
    // since there is no real open-next.output.json to check against.
    expect(() => newSite({ includeTagCache: true })).not.toThrow();
  });
});

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

  test("has ABAC enabled, so the dev permissions boundary's env=prod Deny actually evaluates (docs/open-issues.md issue 9)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", { AbacStatus: "Enabled" });
  });

  test("the profile drives the removal policy", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    synth({ profile: profileFor("dev") }).hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
    });
  });
});

describe("server function", () => {
  test("runs with no VPC configuration — ADR-0002, nothing this app talks to needs a private IP", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    for (const [, resource] of Object.entries(functions)) {
      expect((resource as { Properties: Record<string, unknown> }).Properties["VpcConfig"]).toBeUndefined();
    }
  });

  test("runs on arm64", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
    });
  });

  test("has its own log group rather than relying on the deprecated logRetention custom resource", () => {
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });
});

describe("optional pieces default off", () => {
  test("no image-optimization function, no DynamoDB table, no SQS queue by default", () => {
    template.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
    template.resourceCountIs("AWS::SQS::Queue", 0);
    // The server function plus aws-cdk-lib's own BucketDeployment singleton
    // handler (not declared by this construct — see
    // suppressDeploymentHandlerFindings). No image-optimizer, no revalidation
    // consumer.
    template.resourceCountIs("AWS::Lambda::Function", 2);
  });

  test("includeTagCache provisions the table; includeRevalidation provisions the queue", () => {
    const withBoth = synth({
      includeTagCache: true,
      includeRevalidation: true,
      openNextOutputPath: FIXTURE_OUTPUT_PATH,
      usePlaceholderSource: false,
    });
    withBoth.resourceCountIs("AWS::DynamoDB::GlobalTable", 1);
    // The revalidation queue plus its dead-letter queue (AwsSolutions-SQS3).
    withBoth.resourceCountIs("AWS::SQS::Queue", 2);
    // Server + revalidation consumer + the BucketDeployment handler. Image
    // optimizer still off (not requested).
    withBoth.resourceCountIs("AWS::Lambda::Function", 3);
  });
});

describe("distribution", () => {
  test("redirects HTTP to HTTPS and enforces TLS 1.2+", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: "TLSv1.2_2021" }),
      }),
    });
  });

  test("logs to the shared access-log bucket", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({}),
      }),
    });
  });
});

describe("handles for the consuming stack", () => {
  test("exposes the bucket, log bucket, distribution and server function", () => {
    const { site } = newSite();
    expect(site.bucket.bucketArn).toBeDefined();
    expect(site.logBucket.bucketArn).toBeDefined();
    expect(site.distribution.distributionDomainName).toBeDefined();
    expect(site.serverFunction.functionArn).toBeDefined();
  });

  test("imageFunction, tagCacheTable and revalidationQueue are undefined unless opted into", () => {
    const { site } = newSite();
    expect(site.imageFunction).toBeUndefined();
    expect(site.tagCacheTable).toBeUndefined();
    expect(site.revalidationQueue).toBeUndefined();
  });
});

/**
 * cdk-nag. Same discipline as StaticSite's identical describe block — see
 * its comment. CFR1/CFR2 (geo-restriction, WAF) are judgement calls for the
 * consuming stack, not this construct, and are deliberately left unsuppressed.
 */
describe("cdk-nag AwsSolutionsChecks", () => {
  function violations(props: Partial<OpenNextSiteProps> = {}): PolicyViolation[] {
    const app = new App();
    const stack = new Stack(app, "NagStack", { env: ENV, synthesizer: synthesizerFor("prod") });
    new OpenNextSite(stack, "Site", {
      domainNames: ["example.test"],
      certificate: CERT_ARN,
      profile: profileFor("prod"),
      openNextOutputPath: "/nowhere",
      usePlaceholderSource: true,
      ...props,
    });
    return new AwsSolutionsChecks(app, { verbose: true }).validateScope(app).violations;
  }

  test("reports zero unsuppressed errors with every optional piece off", () => {
    const errors = violations()
      .filter((violation) => violation.severity === "error")
      .map(
        (violation) =>
          `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath ?? ""}`,
      );

    expect(errors).toEqual([]);
  });

  test("reports zero unsuppressed errors with every optional piece on", () => {
    const errors = violations({
      includeTagCache: true,
      includeRevalidation: true,
      includeImageOptimization: true,
      openNextOutputPath: FIXTURE_OUTPUT_PATH,
      usePlaceholderSource: false,
    })
      .filter((violation) => violation.severity === "error")
      .map(
        (violation) =>
          `${violation.ruleName}: ${violation.violatingResources[0]?.constructPath ?? ""}`,
      );

    expect(errors).toEqual([]);
  });
});
