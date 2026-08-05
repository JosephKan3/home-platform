# ADR-0002: Single dual-stack VPC, zero NAT, zero Transit Gateway

- Status: Accepted
- Date: 2026-08-05
- Supersedes: bounded-context VPCs, one-VPC-per-application, NAT-instance egress

## Context

One workload account (ADR-0001) means one VPC. The hard constraints are:

- **No NAT Gateway.** $33/mo/AZ + $0.045/GB.
- **No NAT instance.** ~$3/mo, but a patched, monitored EC2 box in the data path.
- **No Transit Gateway.** $36/mo per attachment.
- Internet Gateway and Egress-only Internet Gateway are acceptable — both are **free**.

The whole problem reduces to one question: **how does a private workload reach the internet
without NAT?** There are exactly four answers, and the design uses all four.

## Decision

### VPC layout

`10.20.0.0/16`, dual-stack (IPv4 + auto-assigned `/56` IPv6), 2 AZs.

| Tier | Subnet CIDR | IPv4 route | IPv6 route | Contents |
| --- | --- | --- | --- | --- |
| Public | `10.20.0.0/20` per AZ | IGW | IGW | ALB, Tailscale router, Fargate tasks needing egress |
| Isolated | `10.20.32.0/20` per AZ | none (gateway endpoints only) | EIGW | RDS, ElastiCache, VPC-attached Lambda |

There is deliberately **no "private with NAT" tier**, because there is no NAT.
CDK: `SubnetType.PUBLIC` and `SubnetType.PRIVATE_ISOLATED` only.

### The four egress strategies

**1. Don't be in the VPC at all. (Preferred — covers most workloads.)**

A Lambda with no VPC config has free, unmetered internet access and no ENI cold-start
penalty. Only attach a Lambda to the VPC if it must reach RDS or ElastiCache over a
private IP. Split functions along that line: an API handler that talks to DynamoDB, S3,
and third-party APIs stays out of the VPC entirely.

Where possible, prefer VPC-less data stores — DynamoDB, S3, and the RDS Data API — so the
question doesn't arise.

**2. Public subnet with a public IP. (For containers that need egress.)**

An ECS Fargate task in a public subnet with `assignPublicIp: ENABLED` routes to the IGW
directly. This is **not** the same as being publicly reachable: the security group has
zero inbound rules except from the ALB's security group. Unsolicited inbound is dropped.

Cost: **$0.005/hr per public IPv4 address = $3.60/mo per running task.** This is the trap
in "just use an IGW" — public IPv4 has not been free since February 2024. It is still 10×
cheaper than a NAT Gateway, and free if the task is IPv6-only.

**3. Egress-only Internet Gateway over IPv6. (Free, for isolated workloads.)**

An EIGW is the IPv6 analogue of a NAT Gateway — outbound-only, stateful, blocks unsolicited
inbound — and it costs **nothing**. An isolated-subnet workload with an IPv6 address reaches
any dualstack destination for free.

The catch: it only works for IPv6-reachable destinations. Coverage as of now:

| Destination | IPv6? |
| --- | --- |
| AWS APIs (dualstack endpoints) | Yes — must explicitly use `*.api.aws` dualstack endpoints |
| GitHub API / raw.githubusercontent | Yes |
| `github.com` git over HTTPS | **No** |
| npm registry | Yes (via Cloudflare) |
| Docker Hub | **No** |
| ECR / ECR Public | Yes (dualstack endpoints) |
| PyPI | Yes (Fastly) |
| Anthropic / OpenAI APIs | Verify per-endpoint before relying on it |

Verify each dependency rather than assuming. When something is IPv4-only, fall back to
strategy 1 or 2, or vendor the dependency into the container image at build time.

**4. Gateway VPC endpoints for S3 and DynamoDB. (Free, always on.)**

Attached to the isolated route table unconditionally. Zero cost, zero data charge, and they
remove the two most common reasons a workload needed egress in the first place.

### Interface endpoints: only when justified

Interface endpoints cost $7.30/AZ/mo each. Five of them across 2 AZs is $73/mo — more than
the NAT Gateway being avoided. Default is **none**. Add one only when a specific isolated
workload needs a specific service and neither IPv6 nor a gateway endpoint works. Single-AZ
if added.

### Cross-VPC connectivity

None, because there is one VPC. If a second VPC ever exists, use **VPC peering** (free,
$0.01/GB cross-AZ) — never Transit Gateway at this scale. TGW only becomes correct past
roughly 5 VPCs, where peering's non-transitivity and route-table sprawl dominate.

CIDRs stay pre-allocated and non-overlapping so peering is always possible:

```
10.10.0.0/16  reserved — future Dev account
10.20.0.0/16  Platform  ← the only one that exists
10.30.0.0/16  reserved — future Shared Services
10.40.0.0/16  reserved — future Sandbox
```

