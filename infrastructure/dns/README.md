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
- Public hosted zone for `newnotams.net`, **off by default** (`-c createProductZone=true`).
  Once on, populated the same way as the platform zone above, gated by its own `productOrigin`
  context value (defaults to `vercel`) and its own ACM certificate — the two domains cut over
  independently (ADR-0006: "separate identity so it can be spun out cleanly"). `vercel` mode
  replicates `newnotams.net`'s real current records, read directly against
  `ns1/ns2.vercel-dns.com` (Phase 1 action plan §0) — dual-IP `A` records for both apex and
  `www`, not the single-IP-plus-CNAME shape `josephkan.ca` used. `cloudfront` mode needs
  `-c productCloudFrontDomainName=dxxxx.cloudfront.net` (`NewNotamsStack`'s distribution).
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

`PLATFORM_ACCOUNT_ID` must be in the session; it lives in `.env.local` (gitignored).

```powershell
npx cdk deploy DnsStack --profile platform
```

Record the outputs `PlatformZoneId` and `PlatformZoneNameServers`.

No TTL preparation at GoDaddy is required first. Because Route53 and GoDaddy serve
byte-identical answers at this point, no cached record is invalidated by the delegation —
there is nothing to propagate. The 300s TTL that makes the later apex cutover reversible is
set by this stack on the records it creates.

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

> **Known failure mode: `www` fails with `RRSet of type A ... is not permitted because a
> conflicting RRSet of type CNAME with the same DNS name already exists`.** Route53 forbids a
> CNAME and an A/ALIAS coexisting at the same name even momentarily, but CloudFormation's
> default replacement is create-before-delete — it tries to create `WwwCloudFrontRecord`
> while `WwwVercelRecord` (the old CNAME) still exists. This bit the very first live cutover
> run. The apex has no such conflict (A replaced by A/ALIAS) and creates fine; only `www`
> (CNAME replaced by ALIAS) hits it. A failed `www` creation triggers an automatic rollback
> of the whole changeset — including the apex, which had already succeeded — but the
> rollback's own attempt to recreate the Vercel apex record can itself fail silently, leaving
> **CloudFormation's tracked state permanently wrong about what the apex record actually is**.
> `aws cloudformation detect-stack-drift` will not catch this: Route53 RecordSets are not a
> drift-detectable resource type, so it reports `IN_SYNC` regardless. `cdk diff -c
> origin=vercel` will also lie, reporting no differences against a live record that is
> actually still on CloudFront. The only reliable check is
> `aws route53 list-resource-record-sets --hosted-zone-id <id>` against the real zone.
>
> **Fix, if this happens:** delete the conflicting `www` CNAME by hand first, then redeploy
> immediately:
> ```powershell
> @'
> {"Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"www.<domain>.","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"cname.vercel-dns.com"}]}}]}
> '@ | Out-File delete-www-cname.json -Encoding ascii -NoNewline
> aws route53 change-resource-record-sets --hosted-zone-id <id> --change-batch file://delete-www-cname.json --profile platform
> npx cdk deploy DnsStack --profile platform -c origin=cloudfront -c cloudFrontDomainName=<domain>
> ```
> `www` is unresolvable for the few seconds between the manual delete and the following
> deploy's `CREATE_COMPLETE` — not the multi-minute TTL-driven outage a naive DNS change
> would cause. Confirm the fix against the authoritative nameservers directly
> (`Resolve-DnsName www.<domain> -Server <one of the zone's own NS>`), since local DNS caching
> from the failed attempts can show a stale answer for a few minutes otherwise.

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

---

# Operational runbook — `newnotams.net` (Phase 1 action plan §4, Stage D)

> **This section describes the ORIGINAL plan. It was attempted 2026-10-08, found wrong, and
> rolled back before touching NameCheap.** `newnotams.net` turned out to have no fixed A
> records to replicate — it is delegated to Vercel's own nameservers, which serve it from a
> rotating anycast pool, not a stable value. The `vercel`/`cloudfront` two-state model this
> section (and `DnsStack`'s `productOrigin` prop) assumes does not fit this domain's real
> shape. **Do not follow D1 below as written until Phase 1 action plan §4's "before retrying
> D1" decisions are made** — see that section for the full finding, including the CAA records
> that independently block ACM validation and the apex-redirects-to-`www` behavior this
> design does not account for.

Same mechanism as Stage D/G above, same reasons, different domain. Differences worth stating
up front, not rediscovering mid-migration:

- **Registrar is NameCheap, not GoDaddy.** DNS hosting today is at Vercel's own nameservers
  (`ns1/ns2.vercel-dns.com`), not a registrar default resolver — confirmed via `vercel domains
  ls` (`Registrar: Third Party`) and WHOIS (`clientTransferProhibited` already set).
- **Both records are already type `A`**, not a CNAME — `www.newnotams.net` is a dual-IP `A`
  record, unlike `josephkan.ca`'s `www`, which was a CNAME. The CNAME/A coexistence failure
  documented above for G1 (`RRSet of type A ... conflicting RRSet of type CNAME`) applies only
  to a CNAME-to-ALIAS transition. An A-to-ALIAS transition has no such conflict. This has not
  been operationally re-verified — it is a reading of Route53's documented constraint, the
  same confidence level the original G1 incident should have had and didn't.
- **Context values are `productOrigin`/`productCloudFrontDomainName`**, not
  `origin`/`cloudFrontDomainName` — the two domains cut over independently, on separate
  schedules, and sharing one context value would couple them.

### D1 (product) — Create and replicate

```powershell
npx cdk deploy DnsStack --profile platform -c createProductZone=true
```

Defaults to `productOrigin=vercel`: the zone is created holding records identical to Vercel's.
Record the outputs `ProductZoneId` and `ProductZoneNameServers`.

### D2 (product) — Verify against Route53, before delegating

```powershell
$ns = (aws route53 get-hosted-zone --id <PRODUCT_ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers

Resolve-DnsName newnotams.net     -Server $ns[0]
Resolve-DnsName www.newnotams.net -Server $ns[0]
```

Expected: both return the two IPs in `newnotamsVercelRecords` (`@platform/config`) — currently
`64.29.17.1`/`64.29.17.65` for the apex, `64.29.17.1`/`216.198.79.65` for `www`. Compare
against what Vercel currently serves:

```powershell
Resolve-DnsName newnotams.net     -Server ns1.vercel-dns.com
Resolve-DnsName www.newnotams.net -Server ns1.vercel-dns.com
```

If they disagree, **stop.** Fix `newnotamsVercelRecords` and redeploy before going further.

### D3 (product) — Switch nameservers at NameCheap

Only once D2 passes. Replace `ns1/ns2.vercel-dns.com` with the four Route53 nameservers from
D1. No-op: zone contents are identical.

While in the NameCheap dashboard, confirm **auto-renew is on** and that
`clientTransferProhibited` (already set, per WHOIS) survives the nameserver change.

### D4 (product) — Wait and verify

`.net` is a gTLD; propagation is typically faster than `.ca`'s 24–48h, but verify rather than
assume (Phase 1 action plan §0 flags this explicitly as unconfirmed timing).

```powershell
Resolve-DnsName newnotams.net -Type NS
# must return awsdns servers, not vercel-dns.com

Resolve-DnsName newnotams.net
Resolve-DnsName www.newnotams.net
# still the Vercel values — nothing has moved yet
```

### D5 (product) — Certificate, then the apex cutover

The ACM certificate is already in this stack (created alongside the zone when
`createProductZone=true`) and validates automatically once Route53 holds the zone:

```powershell
aws ssm get-parameter --name /platform/acm/newnotams.net/certificate-arn --profile platform
```

Once `ISSUED` and `NewNotamsStack`'s distribution is deployed and verified independently on
its own `dxxxx.cloudfront.net` URL (sign-in, saved searches, push notifications — not just a
200 on `/`), cut over:

```powershell
npx cdk deploy DnsStack --profile platform `
  -c createProductZone=true `
  -c productOrigin=cloudfront `
  -c productCloudFrontDomainName=dxxxx.cloudfront.net
```

Review the `cdk diff` first — it should show exactly two records changing, both A-to-ALIAS,
nothing else. Given both are already type `A` (not a CNAME), the known G1 failure mode above
should not reproduce here, but confirm the diff rather than assume it.

**Remove the Vercel project only after a full real hourly notify cycle has been observed
succeeding in production on AWS** (Phase 1 action plan Stage G) — stricter than the personal
site's 24h-clean-operation bar, since this app has a real cron job with real users receiving
push notifications, not just a static page.

---

## Local commands

```powershell
pnpm --filter @platform/infra-dns build
pnpm --filter @platform/infra-dns test
pnpm --filter @platform/infra-dns synth
```

Tests need no AWS credentials. `synth` needs `PLATFORM_ACCOUNT_ID` set.

The `vercel`-mode snapshot test is deliberate: any change to records that are serving live
traffic shows up as a snapshot diff in review rather than as a surprise at deploy time.
