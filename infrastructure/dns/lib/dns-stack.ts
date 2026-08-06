/**
 * DnsStack — Route53 hosted zones, records and the platform ACM certificate
 * (Phase 0 action plan §5 Stage D and §8 Stage G, ADR-0006).
 *
 * The design constraint that shapes this entire file: `josephkan.ca` is LIVE,
 * serving the personal site from Vercel with DNS hosted at GoDaddy. The
 * migration to Route53 must be a no-op at the moment the nameservers change,
 * which means this stack must be able to render a zone whose contents are
 * byte-identical to what GoDaddy serves today, and then — as a separate,
 * independently reversible step — flip the apex to CloudFront.
 *
 * That is what `OriginMode` is. It is not configurability for its own sake; it
 * is the seam that separates "DNS migration" from "hosting migration" so that
 * either can be rolled back without the other.
 */

import { CfnOutput, Duration, Fn, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53 from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import {
  CLOUDFRONT_CERT_REGION,
  DEFAULT_OWNER,
  applyPlatformTags,
  domains,
  ssmPaths,
  vercelRecords,
} from "@platform/config";
import type { StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Where the apex and `www` point.
 *
 * - `vercel`     — replicates the live GoDaddy records exactly. Safe to deploy
 *                  before, during and after the nameserver switch.
 * - `cloudfront` — the apex cutover (Stage G1). ALIAS records, because DNS
 *                  forbids a CNAME at a zone apex.
 */
export type OriginMode = "vercel" | "cloudfront";

/**
 * Every non-alias record uses this TTL, deliberately.
 *
 * A 300s TTL is what makes the apex cutover reversible in five minutes without
 * touching nameservers. It is the entire reason Stage D3 (nameserver switch)
 * and Stage G1 (apex flip) can be separate, independently revertible events.
 * Do not raise it.
 */
const RECORD_TTL = Duration.minutes(5);

export interface DnsStackProps extends StackProps {
  /**
   * Apex/www origin. Defaults to `vercel` — the live state.
   *
   * Flipping this to `cloudfront` IS the apex cutover. It should be a one-line
   * context change and nothing else.
   */
  readonly origin?: OriginMode;

  /**
   * CloudFront distribution domain name (`dxxxx.cloudfront.net`). Required
   * when `origin` is `cloudfront`.
   *
   * The distribution lives in `applications/personal-site`, a different package
   * across the ADR-0004 seam, so this value must NOT arrive via a
   * CloudFormation cross-stack export: an export makes the exporting stack
   * undeletable and forces lockstep deploys of app and platform.
   *
   * It is passed in explicitly (prop, normally sourced from CDK context) rather
   * than read with `StringParameter.valueFromLookup`. Both avoid the export;
   * the difference is that a lookup resolves against live AWS at synth time and
   * caches into `cdk.context.json`, so the rendered template depends on ambient
   * credentials and on cache freshness. For the single highest-risk record
   * change in Phase 0 the value should instead be visible in the diff of the
   * commit that performs the cutover, and identical whether synthesized in CI,
   * locally, or with no credentials at all.
   *
   * The reverse direction — application stacks consuming zone ID, zone name and
   * certificate ARN — does use SSM, via the parameters published below.
   */
  readonly cloudFrontDomainName?: string;

  /**
   * Create the `newnotams.net` public hosted zone. Empty of records: Phase 1
   * replicates its Vercel records and delegates, exactly as Stage D does here.
   *
   * Off by default because an empty zone costs $0.50/mo and nothing on day one
   * consumes it.
   */
  readonly createProductZone?: boolean;

  /**
   * VPC ID to associate the `internal.josephkan.ca` private hosted zone with.
   *
   * A private hosted zone cannot exist without a VPC, and there is no VPC until
   * Phase 1. Omitting this omits the zone. See the README for the Tailscale
   * Split DNS requirement that comes with it.
   */
  readonly internalZoneVpcId?: string;
}

export class DnsStack extends Stack {
  readonly platformZone: route53.PublicHostedZone;
  readonly productZone?: route53.PublicHostedZone;
  readonly internalZone?: route53.PrivateHostedZone;
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: DnsStackProps = {}) {
    super(scope, id, props);

    const origin = props.origin ?? "vercel";

    this.platformZone = new route53.PublicHostedZone(this, "PlatformZone", {
      zoneName: domains.platform,
      comment: `Platform + personal domain (ADR-0006). Origin mode: ${origin}.`,
    });

    if (origin === "vercel") {
      this.addVercelRecords();
    } else {
      this.addCloudFrontRecords(this.requireCloudFrontDomainName(props));
    }

    this.addDmarcRecord();

    // us-east-1 is not a preference here, it is an AWS constraint: CloudFront
    // will only attach a certificate from us-east-1, whatever region anything
    // else runs in. The primary region happens to be us-east-1 today, which is
    // why no cross-region construct is needed — but if PRIMARY_REGION ever
    // changes, this stack must be split so the certificate stays here rather
    // than silently following the new primary region and failing to attach.
    if (props.env?.region !== undefined && props.env.region !== CLOUDFRONT_CERT_REGION) {
      throw new Error(
        `DnsStack must be deployed to ${CLOUDFRONT_CERT_REGION} because CloudFront ` +
          `only accepts ACM certificates from that region, got ${props.env.region}. ` +
          "If the primary region changes, keep this stack (or at least the certificate) " +
          "in us-east-1.",
      );
    }

    this.certificate = new acm.Certificate(this, "PlatformCertificate", {
      domainName: domains.platform,
      subjectAlternativeNames: [`*.${domains.platform}`],
      // Route53 holds the zone, so CDK writes the validation CNAMEs itself.
      validation: acm.CertificateValidation.fromDns(this.platformZone),
    });

    this.publishZoneParameters("PlatformZone", domains.platform, this.platformZone);
    new ssm.StringParameter(this, "PlatformCertificateArnParameter", {
      parameterName: ssmPaths.certificateArn(domains.platform),
      stringValue: this.certificate.certificateArn,
      description: `ACM certificate for ${domains.platform} and *.${domains.platform}.`,
    });

    if (props.createProductZone) {
      // No records: newnotams.net still resolves through its current provider.
      // Phase 1 replicates its records here before any delegation, same order
      // as Stage D. Creating the zone early only reserves the delegation set.
      this.productZone = new route53.PublicHostedZone(this, "ProductZone", {
        zoneName: domains.product,
        comment: `${domains.product} — records migrate in Phase 1 (ADR-0006).`,
      });
      this.publishZoneParameters("ProductZone", domains.product, this.productZone);
    }

    if (props.internalZoneVpcId) {
      this.internalZone = new route53.PrivateHostedZone(this, "InternalZone", {
        zoneName: domains.internal,
        // Imported by ID only. A private zone association reads nothing but
        // the VPC ID and region, and importing by attributes avoids a context
        // lookup that would require live credentials to synthesize. The AZ
        // list is unused here but must be non-empty, since fromVpcAttributes
        // validates subnet counts against it.
        vpc: ec2.Vpc.fromVpcAttributes(this, "InternalZoneVpc", {
          vpcId: props.internalZoneVpcId,
          availabilityZones: [`${this.region}a`],
        }),
        comment: `${domains.internal} — Tailscale-only, NXDOMAIN publicly (ADR-0006).`,
      });
      this.publishZoneParameters("InternalZone", domains.internal, this.internalZone);
    }

    applyPlatformTags(this, {
      app: "platform-dns",
      env: "prod",
      owner: DEFAULT_OWNER,
    });

    new CfnOutput(this, "PlatformZoneNameServers", {
      value: Fn.join(",", this.platformZone.hostedZoneNameServers ?? []),
      description:
        "Set these four as the nameservers at GoDaddy — but only after Stage D2 verification passes.",
    });
    new CfnOutput(this, "PlatformZoneId", { value: this.platformZone.hostedZoneId });
    new CfnOutput(this, "OriginMode", {
      value: origin,
      description: "Where the apex points. Flipping this to cloudfront is the Stage G1 cutover.",
    });
  }

  /**
   * The live GoDaddy records, replicated exactly (Stage D1).
   *
   * These values must match what GoDaddy serves today. If they drift, the
   * nameserver switch in D3 stops being a no-op and takes the site down.
   */
  private addVercelRecords(): void {
    new route53.ARecord(this, "ApexVercelRecord", {
      zone: this.platformZone,
      target: route53.RecordTarget.fromIpAddresses(vercelRecords.apexIpv4),
      ttl: RECORD_TTL,
      comment: "Vercel apex. Replicated from GoDaddy so delegation is a no-op.",
    });

    new route53.CnameRecord(this, "WwwVercelRecord", {
      zone: this.platformZone,
      recordName: "www",
      domainName: vercelRecords.wwwCname,
      ttl: RECORD_TTL,
      comment: "Vercel www. Replicated from GoDaddy so delegation is a no-op.",
    });
  }

  /**
   * The apex cutover (Stage G1).
   *
   * ALIAS, not CNAME. DNS forbids a CNAME at a zone apex because the apex must
   * hold SOA and NS records, and CloudFront publishes a hostname rather than a
   * stable IP. `www` uses an ALIAS too for symmetry; ALIAS queries are free.
   */
  private addCloudFrontRecords(cloudFrontDomainName: string): void {
    const target = route53.RecordTarget.fromAlias({
      bind: () => ({
        hostedZoneId: CloudFrontTarget.getHostedZoneId(this),
        dnsName: cloudFrontDomainName,
      }),
    });

    // No ttl: alias records take their TTL from the target and reject one.
    new route53.ARecord(this, "ApexCloudFrontRecord", {
      zone: this.platformZone,
      target,
      comment: "Apex ALIAS to CloudFront. Revert to origin=vercel to roll back.",
    });

    new route53.ARecord(this, "WwwCloudFrontRecord", {
      zone: this.platformZone,
      recordName: "www",
      target,
      comment: "www ALIAS to the same distribution.",
    });
  }

  /**
   * No mail is sent from this domain, which is precisely why the domain should
   * be unspoofable: `p=reject` costs nothing and closes the gap.
   *
   * Deliberately no SPF and no MX. None exist today, and publishing either
   * without a mail provider behind it would be worse than publishing nothing.
   */
  private addDmarcRecord(): void {
    new route53.TxtRecord(this, "DmarcRecord", {
      zone: this.platformZone,
      recordName: "_dmarc",
      values: ["v=DMARC1; p=reject;"],
      ttl: RECORD_TTL,
      comment: "No mail is sent from this domain, so nothing can legitimately pass DMARC.",
    });
  }

  /**
   * SSM is the contract between this stack and application stacks (ADR-0004).
   * Application stacks read these with `StringParameter.valueFromLookup`; a
   * CloudFormation export would make this stack undeletable and force lockstep
   * deploys across the platform/application seam.
   */
  private publishZoneParameters(
    idPrefix: string,
    domain: string,
    zone: route53.IHostedZone,
  ): void {
    new ssm.StringParameter(this, `${idPrefix}IdParameter`, {
      parameterName: ssmPaths.hostedZoneId(domain),
      stringValue: zone.hostedZoneId,
      description: `Route53 hosted zone ID for ${domain}.`,
    });
    new ssm.StringParameter(this, `${idPrefix}NameParameter`, {
      parameterName: ssmPaths.hostedZoneName(domain),
      stringValue: zone.zoneName,
      description: `Route53 hosted zone name for ${domain}.`,
    });
  }

  private requireCloudFrontDomainName(props: DnsStackProps): string {
    const fromContext = this.node.tryGetContext("cloudFrontDomainName");
    const value = props.cloudFrontDomainName ?? (typeof fromContext === "string" ? fromContext : undefined);
    if (!value) {
      throw new Error(
        "origin=cloudfront requires cloudFrontDomainName (the dxxxx.cloudfront.net domain " +
          "of the personal-site distribution). Pass it as a prop or with " +
          "-c cloudFrontDomainName=dxxxx.cloudfront.net. It is not read from a " +
          "CloudFormation export, by design (ADR-0004).",
      );
    }
    return value;
  }
}
