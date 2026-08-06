/**
 * These tests exist because an SCP is not reviewable by eye. A missing entry in
 * the region-lock NotAction list looks like a tidier list and behaves like a
 * locked account, so the exemptions are asserted individually rather than as a
 * snapshot — a snapshot would happily record the broken version.
 */

import {
  DENIED_INSTANCE_TYPE_PATTERNS,
  GLOBAL_SERVICE_NAMESPACES,
  SCP_MAX_SIZE_BYTES,
  assertPolicySize,
  denyExpensiveComputePolicy,
  denyManagedEgressPolicy,
  denyStaticCredentialsPolicy,
  mergePolicies,
  protectAuditPolicy,
  protectOrganizationPolicy,
  regionLockPolicy,
} from "../lib/service-control-policies.js";
import type { PolicyDocument, PolicyStatement } from "../lib/service-control-policies.js";

const ALL_POLICIES: ReadonlyArray<[string, () => PolicyDocument]> = [
  ["regionLockPolicy", regionLockPolicy],
  ["denyManagedEgressPolicy", denyManagedEgressPolicy],
  ["denyExpensiveComputePolicy", denyExpensiveComputePolicy],
  ["denyStaticCredentialsPolicy", denyStaticCredentialsPolicy],
  ["protectAuditPolicy", protectAuditPolicy],
  ["protectOrganizationPolicy", protectOrganizationPolicy],
];

function actionsOf(statement: PolicyStatement): string[] {
  const actions = statement.Action ?? [];
  return Array.isArray(actions) ? actions : [actions];
}

function onlyStatement(document: PolicyDocument): PolicyStatement {
  expect(document.Statement).toHaveLength(1);
  return document.Statement[0] as PolicyStatement;
}

describe.each(ALL_POLICIES)("%s", (name, factory) => {
  const document = factory();

  test("declares the 2012-10-17 policy version", () => {
    expect(document.Version).toBe("2012-10-17");
  });

  test(`is under the ${SCP_MAX_SIZE_BYTES}-byte SCP quota`, () => {
    expect(JSON.stringify(document).length).toBeLessThan(SCP_MAX_SIZE_BYTES);
    expect(() => assertPolicySize(name, document)).not.toThrow();
  });

  test("every statement is a Deny on a concrete resource", () => {
    expect(document.Statement.length).toBeGreaterThan(0);
    for (const statement of document.Statement) {
      expect(statement.Effect).toBe("Deny");
      expect(statement.Resource).toBeDefined();
    }
  });
});

describe("regionLockPolicy", () => {
  const statement = onlyStatement(regionLockPolicy());
  const notActions = Array.isArray(statement.NotAction)
    ? statement.NotAction
    : [statement.NotAction];

  test("uses NotAction, not Action", () => {
    expect(statement.NotAction).toBeDefined();
    expect(statement.Action).toBeUndefined();
  });

  test("denies on StringNotEquals aws:RequestedRegion us-east-1", () => {
    expect(statement.Condition).toEqual({
      StringNotEquals: { "aws:RequestedRegion": ["us-east-1"] },
    });
  });

  /**
   * Written as a loop on purpose. Dropping any one of these from the exemption
   * list breaks IAM, DNS, CloudFront and billing simultaneously, and the
   * resulting diff looks like a harmless cleanup.
   */
  describe.each([
    "iam:*",
    "organizations:*",
    "route53:*",
    "route53domains:*",
    "cloudfront:*",
    "sts:*",
    "waf:*",
    "wafv2:*",
    "shield:*",
    "globalaccelerator:*",
    "support:*",
    "budgets:*",
    "ce:*",
    "cur:*",
    "health:*",
    "account:*",
    "artifact:*",
    "notifications:*",
    "aws-portal:*",
    "trustedadvisor:*",
    "servicequotas:*",
    "tag:*",
  ])("global service exemption", (namespace) => {
    test(`${namespace} is exempt from the region lock`, () => {
      expect(notActions).toContain(namespace);
    });
  });

  test("exempts exactly the documented global namespace list", () => {
    expect(notActions.sort()).toEqual([...GLOBAL_SERVICE_NAMESPACES].sort());
  });

  test("does not exempt acm, which is regional and already confined to us-east-1", () => {
    expect(notActions).not.toContain("acm:*");
  });
});

