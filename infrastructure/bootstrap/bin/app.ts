#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { GitHubOidcStack } from "../lib/github-oidc-stack.js";

const app = new App();

/**
 * Tagged env=prod, so it synthesizes against the prod qualifier.
 *
 * This is what resolves the chicken-and-egg: this stack creates
 * `cdk-dev-permissions-boundary`, which `cdk bootstrap --qualifier hnbdev
 * --custom-permissions-boundary` needs to already exist. Deploying it through
 * the *prod* qualifier means only the prod bootstrap has to precede it, and the
 * dev bootstrap follows. See README.md for the full order.
 */
new GitHubOidcStack(app, "BootstrapStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor("prod"),
  description: "GitHub Actions OIDC provider and deploy roles (Phase 0 §4).",
  existingOidcProviderArn: app.node.tryGetContext("existingOidcProviderArn"),
});

Aspects.of(app).add(new NoManagedEgressAspect());
// READONLY priority so this runs after the mutating Tags aspects that set the
// tags it checks for; otherwise it fails synth on resources that are tagged.
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());

// ADR-0007. cdk-nag 3.x is a validation plugin, not an Aspect: it runs after
// the entire Aspect pass has finished, so it cannot race the mutating Tags
// aspects the way RequiredTagsAspect can.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
