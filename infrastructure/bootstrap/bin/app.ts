#!/usr/bin/env node
import { App, AspectPriority, Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { accounts, synthesizerFor } from "@josephkan3/config";
import {
  LogRetentionAspect,
  NoManagedEgressAspect,
  RequiredTagsAspect,
} from "@josephkan3/constructs";
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

/**
 * NewNotams.Net's own gha-plan/gha-deploy-dev/gha-deploy-prod, scoped
 * exclusively to that repo's sub claim — see ADR-0009. The existing
 * BootstrapStack's roles above are trust-scoped exclusively to
 * `home-platform`'s own repo ID via an exact `StringEquals` (deliberately,
 * per GitHubOidcStack's own doc comment: a wildcard would let every repo the
 * owner controls assume them), so they cannot be reused for a second repo —
 * this is a second, independent instance of the same construct, not a
 * modification to the first.
 *
 * Deliberately references the *existing* OIDC provider
 * (`existingOidcProviderArn`), never creates a second one: AWS allows
 * exactly one OIDC provider per issuer URL per account, and
 * `token.actions.githubusercontent.com` already has one from BootstrapStack
 * above. `cdk-dev-permissions-boundary` is also NOT duplicated — `existing`
 * mode only, since `createDevPermissionsBoundary` is unconditional in the
 * construct and a second managed policy of the same name would collide.
 * NewNotamsStack's own dev deploys use the same `cdk-hnbdev-cfn-exec-role-*`
 * boundary BootstrapStack already created, which is correct: the boundary
 * protects every `env=prod`-tagged resource account-wide, not scoped to one
 * repo's deploys.
 */
new GitHubOidcStack(app, "NewNotamsGitHubOidcStack", {
  env: { account: accounts.platform.id, region: accounts.platform.region },
  synthesizer: synthesizerFor("prod"),
  description: "GitHub Actions OIDC roles for JosephKan3/NewNotams.Net (ADR-0009).",
  githubOwner: "JosephKan3",
  githubRepo: "NewNotams.Net",
  githubOwnerId: 54008059,
  githubRepoId: 1174868537,
  existingOidcProviderArn:
    app.node.tryGetContext("existingOidcProviderArn") ??
    `arn:aws:iam::${accounts.platform.id}:oidc-provider/token.actions.githubusercontent.com`,
  useExistingDevPermissionsBoundary: true,
  // IAM role names are unique per account; the default prefix ("gha") would
  // collide with BootstrapStack's own gha-plan/gha-deploy-dev/gha-deploy-prod
  // — confirmed directly: the first deploy attempt of this stack failed with
  // "Resource of type 'AWS::IAM::Role' with identifier 'gha-plan' already
  // exists" before this prop existed.
  rolePrefix: "gha-newnotams",
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