describe("denyManagedEgressPolicy", () => {
  const actions = actionsOf(onlyStatement(denyManagedEgressPolicy()));

  test("denies NAT Gateway creation (~$33/mo, ADR-0002)", () => {
    expect(actions).toContain("ec2:CreateNatGateway");
  });

  test("denies Transit Gateway creation (~$36/mo per attachment, ADR-0002)", () => {
    expect(actions).toContain("ec2:CreateTransitGateway");
  });

  test("denies attaching to and accepting a Transit Gateway from elsewhere", () => {
    expect(actions).toContain("ec2:CreateTransitGatewayVpcAttachment");
    expect(actions).toContain("ec2:AcceptTransitGatewayVpcAttachment");
  });
});

describe("denyExpensiveComputePolicy", () => {
  const statement = onlyStatement(denyExpensiveComputePolicy());

  test("denies RunInstances scoped to instance ARNs", () => {
    expect(actionsOf(statement)).toEqual(["ec2:RunInstances"]);
    expect(statement.Resource).toBe("arn:aws:ec2:*:*:instance/*");
  });

  test.each([
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
  ])("denies the %s instance type pattern", (pattern) => {
    expect(statement.Condition?.["StringLike"]?.["ec2:InstanceType"]).toContain(pattern);
  });

  test("matches instance type with StringLike, not StringEquals", () => {
    expect(Object.keys(statement.Condition ?? {})).toEqual(["StringLike"]);
  });

  test("the exported pattern list is what the policy renders", () => {
    expect(statement.Condition?.["StringLike"]?.["ec2:InstanceType"]).toEqual([
      ...DENIED_INSTANCE_TYPE_PATTERNS,
    ]);
  });
});

describe("denyStaticCredentialsPolicy", () => {
  test("denies IAM users, access keys, and console passwords", () => {
    const actions = actionsOf(onlyStatement(denyStaticCredentialsPolicy()));
    expect(actions).toEqual(
      expect.arrayContaining(["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"]),
    );
  });
});

describe("protectAuditPolicy", () => {
  const actions = actionsOf(onlyStatement(protectAuditPolicy()));

  test.each([
    "cloudtrail:StopLogging",
    "cloudtrail:DeleteTrail",
    "cloudtrail:UpdateTrail",
    "guardduty:DeleteDetector",
    "guardduty:DisassociateFromMasterAccount",
    "guardduty:UpdateDetector",
    "config:DeleteConfigurationRecorder",
    "config:StopConfigurationRecorder",
  ])("denies %s", (action) => {
    expect(actions).toContain(action);
  });
});

describe("protectOrganizationPolicy", () => {
  test("denies leaving the organization, which would shed every other guardrail", () => {
    expect(actionsOf(onlyStatement(protectOrganizationPolicy()))).toEqual([
      "organizations:LeaveOrganization",
    ]);
  });
});

describe("assertPolicySize", () => {
  test("no policy, individually or merged, exceeds the SCP size quota", () => {
    for (const [name, factory] of ALL_POLICIES) {
      expect(JSON.stringify(factory()).length).toBeLessThanOrEqual(SCP_MAX_SIZE_BYTES);
      expect(() => assertPolicySize(name, factory())).not.toThrow();
    }
    const everything = mergePolicies(...ALL_POLICIES.map(([, factory]) => factory()));
    expect(() => assertPolicySize("all-combined", everything)).not.toThrow();
  });

  test("throws with the policy name when a document is oversized", () => {
    const oversized: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: Array.from({ length: 400 }, (_, index) => `service${index}:SomeLongActionName`),
          Resource: "*",
        },
      ],
    };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(SCP_MAX_SIZE_BYTES);
    expect(() => assertPolicySize("oversized", oversized)).toThrow(/oversized/);
    expect(() => assertPolicySize("oversized", oversized)).toThrow(
      new RegExp(`${SCP_MAX_SIZE_BYTES}-byte`),
    );
  });

  test("returns the document unchanged when within quota", () => {
    const document = protectOrganizationPolicy();
    expect(assertPolicySize("ok", document)).toBe(document);
  });
});

describe("mergePolicies", () => {
  test("concatenates statements and keeps a single version field", () => {
    const merged = mergePolicies(denyManagedEgressPolicy(), denyExpensiveComputePolicy());
    expect(merged.Version).toBe("2012-10-17");
    expect(merged.Statement).toHaveLength(2);
    expect(merged.Statement[0]?.Sid).toBe("DenyManagedEgress");
    expect(merged.Statement[1]?.Sid).toBe("DenyExpensiveInstanceTypes");
  });
});
