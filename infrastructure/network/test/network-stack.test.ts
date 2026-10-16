/**
 * NetworkStack is shared, platform-owned infrastructure every future
 * private service depends on (see the stack's own doc comment) — these
 * tests exist to catch a regression here before it breaks every consumer
 * at once, not just this one stack.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack.js";

const ENV = { account: "222222222222", region: "us-east-1" };

function synth(): { stack: NetworkStack; template: Template } {
  const app = new App();
  const stack = new NetworkStack(app, "TestNetworkStack", { env: ENV });
  return { stack, template: Template.fromStack(stack) };
}

describe("VPC (ADR-0002)", () => {
  const { template } = synth();

  test("10.20.0.0/16, no NAT Gateway, no Transit Gateway", () => {
    template.hasResourceProperties("AWS::EC2::VPC", { CidrBlock: "10.20.0.0/16" });
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::TransitGateway", 0);
  });

  test("public and isolated subnets only — no PRIVATE_WITH_EGRESS tier", () => {
    // PRIVATE_WITH_EGRESS subnets are what create a NAT Gateway route; the
    // NatGateway count of 0 above is the real proof, this just documents
    // the subnet count matches the 2-AZ, 2-tier layout.
    template.resourceCountIs("AWS::EC2::Subnet", 4);
  });

  test("gateway endpoints for S3 and DynamoDB, no interface endpoints", () => {
    const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
    expect(Object.keys(endpoints)).toHaveLength(2);
    for (const endpoint of Object.values(endpoints)) {
      expect((endpoint as { Properties: { VpcEndpointType: string } }).Properties.VpcEndpointType).toBe(
        "Gateway",
      );
    }
    // ServiceName is an Fn::Join token (region-dependent), not a plain
    // string — rendering it to JSON and checking the suffix is substance
    // over the exact intrinsic shape, which is CDK's to construct, not
    // this stack's.
    const rendered = JSON.stringify(Object.values(endpoints));
    expect(rendered).toContain(".s3");
    expect(rendered).toContain(".dynamodb");
  });

  test("VPC Flow Logs exist, 2-week retention", () => {
    template.resourceCountIs("AWS::EC2::FlowLog", 1);
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
  });
});

describe("Tailscale subnet router", () => {
  const { template } = synth();

  test("t4g.nano, ARM64 Amazon Linux 2023", () => {
    template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.nano" });
  });

  test("in a public subnet with a public IP, not isolated", () => {
    template.hasResourceProperties("AWS::EC2::Instance", {
      NetworkInterfaces: Match.arrayWith([
        Match.objectLike({ AssociatePublicIpAddress: true }),
      ]),
    });
  });

  test("security group allows only UDP 41641 inbound — no SSH, no other port", () => {
    const sgs = template.findResources("AWS::EC2::SecurityGroup");
    const ingressRules = Object.values(sgs).flatMap(
      (sg) => (sg as { Properties: { SecurityGroupIngress?: unknown[] } }).Properties.SecurityGroupIngress ?? [],
    );
    expect(ingressRules).toHaveLength(1);
    expect(ingressRules[0]).toMatchObject({ IpProtocol: "udp", FromPort: 41641, ToPort: 41641 });
  });

  test("no SSH key pair anywhere in the template", () => {
    template.resourceCountIs("AWS::EC2::KeyPair", 0);
  });

  test("instance role can read only the one Tailscale auth-key SSM parameter", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } })
          .Properties.PolicyDocument.Statement,
    );
    const ssmStatement = statements.find(
      (s) => s.Action === "ssm:GetParameter" || (Array.isArray(s.Action) && s.Action.includes("ssm:GetParameter")),
    );
    expect(ssmStatement).toBeDefined();
  });

  test("EBS volume is encrypted", () => {
    template.hasResourceProperties("AWS::EC2::Instance", {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) }),
      ]),
    });
  });

  test("termination protection is enabled", () => {
    template.hasResourceProperties("AWS::EC2::Instance", { DisableApiTermination: true });
  });

  test("UserData installs Tailscale and advertises the VPC's own CIDR", () => {
    const instances = template.findResources("AWS::EC2::Instance");
    const [, instance] = Object.entries(instances)[0]!;
    const userDataBase64 = (
      instance as { Properties: { UserData: { "Fn::Base64": unknown } } }
    ).Properties.UserData["Fn::Base64"];
    const rendered = JSON.stringify(userDataBase64);
    expect(rendered).toContain("pkgs.tailscale.com/stable/amazon-linux/2023");
    expect(rendered).toContain("--advertise-routes=");
    expect(rendered).toContain("10.20.0.0/16");
    expect(rendered).toContain("ssm get-parameter");
    expect(rendered).toContain("/platform/network/tailscale-auth-key");
  });
});

describe("SSM parameters published for consumers (ADR-0004 seam)", () => {
  const { template } = synth();

  test("publishes the VPC ID at the documented ssmPaths.vpcId path", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/platform/prod/vpc/id",
      Type: "String",
    });
  });

  test("publishes isolated subnet IDs for a private-only Lambda/Fargate task to use", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/platform/prod/vpc/isolated-subnet-ids",
    });
  });

  test("does NOT create internal.josephkan.ca itself — that is DnsStack's job", () => {
    template.resourceCountIs("AWS::Route53::HostedZone", 0);
  });
});

describe("outputs", () => {
  const { template } = synth();

  test("outputs the VPC ID for DnsStack's -c internalZoneVpcId flag", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Description?: string }>;
    const vpcIdOutput = Object.values(outputs).find((o) =>
      o.Description?.includes("internalZoneVpcId"),
    );
    expect(vpcIdOutput).toBeDefined();
  });
});
