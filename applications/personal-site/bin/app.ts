#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { SiteStack } from "../lib/site-stack.js";

const app = new App();

/**
 * `-c sitePlaceholder=true` renders the stack without a Next.js export on disk.
 * CI uses it for synth, cdk-nag and diff; a real deploy must not.
 */
const usePlaceholderSource = app.node.tryGetContext("sitePlaceholder") === "true";
const siteSourcePath = app.node.tryGetContext("siteSourcePath");

// The environment name drives both the resource profile and the bootstrap
// qualifier, so the two cannot drift. A dev instance of this stack would pick up
// the bounded cdk-hnbdev-cfn-exec-role by changing this one value.
const envName = "prod";

new SiteStack(app, "PersonalSiteStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor(envName),
  description: "josephkan.ca — S3 + CloudFront with a scheduled OANDA fetcher (Phase 0 §7).",
  envName,
  usePlaceholderSource,
  siteSourcePath: typeof siteSourcePath === "string" ? siteSourcePath : undefined,
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());

// ADR-0007. cdk-nag 3.x is a validation plugin, not an Aspect: it runs after
// the entire Aspect pass has finished, so it cannot race the mutating Tags
// aspects the way RequiredTagsAspect can.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
