#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { NewNotamsStack } from "../lib/newnotams-stack.js";

const app = new App();

/**
 * `-c sitePlaceholder=true` renders the stack without an OpenNext build on
 * disk. CI uses it for synth, cdk-nag and diff; a real deploy must not. See
 * personal-site/bin/app.ts's identical flag.
 */
const usePlaceholderSource = app.node.tryGetContext("sitePlaceholder") === "true";
const openNextOutputPath = app.node.tryGetContext("openNextOutputPath");
const appRepoPath = app.node.tryGetContext("appRepoPath");

// The environment name drives both the resource profile and the bootstrap
// qualifier, so the two cannot drift — see personal-site/bin/app.ts's
// identical comment.
const envName = "prod";

new NewNotamsStack(app, "NewNotamsStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor(envName),
  description: "newnotams.net — Lambda + CloudFront via OpenNext, plus the hourly notify sweep (Phase 1 §3).",
  envName,
  usePlaceholderSource,
  openNextOutputPath: typeof openNextOutputPath === "string" ? openNextOutputPath : undefined,
  appRepoPath: typeof appRepoPath === "string" ? appRepoPath : undefined,
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());

// ADR-0007. cdk-nag 3.x is a validation plugin, not an Aspect — see
// personal-site/bin/app.ts's identical comment.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
