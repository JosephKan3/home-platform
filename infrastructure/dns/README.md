# @platform/infra-dns

Route53 hosted zones, DNS records and the platform ACM certificate
(Phase 0 action plan §5 Stage D and §8 Stage G, ADR-0006).

**`josephkan.ca` is live.** It serves the personal site from Vercel, with DNS hosted at
GoDaddy. Every design choice in this package exists to make the move to Route53 a no-op at
the moment it happens, and to make the later apex cutover reversible in five minutes.

## The two states

The stack renders one of two zone contents, selected by the `origin` context value:

| `origin` | apex `josephkan.ca` | `www.josephkan.ca` |
| --- | --- | --- |
| `vercel` (default) | `A 76.76.21.21` | `CNAME cname.vercel-dns.com` |
| `cloudfront` | `ALIAS` → distribution | `ALIAS` → same distribution |

`vercel` replicates exactly what GoDaddy serves today. That is what makes the nameserver
switch (D3) a no-op: no resolver sees a change, so the site never goes down.

`cloudfront` is the apex cutover (G1). It must be an **ALIAS**, never a CNAME — DNS forbids
a CNAME at a zone apex because the apex holds SOA and NS records, and CloudFront publishes a
hostname rather than a stable IP.

Everything else in the zone is identical between the two states. The migration of DNS and
the migration of hosting are therefore two independent, independently revertible steps.

## Contents

- Public hosted zone for `josephkan.ca`, with the apex/`www` records above, plus a
  `_dmarc` TXT record of `v=DMARC1; p=reject;`. No mail is sent from this domain, which is
  exactly why it should be unspoofable. **No SPF and no MX** — neither exists today, and
  publishing either without a mail provider behind it would be worse than publishing nothing.
- ACM certificate for `josephkan.ca` + `*.josephkan.ca`, DNS-validated against the zone.
  Must live in `us-east-1`; the stack refuses to synthesize anywhere else.
- Public hosted zone for `newnotams.net`, **off by default** (`-c createProductZone=true`),
  created with no records. Phase 1 replicates its records and delegates, same order as
  Stage D here.
- Private hosted zone for `internal.josephkan.ca`, **off by default**. See below.
- SSM parameters that are the contract with application stacks.

### TTLs are 300s deliberately

Every non-alias record uses `Duration.minutes(5)`. This is not a default, it is the property
that makes the apex cutover reversible in five minutes without touching nameservers. Do not
raise it. ALIAS records carry no TTL — Route53 takes it from the target and rejects one.

### SSM, not CloudFormation exports

The stack publishes:

```
/platform/dns/josephkan.ca/hosted-zone-id
/platform/dns/josephkan.ca/hosted-zone-name
/platform/acm/josephkan.ca/certificate-arn
```

Application stacks read these with `StringParameter.valueFromLookup`. Per ADR-0004 there is
no CloudFormation export across the platform/application seam: an export makes the exporting
stack undeletable and forces lockstep deploys.

The reverse direction — this stack needing the CloudFront distribution domain, which is owned
by `applications/personal-site` — is handled by passing the value in as **CDK context**, not
by an SSM lookup. Both avoid the export; the difference is that a lookup resolves against
live AWS at synth time and caches into `cdk.context.json`, so the rendered template would
depend on ambient credentials and cache freshness. For the single highest-risk record change
in Phase 0, the value should instead be visible in the diff of the commit that performs the
cutover, and identical whether synthesized in CI, locally, or with no credentials at all.

### The private zone is deferred to Phase 1

`internal.josephkan.ca` needs a VPC to associate with, and **there is no VPC until Phase 1**
(Phase 0 explicitly has no VPC). It is created only when a VPC ID is supplied:

```powershell
npx cdk deploy DnsStack -c internalZoneVpcId=vpc-xxxxxxxx --profile platform
```

**Tailscale Split DNS is required and is the most common failure mode of this setup.**
Tailscale clients are not inside the VPC, so they do not use the VPC resolver and will fail
to resolve `*.internal.josephkan.ca` even when everything on the AWS side is correct. Two
things are needed:

1. The subnet router advertises `10.20.0.0/16`.
2. Tailscale **Split DNS** sends `internal.josephkan.ca` to the VPC resolver at **`10.20.0.2`**
   (VPC CIDR base + 2).

Without step 2 the zone looks broken from a laptop and the AWS configuration is not at fault.

---

# Operational runbook

## Stage D — DNS delegation

> ### Warning
>
> **D3 must not happen before D2 passes.** Switching nameservers at GoDaddy before verifying
> that Route53 serves the identical Vercel records takes the live site down immediately, and
> the fix then waits on registry propagation rather than on a 300s TTL. If D2 returns
> anything other than the Vercel values, stop.

