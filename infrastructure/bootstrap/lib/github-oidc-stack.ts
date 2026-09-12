/**
 * GitHubOidcStack — the manual-to-automated handoff (Phase 0 action plan §4).
 *
 * This is the only stack deployed by hand, with SSO admin credentials, because
 * it is what creates the identity CI later uses. Everything after it deploys
 * through the roles defined here.
 *
 * It also owns `cdk-dev-permissions-boundary`, which is NOT attached to any
 * role in this stack. It is attached to the dev CDK CloudFormation execution
 * role by `cdk bootstrap --qualifier hnbdev --custom-permissions-boundary
 * cdk-dev-permissions-boundary`, which is where dev's mutations actually
 * happen. See infrastructure/bootstrap/README.md for the ordering this forces.
 */

import { CfnOutput, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  BOOTSTRAP_QUALIFIERS,
  DEFAULT_OWNER,
  DEV_PERMISSIONS_BOUNDARY_NAME,
  applyPlatformTags,
} from "@platform/config";
import { suppressNagRules } from "@platform/constructs";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

/** The bootstrap roles a deploy needs to assume, in `cdk-<qualifier>-<kind>-<account>-<region>`. */
const DEPLOY_ROLE_KINDS = [
  "deploy-role",
  "file-publishing-role",
  "image-publishing-role",
  "lookup-role",
] as const;

