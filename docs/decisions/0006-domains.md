# ADR-0006: Domain strategy — `josephkan.ca` as the platform domain

- Status: Accepted
- Date: 2026-08-05
- Revises: earlier draft recommending registering a new `.com`

## Context

The platform needs DNS before almost anything else — ACM certificate validation, CloudFront
distributions, and the `internal.*` private zone all depend on it. Phase 0 was blocked on it.

Two domains already exist:

| Domain | Registrar | Current state |
| --- | --- | --- |
| `josephkan.ca` | GoDaddy (`ns73/74.domaincontrol.com`) | Apex A → `76.76.21.21` (Vercel), `www` CNAME → `cname.vercel-dns.com`. No MX, no TXT. |
| `newnotams.net` | (separate) | Vercel |

An earlier draft of this ADR recommended registering a new `.com` for the platform. That was
written without knowing `josephkan.ca` existed.

## Decision

**Use `josephkan.ca` as the platform domain.** The apex continues to serve the personal
site; platform services live on subdomains. Do not register anything new.

```
josephkan.ca                     personal site        (CloudFront + S3)
├── www.josephkan.ca             redirect → apex
├── api.josephkan.ca             Platform API         (Phase 3)
├── status.josephkan.ca          public status page   (optional)
└── internal.josephkan.ca        PRIVATE hosted zone — Tailscale-only, no public records
    ├── grafana.internal.josephkan.ca
    ├── auth.internal.josephkan.ca
    └── db.internal.josephkan.ca

newnotams.net                    the product — unchanged, separate identity
├── www.newnotams.net
└── staging.newnotams.net
```

### Why this is better than registering a new `.com`

- **It's already owned.** $0 and zero delay. The only Phase 0 blocker disappears.
- **`.ca` has no downside here.** CIRA is a reputable registry with no spam reputation
  problem, so email deliverability and corporate firewall behaviour are unaffected. It is
  not a discount TLD.
- **It's accurate.** Canadian developer, Canadian aviation product consuming a Nav Canada
  API. A `.ca` is a signal, not a compromise.
- **The `.com` argument was weak.** That reasoning was "if this becomes a startup, `.com`
  matters" — but a startup would get its **own** domain regardless. A company named after
  your personal domain is odd. Personal identity and company identity are correctly
  separate concerns, and conflating them was the actual error in the earlier draft.

`josephkan.com` as a defensive registration is optional, ~$14/yr, and purely about typo
traffic. Not a blocker and not recommended for now.

### Registrar: leave it at GoDaddy. Delegate DNS to Route53.

Registration and DNS hosting are separable, and only DNS hosting matters architecturally.

- **Do not transfer the registration.** Transfers incur a 60-day lock and gain nothing.
  `.ca` transfers additionally involve CIRA-specific rules and Canadian Presence
  Requirements paperwork. Pure friction.
- **Do delegate the nameservers to Route53.** This is required, not optional — see below.

### Why delegation is mandatory, not a preference

The apex `josephkan.ca` must point at a CloudFront distribution. CloudFront gives you a
hostname (`dxxxx.cloudfront.net`), not a stable IP, and **DNS forbids a CNAME at a zone
apex** because the apex must hold SOA and NS records.

Route53 solves this with **ALIAS records** — a proprietary record type that resolves to
CloudFront's addresses at query time and is free to query. GoDaddy has no equivalent that
works reliably for this.

So: apex-on-CloudFront requires Route53-hosted DNS. Everything else — ACM DNS validation
without manual record copying, the private hosted zone, CDK-managed records — follows from
the same delegation.

Cost: $0.50/mo per public hosted zone.

## Migration sequence (this is the part that can break the live site)

The personal site is live on Vercel right now. Delegating nameservers without preparation
takes it down.

**Step 1 — Replicate before delegating.** Create the `josephkan.ca` public hosted zone in
Route53 and populate it with the *existing* Vercel records first:

```
josephkan.ca        A       76.76.21.21
www.josephkan.ca    CNAME   cname.vercel-dns.com
```

