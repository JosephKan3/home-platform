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
 * `newnotams.net`'s current records at Vercel's own nameservers
 * (`ns1/ns2.vercel-dns.com`), read directly against them — not the same
 * shape as `vercelRecords` above. The registrar is NameCheap, not GoDaddy
 * (Phase 1 action plan §0); only the DNS *hosting* is at Vercel. Both apex
 * and `www` are dual-IP `A` records here, not a single IP plus a `www`
 * CNAME the way `josephkan.ca` was.
 */
export const newnotamsVercelRecords = {
  apexIpv4: ["64.29.17.1", "64.29.17.65"],
  wwwIpv4: ["64.29.17.1", "216.198.79.65"],
} as const;

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
