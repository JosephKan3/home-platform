/**
 * Service Control Policy documents (Phase 0 action plan §6 E1).
 *
 * These are the highest-risk artifacts in the repository. An SCP is evaluated
 * before any IAM policy and cannot be overridden from inside a member account:
 * a wrong Deny here locks every principal — including the account's own
 * administrators — out of the affected APIs, and the only fix is to sign in to
 * the *management* account and detach the policy.
 *
 * Two properties keep that recoverable:
 *
 *  1. SCPs never apply to the management account (§10 "Gotchas"). That account
 *     is always able to detach a policy, which is exactly why no workload is
 *     allowed to run there.
 *  2. Everything here is attached to an OU, never to an account (ADR-0001), so
 *     detaching is a single operation regardless of how many accounts exist.
 *
 * Bundling: AWS allows a maximum of 5 policies attached per OU or account, and
 * the AWS-managed `FullAWSAccess` policy occupies one of those slots. The six
 * logical policies below are therefore emitted as four attached documents by
 * `governance-stack.ts`. See the README for the grouping and its rationale.
 */

export interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action?: string | string[];
  readonly NotAction?: string | string[];
  readonly Resource: string | string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: PolicyStatement[];
}

/** Hard AWS quota on the size of a service control policy document, in bytes. */
export const SCP_MAX_SIZE_BYTES = 5120;

/** Maximum policies attachable to one OU or account, including `FullAWSAccess`. */
export const SCP_MAX_POLICIES_PER_TARGET = 5;

/** The one region everything runs in (ADR-0001, action plan §0). */
const ALLOWED_REGION = "us-east-1";

/**
 * Global (non-regional) service namespaces exempted from the region lock.
 *
 * READ BEFORE EDITING. Global services are only reachable through their
 * `us-east-1` endpoints, but they report `aws:RequestedRegion` values that are
 * not `us-east-1` — IAM and Organizations report `aws-global`, Route53 reports
 * the endpoint region, billing APIs vary. A region-lock SCP that does not
 * exempt them by namespace therefore denies:
 *
 *   - every IAM call, so no role or policy can be created, read, or repaired;
 *   - every Organizations call, so the SCP itself cannot be detached from
 *     inside the org;
 *   - every Route53 call, so DNS cannot be changed and the site cannot be
 *     recovered;
 *   - every CloudFront call, so the distribution serving the site is frozen;
 *   - every billing, Cost Explorer, budgets and support call, so the damage is
 *     invisible and AWS Support cannot be contacted to help undo it.
 *
 * All of that fails simultaneously and silently, from a single missing line.
 * This is the classic way to brick an AWS account. Removing an entry from this
 * list is never a cleanup; treat any diff that shortens it as a defect.
 *
 * `sts:*` is exempt because STS has a global endpoint and denying it breaks
 * role assumption itself, including the assume-role chain CI depends on.
 *
 * `acm:*` is deliberately absent: ACM is a regional service. CloudFront
 * requires its certificates in `us-east-1`, which is already the only allowed
 * region, so nothing is lost by leaving ACM under the lock.
 */
export const GLOBAL_SERVICE_NAMESPACES: readonly string[] = [
  "account:*",
  "artifact:*",
  "aws-portal:*",
  "budgets:*",
  "ce:*",
  "cloudfront:*",
  "cur:*",
  "globalaccelerator:*",
  "health:*",
  "iam:*",
  "notifications:*",
  "organizations:*",
  "route53:*",
  "route53domains:*",
  "servicequotas:*",
  "shield:*",
  "sts:*",
  "support:*",
  "tag:*",
  "trustedadvisor:*",
  "waf:*",
  "wafv2:*",
];

/**
 * Instance type patterns that are denied outright.
 *
 * Accelerated families (`p*`, `g*`), high-memory families (`x*`, `u-*`), bare
 * metal, and anything at or above 8xlarge. A single `p4d.24xlarge` left running
 * for a weekend costs more than a decade of this platform's intended budget,
 * and nothing in Phase 0 runs EC2 at all.
 */
export const DENIED_INSTANCE_TYPE_PATTERNS: readonly string[] = [
  "p*",
  "g*",
  "x*",
  "u-*",
  "*.metal",
  "*.8xlarge",
  "*.12xlarge",
  "*.16xlarge",
  "*.24xlarge",
  "*.32xlarge",
  "*.48xlarge",
];

