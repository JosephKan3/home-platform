/**
 * NetworkStack — the shared VPC and Tailscale subnet router that Phase 1's
 * roadmap specified and never built (`docs/architecture/roadmap.md`,
 * "Tailscale subnet router on t4g.nano"). Platform-owned, shared
 * infrastructure — a VPC and a subnet router exist exactly once, used by
 * every app that needs private-only reachability, not duplicated per app.
 *
 * Deliberately does NOT create `internal.josephkan.ca` itself.
 * `infrastructure/dns`'s `DnsStack` already has that logic
 * (`props.internalZoneVpcId`, gated on a VPC ID that did not exist until
 * this stack) — confirmed by reading it, not assumed; it was written ahead
 * of this stack specifically to receive this VPC's ID. Creating a second
 * `PrivateHostedZone` for the same zone name here would conflict with it.
 * This stack's job ends at publishing `ssmPaths.vpcId` for `DnsStack` (or a
 * human running `cdk deploy DnsStack -c internalZoneVpcId=...`) to consume.
 *
 * `pilot-receipts-platform` is the first real app consumer: it deploys a
 * Lambda into the isolated subnets this stack creates, and reads
 * `ssmPaths.hostedZoneId(domains.internal)` (published by `DnsStack`, once
 * that stack is redeployed with this VPC's ID) to add its own record. Future
 * private services do the same — this stack adds nothing app-specific.
 *
 * ## Why this is a VPC at all, given ADR-0002's "don't be in the VPC" default
 *
 * ADR-0002's strategy 1 ("a Lambda with no VPC config has free, unmetered
 * internet access") is the right default for anything that only needs the
 * *public* internet. It does not apply here: the entire point of this stack
 * is a network surface that is NOT reachable from the public internet at
 * all, which is a property only a VPC (plus private DNS) can express. A
 * VPC-less Lambda is reachable from anywhere by design; a Lambda inside this
 * VPC's isolated subnets, with a Function URL, is reachable only from
 * resources that can route to it — which, after this stack, means only
 * devices on the tailnet.
 *
 * ## The subnet router's placement
 *
 * Public subnet, matching ADR-0002's strategy 2 exactly ("public subnet
 * with a public IP... not the same as being publicly reachable: the
 * security group has zero inbound rules except..."). The only inbound this
 * security group allows is UDP 41641 (Tailscale's own WireGuard-based
 * transport) from anywhere — required for other tailnet peers to reach this
 * node's relay/direct-connection attempts at all — everything else is
 * dropped. This is the same posture ADR-0002 already accepted for any
 * public-subnet compute.
 */

import { CfnOutput, Stack, Validations } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { applyPlatformTags, DEFAULT_OWNER, domains, ssmPaths } from "@josephkan3/config";
import { flattenForNagId, suppressNagRules } from "@josephkan3/constructs";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * `10.20.0.0/16`, exactly as ADR-0002 pre-allocates for the Platform account.
 * Not configurable per-deploy: there is one VPC, this is its one CIDR, and a
 * second value here would silently violate the CIDR plan ADR-0002 lays out
 * for a future second VPC to peer against.
 */
const VPC_CIDR = "10.20.0.0/16";

/**
 * Tailscale's own transport port (WireGuard-based). Needs to be reachable
 * from the public internet for peers outside this VPC to establish a direct
 * or relayed connection to this node — this is the one inbound rule ADR-0002's
 * "public subnet, strict SG" posture allows for a node whose entire purpose
 * is to be a tailnet gateway.
 */
const TAILSCALE_UDP_PORT = 41641;

/**
 * SSM parameter the subnet router's UserData reads at boot to authenticate.
 * A `String`, not `SecureString` — matches `NewNotamsStack`'s own documented
 * reasoning (grantServerSecrets's doc comment in that repo): `SecureString`
 * read via the console/CLI with `--with-decryption` needs no different IAM
 * grant than a plain `String` for an EC2 instance role (unlike Lambda's
 * `valueForStringParameter`/`valueFromLookup` split, which is what actually
 * drove that repo's decision) — but a plain `String` keeps this consistent
 * with that repo's resolved position rather than introducing a second
 * pattern. The real secret-at-rest property that matters here is the IAM
 * grant being scoped to exactly this one parameter, not SecureString's KMS
 * envelope on top of an already narrowly-grantable read.
 */
