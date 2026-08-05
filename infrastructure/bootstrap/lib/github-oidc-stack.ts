/**
 * GitHubOidcStack — the manual-to-automated handoff (Phase 0 action plan §4).
 *
 * This is the only stack deployed by hand, with SSO admin credentials, because
 * it is what creates the identity CI later uses. Everything after it deploys
 * through the roles defined here.
 */

import { CfnOutput, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { DEFAULT_OWNER, applyPlatformTags } from "@platform/config";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

export interface GitHubOidcStackProps extends StackProps {
  /** GitHub owner (personal account or org) that owns the monorepo. */
  readonly githubOwner?: string;
  /** Monorepo name. Encoded into every trust policy `sub` claim. */
  readonly githubRepo?: string;
  /**
   * ARN of an OIDC provider that already exists in this account.
   *
   * An AWS account can hold exactly one OIDC provider per issuer URL, and
   * creating a duplicate fails. Supplying this ARN references the existing
   * provider instead, so re-running against an account that was bootstrapped
   * previously (for example by EKS or another repo) does not error.
   */
  readonly existingOidcProviderArn?: string;
}

export class GitHubOidcStack extends Stack {
  readonly planRole: iam.Role;
  readonly deployDevRole: iam.Role;
  readonly deployProdRole: iam.Role;
  readonly devPermissionsBoundary: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps = {}) {
    super(scope, id, props);

    const owner = props.githubOwner ?? "JosephKan3";
    const repo = props.githubRepo ?? "home-platform";
    const repoRef = `repo:${owner}/${repo}`;

    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GitHubOidcProvider",
          props.existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, "GitHubOidcProvider", {
          url: GITHUB_OIDC_URL,
          clientIds: [GITHUB_OIDC_AUDIENCE],
          // No thumbprints: AWS retrieves and rotates the issuer's CA thumbprint
          // itself for the well-known GitHub Actions provider. Pinning one here
          // would break silently when GitHub rotates certificates.
        });

    this.devPermissionsBoundary = this.createDevPermissionsBoundary();

    this.planRole = new iam.Role(this, "GhaPlanRole", {
      roleName: "gha-plan",
      description: `Pull request plan role for ${owner}/${repo}. Read-only plus CDK lookup.`,
      assumedBy: this.githubPrincipal(provider, `${repoRef}:pull_request`),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
    });
    this.planRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkLookupRole",
        actions: ["sts:AssumeRole"],
        resources: [this.cdkBootstrapRoleArn("lookup-role")],
      }),
    );

    this.deployDevRole = new iam.Role(this, "GhaDeployDevRole", {
      roleName: "gha-deploy-dev",
      description: `Dev deploy role for ${owner}/${repo}. Bounded away from env=prod resources.`,
      assumedBy: this.githubPrincipal(provider, `${repoRef}:environment:dev`),
      permissionsBoundary: this.devPermissionsBoundary,
    });
    this.grantCdkDeploy(this.deployDevRole);

    this.deployProdRole = new iam.Role(this, "GhaDeployProdRole", {
      roleName: "gha-deploy-prod",
      description: `Prod deploy role for ${owner}/${repo}. Gated by the GitHub prod environment.`,
      assumedBy: this.githubPrincipal(provider, `${repoRef}:environment:prod`),
    });
    this.grantCdkDeploy(this.deployProdRole);

    applyPlatformTags(this, {
      app: "platform-bootstrap",
      env: "prod",
      owner: DEFAULT_OWNER,
    });

    new CfnOutput(this, "PlanRoleArn", {
      value: this.planRole.roleArn,
      description: "Set as GitHub repository variable AWS_PLAN_ROLE_ARN",
    });
    new CfnOutput(this, "DeployDevRoleArn", {
      value: this.deployDevRole.roleArn,
      description: "Set as GitHub repository variable AWS_DEPLOY_DEV_ROLE_ARN",
    });
    new CfnOutput(this, "DeployProdRoleArn", {
      value: this.deployProdRole.roleArn,
      description: "Set as GitHub repository variable AWS_DEPLOY_PROD_ROLE_ARN",
    });
  }

  /**
   * StringEquals on both `aud` and the full `sub`, never StringLike.
   *
   * A `StringLike` condition such as `repo:owner/*` would let every repository
   * the owner controls — including ones that do not exist yet, and forks pushed
   * by anyone who gains write access to any of them — assume this role. The sub
   * claim must therefore be matched exactly, with no wildcard anywhere.
   */
  private githubPrincipal(
    provider: iam.IOpenIdConnectProvider,
    sub: string,
  ): iam.OpenIdConnectPrincipal {
    return new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
        [`${GITHUB_OIDC_ISSUER}:sub`]: sub,
      },
    });
  }

  /**
   * The deploy roles hold no AWS power directly. They may only assume the CDK
   * bootstrap roles, which is where the actual permissions live:
   *
   *   GitHub Actions -> gha-deploy-* -> cdk-*-deploy-role-* -> CloudFormation
   *
   * This keeps the standing GitHub-assumable surface to sts:AssumeRole, and
   * means the blast radius is defined by the bootstrap stack (which CDK owns
   * and cdk-nag reviews) rather than by an AdministratorAccess attachment.
   */
  private grantCdkDeploy(role: iam.Role): void {
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          this.cdkBootstrapRoleArn("deploy-role"),
          this.cdkBootstrapRoleArn("file-publishing-role"),
          this.cdkBootstrapRoleArn("image-publishing-role"),
          this.cdkBootstrapRoleArn("lookup-role"),
        ],
      }),
    );
  }

  /** Matches any bootstrap qualifier, account and region suffix. */
  private cdkBootstrapRoleArn(kind: string): string {
    return `arn:${this.partition}:iam::${this.account}:role/cdk-*-${kind}-*`;
  }

  /**
   * Permissions boundary making ADR-0001's single-account dev/prod compromise
   * survivable: dev CI cannot touch anything tagged env=prod, and cannot remove
   * the boundary that says so.
   *
   * A boundary caps permissions, it never grants them, which is why the Allow
   * is unrestricted — effective permissions are the intersection of the
   * boundary and the role's own policies.
   */
  private createDevPermissionsBoundary(): iam.ManagedPolicy {
    return new iam.ManagedPolicy(this, "DevPermissionsBoundary", {
      managedPolicyName: "gha-deploy-dev-boundary",
      description: "Caps gha-deploy-dev: denies any action on env=prod resources.",
      statements: [
        new iam.PolicyStatement({
          sid: "AllowAllAsBoundaryCeiling",
          effect: iam.Effect.ALLOW,
          actions: ["*"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "DenyProdTaggedResources",
          effect: iam.Effect.DENY,
          actions: ["*"],
          resources: ["*"],
          conditions: {
            StringEquals: { "aws:ResourceTag/env": "prod" },
          },
        }),
        new iam.PolicyStatement({
          // A role able to detach its own boundary has no boundary. Static
          // credentials are denied for the same reason: an access key created
          // by this role would outlive and sidestep the boundary.
          sid: "DenyBoundaryEscape",
          effect: iam.Effect.DENY,
          actions: [
            "iam:CreateUser",
            "iam:CreateAccessKey",
            "iam:DeleteUserPermissionsBoundary",
            "iam:PutUserPermissionsBoundary",
            "iam:DeleteRolePermissionsBoundary",
            "iam:PutRolePermissionsBoundary",
          ],
          resources: ["*"],
        }),
      ],
    });
  }
}