export interface GitHubOidcStackProps extends StackProps {
  /** GitHub owner (personal account or org) that owns the monorepo. */
  readonly githubOwner?: string;
  /** Monorepo name. Encoded into every trust policy `sub` claim. */
  readonly githubRepo?: string;
  /**
   * Numeric GitHub owner ID, required by the immutable `sub` claim format.
   *
   * Repositories created after 2026-07-15 (this one included — created
   * 2026-09-11) get `sub` claims of the form
   * `repo:OWNER@OWNER-ID/REPO@REPO-ID:...` instead of the legacy
   * `repo:OWNER/REPO:...`. Not a secret: visible via the unauthenticated
   * `GET /repos/{owner}/{repo}` API for any public repo, unlike an AWS
   * account ID.
   */
  readonly githubOwnerId?: number;
  /** Numeric GitHub repository ID. See `githubOwnerId`. */
  readonly githubRepoId?: number;
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
    const ownerId = props.githubOwnerId ?? 54008059;
    const repoId = props.githubRepoId ?? 1366801384;
    // Immutable subject format (repos created after 2026-07-15): the `repo`
    // segment carries `OWNER@OWNER-ID/REPO@REPO-ID`, not the bare names. Using
    // the legacy `repo:owner/repo:...` format here silently matches nothing —
    // AssumeRoleWithWebIdentity is denied with no indication of why the sub
    // didn't match, since IAM does not echo back the token it rejected.
    const repoRef = `repo:${owner}@${ownerId}/${repo}@${repoId}`;

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
    // `cdk diff` on a PR must be able to look up context for either environment,
    // so the plan role gets both qualifiers' lookup roles — and nothing else.
    this.planRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkLookupRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          this.cdkBootstrapRoleArn(BOOTSTRAP_QUALIFIERS.dev, "lookup-role"),
          this.cdkBootstrapRoleArn(BOOTSTRAP_QUALIFIERS.prod, "lookup-role"),
        ],
      }),
    );
    this.suppressBootstrapRoleWildcards(this.planRole, [
      [BOOTSTRAP_QUALIFIERS.dev, "lookup-role"],
      [BOOTSTRAP_QUALIFIERS.prod, "lookup-role"],
    ]);
    suppressNagRules(this.planRole, [
      {
        id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess]",
        reason:
          "ReadOnlyAccess is the intended grant, not a shortcut. This role runs " +
          "`cdk diff` on pull requests (ADR-0007, action plan §4 C3), which must be " +
          "able to describe any resource type the repo might add without the role " +
          "being edited first. A customer-managed equivalent would be a hand-maintained " +
          "copy of an AWS policy covering every read action in every service, which " +
          "drifts silently and fails closed on new services. The role grants no write " +
          "action and cannot assume any cdk-* deploy role, only the lookup roles.",
      },
    ]);

    this.deployDevRole = new iam.Role(this, "GhaDeployDevRole", {
      roleName: "gha-deploy-dev",
      description:
        `Dev deploy role for ${owner}/${repo}. May assume only the ` +
        `cdk-${BOOTSTRAP_QUALIFIERS.dev}-* bootstrap roles, whose CFN execution role is ` +
        `bounded away from env=prod resources.`,
      assumedBy: this.githubPrincipal(provider, `${repoRef}:environment:dev`),
    });
    this.grantCdkDeploy(this.deployDevRole, BOOTSTRAP_QUALIFIERS.dev);

    this.deployProdRole = new iam.Role(this, "GhaDeployProdRole", {
      roleName: "gha-deploy-prod",
      description: `Prod deploy role for ${owner}/${repo}. Gated by the GitHub prod environment.`,
      assumedBy: this.githubPrincipal(provider, `${repoRef}:environment:prod`),
    });
    this.grantCdkDeploy(this.deployProdRole, BOOTSTRAP_QUALIFIERS.prod);

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
    new CfnOutput(this, "DevPermissionsBoundaryName", {
      value: DEV_PERMISSIONS_BOUNDARY_NAME,
      description:
        "Pass to: cdk bootstrap --qualifier " +
        `${BOOTSTRAP_QUALIFIERS.dev} --custom-permissions-boundary <this>`,
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
   * bootstrap roles of their own qualifier, which is where the permissions live:
   *
   *   GitHub Actions -> gha-deploy-dev -> cdk-hnbdev-deploy-role-*
   *                                    -> CloudFormation
   *                                    -> cdk-hnbdev-cfn-exec-role-*  [bounded]
   *
   * Scoping to one qualifier is load-bearing. If the dev role could assume
   * `cdk-*-deploy-role-*` it would reach the prod qualifier's roles, whose CFN
   * execution role carries no boundary, and the whole mechanism would be a
   * naming convention.
   */
  private grantCdkDeploy(role: iam.Role, qualifier: string): void {
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: DEPLOY_ROLE_KINDS.map((kind) => this.cdkBootstrapRoleArn(qualifier, kind)),
      }),
    );
    this.suppressBootstrapRoleWildcards(
      role,
      DEPLOY_ROLE_KINDS.map((kind) => [qualifier, kind]),
    );
  }

  /**
   * Only the region suffix is a wildcard now that the qualifier is pinned.
   *
   * The finding ID carries the ARN with `${AWS::Partition}` flattened to the
   * literal `<AWS::Partition>`, which is how cdk-nag stringifies an intrinsic.
   * `this.partition` is a CDK token and would render as a `Fn::Join`, so it
   * cannot be interpolated here.
   */
  private suppressBootstrapRoleWildcards(
    role: iam.Role,
    targets: Array<[qualifier: string, kind: string]>,
  ): void {
    suppressNagRules(
      role,
      targets.map(([qualifier, kind]) => ({
        id:
          "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::" +
          `${this.account}:role/cdk-${qualifier}-${kind}-${this.account}-*]`,
        reason:
          `CDK names its bootstrap roles cdk-${qualifier}-${kind}-<account>-<region>. ` +
          "The qualifier and the account are pinned here; only the region suffix is a " +
          "wildcard, because it is chosen at bootstrap time and a second region would " +
          "otherwise require editing this stack before it could be deployed to. The " +
          "alternative an SCP could not improve on is attaching AdministratorAccess to " +
          "the GitHub-assumable role directly, which is what this indirection exists to " +
          "avoid (ADR-0007, action plan §4 C2). Pinning the qualifier is what keeps the " +
          "dev role away from the prod qualifier's unbounded execution role (ADR-0001).",
      })),
    );
  }

  /** Pinned to one qualifier and this account; only the region suffix is wild. */
  private cdkBootstrapRoleArn(qualifier: string, kind: string): string {
    return `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-${kind}-${this.account}-*`;
  }

  /**
   * The permissions boundary that makes ADR-0001's single-account dev/prod
   * compromise survivable.
   *
   * It is created here but attached elsewhere. `cdk bootstrap
   * --custom-permissions-boundary <name>` resolves the name to a policy ARN
   * inside the bootstrap template and sets it as `PermissionsBoundary` on
   * `cdk-<qualifier>-cfn-exec-role-<account>-<region>` — the role CloudFormation
   * assumes to create, update and delete resources. That is the only principal
   * in the dev deploy chain that holds real permissions, so it is the only place
   * a boundary changes any outcome.
   *
   * Two consequences follow, both deliberate:
   *
   *   - The name must be stable and predictable, because the bootstrap CLI takes
   *     a name and does not verify the policy exists. A CDK-generated name could
   *     not be passed to a command that runs before this stack does.
   *   - This stack must be deployed BEFORE `cdk bootstrap --qualifier hnbdev`.
   *     See the README: the ordering is a real chicken-and-egg, since bootstrap
   *     normally comes first.
   *
   * A boundary caps permissions, it never grants them, which is why the Allow is
   * unrestricted — effective permissions are the intersection of the boundary and
   * the role's own policies (here, AdministratorAccess).
   */
  private createDevPermissionsBoundary(): iam.ManagedPolicy {
    const boundary = new iam.ManagedPolicy(this, "DevPermissionsBoundary", {
      managedPolicyName: DEV_PERMISSIONS_BOUNDARY_NAME,
      description:
        `Permissions boundary for cdk-${BOOTSTRAP_QUALIFIERS.dev}-cfn-exec-role-*. ` +
        "Denies any action on env=prod resources.",
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
        new iam.PolicyStatement({
          // Without this the boundary is one API call from bypassable: the dev
          // CFN execution role would create an unbounded role and act through
          // it. iam:CreateRole cannot simply be denied — dev stacks legitimately
          // create Lambda execution roles — so it is conditioned on the new role
          // carrying this same boundary.
          //
          // OPERATIONAL CONSEQUENCE, documented in the README: every dev stack
          // that creates an IAM role must apply this boundary to it, e.g.
          // `PermissionsBoundary.of(devStage).apply(boundary)`. There are no
          // dev-scoped stacks yet (docs/open-issues.md issue 2), so nothing is
          // broken today, but the first one must do this or its deploy fails.
          sid: "DenyCreatingUnboundedPrincipals",
          effect: iam.Effect.DENY,
          actions: ["iam:CreateRole", "iam:CreateUser"],
          resources: ["*"],
          conditions: {
            StringNotEquals: {
              "iam:PermissionsBoundary": this.formatArn({
                service: "iam",
                region: "",
                resource: "policy",
                resourceName: DEV_PERMISSIONS_BOUNDARY_NAME,
              }),
            },
          },
        }),
        new iam.PolicyStatement({
          // Editing the boundary's own policy document is equivalent to removing
          // it. Deleting a version is enough: the default version can be swapped
          // for one without the env=prod Deny.
          sid: "DenyBoundaryPolicyAlteration",
          effect: iam.Effect.DENY,
          actions: [
            "iam:CreatePolicyVersion",
            "iam:DeletePolicy",
            "iam:DeletePolicyVersion",
            "iam:SetDefaultPolicyVersion",
          ],
          resources: [
            this.formatArn({
              service: "iam",
              region: "",
              resource: "policy",
              resourceName: DEV_PERMISSIONS_BOUNDARY_NAME,
            }),
          ],
        }),
      ],
    });

    // IAM5 reads `Action: *` / `Resource: *` as an over-broad grant. On a
    // permissions boundary the meaning is inverted: a boundary grants nothing,
    // it only caps, and effective permissions are the intersection of the
    // boundary with the role's own policies. Narrowing the ceiling here would
    // narrow what a dev deploy can do without changing what it is *allowed* to
    // do, and would silently break future dev deploys instead of denying them.
    // The Deny statements alongside it are where this policy does its work.
    const boundaryReason =
      "This is a permissions boundary, not a grant. A boundary caps effective " +
      "permissions at the intersection of itself and the principal's own policies; " +
      "the unrestricted Allow is the ceiling, and the Deny statements are the " +
      "control. Restricting the ceiling would break unrelated dev deploys without " +
      "granting anything less. It is attached to the dev CDK CloudFormation " +
      "execution role at bootstrap time and is the mechanism ADR-0001 relies on to " +
      "make one shared dev/prod account survivable, and ADR-0005 requires for " +
      "scoped automation roles.";
    suppressNagRules(boundary, [
      { id: "AwsSolutions-IAM5[Action::*]", reason: boundaryReason },
      { id: "AwsSolutions-IAM5[Resource::*]", reason: boundaryReason },
    ]);

    return boundary;
  }
}
