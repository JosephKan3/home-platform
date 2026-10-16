# @platform/infra-network

The shared VPC and Tailscale subnet router — the Phase 1 roadmap item ("Tailscale subnet
router on t4g.nano... Private hosted zone internal.josephkan.ca") that was specified but never
built. This package owns the VPC and the router. `infrastructure/dns`'s `DnsStack` owns the
private zone itself (`internal.josephkan.ca`) — see that package's README, "The private zone
is deferred to Phase 1" section, which already documents the DNS-side half of this setup and
is not repeated here.

**Why this exists now, specifically:** `pilot-receipts-platform`'s upload-gate Lambda needs a
network surface that is reachable only from Tailscale-connected devices, not the public
internet. That property does not exist without a VPC plus private DNS (ADR-0002's
"don't be in the VPC" default is for workloads that only need the public internet — this is
the opposite case). This package is platform-owned, shared infrastructure: one VPC, one
subnet router, used by every future private service, not duplicated per app.

## What this deploys

- One VPC, `10.20.0.0/16`, 2 AZs, public + isolated subnets only (ADR-0002) — no NAT, no
  Transit Gateway, gateway endpoints for S3 and DynamoDB, VPC Flow Logs to CloudWatch
  (2-week retention).
- One `t4g.nano` EC2 instance in a public subnet, running Tailscale as a subnet router,
  advertising the VPC's full CIDR. No SSH key, no port 22 — operational access is SSM
  Session Manager only. EBS encrypted, termination protection on.
- SSM parameters: the VPC ID (`ssmPaths.vpcId("prod")`) and the isolated subnet IDs
  (`/platform/prod/vpc/isolated-subnet-ids`), for a consuming app to read the same way
  `NewNotamsStack` reads `ssmPaths.certificateArn`.

## What this does NOT deploy

- `internal.josephkan.ca` itself. That is `DnsStack`'s resource — see
  `infrastructure/dns/README.md`. This package's `VpcId` CloudFormation output exists
  specifically to feed that stack's `-c internalZoneVpcId=...` flag.
- Tailscale account configuration (auth keys, ACLs, Split DNS, route approval). None of this
  is an AWS resource; it is Tailscale's own admin console and API, documented below as the
  manual steps they are.

## Deploy order — this is not optional

1. **Generate a Tailscale auth key and seed it into SSM, before the first deploy.** The
   subnet router's UserData reads this at boot; without it, the instance comes up with no
   Tailscale identity at all and silently does nothing.

   Open the [Keys page](https://console.tailscale.com/admin/settings/keys) of the Tailscale
   admin console → **Generate auth key**. Settings that matter for this specific use:

   - **Reusable: off.** This key authenticates exactly one node (the subnet router). A
     reusable key is a bigger blast radius than this use case needs — if the instance is
     ever replaced (AMI update, instance-type change), generate a new key rather than reuse
     this one, same as `NewNotamsStack`'s VAPID keypair was re-seeded rather than reused
     across an unrelated migration.
   - **Ephemeral: off.** An ephemeral node is removed from the tailnet entirely once it goes
     offline — wrong for a subnet router, which should keep its identity (and therefore its
     approved routes) across a planned reboot.
   - **Pre-approved: on**, if you want the route approval step below to happen
     automatically. Otherwise it is a manual step in the admin console after the instance
     first comes up.
   - **Expiry:** up to 90 days. Tagged devices (not used here, since this is a personal
     tailnet with one owner, not a team needing tag-based ACLs) get key expiry disabled by
     default; an untagged key will need regenerating and reseeding before it expires, or the
     instance stays connected on its existing session but a *replacement* instance (e.g.
     after `cdk deploy` changes something that forces instance replacement) would fail to
     re-authenticate. Put a reminder on the calendar for whatever expiry you pick.

   ```powershell
   aws ssm put-parameter --name /platform/network/tailscale-auth-key `
     --type String --value "tskey-auth-..." --profile platform
   ```

   `String`, not `SecureString` — matches `NewNotamsStack`'s resolved position
   (`grantServerSecrets`'s doc comment there): the IAM grant this stack writes
   (`ssm:GetParameter` scoped to exactly this one parameter ARN) is the real access control,
   not the encryption-at-rest layer SecureString adds on top of an already narrow grant.

2. **Deploy.**

   ```powershell
   npx cdk deploy NetworkStack --profile platform
   ```

   `PLATFORM_ACCOUNT_ID` and `MGMT_ACCOUNT_ID` must be in the session (`.env.local`,
   gitignored — same as every other package here).

3. **Approve the advertised route, if the auth key was not pre-approved.** Open the
   [Machines page](https://console.tailscale.com/admin/machines), find the instance (hostname
   `subnet-router`), open its **Subnets** section, and approve `10.20.0.0/16`.

4. **Create the private zone**, now that a VPC ID exists — this is `DnsStack`'s deploy, not
   this package's:

   ```powershell
   npx cdk deploy DnsStack -c internalZoneVpcId=<VpcId output from step 2> --profile platform
   ```

5. **Configure Tailscale Split DNS.** [DNS page](https://console.tailscale.com/admin/dns) of
   the admin console → add a nameserver for `internal.josephkan.ca` →
   **`10.20.0.2`** (VPC CIDR base + 2, where the VPC's own resolver always lives). See
   `infrastructure/dns/README.md`'s own note on why this step is the most common failure mode
   of this entire setup: without it, the zone is correctly configured on the AWS side and
   still looks completely broken from every Tailscale-connected device.

6. **Verify**, from a device on the tailnet (not this deploying machine unless it is also on
   the tailnet):

   ```powershell
   ping <subnet router's 100.x Tailscale IP>          # confirms the tailnet connection itself
   nslookup <anything>.internal.josephkan.ca          # confirms Split DNS is wired correctly
   ```

## Operational notes

- **No SSH.** `aws ssm start-session --target <SubnetRouterInstanceId output> --profile platform`
  is the only way in. There is no key pair to lose and no port 22 to scan.
- **Checking Tailscale's own status on the instance**, once connected via Session Manager:
  `sudo tailscale status`. A healthy router shows itself plus every peer it can currently
  reach.
- **Instance replacement re-authenticates automatically**, as long as the SSM parameter still
  holds a valid, unexpired auth key — this is the entire reason the key is read at boot
  rather than baked into the AMI or passed as a CloudFormation parameter (see the stack's own
  doc comment on `createUserData`).
- **A second subnet router for high availability** is a real Tailscale feature
  (`--advertise-routes` from two nodes, Tailscale picks the healthy one) and is explicitly out
  of scope for this first version — revisit only if this single node's downtime has ever
  actually mattered in practice.

## Local commands

```powershell
pnpm --filter @platform/infra-network build
pnpm --filter @platform/infra-network test
pnpm --filter @platform/infra-network synth
```

Tests need no AWS credentials — confirmed directly: `ec2.MachineImage.latestAmazonLinux2023()`
resolves to a CloudFormation dynamic SSM parameter reference at synth time, not a live API
call, so it works offline the same way `cdk synth` does. `synth`/`deploy` need
`PLATFORM_ACCOUNT_ID` set and (for `deploy`) a real `platform` SSO session, since
`latestAmazonLinux2023` is still a real SSM parameter lookup CloudFormation performs during
the actual deploy.