/**
 * Deny every action outside the primary region, except global services.
 *
 * `NotAction` rather than `Action` is what makes the exemption list load
 * bearing — see GLOBAL_SERVICE_NAMESPACES before changing anything here.
 */
export function regionLockPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyAllOutsidePrimaryRegion",
        Effect: "Deny",
        NotAction: [...GLOBAL_SERVICE_NAMESPACES],
        Resource: "*",
        Condition: {
          StringNotEquals: { "aws:RequestedRegion": [ALLOWED_REGION] },
        },
      },
    ],
  };
}

/**
 * Deny managed egress infrastructure (ADR-0002).
 *
 * A NAT Gateway is ~$33/mo per AZ and a Transit Gateway ~$36/mo per attachment.
 * Both are recurring cost with no architectural benefit at this scale, and both
 * are easy to create accidentally — `SubnetType.PRIVATE_WITH_EGRESS` creates a
 * NAT Gateway without ever naming one.
 *
 * `NoManagedEgressAspect` catches this at synth with a readable message; this
 * policy is layer 2, the backstop for console clicks, local deploys, and any
 * tool that never runs synth.
 */
export function denyManagedEgressPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyManagedEgress",
        Effect: "Deny",
        Action: [
          "ec2:CreateNatGateway",
          "ec2:CreateTransitGateway",
          "ec2:CreateTransitGatewayVpcAttachment",
          "ec2:AcceptTransitGatewayVpcAttachment",
        ],
        Resource: "*",
      },
    ],
  };
}

/** Deny launching accelerated, high-memory, bare metal, or oversized instances. */
export function denyExpensiveComputePolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyExpensiveInstanceTypes",
        Effect: "Deny",
        Action: ["ec2:RunInstances"],
        Resource: "arn:aws:ec2:*:*:instance/*",
        Condition: {
          StringLike: { "ec2:InstanceType": [...DENIED_INSTANCE_TYPE_PATTERNS] },
        },
      },
    ],
  };
}

/**
 * Deny long-lived credentials. Identity Center only.
 *
 * `iam:CreateLoginProfile` is included alongside the two obvious actions: a
 * console password on a new IAM user is a standing credential in exactly the
 * same way an access key is.
 */
export function denyStaticCredentialsPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyStaticCredentials",
        Effect: "Deny",
        Action: ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"],
        Resource: "*",
      },
    ],
  };
}

/**
 * Deny disabling or tampering with audit and detection.
 *
 * `UpdateTrail` and `UpdateDetector` are denied as well as the delete/stop
 * actions: an attacker who can reconfigure a trail to log nowhere has disabled
 * it just as effectively as one who deleted it.
 */
export function protectAuditPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ProtectAuditTrail",
        Effect: "Deny",
        Action: [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "cloudtrail:UpdateTrail",
          "guardduty:DeleteDetector",
          "guardduty:DisassociateFromMasterAccount",
          "guardduty:UpdateDetector",
          "config:DeleteConfigurationRecorder",
          "config:StopConfigurationRecorder",
        ],
        Resource: "*",
      },
    ],
  };
}

/** Deny a member account removing itself from the organization and its guardrails. */
export function protectOrganizationPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyLeaveOrganization",
        Effect: "Deny",
        Action: ["organizations:LeaveOrganization"],
        Resource: "*",
      },
    ],
  };
}

/** Merge several documents into one attachable policy, preserving statement order. */
export function mergePolicies(...documents: PolicyDocument[]): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: documents.flatMap((document) => document.Statement),
  };
}

/**
 * Throw if a document exceeds the SCP size quota.
 *
 * The quota is enforced by the Organizations API, not by CloudFormation's
 * template validation, so an oversized policy surfaces as an opaque failure
 * partway through a deploy rather than at synth. Checking at construction time
 * turns that into a local error with the policy name attached.
 */
export function assertPolicySize(name: string, document: PolicyDocument): PolicyDocument {
  const size = JSON.stringify(document).length;
  if (size > SCP_MAX_SIZE_BYTES) {
    throw new Error(
      `SCP "${name}" is ${size} bytes, over the ${SCP_MAX_SIZE_BYTES}-byte AWS quota. ` +
        "Split it across another attached policy, or shorten action lists using " +
        "namespace wildcards. Note the limit of " +
        `${SCP_MAX_POLICIES_PER_TARGET} policies per OU (FullAWSAccess occupies one).`,
    );
  }
  return document;
}
