import { App, Aspects, CfnParameter, Stack } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { NoManagedEgressAspect } from "../src/index.js";

function newStack(): Stack {
  const app = new App();
  return new Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
}

describe("NoManagedEgressAspect", () => {
  it("errors on a raw CfnNatGateway", () => {
    const stack = newStack();
    new ec2.CfnNatGateway(stack, "Nat", { subnetId: "subnet-0123456789abcdef0" });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("NAT Gateway blocked"));
  });

  it("names PRIVATE_WITH_EGRESS as the likely cause", () => {
    const stack = newStack();
    new ec2.CfnNatGateway(stack, "Nat", { subnetId: "subnet-0123456789abcdef0" });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("PRIVATE_WITH_EGRESS"));
  });

  it("fires on a real Vpc built with PRIVATE_WITH_EGRESS subnets", () => {
    const stack = newStack();
    new ec2.Vpc(stack, "Vpc", {
      maxAzs: 2,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("NAT Gateway blocked"));
  });

  it("stays silent on a Vpc with only PUBLIC and PRIVATE_ISOLATED subnets", () => {
    const stack = newStack();
    new ec2.Vpc(stack, "Vpc", {
      maxAzs: 2,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("errors on a Transit Gateway", () => {
    const stack = newStack();
    new ec2.CfnTransitGateway(stack, "Tgw", {});
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("Transit Gateway blocked"));
  });

  it("errors on a Transit Gateway attachment", () => {
    const stack = newStack();
    new ec2.CfnTransitGatewayAttachment(stack, "TgwAttach", {
      transitGatewayId: "tgw-0123456789abcdef0",
      vpcId: "vpc-0123456789abcdef0",
      subnetIds: ["subnet-0123456789abcdef0"],
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("~\\$36/mo per attachment"));
  });

  it("warns on a non-allowlisted interface endpoint", () => {
    const stack = newStack();
    new ec2.CfnVPCEndpoint(stack, "Endpoint", {
      vpcId: "vpc-0123456789abcdef0",
      serviceName: "com.amazonaws.us-east-1.secretsmanager",
      vpcEndpointType: "Interface",
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasWarning("*", Match.stringLikeRegexp("\\$7.30/AZ/mo"));
    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("stays silent on an allowlisted interface endpoint", () => {
    const stack = newStack();
    new ec2.CfnVPCEndpoint(stack, "Endpoint", {
      vpcId: "vpc-0123456789abcdef0",
      serviceName: "com.amazonaws.us-east-1.secretsmanager",
      vpcEndpointType: "Interface",
    });
    Aspects.of(stack).add(
      new NoManagedEgressAspect({
        allowedInterfaceEndpoints: ["com.amazonaws.us-east-1.secretsmanager"],
      }),
    );

    Annotations.fromStack(stack).hasNoWarning("*", Match.anyValue());
  });

  it("stays silent on a gateway endpoint", () => {
    const stack = newStack();
    new ec2.CfnVPCEndpoint(stack, "Endpoint", {
      vpcId: "vpc-0123456789abcdef0",
      serviceName: "com.amazonaws.us-east-1.s3",
      vpcEndpointType: "Gateway",
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasNoWarning("*", Match.anyValue());
    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("skips an interface endpoint whose serviceName is an unresolved token", () => {
    const stack = newStack();
    const serviceName = new CfnParameter(stack, "ServiceName", { type: "String" });
    new ec2.CfnVPCEndpoint(stack, "Endpoint", {
      vpcId: "vpc-0123456789abcdef0",
      serviceName: serviceName.valueAsString,
      vpcEndpointType: "Interface",
    });
    Aspects.of(stack).add(new NoManagedEgressAspect());

    Annotations.fromStack(stack).hasNoWarning("*", Match.anyValue());
  });
});