### Enforcement — two layers

**Layer 1: fail at synth (fast, local, before anything is attempted).**

A custom CDK Aspect, `NoManagedEgressAspect`, applied at the `App` root, adds an error
annotation — which fails `cdk synth` — on:

- Any `AWS::EC2::NatGateway` in the synthesized template.
- Any `AWS::EC2::TransitGateway` or `AWS::EC2::TransitGatewayAttachment`.
- Any `ec2.Subnet` whose construct tree indicates `PRIVATE_WITH_EGRESS`.
- Any `AWS::EC2::VPCEndpoint` with `VpcEndpointType: Interface` not present in an explicit
  allowlist (warns rather than errors, since these are sometimes justified).

```ts
export class NoManagedEgressAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnNatGateway) {
      Annotations.of(node).addError(
        'NAT Gateway blocked (ADR-0002, ~$33/mo). Use a public subnet with a strict SG, ' +
        'an IPv6 egress-only IGW, or a Lambda with no VPC attachment.',
      );
    }
    if (node instanceof CfnTransitGateway || node instanceof CfnTransitGatewayAttachment) {
      Annotations.of(node).addError('Transit Gateway blocked (ADR-0002, ~$36/mo/attachment).');
    }
    if (node instanceof CfnVPCEndpoint && node.vpcEndpointType === 'Interface'
        && !ALLOWED_INTERFACE_ENDPOINTS.has(node.serviceName)) {
      Annotations.of(node).addWarning(
        `Interface endpoint ${node.serviceName} costs $7.30/AZ/mo. Add to the allowlist with a reason.`,
      );
    }
  }
}
```

The `PRIVATE_WITH_EGRESS` case is caught for free: that subnet type is *what creates* the
`CfnNatGateway`, so the first rule fires with an error message that names the actual cause.

A unit test asserts the Aspect fires, so the guardrail itself can't silently rot.

**Layer 2: SCP denies `ec2:CreateNatGateway` and `ec2:CreateTransitGateway`.**

Backstop for anything that bypasses CI — console clicks, a local `cdk deploy`, a Lambda,
a third-party tool. Layer 1 gives a fast, readable failure; layer 2 makes it impossible.
Both are needed: the Aspect alone is advisory, the SCP alone produces an opaque
`UnauthorizedOperation` deep in a CloudFormation rollback.

## Rationale

- The three avoided items (NAT, TGW, extra VPCs) are pure recurring cost with no
  architectural benefit at this scale.
- Public-subnet-plus-strict-SG is the same security posture as private-plus-NAT: in both
  cases unsolicited inbound is dropped. NAT buys defence in depth against SG misconfiguration,
  which is real but is worth $33/mo only when there's something valuable behind it.
- Anything genuinely valuable — RDS, ElastiCache — sits in an isolated subnet with **no
  route to the internet at all**, which is strictly stronger than private-with-NAT.
- IPv6 + EIGW is what NAT-free egress is actually supposed to look like. Building it now
  means the eventual IPv6-only story is already done.

## Consequences

- **Public IPv4 is $3.60/mo per always-on task.** Keep the count low; prefer Lambda for
  spiky work and IPv6-only where dependencies allow.
- **IPv6 dependency verification is real work.** Docker Hub and git-over-HTTPS to github.com
  being IPv4-only is the most likely thing to bite. Mitigation: pull base images from ECR
  (dualstack) and cache them; use the GitHub API over IPv6 rather than `git clone`.
- **Security groups carry the entire load.** Misconfiguration is directly exploitable
  because workloads sit in public subnets. Mitigations: no inbound rules except from the
  ALB SG by SG-reference; `cdk-nag` `AwsSolutions-EC23` in CI blocking `0.0.0.0/0`;
  GuardDuty on; quarterly SG review.
- **Single VPC across dev and prod** means SG hygiene is also the environment boundary.
  Dev SGs and prod SGs must never reference each other.
- **2 AZs, not 3.** Nothing here is multi-AZ-critical, RDS is single-AZ, and 2 AZs halves
  any future per-AZ endpoint cost. RDS Multi-AZ can still be enabled later within 2 AZs.

## Alternatives considered

- **NAT instance (`fck-nat`, `t4g.nano`, ~$3/mo).** Genuinely cheap and the previous
  recommendation. Rejected because it puts a patched, monitored EC2 instance in the data
  path for a problem that IGW + EIGW + no-VPC-Lambda solves for free. Reconsider only if
  IPv4-only egress from isolated subnets turns out to be unavoidable — at that point it
  is still the correct answer, and $3/mo.
- **Interface endpoints for everything.** Rejected: costs more than the NAT Gateway it
  replaces and still doesn't reach non-AWS destinations.
- **NAT Gateway in prod only.** Deferred. Revisit if a compliance requirement or a real
  customer makes public-subnet compute unacceptable.
