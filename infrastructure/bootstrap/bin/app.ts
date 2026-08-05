#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib";
import { accounts } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { GitHubOidcStack } from "../lib/github-oidc-stack.js";

const app = new App();

new GitHubOidcStack(app, "BootstrapStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  description: "GitHub Actions OIDC provider and deploy roles (Phase 0 §4).",
  existingOidcProviderArn: app.node.tryGetContext("existingOidcProviderArn"),
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect());
Aspects.of(app).add(new LogRetentionAspect());
