/**
 * NoManagedEgressAspect — enforcement layer 1 for ADR-0002.
 *
 * Fails `cdk synth` on managed-egress resources that carry recurring cost with
 * no architectural benefit at this scale. Interface endpoints only warn, since
 * they are occasionally justified.
 */

import { Annotations, Token } from "aws-cdk-lib";
import {
  CfnNatGateway,
  CfnTransitGateway,
  CfnTransitGatewayAttachment,
  CfnVPCEndpoint,
} from "aws-cdk-lib/aws-ec2";
import type { IAspect } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export interface NoManagedEgressAspectProps {
  /**
   * Interface endpoint service names that are accepted without a warning.
   * Each entry should be justified — $7.30/AZ/mo per endpoint.
   */
  readonly allowedInterfaceEndpoints?: string[];
}

export class NoManagedEgressAspect implements IAspect {
  private readonly allowedInterfaceEndpoints: ReadonlySet<string>;

  constructor(props: NoManagedEgressAspectProps = {}) {
    this.allowedInterfaceEndpoints = new Set(props.allowedInterfaceEndpoints ?? []);
  }

  visit(node: IConstruct): void {
    if (node instanceof CfnNatGateway) {
      Annotations.of(node).addError(
        "NAT Gateway blocked (ADR-0002, ~$33/mo per gateway plus $0.045/GB). " +
          "The likely cause is a Vpc using SubnetType.PRIVATE_WITH_EGRESS, which is " +
          "what constructs this NAT Gateway. Use SubnetType.PUBLIC with a strict " +
          "security group, SubnetType.PRIVATE_ISOLATED with an IPv6 egress-only " +
          "internet gateway, or a Lambda with no VPC attachment.",
      );
    }

    if (node instanceof CfnTransitGateway || node instanceof CfnTransitGatewayAttachment) {
      Annotations.of(node).addError(
        "Transit Gateway blocked (ADR-0002, ~$36/mo per attachment). " +
          "There is one VPC; if a second ever exists, use VPC peering.",
      );
    }

    if (node instanceof CfnVPCEndpoint) {
      this.visitVpcEndpoint(node);
    }
  }

  private visitVpcEndpoint(node: CfnVPCEndpoint): void {
    if (node.vpcEndpointType !== "Interface") {
      return;
    }
    // serviceName can be an unresolved token (e.g. built from a region lookup),
    // and is optional in the L1 type. Nothing can be compared against the
    // allowlist in either case.
    const serviceName = node.serviceName;
    if (serviceName === undefined || Token.isUnresolved(serviceName)) {
      return;
    }
    if (this.allowedInterfaceEndpoints.has(serviceName)) {
      return;
    }
    Annotations.of(node).addWarning(
      `Interface endpoint ${serviceName} costs $7.30/AZ/mo (ADR-0002). ` +
        "Add it to allowedInterfaceEndpoints with a reason, or use a gateway " +
        "endpoint, IPv6 egress, or a Lambda outside the VPC instead.",
    );
  }
}
