# DNS rollback

`josephkan.ca` is broken. Getting it back.

The full DNS procedure — Stage D delegation, Stage G cutover, verification at each step — is in
[`infrastructure/dns/README.md`](../../infrastructure/dns/README.md). This document is only the
emergency path.

**The one thing to know:** the apex cutover is reversible in **about five minutes** by changing
one context value and redeploying. Records carry a 300s TTL and the nameservers are not
touched. You almost never need to go anywhere near GoDaddy.

---

## Symptom → decision

| What you observe | Cause | Action |
| --- | --- | --- |
| Site 404s, wrong page, TLS error, or charts broken — and `Resolve-DnsName josephkan.ca` returns CloudFront | The apex cutover (Stage G1) went wrong | [Roll the apex back](#roll-the-apex-back) — 5 minutes |
| `Resolve-DnsName josephkan.ca` returns `76.76.21.21` and the site is still broken | Not DNS. Vercel or the app. | Stop here. This runbook does not apply. |
| `Resolve-DnsName josephkan.ca` returns NXDOMAIN or nothing anywhere | Delegation is broken — Route53 is authoritative but the zone is wrong or gone | [Fix forward in Route53](#fix-forward-in-route53) |
| `Resolve-DnsName josephkan.ca -Type NS` returns `awsdns` but Route53 has no zone for it | The hosted zone was deleted while GoDaddy still points at it | [Fix forward in Route53](#fix-forward-in-route53) — recreate the zone. Nameservers will differ; see the note there. |
| Delegation was switched before the records were replicated (D3 before D2) | The site went down at the moment of delegation | [Fix forward in Route53](#fix-forward-in-route53) first. Reverting NS is the slow option. |
| Everything AWS looks right, and it has been under 48h since the nameserver change | `.ca` registry propagation, still in flight | Wait. Verify against the Route53 nameservers directly (below) to confirm AWS is correct. |

Default to fixing forward in Route53. Reverting nameservers at GoDaddy trades a five-minute fix
for a 24-48 hour one.

---

## Roll the apex back

The cutover is one context value. So is the rollback.

```powershell
cd infrastructure/dns
$env:PLATFORM_ACCOUNT_ID = "<platform account id>"

npx cdk deploy DnsStack --profile platform -c origin=vercel
```

If `cdk.json` was edited to make the cutover permanent (`"origin": "cloudfront"`), the `-c`
flag above still overrides it for this deploy. Revert the `cdk.json` change and land it
afterwards, or the next CI deploy re-applies the cutover.

**Requires an SSO session.** If `aws sso login --profile platform` is needed, see
[`break-glass.md`](break-glass.md). Doing this through CI is fine if CI works — revert the
commit that flipped `origin` and let the pipeline run — but the command above is faster and
this is an outage.

### Why this is safe

- **Nameservers are not touched.** Route53 stays authoritative for the zone. Only two records
  change: the apex `A` and the `www` record.
- **TTL is 300s** on every non-alias record in this zone, deliberately, and it is the entire
  reason Stage D3 (delegation) and Stage G1 (cutover) are separate events. Resolvers pick up
  the Vercel values within five minutes.
- **Vercel must still be serving.** This is why `infrastructure/dns/README.md` says not to
  remove the Vercel project until 24h of clean operation. If it is already gone, this rollback
  does nothing useful — stand the site back up on Vercel first, or fix forward on CloudFront.

### Verify

```powershell
# Against the Route53 nameservers directly — no resolver caching in the way.
$ns = (aws route53 get-hosted-zone --id <ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers
Resolve-DnsName josephkan.ca     -Server $ns[0]
Resolve-DnsName www.josephkan.ca -Server $ns[0]
```

Expected immediately:

- `josephkan.ca` → `A 76.76.21.21`
- `www.josephkan.ca` → `CNAME cname.vercel-dns.com`

If those are right, AWS is correct and anything still wrong is a cached answer. Then check what
the public actually sees:

```powershell
# Your resolver, then a public one that has no cache of yours
Resolve-DnsName josephkan.ca
Resolve-DnsName josephkan.ca -Server 1.1.1.1
Resolve-DnsName josephkan.ca -Server 8.8.8.8

curl.exe -I https://josephkan.ca
curl.exe -I https://www.josephkan.ca
```

Within five minutes all three resolvers should agree on `76.76.21.21` and `curl` should return
`200` from Vercel. Check from a second network — a phone on cellular — before calling it fixed;
a local resolver holding a stale answer is not the same as the internet holding one.

If a resolver still returns the CloudFront answer after five minutes, it is that resolver's
cache, not Route53. Flush locally with `Clear-DnsClientCache`.

---

## Fix forward in Route53

For everything that is not an apex cutover gone wrong. This is almost always faster than
touching the registrar.

Confirm what the zone actually contains:

```powershell
aws route53 list-hosted-zones --profile platform
aws route53 list-resource-record-sets --hosted-zone-id <ZONE_ID> --profile platform `
  --query "ResourceRecordSets[].[Name,Type,TTL,ResourceRecords[0].Value,AliasTarget.DNSName]" `
  --output table
```

Then compare against what GoDaddy served before the migration, which is what
`vercelRecords` in `packages/config/src/domains.ts` encodes:

```
josephkan.ca      A      76.76.21.21
www.josephkan.ca  CNAME  cname.vercel-dns.com
```

If the zone is wrong, `cdk deploy DnsStack -c origin=vercel` restores it — the records are
declarative and the stack owns them. If the zone is **missing entirely**, redeploying recreates
it, but Route53 assigns a **new delegation set**: the four nameservers will differ from the
ones currently configured at GoDaddy, and the domain stays down until they are updated there
and propagate. That is the one failure mode in this runbook with no fast path. It is also why
[`teardown-phase-0.md`](teardown-phase-0.md) recommends keeping the hosted zone.

Recover the current nameservers to compare:

```powershell
(aws route53 get-hosted-zone --id <ZONE_ID> --profile platform | ConvertFrom-Json).DelegationSet.NameServers
Resolve-DnsName josephkan.ca -Type NS
```

If those two lists do not match, GoDaddy is pointing at nameservers Route53 no longer uses.

---

## Reverting nameservers at GoDaddy

**Last resort.** Do this only if Route53 cannot serve the zone at all — the zone is gone and
recreating it is not viable, or the delegation itself was premature and the site is down with
no AWS-side fix.

What it costs:

- **24-48 hours** for `.ca` registry propagation, both directions. There is no way to shorten
  it. TTL does not help: this is registry and TLD nameserver caching, not record caching.
- **The window is asymmetric and messy.** During propagation some resolvers use Route53 and
  some use GoDaddy. If the two disagree, users get inconsistent answers with no pattern, and
  every debugging observation is unreliable for two days.
- **It cannot be quickly undone.** Reverting the revert costs another 24-48 hours.

Compare that against fixing forward in Route53, which is a five-minute record change.

If you are genuinely doing it:

1. GoDaddy → domain → Nameservers → change from the four `awsdns` servers back to GoDaddy's
   defaults (`ns##.domaincontrol.com`).
2. In the GoDaddy DNS records, confirm the Vercel records are still present and correct:
   `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com`. GoDaddy keeps its zone data when
   nameservers are pointed elsewhere, but it is worth eyeballing before relying on it.
3. Confirm **auto-renew and transfer lock are still ON** while you are in there. A lapsed
   registration takes down both the platform and the product, and is far worse than whatever
   sent you here.
4. Then wait, and watch:

```powershell
Resolve-DnsName josephkan.ca -Type NS
# domaincontrol.com when the revert has taken effect; awsdns until then

Resolve-DnsName josephkan.ca -Server ns73.domaincontrol.com
# what GoDaddy will serve once it is authoritative again — check this NOW, not in 24h
```

Step 4's second command is the important one: it tells you what GoDaddy will serve *before* the
propagation completes. If it is wrong, fix it in GoDaddy immediately rather than discovering it
a day later.

---

## After any rollback

1. **Do not remove the Vercel project.** It is the fallback and the rollback depends on it
   existing.
2. **Make the repo match reality.** If `origin` was flipped by hand, land the corresponding
   change in `main` — otherwise the next CI deploy silently re-applies the broken state.
3. **Find out what actually broke** before attempting the cutover again. Stage F4 exists for
   this: verify the site fully on the `dxxxx.cloudfront.net` domain, charts included, before
   touching the apex. A cutover that failed once will fail identically the second time.
4. If the certificate was involved, confirm it is `ISSUED` and covers both names:

```powershell
aws acm describe-certificate --certificate-arn <CERT_ARN> --region us-east-1 --profile platform `
  --query "Certificate.[Status,DomainName,SubjectAlternativeNames]"
```

`PENDING_VALIDATION` after delegation has completed usually means the validation CNAME is
missing from the zone. `cdk deploy DnsStack` recreates it.
