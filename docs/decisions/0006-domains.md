# ADR-0006: Domain strategy

- Status: Proposed
- Date: 2026-08-05

## Context

The platform needs DNS before almost anything else — ACM certificate validation, CloudFront
distributions, ALB records, and the `internal.*` private zone all depend on it. Phase 0 is
blocked on this.

Two domains already exist in the picture:

- **`newnotams.net`** — the NOTAM/weather briefing product, currently on Vercel.
- A personal site with no domain identified yet.

## Decision

**Two domains, different jobs, both DNS-hosted in Route53 in the Platform account.**

| Domain | Role | Registrar |
| --- | --- | --- |
| `<yourname>.com` | Platform + personal. Portfolio site, all internal subdomains, platform APIs. | Route53 |
| `newnotams.net` | Product. Nothing platform-related. | Wherever it is now; NS delegated to Route53 |

Keeping the product domain separate from the platform domain is the correct boundary and
matches ADR-0004: applications own their own identity. If NewNotams is ever sold, spun out,
or handed off, the domain goes with it and nothing platform-related is entangled.

### Namespace layout

```
yourname.com                    portfolio site (CloudFront + S3)
├── api.yourname.com            platform API (Phase 3)
├── auth.yourname.com           Authentik (Phase 2, Tailscale-only)
└── internal.yourname.com       PRIVATE hosted zone — resolves only over Tailscale
    ├── grafana.internal.…
    ├── argocd.internal.…       (n/a — no Kubernetes)
    └── db.internal.…

newnotams.net                   the product
├── www.newnotams.net
└── staging.newnotams.net       (dev environment, ADR-0001 tag-scoped)
```

Note the `internal.` zone is a **private hosted zone** attached to the VPC. It resolves only
from inside the VPC or over the Tailscale subnet router — there is no public record for any
internal service, which is stronger than relying on a security group alone.

### TLD choice for the platform domain

**`.com`.** Reasoning:

- Universally trusted, no deliverability penalty, no registry surprises.
- If this ever becomes a startup, `.com` is the only TLD nobody questions.
- $14/yr at Route53. The alternatives save $3/yr and cost credibility.

Rejected:

- **`.dev` / `.app`** — HSTS-preloaded (forced HTTPS) which is genuinely nice, and fine for
  a developer portfolio. Rejected only because the "startup foundation" goal favors `.com`.
  A reasonable second choice.
- **`.io`** — expensive (~$40/yr) and the ccTLD's long-term status is politically uncertain.
- **`.xyz`, `.top`, `.tk`, and other cheap TLDs** — measurable spam reputation, which shows
  up as email deliverability problems and occasional corporate-firewall blocks.

Pick something short, unambiguous when spoken aloud, and free of hyphens or number/letter
homographs. Your own name is the safest choice for something that has to serve as both a
portfolio and a company for an unknown number of years.

### Registrar: Route53

Register the platform domain directly in Route53.

- $14/yr for `.com`. Not the cheapest, but within a few dollars of anyone.
- WHOIS privacy is **free and on by default**.
- Auto-renew and transfer lock on by default.
- The hosted zone is created automatically and lives in the same account as everything else,
  so ACM DNS validation, CloudFront alias records, and the private zone all work with no
  cross-account role or third-party API token.

Registration is **not** available as a CloudFormation resource, so it is a one-time manual
step. It belongs in the Phase 0 bootstrap list alongside the Organization — the small,
documented set of things done by hand exactly once.

**Cloudflare Registrar was considered** — it sells at wholesale (~$10.44/yr for `.com`, no
markup ever) which is genuinely the best price available. Rejected because it requires the
domain to use Cloudflare nameservers, which conflicts with Route53-hosted DNS and would add
a second control plane and an API token to manage for a $4/yr saving.

### `newnotams.net`: delegate, don't transfer

Leave it registered wherever it is. Create the hosted zone in Route53 and point the
registrar's nameservers at it. This decouples DNS control from registrar migration and
avoids the 60-day transfer lock. Transfer later if consolidating billing is worth it.

### Email

Not required by the platform, but a `@yourname.com` address is worth having on a résumé.

- **Receiving:** the cheapest credible option is a forwarding service (ImprovMX free tier,
  or SES → S3 → Lambda if you want it self-built). Google Workspace at $7/user/mo is real
  money for one mailbox.
- **Sending:** Amazon SES, $0.10 per 1,000 emails. Requires DKIM records and moving out of
  the sandbox.
- **Whatever you choose, publish SPF, DKIM, and DMARC records.** A domain with no DMARC
  record can be spoofed freely, and the records cost nothing.

Defer to Phase 1. Do not let it block Phase 0.

## Consequences

- Domain registration is a manual Phase 0 step. Everything downstream — hosted zone records,
  ACM certificates, CloudFront aliases — is CDK-managed.
- Two public hosted zones at $0.50/mo each, plus one private zone at $0.50/mo. ~$1.50/mo total.
- ACM certificates must be requested in `us-east-1` for CloudFront regardless of the
  platform's primary region. CDK's `DnsValidatedCertificate` handles the cross-region case.
- The private zone means internal service names do not resolve publicly, so no internal
  hostname is discoverable via certificate transparency logs or DNS enumeration.