**Step 2 — Verify against the Route53 nameservers directly**, before any delegation:

```powershell
Resolve-DnsName josephkan.ca -Server <ns-xxx.awsdns-xx.com>
```

**Step 3 — Lower TTLs** on the existing GoDaddy records to 300s and wait for the old TTL to
expire. This shortens the rollback window if anything goes wrong later.

**Step 4 — Change the nameservers at GoDaddy** to the four Route53 NS records. Delegation
is a **no-op** at this point because the zone contents are identical — the site never goes
down. Registry-level NS changes for `.ca` can take 24-48h to propagate fully.

**Step 5 — Wait and verify** the delegation has taken effect everywhere before proceeding.

**Step 6 — Cut the apex over to CloudFront** by replacing the A record with an ALIAS, once
the AWS deployment is actually serving correctly. This is now a single, reversible record
change with a 300s TTL, entirely inside CDK.

The value of this sequence: **DNS migration and hosting migration become two independent
steps.** If the AWS deployment has a problem, step 6 reverts in five minutes without
touching nameservers.

### `newnotams.net`

Same treatment, same reasoning, in Phase 1: replicate records → delegate NS → cut over. Its
identity stays separate from the platform domain so it can be spun out cleanly (ADR-0004).

## The private zone and Tailscale

`internal.josephkan.ca` is a **private hosted zone** attached to the VPC. There is no public
NS delegation for it, so it returns NXDOMAIN publicly and no internal hostname is
discoverable via DNS enumeration or certificate transparency logs. Stronger than relying on
a security group alone.

**Non-obvious detail:** Tailscale clients are not inside the VPC, so they do not use the VPC
resolver by default and will fail to resolve `*.internal.josephkan.ca`. Two things are
required:

1. The subnet router advertises `10.20.0.0/16` (already planned).
2. **Tailscale Split DNS** is configured to send `internal.josephkan.ca` to the VPC resolver
   at `10.20.0.2` (the VPC CIDR base + 2).

Without step 2 the private zone appears broken from a laptop even though everything is
configured correctly on the AWS side. This is the most common failure mode of this setup.

## Certificates

- **`us-east-1` ACM cert** for CloudFront — required regardless of the platform's primary
  region. Cover `josephkan.ca` and `*.josephkan.ca`.
- **Primary-region ACM cert** for any future ALB.
- DNS validation, automated by CDK, since Route53 now holds the zone.
- Internal services get certificates from the same public ACM cert where they terminate at
  an AWS-managed endpoint. A private CA is not needed and **ACM Private CA at $400/mo is
  never justified here**.

## Email

No MX or TXT records currently exist, so nothing is at risk during migration.

A `@josephkan.ca` address is worth having on a résumé. Deferred to Phase 1 — do not let it
block Phase 0.

- **Receiving:** a forwarding service (ImprovMX free tier) or SES → S3 → Lambda if you want
  to build it. Google Workspace at $7/user/mo is real money for one mailbox.
- **Sending:** SES at $0.10 per 1,000 emails, after DKIM setup and sandbox removal.
- **Regardless of choice, publish SPF, DKIM, and DMARC.** A domain with no DMARC record can
  be spoofed freely, and the records cost nothing. Worth adding a `v=DMARC1; p=reject;`
  record even while no mail is sent, precisely because no mail is sent.

## Consequences

- **Phase 0 is unblocked.** The last open blocker in the design is resolved.
- Registration stays at GoDaddy and remains a manual, out-of-band concern. Confirm auto-renew
  and transfer lock are on; a lapsed registration takes down the platform and the product.
- Two public hosted zones ($0.50/mo each) + one private zone ($0.50/mo) = **~$1.50/mo**.
- Personal site and platform share a zone, so a bad hosted-zone change affects both.
  Mitigated by keeping every record in CDK, where changes are diffed and reviewed.
- The apex cutover in step 6 is the single highest-risk moment in Phase 0. It is deliberately
  isolated to one record change with a short TTL.
