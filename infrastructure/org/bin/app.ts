#!/usr/bin/env node
import { App, Aspects, AspectPriority, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts } from "@platform/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@platform/constructs";
import { GovernanceStack } from "../lib/governance-stack.js";

const app = new App();

/**
 * OU IDs come from context because the OUs are created by hand in Stage A —
 * they are inputs to this stack, not outputs of it.
 *
 *   npx cdk deploy GovernanceStack --profile mgmt \
 *     -c workloadsOuId=ou-xxxx-xxxxxxxx -c sandboxOuId=ou-xxxx-xxxxxxxx
 */
function requiredContext(key: string): string {
  const value = app.node.tryGetContext(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Missing required context "${key}". Pass it with -c ${key}=<value>. ` +
        "OU IDs are created by hand in Stage A (docs/phase-0-action-plan.md §2 A2) " +
        "and can be listed with: aws organizations list-organizational-units-for-parent.",
    );
  }
  return value;
}

new GovernanceStack(app, "GovernanceStack", {
  // The one stack that targets the management account (action plan §6).
  env: { account: accounts.management.id, region: accounts.management.region },
  description: "Organization SCPs, org CloudTrail, budget and anomaly detection (Phase 0 §6).",
  workloadsOuId: requiredContext("workloadsOuId"),
  sandboxOuId: requiredContext("sandboxOuId"),
  alertEmail: app.node.tryGetContext("alertEmail"),
  organizationId: app.node.tryGetContext("organizationId"),
  budgetAccountId: app.node.tryGetContext("budgetAccountId"),
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
