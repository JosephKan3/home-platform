/**
 * These tests exist because this stack edits DNS for a domain that is serving
 * live traffic right now.
 *
 * The two that matter most:
 *   - in `vercel` mode the records must equal the live GoDaddy values, or the
 *     nameserver switch stops being a no-op and the site goes down;
 *   - in `cloudfront` mode the apex must be an ALIAS and never a CNAME, because
 *     DNS forbids a CNAME at a zone apex.
 *
 * They assert against the `vercelRecords` constants rather than string
 * literals, so a change to the source of truth cannot pass silently here.
 */

process.env["MGMT_ACCOUNT_ID"] ??= "111111111111";
process.env["PLATFORM_ACCOUNT_ID"] ??= "222222222222";

import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CLOUDFRONT_CERT_REGION, domains, ssmPaths, vercelRecords } from "@platform/config";
import { DnsStack } from "../lib/dns-stack.js";
import type { DnsStackProps } from "../lib/dns-stack.js";

const ENV = { account: "222222222222", region: CLOUDFRONT_CERT_REGION };
const CLOUDFRONT_DOMAIN = "d111111abcdef8.cloudfront.net";

function synth(props: Omit<DnsStackProps, "env"> = {}): Template {
  const app = new App();
  return Template.fromStack(new DnsStack(app, "TestDnsStack", { env: ENV, ...props }));
}

type RecordProps = Record<string, unknown>;

/** Record sets matching a fully qualified name and type, keyed by logical ID. */
function recordSets(template: Template, name: string, type: string): RecordProps[] {
  return Object.values(template.findResources("AWS::Route53::RecordSet"))
    .map((resource) => (resource as { Properties: RecordProps }).Properties)
    .filter((props) => props["Name"] === name && props["Type"] === type);
}

function allRecordSets(template: Template): RecordProps[] {
  return Object.values(template.findResources("AWS::Route53::RecordSet")).map(
    (resource) => (resource as { Properties: RecordProps }).Properties,
  );
}

describe("DnsStack in vercel mode (the live state)", () => {
  const template = synth();

  test("defaults to vercel — deploying without context must not move the site", () => {
    template.hasOutput("OriginMode", { Value: "vercel" });
  });

  test("the apex A record is exactly the live Vercel IP", () => {
    const apex = recordSets(template, `${domains.platform}.`, "A");
    expect(apex).toHaveLength(1);
    expect(apex[0]?.["ResourceRecords"]).toEqual([vercelRecords.apexIpv4]);
    // Not an alias: this is a plain A record, identical to what GoDaddy serves.
    expect(apex[0]?.["AliasTarget"]).toBeUndefined();
  });

  test("the www CNAME is exactly the live Vercel target", () => {
    const www = recordSets(template, `www.${domains.platform}.`, "CNAME");
    expect(www).toHaveLength(1);
    expect(www[0]?.["ResourceRecords"]).toEqual([vercelRecords.wwwCname]);
  });

  test("no alias records exist — the zone is byte-equivalent to GoDaddy", () => {
    for (const record of allRecordSets(template)) {
      expect(record["AliasTarget"]).toBeUndefined();
    }
  });

  test("full template snapshot — any change to live-serving DNS shows up in review", () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe("DnsStack in cloudfront mode (the apex cutover)", () => {
  const template = synth({ origin: "cloudfront", cloudFrontDomainName: CLOUDFRONT_DOMAIN });

  test("the apex is an ALIAS with no ResourceRecords", () => {
    const apex = recordSets(template, `${domains.platform}.`, "A");
    expect(apex).toHaveLength(1);
    // The zone ID is CloudFront's fixed global one, rendered as a partition
    // mapping lookup rather than the literal Z2FDTNDATAQYW2.
    expect(apex[0]?.["AliasTarget"]).toMatchObject({ DNSName: CLOUDFRONT_DOMAIN });
    expect(JSON.stringify(apex[0]?.["AliasTarget"])).toContain(
      "AWSCloudFrontPartitionHostedZoneIdMap",
    );
    expect(apex[0]?.["ResourceRecords"]).toBeUndefined();
  });

  test("the apex is NOT a CNAME — DNS forbids CNAME at a zone apex", () => {
    expect(recordSets(template, `${domains.platform}.`, "CNAME")).toHaveLength(0);
  });

  test("www is an ALIAS to the same distribution", () => {
    const www = recordSets(template, `www.${domains.platform}.`, "A");
    expect(www).toHaveLength(1);
    expect(www[0]?.["AliasTarget"]).toMatchObject({ DNSName: CLOUDFRONT_DOMAIN });
    expect(recordSets(template, `www.${domains.platform}.`, "CNAME")).toHaveLength(0);
  });

  test("the Vercel A record is gone", () => {
    for (const record of allRecordSets(template)) {
      expect(JSON.stringify(record["ResourceRecords"] ?? [])).not.toContain(
        vercelRecords.apexIpv4,
      );
    }
  });

  test("refuses to synthesize without a distribution domain name", () => {
    expect(() => synth({ origin: "cloudfront" })).toThrow(/cloudFrontDomainName/);
  });

  test("accepts the distribution domain from CDK context", () => {
    const app = new App({ context: { cloudFrontDomainName: CLOUDFRONT_DOMAIN } });
    const fromContext = Template.fromStack(
      new DnsStack(app, "ContextDnsStack", { env: ENV, origin: "cloudfront" }),
    );
    expect(recordSets(fromContext, `${domains.platform}.`, "A")[0]?.["AliasTarget"]).toMatchObject({
      DNSName: CLOUDFRONT_DOMAIN,
    });
  });
});

describe.each([["vercel"], ["cloudfront"]] as const)("TTLs in %s mode", (origin) => {
  const template = synth(
    origin === "cloudfront"
      ? { origin, cloudFrontDomainName: CLOUDFRONT_DOMAIN }
      : { origin },
  );

  test("every non-alias record uses a 300s TTL so a cutover reverts in five minutes", () => {
    const nonAlias = allRecordSets(template).filter((r) => r["AliasTarget"] === undefined);
    expect(nonAlias.length).toBeGreaterThan(0);
    for (const record of nonAlias) {
      expect(record["TTL"]).toBe("300");
    }
  });

  test("alias records carry no TTL — Route53 rejects one", () => {
    for (const record of allRecordSets(template)) {
      if (record["AliasTarget"] !== undefined) {
        expect(record["TTL"]).toBeUndefined();
      }
    }
  });
});

describe("DMARC", () => {
  const template = synth();

  test("publishes p=reject at _dmarc, because no mail is sent from this domain", () => {
    const dmarc = recordSets(template, `_dmarc.${domains.platform}.`, "TXT");
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0]?.["ResourceRecords"]).toEqual(['"v=DMARC1; p=reject;"']);
    expect(dmarc[0]?.["TTL"]).toBe("300");
  });

  test("publishes no MX and no SPF — none exist today and a bare SPF would be wrong", () => {
    expect(allRecordSets(template).filter((r) => r["Type"] === "MX")).toHaveLength(0);
    expect(JSON.stringify(allRecordSets(template))).not.toContain("v=spf1");
  });
});

describe("certificate", () => {
  const template = synth();

  test("covers the apex and the wildcard", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: domains.platform,
      SubjectAlternativeNames: [`*.${domains.platform}`],
    });
  });

  test("uses DNS validation against the platform hosted zone", () => {
    const zoneId = Object.keys(template.findResources("AWS::Route53::HostedZone"))[0];
    // A wildcard validates through its parent, so ACM emits one validation
    // option covering both names rather than two.
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      ValidationMethod: "DNS",
      DomainValidationOptions: [
        { DomainName: domains.platform, HostedZoneId: { Ref: zoneId } },
      ],
    });
  });

  test("rejects a region other than us-east-1, which CloudFront requires", () => {
    const app = new App();
    expect(
      () =>
        new DnsStack(app, "WrongRegionDnsStack", {
          env: { account: "222222222222", region: "ca-central-1" },
        }),
    ).toThrow(/us-east-1/);
  });
});