### D1 — Create and replicate

Deploy with the default `origin=vercel`. The zone is created holding records identical to
GoDaddy's.

```powershell
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"
npx cdk deploy DnsStack --profile platform
```

Record the outputs `PlatformZoneId` and `PlatformZoneNameServers`.

Prerequisite from action plan §1: the existing GoDaddy records should already have been
lowered to a 300s TTL, and the old TTL should have expired.

### D2 — Verify against the Route53 nameservers, before delegating

```powershell
$ns = (aws route53 get-hosted-zone --id <ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers

Resolve-DnsName josephkan.ca        -Server $ns[0]
Resolve-DnsName www.josephkan.ca    -Server $ns[0]
Resolve-DnsName _dmarc.josephkan.ca -Type TXT -Server $ns[0]
```

Expected:

- `josephkan.ca` → `A 76.76.21.21`
- `www.josephkan.ca` → `CNAME cname.vercel-dns.com`
- `_dmarc.josephkan.ca` → `TXT "v=DMARC1; p=reject;"`

Compare against what GoDaddy currently serves, to be certain they match:

```powershell
Resolve-DnsName josephkan.ca     -Server ns73.domaincontrol.com
Resolve-DnsName www.josephkan.ca -Server ns73.domaincontrol.com
```

If the two do not agree on the apex A record and the `www` CNAME, **stop.** Fix
`vercelRecords` in `@platform/config` and redeploy before going further.

### D3 — Switch nameservers at GoDaddy

Only once D2 passes. Replace GoDaddy's nameservers with the four Route53 ones from D1.

This is a no-op: zone contents are identical, so no resolver observes a change.

While in GoDaddy, **confirm auto-renew and transfer lock are ON.** A lapsed registration
takes down both the platform and the product.

### D4 — Wait and verify

`.ca` registry propagation takes 24–48h.

```powershell
Resolve-DnsName josephkan.ca -Type NS
# must return awsdns servers, not domaincontrol.com

Resolve-DnsName josephkan.ca
Resolve-DnsName www.josephkan.ca
# still the Vercel values — nothing has moved yet
```

Check from a second network (phone on cellular) before considering it done.

### D5 — Certificate

The ACM certificate is already in this stack and validates automatically once Route53 holds
the zone. Confirm it reached `ISSUED`:

```powershell
aws acm list-certificates --region us-east-1 --profile platform
aws ssm get-parameter --name /platform/acm/josephkan.ca/certificate-arn --profile platform
```

A certificate stuck in `PENDING_VALIDATION` after D4 means delegation has not fully taken
effect. Wait, do not intervene manually.

## Stage G — The apex cutover

Do not start until the site has been verified end to end on the CloudFront domain
(`dxxxx.cloudfront.net`), including the charts (action plan §7 F4).

### G1 — Flip it

This is one context change:

```powershell
npx cdk deploy DnsStack --profile platform `
  -c origin=cloudfront `
  -c cloudFrontDomainName=dxxxx.cloudfront.net
```

Review the `cdk diff` first. It should show exactly: the apex `A` record replaced by an ALIAS,
and the `www` `CNAME` replaced by an ALIAS. Nothing else should move.

For a permanent flip, change `"origin": "vercel"` to `"origin": "cloudfront"` in `cdk.json`
and add `"cloudFrontDomainName"` next to it, so CI deploys the cut-over state by default.

### G2 — Verify

```powershell
Resolve-DnsName josephkan.ca
Resolve-DnsName www.josephkan.ca
curl.exe -I https://josephkan.ca
curl.exe -I https://www.josephkan.ca
```

Check the certificate, the security headers, and the charts in a real browser.

**Remove the Vercel project only after 24h of clean operation** — not before. It is the
fallback for the rollback below.

## Rollback

Redeploy with `origin` back at `vercel`:

```powershell
npx cdk deploy DnsStack --profile platform -c origin=vercel
```

Or revert the `cdk.json` change and let CI redeploy.

- **Nameservers are not touched.** Route53 keeps serving the zone; only two records change.
- TTL is 300s, so resolvers pick up the old Vercel values within **five minutes**.
- Vercel must still be serving for this to work, which is why G2 defers decommissioning.

This is the entire reason D3 and G1 are separate events: a problem with the AWS deployment
is a five-minute record change, not a 24–48h registry propagation.

## Local commands

```powershell
pnpm --filter @platform/infra-dns build
pnpm --filter @platform/infra-dns test
pnpm --filter @platform/infra-dns synth
```

Tests need no AWS credentials. `synth` needs `PLATFORM_ACCOUNT_ID` set.

The `vercel`-mode snapshot test is deliberate: any change to records that are serving live
traffic shows up as a snapshot diff in review rather than as a surprise at deploy time.
