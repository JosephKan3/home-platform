/**
 * Domain topology (ADR-0006).
 *
 * Both domains are already owned. Registrations stay at their current
 * registrars; only DNS hosting moves to Route53, because apex-on-CloudFront
 * requires Route53 ALIAS records (DNS forbids a CNAME at a zone apex).
 */

export const domains = {
  /** Platform + personal. Apex serves the personal site. */
  platform: "josephkan.ca",
  /** The product. Separate identity so it can be spun out cleanly. */
  product: "newnotams.net",
  /** Private hosted zone — Tailscale-only, returns NXDOMAIN publicly. */
  internal: "internal.josephkan.ca",
} as const;

/** Records that exist today at GoDaddy, replicated into Route53 before delegating. */
export const vercelRecords = {
  apexIpv4: "76.76.21.21",
  wwwCname: "cname.vercel-dns.com",
} as const;

/**
 * There is deliberately no `newnotamsVercelRecords` constant.
 *
 * An earlier attempt added one, holding a 2-IP snapshot per record, on the
 * assumption `newnotams.net` could be replicated the way `josephkan.ca` was.
 * It could not: `vercel dns ls newnotams.net` shows its real zone contents
 * are `ALIAS` records to Vercel hostnames, not A records, and every IP
 * visible by querying a resolver is Vercel flattening those ALIASes at
 * request time — a rotating pool, not a stable value. Replicating it was
 * deployed, found wrong, and rolled back (Phase 1 action plan §4).
 *
 * The migration writes no pre-cutover apex/`www` records at all. Nothing
 * queries the Route53 zone until the nameserver switch, and the records
 * written at that point target CloudFront, never Vercel. See `DnsStack`'s
 * `addProductPreCutoverRecords`.
 */

/**
 * SSM parameter paths are the contract between platform and application
 * stacks (ADR-0004). Applications read these via StringParameter.valueFromLookup.
 *
 * Never use CloudFormation cross-stack exports across this seam: an export
 * makes the exporting stack undeletable and forces lockstep deploys.
 */
export const ssmPaths = {
  hostedZoneId: (domain: string) => `/platform/dns/${domain}/hosted-zone-id`,
  hostedZoneName: (domain: string) => `/platform/dns/${domain}/hosted-zone-name`,
  certificateArn: (domain: string) => `/platform/acm/${domain}/certificate-arn`,
  vpcId: (env: string) => `/platform/${env}/vpc/id`,
} as const;