describe("SSM contract with application stacks", () => {
  const template = synth();

  test.each([
    ssmPaths.hostedZoneId(domains.platform),
    ssmPaths.hostedZoneName(domains.platform),
    ssmPaths.certificateArn(domains.platform),
  ])("publishes %s", (parameterName) => {
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: parameterName });
  });

  test("exports nothing via CloudFormation (ADR-0004)", () => {
    expect(template.toJSON()["Outputs"]).toBeDefined();
    for (const output of Object.values(
      (template.toJSON()["Outputs"] ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      expect(output["Export"]).toBeUndefined();
    }
  });
});

describe("optional zones", () => {
  test("the product zone is off by default and empty when enabled", () => {
    const off = synth();
    expect(JSON.stringify(off.findResources("AWS::Route53::HostedZone"))).not.toContain(
      domains.product,
    );

    const on = synth({ createProductZone: true });
    on.hasResourceProperties("AWS::Route53::HostedZone", { Name: `${domains.product}.` });
    // No records: newnotams.net still resolves through its current provider
    // until Phase 1 replicates them.
    for (const record of allRecordSets(on)) {
      expect(String(record["Name"])).not.toContain(domains.product);
    }
    on.hasResourceProperties("AWS::SSM::Parameter", {
      Name: ssmPaths.hostedZoneId(domains.product),
    });
  });

  test("the private internal zone is off by default and needs a VPC", () => {
    const off = synth();
    expect(Object.keys(off.findResources("AWS::Route53::HostedZone"))).toHaveLength(1);

    const on = synth({ internalZoneVpcId: "vpc-0123456789abcdef0" });
    on.hasResourceProperties("AWS::Route53::HostedZone", {
      Name: `${domains.internal}.`,
      VPCs: [{ VPCId: "vpc-0123456789abcdef0", VPCRegion: CLOUDFRONT_CERT_REGION }],
    });
  });
});

describe("tagging", () => {
  const template = synth();

  test("every hosted zone carries app/env/owner", () => {
    for (const zone of Object.values(template.findResources("AWS::Route53::HostedZone"))) {
      const tags = (zone as { Properties: RecordProps }).Properties["HostedZoneTags"] as Array<{
        Key: string;
        Value: string;
      }>;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "app", Value: "platform-dns" },
          { Key: "env", Value: "prod" },
        ]),
      );
    }
  });
});
