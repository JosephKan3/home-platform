#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { DnsStack } from "../lib/dns-stack.js";
import type { OriginMode } from "../lib/dns-stack.js";

const app = new App();

/**
 * The apex cutover is this one context value (Stage G1).
 *
 *   cdk deploy -c origin=cloudfront -c cloudFrontDomainName=dxxxx.cloudfront.net
 *
 * and the rollback is the same command with `-c origin=vercel`. Records carry a
 * 300s TTL and nameservers are untouched either way, so reverting takes five
 * minutes. Default stays `vercel`: the live state.
 */
const origin = (app.node.tryGetContext("origin") as OriginMode | undefined) ?? "vercel";
if (origin !== "vercel" && origin !== "cloudfront") {
  throw new Error(`Invalid origin context value: ${String(origin)}. Expected vercel or cloudfront.`);
}

// newnotams.net's own cutover, independent of the platform's (Phase 1 action
// plan §4, Stage D). Same mechanism, different domain, different schedule.
const productOrigin = (app.node.tryGetContext("productOrigin") as OriginMode | undefined) ?? "vercel";
if (productOrigin !== "vercel" && productOrigin !== "cloudfront") {
  throw new Error(
    `Invalid productOrigin context value: ${String(productOrigin)}. Expected vercel or cloudfront.`,
  );
}

// The hosted zone is the live apex; it is env=prod and deploys through the prod
// bootstrap qualifier, whose CFN execution role carries no boundary.
new DnsStack(app, "DnsStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor("prod"),
  description: "Route53 zones, records and the platform ACM certificate (Phase 0 §5, §8).",
  origin,
  cloudFrontDomainName: app.node.tryGetContext("cloudFrontDomainName"),
  // `=== true` alone never matched a CLI `-c createProductZone=true`, which
  // arrives as the string "true" — a real, pre-Phase-1 bug, caught only now
  // because this flag had never actually been exercised. Accepts both the
  // boolean (set programmatically, e.g. from a test) and the string (set via
  // -c on the command line).
  createProductZone:
    app.node.tryGetContext("createProductZone") === true ||
    app.node.tryGetContext("createProductZone") === "true",
  productOrigin,
  productCloudFrontDomainName: app.node.tryGetContext("productCloudFrontDomainName"),
  internalZoneVpcId: app.node.tryGetContext("internalZoneVpcId"),
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());

// ADR-0007. cdk-nag 3.x is a validation plugin, not an Aspect: it runs after
// the entire Aspect pass has finished, so it cannot race the mutating Tags
// aspects the way RequiredTagsAspect can.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
