#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@josephkan3/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@josephkan3/constructs";
import { NetworkStack } from "../lib/network-stack.js";

const app = new App();

// Platform-owned shared infrastructure (see network-stack.ts's own doc
// comment) — there is one VPC, one subnet router, always deployed through
// the prod bootstrap qualifier, same as DnsStack.
new NetworkStack(app, "NetworkStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor("prod"),
  description:
    "Shared VPC + Tailscale subnet router (Phase 1 roadmap item, never built until now). " +
    "Platform-owned; feeds its VPC ID into infrastructure/dns's DnsStack for the " +
    "internal.josephkan.ca private zone.",
});

Aspects.of(app).add(new NoManagedEgressAspect());
Aspects.of(app).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
Aspects.of(app).add(new LogRetentionAspect());

// ADR-0007. cdk-nag 3.x is a validation plugin, not an Aspect: it runs after
// the entire Aspect pass has finished, so it cannot race the mutating Tags
// aspects the way RequiredTagsAspect can.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
