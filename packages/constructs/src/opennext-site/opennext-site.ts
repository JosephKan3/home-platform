/**
 * OpenNextSite — a Next.js app built with `@opennextjs/aws` and deployed as
 * S3 + CloudFront + Lambda, modeled on the official OpenNext reference CDK
 * implementation (https://opennext.js.org/aws/reference-implementation) but
 * read from `open-next.output.json` at synth time rather than hand-copied,
 * and adapted to this platform's conventions (profile-driven removal policy,
 * `abacStatus` on every bucket, scoped execution roles, cited cdk-nag
 * suppressions) the way `StaticSite` was for a plain static export.
 *
 * Unlike `StaticSite`, this construct's shape is genuinely conditional on
 * what the built app uses. OpenNext's build always emits an
 * image-optimization function, a revalidation function, a warmer function,
 * and (unless `dangerous.disableTagCache` is set in the app's
 * `open-next.config.ts`) a DynamoDB tag-cache table and its one-time init
 * Lambda — regardless of whether the app's code ever calls `next/image`
 * without `unoptimized: true`, `revalidateTag`/`revalidatePath`, or defines
 * any ISR route. Provisioning all of it unconditionally would mean real,
 * billed AWS resources (DynamoDB's on-demand floor, SQS, two extra Lambdas)
 * for features nothing invokes — confirmed directly against NewNotams'
 * first real consumer, which uses none of them (Phase 1 action plan §0, §2).
 * `includeImageOptimization`, `includeRevalidation`, and `includeTagCache`
 * default to `false` for exactly this reason: a future consumer that *does*
 * use ISR or `next/image` optimization opts in explicitly, rather than every
 * consumer paying for the reference implementation's full shape by default.
 *
 * Still owns only what `StaticSite` owns: the generic shape, not anything
 * application-specific. SSM reads, additional IAM grants, and the
 * EventBridge-invoked background job (if any) are added by the caller
 * through `serverFunction.role`, the same seam `ScheduledJob` uses.
 */

import { Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { bootstrapQualifierFor } from "@platform/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { Construct } from "constructs";
import { flattenForNagId, suppressNagRules, suppressNagRulesAtPath } from "../nag/index.js";
import type { EnvProfile } from "@platform/config";

/**
 * Runtime every OpenNext Lambda on the platform runs. See
 * ScheduledJob.SCHEDULED_JOB_RUNTIME's comment for why this is Node 24, not a
 * lower version a particular OpenNext handler happens to be compiled for:
 * it is the newest runtime aws-cdk-lib 2.263 knows about, which is what
 * `AwsSolutions-L1` checks against.
 */
export const OPEN_NEXT_RUNTIME = lambda.Runtime.NODEJS_24_X;

/** Server function memory. OpenNext's own default; generous enough for a cold Next.js boot. */
const DEFAULT_SERVER_MEMORY_MB = 1024;
const DEFAULT_SERVER_TIMEOUT = Duration.seconds(30);
const DEFAULT_IMAGE_MEMORY_MB = 1024;
const DEFAULT_IMAGE_TIMEOUT = Duration.seconds(25);
const DEFAULT_REVALIDATION_MEMORY_MB = 128;
const DEFAULT_REVALIDATION_TIMEOUT = Duration.seconds(30);

/**
 * Prefix for both S3 server access logs and CloudFront standard logs.
 *
 * Named distinctly from `StaticSite`'s identical constants of the same
 * value, rather than imported from there, because the two constructs are
 * independent and a future change to one's log layout should not silently
 * also move the other's.
 */
export const OPEN_NEXT_ACCESS_LOG_PREFIX = "s3/";
export const OPEN_NEXT_CLOUDFRONT_LOG_PREFIX = "cloudfront/";
export const OPEN_NEXT_ACCESS_LOG_RETENTION_DAYS = 90;

/**
 * Shape of `.open-next/open-next.output.json`. Narrowed to the fields this
 * construct reads — OpenNext's own type is `OpenNextConfigOutput` internal to
 * `@opennextjs/aws`, not exported for consumers to import.
 */
interface OpenNextOutput {
  origins: {
    s3: {
      originPath: string;
      copy: { from: string; to: string; cached: boolean; versionedSubDir?: string }[];
    };
    default: { handler: string; bundle: string; streaming?: boolean };
    imageOptimizer?: { handler: string; bundle: string; streaming?: boolean };
    [key: string]: unknown;
  };
  behaviors: { pattern: string; origin?: string }[];
  additionalProps?: {
    disableTagCache?: boolean;
    warmer?: { handler: string; bundle: string };
    revalidationFunction?: { handler: string; bundle: string };
    initializationFunction?: { handler: string; bundle: string };
  };
}

export interface OpenNextSiteProps {
  /** Aliases on the distribution. The first is used in generated comments. */
  readonly domainNames: string[];

  /** ACM certificate for `domainNames`, in us-east-1. See StaticSiteProps. */
  readonly certificate: acm.ICertificate | string;

  /** Drives removal policy and object auto-deletion. */
  readonly profile: EnvProfile;

  /**
   * Directory holding `npx open-next build`'s output (the directory
   * containing `open-next.output.json`, conventionally `.open-next`).
   *
   * Read only when `usePlaceholderSource` is false. See StaticSiteProps for
   * why synth must work without this directory existing.
   */
  readonly openNextOutputPath: string;

  /**
   * Deploy a generated placeholder instead of the real build output.
   *
   * See StaticSiteProps.usePlaceholderSource. When true, none of
   * `openNextOutputPath` is read and the server function is a trivial inline
   * handler returning a static page, so synth needs no app checkout at all.
   */
  readonly usePlaceholderSource?: boolean;

  /**
   * Provision the image-optimization Lambda and its `_next/image*` CloudFront
   * behavior.
   *
   * Default `false`. If the app's `next.config` sets `images.unoptimized: true`
   * (or passes a custom non-`"default"` loader), `next/image` never generates
   * an optimizer request in the first place — Next's own server returns 404
   * for that route without invoking the optimizer — so the Lambda OpenNext
   * still bundles would sit permanently idle. Set true only if the app
   * actually uses Next's built-in image optimization.
   */
  readonly includeImageOptimization?: boolean;

  /**
   * Provision the DynamoDB tag-cache table, its one-time init Lambda, and the
   * custom resource that seeds it.
   *
   * Default `false`. This table exists solely to back `revalidateTag` and
   * `revalidatePath` on the App Router (OpenNext docs: "exclusively used for
   * ISR"). Leave this default unless the app actually calls either function —
   * and if it does, set `dangerous.disableTagCache` to `false` (the OpenNext
   * default) in the app's own `open-next.config.ts`, since this prop and that
   * config must agree: this construct does not read the app's OpenNext config
   * to detect which value was used, only `open-next.output.json`'s own
   * `additionalProps.disableTagCache` echo of it (asserted in the constructor).
   */
  readonly includeTagCache?: boolean;

  /**
   * Provision the SQS revalidation queue and its consumer Lambda.
   *
   * Default `false`, for the same reason as `includeTagCache`: the
   * revalidation queue is "exclusively used for ISR" (OpenNext docs) — a
   * message is enqueued only when a page already serving stale content is
   * revalidated, which requires a route to opt into ISR in the first place.
   * An app with no `export const revalidate` and no ISR route never sends a
   * message, so the queue and its consumer would sit permanently idle.
   */
  readonly includeRevalidation?: boolean;

  /** Server function memory, MB. OpenNext's own default is 1024. */
  readonly serverMemorySize?: number;

  /** Server function timeout. Default 30s. */
  readonly serverTimeout?: Duration;

  /** Distribution comment. Shown in the CloudFront console. */
  readonly comment?: string;
}

export class OpenNextSite extends Construct {
  /** The static-asset origin bucket. Grant to this to let something else write into it. */
  readonly bucket: s3.Bucket;
  /** Destination for S3 and CloudFront access logs. */
  readonly logBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  /** The Next.js server. Add SSM/other grants to `serverFunction.role`. */
  readonly serverFunction: lambda.Function;
  /** Present only when `includeImageOptimization` is true. */
  readonly imageFunction?: lambda.Function;
  /** Present only when `includeTagCache` is true. */
  readonly tagCacheTable?: dynamodb.TableV2;
  /** Present only when `includeRevalidation` is true. */
  readonly revalidationQueue?: sqs.Queue;

  private readonly output: OpenNextOutput;

  constructor(scope: Construct, id: string, props: OpenNextSiteProps) {
    super(scope, id);

    const { profile } = props;
    const primaryDomain = props.domainNames[0] ?? "Next.js site";
    this.output = this.loadOutput(props);

    this.assertTagCacheAgreement(props);

    this.logBucket = this.createLogBucket(profile.removalPolicy);
    this.bucket = this.createSiteBucket(profile.removalPolicy);

    const includeImageOptimization = props.includeImageOptimization ?? false;
    const includeTagCache = props.includeTagCache ?? false;
    const includeRevalidation = props.includeRevalidation ?? false;

    if (includeTagCache) {
      this.tagCacheTable = this.createTagCacheTable(profile.removalPolicy);
    }
    if (includeRevalidation) {
      this.revalidationQueue = this.createRevalidationQueue(profile);
    }

    const environment = this.buildServerEnvironment();

    this.serverFunction = this.createServerFunction(props, environment);
    this.grantServerPermissions();

    if (includeImageOptimization) {
      this.imageFunction = this.createImageFunction(props, environment);
    }

    this.distribution = this.createDistribution(props, primaryDomain, includeImageOptimization);
    this.deployStaticAssets(props, primaryDomain);
  }

  /**
   * `open-next.output.json` is read at synth time, not hand-copied the way
   * the OpenNext reference implementation's example embeds a fixed shape —
   * so a future OpenNext version that changes behaviors or adds an origin
   * type is reflected automatically, at the cost of the type assertion below
   * being honest about how little is actually validated.
   */
  private loadOutput(props: OpenNextSiteProps): OpenNextOutput {
    if (props.usePlaceholderSource === true) {
      // Synth must work with no app checkout at all — see
      // StaticSiteProps.usePlaceholderSource. A minimal manifest describing a
      // site with no image optimization, no tag cache and no revalidation
      // lets every code path below run against *something*, without reading
      // a real build.
      return {
        origins: {
          s3: { originPath: "/_assets", copy: [] },
          default: { handler: "index.handler", bundle: "" },
        },
        behaviors: [{ pattern: "*" }],
        additionalProps: { disableTagCache: true },
      };
    }

    const manifestPath = path.join(props.openNextOutputPath, "open-next.output.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `OpenNext build output not found at ${manifestPath}. Run ` +
          "`npx open-next build` in the app repo first, pass a different " +
          "openNextOutputPath, or set usePlaceholderSource to render the stack " +
          "without a build.",
      );
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as OpenNextOutput;
    return this.resolveBundlePaths(raw, props.openNextOutputPath);
  }

  /**
   * `open-next.output.json`'s own `bundle`/`copy.from` fields are written
   * relative to the directory `npx open-next build` was run from (the app's
   * project root — confirmed against a real build: a path reads
   * `.open-next/server-functions/default`, not `server-functions/default`,
   * even though the manifest itself lives inside `.open-next/`). Resolving
   * them here, against `openNextOutputPath`'s parent, means
   * `lambda.Code.fromAsset(...)` gets a correct path regardless of the CDK
   * process's own working directory at synth time — which will not always
   * match the app repo's root, since this stack's `cdk synth` runs from
   * inside this monorepo, not inside the checked-out app repo.
   */
  private resolveBundlePaths(output: OpenNextOutput, openNextOutputPath: string): OpenNextOutput {
    const projectRoot = path.dirname(path.resolve(openNextOutputPath));
    const resolve = (relativePath: string): string => path.join(projectRoot, relativePath);

    return {
      ...output,
      origins: {
        ...output.origins,
        s3: {
          ...output.origins.s3,
          copy: output.origins.s3.copy.map((copy) => ({ ...copy, from: resolve(copy.from) })),
        },
        default: { ...output.origins.default, bundle: resolve(output.origins.default.bundle) },
        ...(output.origins.imageOptimizer !== undefined
          ? { imageOptimizer: { ...output.origins.imageOptimizer, bundle: resolve(output.origins.imageOptimizer.bundle) } }
          : {}),
      },
      additionalProps:
        output.additionalProps === undefined
          ? undefined
          : {
              ...output.additionalProps,
              revalidationFunction:
                output.additionalProps.revalidationFunction === undefined
                  ? undefined
                  : {
                      ...output.additionalProps.revalidationFunction,
                      bundle: resolve(output.additionalProps.revalidationFunction.bundle),
                    },
            },
    };
  }

  /**
   * `includeTagCache` (this construct's prop) and `dangerous.disableTagCache`
   * (the app's own `open-next.config.ts`) describe the same decision from two
   * sides of the platform/application seam and must agree, or the deployed
   * infrastructure silently mismatches what the Lambda bundle expects at
   * runtime — e.g. a server function built expecting a DynamoDB table that
   * this construct never provisions. Caught here, at synth, rather than as a
   * runtime `ResourceNotFoundException` days later.
   */
  private assertTagCacheAgreement(props: OpenNextSiteProps): void {
    if (props.usePlaceholderSource === true) return;
    const includeTagCache = props.includeTagCache ?? false;
    const appDisabledTagCache = this.output.additionalProps?.disableTagCache ?? false;
    if (includeTagCache === appDisabledTagCache) {
      throw new Error(
        `OpenNextSite "${this.node.path}": includeTagCache is ${includeTagCache}, but the ` +
          `app's own open-next.config.ts sets dangerous.disableTagCache to ` +
          `${appDisabledTagCache}. These must disagree (includeTagCache = ` +
          "!disableTagCache) — the server function bundle was built expecting one " +
          "answer and this construct would provision infrastructure for the other.",
      );
    }
  }

  /** Mirrors StaticSite.createLogBucket exactly; see its comment for the reasoning. */
  private createLogBucket(removalPolicy: RemovalPolicy): s3.Bucket {
    const bucket = new s3.Bucket(this, "AccessLogBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [
        { id: "ExpireAccessLogs", enabled: true, expiration: Duration.days(OPEN_NEXT_ACCESS_LOG_RETENTION_DAYS) },
      ],
      abacStatus: true,
    });

    suppressNagRules(bucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "This is the access log destination. See StaticSite's identical " +
          "suppression and ADR-0007 for the full reasoning.",
      },
    ]);

    return bucket;
  }

  private createSiteBucket(removalPolicy: RemovalPolicy): s3.Bucket {
    return new s3.Bucket(this, "Bucket", {
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: OPEN_NEXT_ACCESS_LOG_PREFIX,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      // See StaticSite's identical property and docs/open-issues.md issue 9.
      abacStatus: true,
    });
  }

  /**
   * Tag cache table. Only created when `includeTagCache` is true — see that
   * prop's doc comment. The reference implementation also provisions a
   * one-time init Lambda and custom resource to seed this table from the
   * build output; omitted here because OpenNext's own revalidation path
   * creates rows on demand and an empty table at first deploy is a cache
   * miss, not a correctness problem, for any consumer that reaches this
   * branch. Revisit if a future consumer's access pattern needs the seed.
   */
  private createTagCacheTable(removalPolicy: RemovalPolicy): dynamodb.TableV2 {
    return new dynamodb.TableV2(this, "TagCacheTable", {
      partitionKey: { name: "tag", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "path", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: "revalidate",
          partitionKey: { name: "path", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "revalidatedAt", type: dynamodb.AttributeType.NUMBER },
        },
      ],
      removalPolicy,
    });
  }

  private createRevalidationQueue(profile: EnvProfile): sqs.Queue {
    // AwsSolutions-SQS3: a dead-letter queue for messages the consumer
    // cannot process after its retries. A revalidation message that never
    // succeeds is not urgent (the stale page keeps serving its last-known
    // content), so maxReceiveCount is generous rather than tight — the DLQ
    // exists so a systemic failure is observable, not to minimize retry
    // latency on an occasional bad message.
    const deadLetterQueue = new sqs.Queue(this, "RevalidationDeadLetterQueue", {
      fifo: true,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new sqs.Queue(this, "RevalidationQueue", {
      fifo: true,
      receiveMessageWaitTime: Duration.seconds(20),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
    });

    const consumerLogs = new logs.LogGroup(this, "RevalidationFunctionLogs", {
      retention: profile.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const revalidationBundle = this.output.additionalProps?.revalidationFunction;
    if (revalidationBundle === undefined) {
      throw new Error(
        `OpenNextSite "${this.node.path}": includeRevalidation is true but ` +
          "open-next.output.json has no additionalProps.revalidationFunction. " +
          "The OpenNext build did not emit a revalidation bundle to deploy.",
      );
    }

    const consumerRole = this.createServerExecutionRole("RevalidationFunction", consumerLogs);

    const consumer = new lambda.Function(this, "RevalidationFunction", {
      description: "OpenNext revalidation consumer — processes ISR revalidation requests.",
      runtime: OPEN_NEXT_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      handler: revalidationBundle.handler,
      code: lambda.Code.fromAsset(revalidationBundle.bundle),
      timeout: DEFAULT_REVALIDATION_TIMEOUT,
      memorySize: DEFAULT_REVALIDATION_MEMORY_MB,
      logGroup: consumerLogs,
      role: consumerRole,
    });
    consumer.addEventSource(new SqsEventSource(queue, { batchSize: 5 }));

    return queue;
  }

  private buildServerEnvironment(): Record<string, string> {
    const env: Record<string, string> = {
      CACHE_BUCKET_NAME: this.bucket.bucketName,
      CACHE_BUCKET_KEY_PREFIX: "_cache",
      CACHE_BUCKET_REGION: Stack.of(this).region,
      BUCKET_NAME: this.bucket.bucketName,
      BUCKET_KEY_PREFIX: "_assets",
    };
    if (this.revalidationQueue !== undefined) {
      env["REVALIDATION_QUEUE_URL"] = this.revalidationQueue.queueUrl;
      env["REVALIDATION_QUEUE_REGION"] = Stack.of(this).region;
    }
    if (this.tagCacheTable !== undefined) {
      env["CACHE_DYNAMO_TABLE"] = this.tagCacheTable.tableName;
    }
    return env;
  }

  private createServerFunction(
    props: OpenNextSiteProps,
    environment: Record<string, string>,
  ): lambda.Function {
    const logGroup = new logs.LogGroup(this, "ServerFunctionLogs", {
      retention: props.profile.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = this.createServerExecutionRole("ServerFunction", logGroup);

    return new lambda.Function(this, "ServerFunction", {
      description: `${props.domainNames[0] ?? "site"} — Next.js server (OpenNext).`,
      runtime: OPEN_NEXT_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      handler: this.output.origins.default.handler,
      code:
        props.usePlaceholderSource === true
          ? lambda.Code.fromInline(PLACEHOLDER_SERVER_SOURCE)
          : lambda.Code.fromAsset(this.output.origins.default.bundle),
      memorySize: props.serverMemorySize ?? DEFAULT_SERVER_MEMORY_MB,
      timeout: props.serverTimeout ?? DEFAULT_SERVER_TIMEOUT,
      environment,
      logGroup,
      role,
    });
  }

  private createImageFunction(
    props: OpenNextSiteProps,
    environment: Record<string, string>,
  ): lambda.Function {
    const imageOrigin = this.output.origins.imageOptimizer;
    if (imageOrigin === undefined) {
      throw new Error(
        `OpenNextSite "${this.node.path}": includeImageOptimization is true but ` +
          "open-next.output.json has no origins.imageOptimizer. The OpenNext " +
          "build did not emit an image-optimization bundle to deploy.",
      );
    }

    const logGroup = new logs.LogGroup(this, "ImageFunctionLogs", {
      retention: props.profile.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = this.createServerExecutionRole("ImageFunction", logGroup);
    this.bucket.grantRead(role);
    this.suppressBucketGrantFindings(role, "ImageFunction", false);

    return new lambda.Function(this, "ImageFunction", {
      description: `${props.domainNames[0] ?? "site"} — Next.js image optimizer (OpenNext).`,
      runtime: OPEN_NEXT_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      handler: imageOrigin.handler,
      code: lambda.Code.fromAsset(imageOrigin.bundle),
      memorySize: DEFAULT_IMAGE_MEMORY_MB,
      timeout: DEFAULT_IMAGE_TIMEOUT,
      environment,
      logGroup,
      role,
    });
  }

  /**
   * Scoped to this function's own log group, exactly like
   * ScheduledJob.createExecutionRole — see its comment for why this replaces
   * rather than supplements the AWSLambdaBasicExecutionRole managed policy.
   */
  private createServerExecutionRole(idPrefix: string, logGroup: logs.LogGroup): iam.Role {
    const role = new iam.Role(this, `${idPrefix}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        `Execution role for ${idPrefix}. Writes its own log group; every other ` +
        "grant is added explicitly by this construct or its caller.",
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
      }),
    );

    suppressNagRules(role, [
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, logGroup.logGroupArn)}:log-stream:*]`,
        reason:
          "Lambda creates one log stream per concurrent execution with a " +
          "service-generated name — see ScheduledJob's identical suppression " +
          "and ADR-0007.",
      },
    ]);

    return role;
  }

  /**
   * Grants the server function needs regardless of which optional pieces are
   * enabled: read/write on its own cache prefix in the site bucket (OpenNext's
   * S3-backed incremental cache always runs, independent of
   * `includeTagCache`/`includeRevalidation` — see Phase 1 action plan §2's
   * note on the incremental cache still serving the static homepage even with
   * zero ISR revalidation ever triggered).
   */
  private grantServerPermissions(): void {
    const role = this.serverFunction.role!;
    this.bucket.grantReadWrite(role);
    this.suppressBucketGrantFindings(role, "ServerFunction", true);

    if (this.tagCacheTable !== undefined) {
      this.tagCacheTable.grantReadWriteData(role);
      // ITableV2.grantReadWriteData widens to the table plus every GSI's
      // index ARN with a wildcard, since which index a query hits is a
      // runtime decision the grant cannot narrow at synth. There is no
      // finer-grained L2 grant method (ADR-0007).
      suppressNagRules(role, [
        {
          id: `AwsSolutions-IAM5[Resource::${flattenForNagId(
            this,
            this.tagCacheTable.tableArn,
          )}/index/*]`,
          reason:
            "ITableV2.grantReadWriteData widens to every GSI's index ARN with a " +
            "wildcard; see this comment and ADR-0007.",
        },
      ]);
    }
    if (this.revalidationQueue !== undefined) {
      this.revalidationQueue.grantSendMessages(role);
    }
  }

  /**
   * `IBucket.grantRead`/`grantReadWrite` always widen to an object-level
   * wildcard (`<bucket>/*`) plus `s3:List*`/`s3:GetBucket*` — there is no
   * narrower L2 grant method, and the alternative (hand-writing the policy
   * statement) is exactly the kind of code this construct exists to not
   * make every consumer repeat. The wildcard is still bounded to this one
   * bucket, which exists only for this site's own build output and OpenNext
   * cache keys: the grant is not a path to any other resource. OpenNext's
   * incremental cache writes cache keys derived from request paths that
   * cannot be enumerated at synth time, so a narrower prefix is not possible
   * without hand-parsing OpenNext's own cache-key scheme (ADR-0007).
   */
  private suppressBucketGrantFindings(role: iam.IRole, idPrefix: string, write: boolean): void {
    const reason =
      `IBucket.${write ? "grantReadWrite" : "grantRead"} widens to this shape with no ` +
      `narrower L2 grant available; see ${idPrefix}'s caller and ADR-0007.`;
    const readActions = ["Action::s3:GetObject*", "Action::s3:GetBucket*", "Action::s3:List*"];
    const writeActions = ["Action::s3:DeleteObject*", "Action::s3:Abort*"];

    suppressNagRules(role, [
      ...[...readActions, ...(write ? writeActions : [])].map((finding) => ({
        id: `AwsSolutions-IAM5[${finding}]`,
        reason,
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${flattenForNagId(this, this.bucket.arnForObjects("*"))}]`,
        reason,
      },
    ]);
  }

  private createDistribution(
    props: OpenNextSiteProps,
    primaryDomain: string,
    includeImageOptimization: boolean,
  ): cloudfront.Distribution {
    const s3Origin = S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originPath: this.output.origins.s3.originPath,
    });
    const serverOrigin = this.createFunctionUrlOrigin(this.serverFunction);

    const serverCachePolicy = this.createServerCachePolicy();
    const staticCachePolicy = cloudfront.CachePolicy.CACHING_OPTIMIZED;
    const viewerRequestFunction = this.createViewerRequestFunction();

    const defaultBehavior: cloudfront.BehaviorOptions = {
      origin: serverOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: serverCachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
      functionAssociations: [
        { function: viewerRequestFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
    };

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const behavior of this.output.behaviors) {
      if (behavior.pattern === "*") continue;
      const isImagePattern = behavior.origin === "imageOptimizer";
      if (isImagePattern && !includeImageOptimization) {
        // The app's build emitted this behavior, but includeImageOptimization
        // is false — per that prop's doc comment, the optimizer route is
        // unreachable from a correctly-configured app (images.unoptimized or
        // a custom loader), so there is no origin to route it to. Skipping
        // the behavior entirely leaves CloudFront's catch-all (`*`, routed to
        // the server function) to 404 it the same way Next's own server
        // would, rather than pointing at a Lambda this construct never built.
        continue;
      }
      const isS3Pattern = behavior.origin === "s3" || behavior.origin === undefined;
      additionalBehaviors[behavior.pattern] = {
        origin: isImagePattern
          ? this.createFunctionUrlOrigin(this.imageFunction!)
          : isS3Pattern
            ? s3Origin
            : serverOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: isS3Pattern ? staticCachePolicy : serverCachePolicy,
        originRequestPolicy: isS3Pattern
          ? undefined
          : cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
        // S3 doesn't run Next.js code and has no notion of its own host;
        // the server and image-optimizer origins both do (Next reads
        // x-forwarded-host for canonical-URL generation — Auth.js's OAuth
        // callback URLs in particular — see createViewerRequestFunction).
        functionAssociations: isS3Pattern
          ? undefined
          : [{ function: viewerRequestFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      };
    }

    return new cloudfront.Distribution(this, "Distribution", {
      domainNames: props.domainNames,
      certificate: this.resolveCertificate(props.certificate),
      enableLogging: true,
      logBucket: this.logBucket,
      logFilePrefix: OPEN_NEXT_CLOUDFRONT_LOG_PREFIX,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: props.comment ?? `${primaryDomain} — Next.js (OpenNext).`,
      defaultBehavior,
      additionalBehaviors,
    });
  }

  /**
   * `FunctionUrlOrigin.withOriginAccessControl` — CloudFront's native,
   * purpose-built mechanism for a Lambda Function URL origin — cannot be
   * used here. AWS's own documentation is explicit: "If you use PUT or
   * POST methods with your Lambda function URL, your users must compute
   * the SHA256 of the body and include the payload hash value... in the
   * x-amz-content-sha256 header... Lambda doesn't support unsigned
   * payloads" (`private-content-restricting-access-to-lambda.html`). A
   * browser's `fetch`/form POST — which is what every real caller of this
   * site sends, Auth.js's `signIn()` included — never computes or sends
   * that header, so OAC-signed CloudFront rejects *every* POST request
   * that carries a body with `403 InvalidSignatureException`, matching
   * neither a code bug nor a misconfiguration: a POST with an empty body
   * succeeds, the identical request with `callbackUrl=/` in the body does
   * not. Confirmed directly against a live deployment, reproduced with two
   * independent HTTP clients (`curl`, PowerShell's `Invoke-WebRequest`),
   * not assumed from documentation alone — this broke Google OAuth sign-in
   * (and, since the same mechanism handles every POST, the credentials
   * sign-in and sign-up forms too) on the very first real end-to-end test
   * after the apex cutover.
   *
   * The fix is `FunctionUrlAuthType.NONE` — an unsigned, publicly-invokable
   * function URL — exactly what the official OpenNext reference CDK
   * implementation uses (`opennext.js.org/aws/reference-implementation`,
   * `createFunctionOrigin`). This means the Lambda Function URL itself is
   * the access boundary: its hostname
   * (`https://<21-char-random-id>.lambda-url.<region>.on.aws`) is a
   * cryptographically random identifier nothing publishes or guesses, the
   * same practical strength as an unguessable bearer token in a URL. A
   * stronger boundary (e.g. a shared secret the origin itself checks before
   * doing any work) was considered and rejected: it would need to be
   * enforced *inside* the Lambda handler, which is OpenNext's own generated
   * code (`npx open-next build` output, re-generated on every build) —
   * there is no hook in this construct's control to add that check to, so
   * a secret header this construct could inject would have nothing on the
   * other end actually verifying it, making it theater rather than a real
   * control. The reference implementation accepts the same tradeoff for
   * the same reason.
   */
  private createFunctionUrlOrigin(fn: lambda.Function): cloudfront.IOrigin {
    const functionUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    fn.addPermission("InvokeFunctionUrlFromAnyone", {
      principal: new iam.AnyPrincipal(),
      action: "lambda:InvokeFunctionUrl",
      functionUrlAuthType: lambda.FunctionUrlAuthType.NONE,
    });
    return new HttpOrigin(Fn.select(2, Fn.split("/", functionUrl.url)));
  }

  /**
   * `ALL_VIEWER_EXCEPT_HOST_HEADER` (every non-S3 behavior's origin request
   * policy) deliberately replaces the viewer's `Host` header with the
   * origin's own hostname before forwarding — correct, since the origin (a
   * Lambda Function URL) needs its own host to route the request at all.
   * This means Next.js never sees `newnotams.net` (or this distribution's
   * own `dxxxx.cloudfront.net`) as the request's Host, only the raw
   * `*.lambda-url.*.on.aws` hostname. Next.js — and Auth.js's `trustHost`
   * specifically — falls back to `x-forwarded-host` when present, which is
   * exactly what this supplies. Confirmed as a real, reproducible gap: a
   * live deploy's `/api/auth/providers` returned Lambda-Function-URL-hosted
   * `signinUrl`/`callbackUrl` values instead of the CloudFront domain,
   * which would have broken Google OAuth's registered redirect URI, until
   * this was added. This is exactly what the OpenNext reference CDK
   * implementation's own `OpenNextCfFunction` does.
   */
  private createViewerRequestFunction(): cloudfront.Function {
    return new cloudfront.Function(this, "ViewerRequestFunction", {
      comment: "Forwards the viewer Host header to the origin as x-forwarded-host.",
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) {\n" +
          "  var request = event.request;\n" +
          '  request.headers["x-forwarded-host"] = request.headers.host;\n' +
          "  return request;\n" +
          "}\n",
      ),
    });
  }

  private createServerCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(this, "ServerCachePolicy", {
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        "accept",
        "accept-encoding",
        "rsc",
        "next-router-prefetch",
        "next-router-state-tree",
        "next-url",
        "x-prerender-revalidate",
      ),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
    });
  }

  private deployStaticAssets(props: OpenNextSiteProps, primaryDomain: string): void {
    const sources =
      props.usePlaceholderSource === true
        ? [
            s3deploy.Source.data(
              "placeholder.txt",
              `Placeholder. ${primaryDomain}'s OpenNext build has not been deployed yet.`,
            ),
          ]
        : this.output.origins.s3.copy.map((copy) => s3deploy.Source.asset(copy.from));

    const destinationKeyPrefix =
      props.usePlaceholderSource === true ? undefined : this.output.origins.s3.originPath.replace(/^\//, "");

    const deployment = new s3deploy.BucketDeployment(this, "StaticAssetsDeployment", {
      sources,
      destinationBucket: this.bucket,
      destinationKeyPrefix,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: false,
    });

    this.suppressDeploymentHandlerFindings(deployment, bootstrapQualifierFor(props.profile.env));
  }

  /** Identical reasoning to StaticSite.suppressDeploymentHandlerFindings. */
  private suppressDeploymentHandlerFindings(
    deployment: s3deploy.BucketDeployment,
    qualifier: string,
  ): void {
    const stack = Stack.of(this);
    const cdkOwned =
      "This resource is generated by aws-cdk-lib's BucketDeployment singleton " +
      "handler, not declared here — see StaticSite's identical suppression " +
      "and ADR-0007.";

    const handler = stack.node.children.find((child) =>
      child.node.id.startsWith("Custom::CDKBucketDeployment"),
    );
    if (handler === undefined) {
      throw new Error(
        `No Custom::CDKBucketDeployment* handler found under ${stack.node.path} for ` +
          `${deployment.node.path}. See StaticSite's identical check (ADR-0007).`,
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
        id:
          "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::" +
          `cdk-${qualifier}-assets-${stack.account}-${stack.region}/*]`,
        reason: cdkOwned,
      },
    ]);

    suppressNagRulesAtPath(stack, handlerPath, [{ id: "AwsSolutions-L1", reason: cdkOwned }]);
  }

  private resolveCertificate(certificate: acm.ICertificate | string): acm.ICertificate {
    return typeof certificate === "string"
      ? acm.Certificate.fromCertificateArn(this, "Certificate", certificate)
      : certificate;
  }
}

/** Inline placeholder server, used only when usePlaceholderSource is true. */
const PLACEHOLDER_SERVER_SOURCE = `
exports.handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "text/html" },
  body: "<!doctype html><title>Placeholder</title><p>OpenNext build not deployed yet.",
});
`;