const TAILSCALE_AUTH_KEY_PARAMETER = "/platform/network/tailscale-auth-key";

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly subnetRouter: ec2.Instance;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    applyPlatformTags(this, { app: "network", env: "prod", owner: DEFAULT_OWNER });

    this.vpc = this.createVpc();
    this.subnetRouter = this.createSubnetRouter();

    this.publishVpcParameters();

    new CfnOutput(this, "SubnetRouterInstanceId", {
      value: this.subnetRouter.instanceId,
      description: "Connect via SSM Session Manager (no SSH key, no open port 22) to check Tailscale status.",
    });
    new CfnOutput(this, "SubnetRouterPublicIp", {
      value: this.subnetRouter.instancePublicIp,
      description:
        "Changes on instance replacement — this is why the Tailscale auth key is read at every " +
        "boot rather than baked in once: a replaced instance re-authenticates itself automatically.",
    });

    // W3010 (CloudFormation Validate, not cdk-nag — see createVpc's own
    // comment on why hardcoded AZs are deliberate here).
    Validations.of(this).acknowledge({
      id: "CloudFormation-Validate::W3010",
      reason:
        "This stack's env is always concrete (one Platform account) and the alternative is the " +
        "live ec2:DescribeAvailabilityZones lookup that broke deploy.yml's dev job on a " +
        "from-scratch CI checkout — see createVpc's own comment.",
    });
  }

  /**
   * `10.20.0.0/16`, dual-stack, 2 AZs, public + isolated subnets only — the
   * exact layout ADR-0002 specifies. No `PRIVATE_WITH_EGRESS` tier exists
   * because there is no NAT; `NoManagedEgressAspect` (applied at the app
   * root, not here — see `bin/app.ts`) fails synth immediately if that ever
   * changes.
   *
   * Gateway endpoints for S3 and DynamoDB are attached unconditionally
   * (ADR-0002 strategy 4: "free, always on") so an isolated-subnet Lambda —
   * like `pilot-receipts-platform`'s presigned-URL function — can reach both
   * without any egress path at all.
   */
  private createVpc(): ec2.Vpc {
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      // Explicit, not `maxAzs: 2` — deterministic (matches ADR-0002's own
      // language) rather than "whichever two AZs CDK's lookup happens to
      // return first".
      //
      // This does NOT avoid a live context lookup, though — confirmed by
      // reading aws-cdk-lib's own source: `Vpc`'s constructor calls
      // `stack.availabilityZones` unconditionally to *validate* this list
      // against the stack's real AZs, and `Stack.availabilityZones`
      // itself always queries the `AVAILABILITY_ZONE_PROVIDER` context
      // for any concretely-enviroedstack. There is no prop on either class
      // that skips this. The actual fix is `cdk.context.json` being
      // committed for this one package (see .gitignore's own comment) —
      // this broke deploy.yml's `dev` job (gha-deploy-dev holds only
      // sts:AssumeRole, no direct AWS permissions, by design) on a
      // from-scratch CI checkout with no pre-existing lookup cache.
      availabilityZones: ["us-east-1a", "us-east-1b"],
      natGateways: 0,
      // W3010's advice ("avoid hardcoding AZs, a stack should be portable
      // across regions") does not apply: this stack's `env` is always
      // concrete (accounts.platform.region), there is exactly one Platform
      // account, and the alternative is the live
      // `ec2:DescribeAvailabilityZones` lookup that broke deploy.yml's
      // `dev` job in the first place (see the comment above).
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },
        { name: "Isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    });

    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // VPC Flow Logs to CloudWatch, 2-week retention (dev-equivalent — this
    // stack's own env is "prod" for tagging/billing purposes, but there is
    // no dev/prod split for a single shared network, and flow log volume at
    // this traffic level does not justify the 1-month retention
    // LogRetentionAspect would otherwise expect; explicit here rather than
    // left to the Aspect's default). Real security value for near-zero
    // cost: this is the one VPC every future private service shares, so a
    // misconfigured security group anywhere in it is diagnosable from here
    // instead of being invisible until it is actively exploited.
    vpc.addFlowLog("FlowLog", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", { retention: logs.RetentionDays.TWO_WEEKS }),
      ),
    });

    return vpc;
  }

  /**
   * One `t4g.nano` in a public subnet, advertising the VPC's full IPv4 CIDR
   * to the tailnet. ARM/Graviton (`t4g`) because Tailscale's Amazon Linux
   * 2023 `arm64` package exists and this workload has no architecture
   * dependency that would need `t3.nano`'s x86_64 instead — `t4g.nano` is
   * meaningfully cheaper per the roadmap's own cost note (~$3/mo).
   *
   * No SSH key pair, no port 22 open anywhere: operational access is SSM
   * Session Manager exclusively (the instance role below grants
   * `AmazonSSMManagedInstanceCore`), which needs zero inbound security group
   * rules at all — it is an outbound-initiated connection to the SSM
   * service, the same "public subnet, strict SG, zero unsolicited inbound"
   * posture ADR-0002 already requires.
   */
  private createSubnetRouter(): ec2.Instance {
    const sg = new ec2.SecurityGroup(this, "SubnetRouterSg", {
      vpc: this.vpc,
      // CloudFormation's own GroupDescription regex rejects both em dashes
      // and apostrophes (confirmed by two successive synth warnings) —
      // its allowed charset is narrower than ordinary English punctuation.
      description: "Tailscale subnet router. Inbound limited to Tailscales own transport port.",
      allowAllOutbound: true,
    });
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(TAILSCALE_UDP_PORT),
      "Tailscale WireGuard-based transport — required for any peer to reach this node directly.",
    );
    // AwsSolutions-EC23: this 0.0.0.0/0 inbound rule is exactly the single
    // exception ADR-0002's "public subnet, strict SG, zero unsolicited
    // inbound except..." posture already carves out — a tailnet peer's IP
    // is unknowable in advance (it is whichever device is roaming/behind
    // whatever NAT), so there is no narrower CIDR to scope this to. Scoped
    // to exactly one UDP port, no other inbound rule exists on this SG.
    suppressNagRules(sg, [
      {
        id: "AwsSolutions-EC23",
        reason:
          "ADR-0002: Tailscale's transport port must accept inbound from any peer's IP, which " +
          "is unknowable in advance. Scoped to UDP 41641 only, no other inbound rule exists.",
      },
    ]);

    const role = new iam.Role(this, "SubnetRouterRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Tailscale subnet router instance role: SSM access, no data-plane permissions.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    // AwsSolutions-IAM4: AmazonSSMManagedInstanceCore is AWS's own
    // purpose-built policy for exactly this (Session Manager access with no
    // SSH key/port 22) — same precedent as suppressing
    // AWSCodeDeployRoleForLambdaLimited on ScheduledJob's deployment group
    // in @josephkan3/constructs (ADR-0007).
    suppressNagRules(role, [
      {
        id: `AwsSolutions-IAM4[Policy::${flattenForNagId(this, iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore").managedPolicyArn)}]`,
        reason:
          "ADR-0007: AWS's own purpose-built policy for SSM Session Manager access, the only " +
          "way this instance is operated (no SSH key, no port 22 open anywhere).",
      },
    ]);
    const authKeyParameterArn = `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${TAILSCALE_AUTH_KEY_PARAMETER}`;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [authKeyParameterArn],
      }),
    );

    const instance = new ec2.Instance(this, "SubnetRouter", {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      // A real public IP, not NAT'd through anything (ADR-0002 strategy 2):
      // this IS the "public subnet with a public IP" the subnet router's
      // whole purpose requires — nothing routes outbound internet traffic
      // through it (that would make it an exit node, a different Tailscale
      // feature this stack deliberately does not enable).
      associatePublicIpAddress: true,
      userData: this.createUserData(),
      // AwsSolutions-EC26: EBS encryption at rest, essentially free (no
      // extra charge for gp3 encryption) and straightforward to enable —
      // fixed rather than suppressed.
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true }),
        },
      ],
    });

    // AwsSolutions-EC29: termination protection, likewise straightforward
    // to enable and genuinely useful here — this is the one node every
    // private service depends on, so an accidental `terminate-instances`
    // should require a deliberate extra step, not succeed on the first try.
    instance.instance.disableApiTermination = true;

    // AwsSolutions-EC28: detailed (1-minute) CloudWatch monitoring, as
    // opposed to the free 5-minute default, costs $2.10/mo per instance
    // (per-metric EC2 detailed monitoring pricing) for a single t4g.nano
    // whose entire job is "stay up and relay packets" — no dashboard or
    // alarm in this stack currently needs 1-minute granularity to be
    // useful. Revisit if this node ever needs a tighter SLO.
    suppressNagRules(instance, [
      {
        id: "AwsSolutions-EC28",
        reason:
          "$2.10/mo for 1-minute monitoring granularity this single-purpose relay node has no " +
          "current SLO that needs; the free 5-minute default is sufficient today.",
      },
    ]);

    return instance;
  }

  /**
   * Installs Tailscale from its own Amazon Linux 2023 repo (gpg-verified,
   * the exact repo file Tailscale publishes at
   * pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo — fetched and
   * confirmed directly, not guessed), enables IP forwarding per Tailscale's
   * own subnet-router documentation, and brings the node up advertising this
   * VPC's full CIDR.
   *
   * The auth key is read from SSM at every boot, not baked into the AMI or
   * passed as a CloudFormation parameter: an instance replacement (AMI
   * update, instance-type change, or just AWS retiring the hardware)
   * re-authenticates itself automatically with no manual step, and the key
   * never appears in a CloudFormation template, console history, or this
   * stack's own CDK output.
   *
   * `--accept-routes` is deliberately omitted: this is a subnet router, not
   * a client that should also pull in other routes, and Tailscale's own
   * docs warn against it specifically for HA failover scenarios this stack
   * may grow into later (a second subnet router for redundancy).
   */
  private createUserData(): ec2.UserData {
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euo pipefail",
      "cat <<'EOF' > /etc/yum.repos.d/tailscale.repo",
      "[tailscale-stable]",
      "name=Tailscale stable",
      "baseurl=https://pkgs.tailscale.com/stable/amazon-linux/2023/$basearch",
      "enabled=1",
      "type=rpm",
      "repo_gpgcheck=1",
      "gpgcheck=1",
      "gpgkey=https://pkgs.tailscale.com/stable/amazon-linux/2023/repo.gpg",
      "EOF",
      "dnf install -y tailscale",
      "systemctl enable --now tailscaled",
      "echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-tailscale.conf",
      "echo 'net.ipv6.conf.all.forwarding = 1' >> /etc/sysctl.d/99-tailscale.conf",
      "sysctl -p /etc/sysctl.d/99-tailscale.conf",
      `AUTH_KEY=$(aws ssm get-parameter --name "${TAILSCALE_AUTH_KEY_PARAMETER}" ` +
        `--region "${this.region}" --query Parameter.Value --output text)`,
      `tailscale up --auth-key="$AUTH_KEY" --advertise-routes="${VPC_CIDR}" --hostname=subnet-router`,
    );
    return userData;
  }

  /**
   * The seam `ssmPaths.vpcId` already names (`packages/config/src/domains.ts`),
   * written here for the first time. A consuming app (`pilot-receipts-platform`
   * today) reads this the same way `NewNotamsStack` reads `ssmPaths.certificateArn`
   * — `StringParameter.valueForStringParameter` against a well-known path,
   * never a CloudFormation cross-stack export (ADR-0004's reasoning: an
   * export makes this stack undeletable and forces lockstep deploys).
   *
   * `DnsStack` needs this VPC's ID too, but as a `-c internalZoneVpcId=...`
   * CLI context value at deploy time (see that stack's own prop doc
   * comment), not read from SSM — a private hosted zone's VPC association
   * is set at zone-creation time, not patchable after the fact the way a
   * Lambda's env var is, so `DnsStack`'s own synth needs the value before
   * it can decide whether to create the zone at all. The CfnOutput below
   * exists specifically so that value is easy to find without reading this
   * stack's CloudFormation console output by hand.
   */
  private publishVpcParameters(): void {
    new ssm.StringParameter(this, "VpcIdParameter", {
      parameterName: ssmPaths.vpcId("prod"),
      stringValue: this.vpc.vpcId,
      description: "Platform VPC ID — the shared network, not per-app.",
    });
    new ssm.StringParameter(this, "IsolatedSubnetIdsParameter", {
      parameterName: "/platform/prod/vpc/isolated-subnet-ids",
      stringValue: this.vpc.isolatedSubnets.map((s) => s.subnetId).join(","),
      description: "Comma-separated isolated subnet IDs — where a private-only Lambda/Fargate task should live.",
    });

    new CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description:
        "Pass this to infrastructure/dns's DnsStack as -c internalZoneVpcId=... to create " +
        `${domains.internal}'s private hosted zone, associated with this VPC.`,
    });
  }
}
