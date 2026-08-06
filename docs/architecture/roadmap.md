# Roadmap

Two accounts, one VPC, no NAT, no Kubernetes. Each phase has exit criteria; don't start a
phase until the previous one's criteria are met and its idle cost is verified over a full
billing cycle.

---

## Phase 0 — Organization and foundation

**Budget: $3-8/mo**

> **Executable plan: [`../phase-0-action-plan.md`](../phase-0-action-plan.md)** — sequenced
> stages, exact commands, exit criteria, and the gotcha list. The checklist below is the
> summary; the action plan is what you work from.

The only manual work in the project happens here. Keep the list short and documented.

- [ ] **Delegate `josephkan.ca` DNS to Route53.** No registration needed — it's already owned
      at GoDaddy. Sequence matters, since the personal site is live on Vercel (ADR-0006):
      1. Create the Route53 public hosted zone and replicate the **existing Vercel records**
         (`josephkan.ca A 76.76.21.21`, `www CNAME cname.vercel-dns.com`).
      2. Verify against the Route53 nameservers directly with
         `Resolve-DnsName josephkan.ca -Server <ns-xxx.awsdns-xx.com>`.
      3. Change nameservers at GoDaddy. **This is a no-op** — zone contents are identical,
         so no cached answer is invalidated and the site never goes down. No TTL
         preparation is needed. `.ca` registry propagation takes 24-48h.
      4. Verify delegation everywhere before proceeding.
      Confirm auto-renew and transfer lock are on at GoDaddy while you're there.
- [ ] ACM certificate in **`us-east-1`** (required for CloudFront regardless of primary
      region) covering `josephkan.ca` and `*.josephkan.ca`. DNS-validated via CDK.
- [ ] Create AWS Organization from the management account. Root user MFA'd, then locked away.
- [ ] OUs: `Security` (empty), `Workloads`, `Sandbox` (empty). Create the **Platform**
      account in `Workloads`. Declaratively, via `AWS::Organizations::Account` in CDK.
- [ ] IAM Identity Center. Permission sets for admin and read-only. No IAM users, no access keys.
- [ ] Org CloudTrail → S3 in the management account. GuardDuty on the Platform account.
- [ ] SCPs on OUs (not accounts, so future accounts inherit):
      region lock; deny NAT Gateway; deny Transit Gateway; deny large/GPU instance families;
      deny IAM user creation; deny disabling CloudTrail/GuardDuty; deny leaving the org.
- [ ] Budgets + Cost Anomaly Detection on the Platform account.
- [ ] Activate cost allocation tags `app`, `env`, `owner`. With one account these *are* the
      billing breakdown.
- [ ] `cdk bootstrap` both accounts. Management trusts itself; Platform trusts the deploy role.
- [ ] GitHub OIDC provider + two roles: `deploy-dev` and `deploy-prod`.
      `sub` scoped to `repo:ORG/REPO:environment:*`. Prod role behind a GitHub Environment
      with required reviewers. Dev role carries a permissions boundary denying
      `aws:ResourceTag/env = prod`.
- [ ] Monorepo scaffold: pnpm workspaces, Turborepo, CDK app, jest, eslint, cdk-nag, Renovate.
      Top-level split `infrastructure/` `applications/` `automation/` `packages/`.
- [ ] `eslint-plugin-boundaries` encoding the dependency matrix in ADR-0004.
      Applications must not import infrastructure, and vice versa.
- [ ] CDK Aspects, all failing **synth** rather than deploy:
      - `NoManagedEgressAspect` — errors on NAT Gateway, Transit Gateway,
        `PRIVATE_WITH_EGRESS`; warns on non-allowlisted interface endpoints.
      - Tag enforcement (`app`, `env`, `owner`).
      - Log retention enforcement.
      Each with a unit test asserting it actually fires.
- [ ] CI: lint → boundaries → test → synth → aspects → cdk-nag → diff on PR; deploy on merge.
- [ ] **Ship the personal site.** S3 + CloudFront + OAC + ACM. Static export.
      Replace the two OANDA API routes with an **EventBridge-scheduled Lambda that writes
      JSON to S3** — removes all request-path compute, keeps the OANDA token off any
      internet-reachable surface, and survives OANDA outages. See `applications.md`.
- [ ] **Cut the apex over to CloudFront.** Replace the `A 76.76.21.21` record with a Route53
      **ALIAS** to the distribution, and `www` with a redirect to the apex. Single record
      change, 300s TTL, fully in CDK. **The highest-risk moment in Phase 0** — deliberately
      isolated so it reverts in five minutes without touching nameservers.
- [ ] Add a `v=DMARC1; p=reject;` TXT record. No mail is sent from this domain, which is
      exactly why it should be unspoofable. Costs nothing.

**Exit criteria:** a merge to `main` deploys the personal site to production at
`josephkan.ca` with nobody touching the console. Vercel is switched off for the personal
site. Bill under $8. Budget alert has fired at least once in testing. A CI test proves the
dev role is denied a prod-tagged action.

---

## Phase 1 — NewNotams on AWS, observability, private access

**Budget: $8-15/mo** (revised down — neither application needs RDS yet)

- [ ] **Migrate NewNotams off Vercel.** Next.js on **Lambda via OpenNext**, CloudFront in
      front, **no VPC attachment**. Keep Upstash Redis initially — it's an HTTPS client, so
      it works unchanged from a VPC-less Lambda. Migrating compute and datastore in one step
      would make a failed deploy undiagnosable.
- [ ] `CRON_SECRET` external cron → **EventBridge Scheduler → direct Lambda invoke**.
      Prefer direct invocation over the public `/api/notify` endpoint so the notify path
      stops being internet-reachable at all.
- [ ] Secrets → **SSM Parameter Store SecureString**. Nothing here rotates, so Secrets
      Manager's $0.40/secret isn't justified (7 secrets = $2.80/mo saved).
- [ ] Rate-limit `/api/weather` at CloudFront or WAF — it's an unauthenticated open proxy to
      Nav Canada today.
- [ ] Remove `typescript.ignoreBuildErrors` from `next.config.mjs` before this becomes the
      reference app for a platform whose CI story is part of the pitch.
- [ ] OTel instrumentation. CloudWatch for AWS metrics. Grafana Cloud free tier.
- [ ] **SLIs and SLOs for the notify job.** A weather brief that silently stops arriving is
      a real incident — this is the workload that makes alerting matter. Multi-window
      burn-rate alerts.
- [ ] `runbooks/` with real procedures for the top 5 plausible failures.
- [ ] VPC construct: `10.20.0.0/16`, dual-stack, 2 AZs, **public + isolated subnets only**.
      No `PRIVATE_WITH_EGRESS` anywhere — it silently creates NAT Gateways.
      Build it now even though nothing needs it yet; it's free and Phase 2 depends on it.
- [ ] IGW + Egress-only IGW. Gateway endpoints for S3 and DynamoDB. Zero interface endpoints.
- [ ] **Verify IPv6 egress** per dependency before relying on it. Known IPv4-only: Docker Hub,
      `git clone` from github.com. Record results in `docs/architecture/ipv6-coverage.md`.
- [ ] Tailscale subnet router on `t4g.nano`, public subnet, advertising `10.20.0.0/16`.
      Tailscale SSH, ACLs by tag. **Close all public SSH and DB ports permanently.**
- [ ] Private hosted zone `internal.josephkan.ca`, attached to the VPC.
- [ ] **Configure Tailscale Split DNS** to route `internal.josephkan.ca` → `10.20.0.2`
      (the VPC resolver). Tailscale clients are not inside the VPC and won't use its
      resolver by default — without this the private zone looks broken from a laptop even
      though the AWS side is correct. Most common failure mode of this setup.
- [ ] Delegate `newnotams.net` to Route53 using the same replicate → verify → delegate
      sequence used for `josephkan.ca`.
- [ ] **RDS deferred.** Neither application needs relational storage. Provision when a real
      need appears — saves ~$12/mo. Backup/restore drill moves to whenever that happens,
      or applies to DynamoDB PITR in Phase 2.

**Exit criteria:** NewNotams serves production traffic on AWS with an SLO and burn-rate
alerts. Vercel is switched off. No public ingress except CloudFront. No NAT Gateway exists.
One clean billing cycle.

---

## Phase 2 — Progressive delivery, data migration, identity

**Budget: $25-50/mo**

- [ ] **CodeDeploy progressive delivery** — canary traffic shifting with automatic rollback
      on CloudWatch alarm, for Lambda. Prove it: deliberately break a NewNotams deploy and
      show the automatic rollback. **Highest-signal item in the whole roadmap.**
- [ ] **Migrate NewNotams from Upstash to DynamoDB.** Every operation in `user-store.ts`,
      `saved-searches.ts`, and `schedule/route.ts` is a key lookup or set membership —
      DynamoDB is the natural fit, costs ~$0 at this volume, and **preserves the no-VPC
      property** that makes the app cheap. `getKv()` in `lib/kv.ts` is already the seam.
      Enable PITR; run the restore drill here.
- [ ] Fix the `getSchedulesDueAt` N+1 during the migration — query by notify-hour rather
      than fanning out one `get` per user.
- [ ] Authentik, or **reconsider Cognito** — with only NewNotams needing identity, Authentik's
      Fargate task ($12/mo) plus an ALB ($17/mo) is $29/mo to replace a working Auth.js
      setup. Decide against real requirements. Migrating existing users is the interesting
      part either way; `findOrCreateOAuthUser` already derives stable IDs from email hashes,
      which makes ID continuity tractable.
- [ ] ECS Fargate cluster + shared ALB **only if** something genuinely long-running exists.
      Both current apps are CloudFront-fronted, so this may not be needed at all.
- [ ] Grafana Cloud free tier as the OTel backend. Dashboards + SLO alerts.
- [ ] Supply chain: SBOM generation, Renovate automerge for patches, cosign if containers exist.
- [ ] cdk-nag blocking in CI with documented, justified suppressions.
- [ ] CloudFormation drift detection on a schedule — the substitute for a GitOps reconcile loop.

**Exit criteria:** a canary deploy has automatically rolled back on an injected failure.
NewNotams is off Upstash. A restore has been performed and timed.

---

## Phase 3 — Platform API and AI automation

**Budget: $70-110/mo**

- [ ] Platform API. Every mutating operation is a **Step Functions** execution:
      scoped role per step, `waitForTaskToken` approval gates, SSM kill switch,
      structured audit events. See ADR-0005.
- [ ] Keep `automation/platform-api/activities/` engine-agnostic — plain typed async
      functions, zero engine SDK imports. Thin per-engine adapters wrap them. API returns
      an opaque `operationId`, never an execution ARN. Preserves the Temporal path without
      building a facade for it.
- [ ] `platform-mcp` server wrapping the Platform API. Read-only GitHub + CloudWatch MCP
      alongside. **No filesystem, Docker, or DB-write MCP in any agent context that reads
      third-party text.**
- [ ] Deploy Bot GitHub App: PR previews, deploy status, `/deploy` and `/rollback` routed
      through the Platform API with approval gates.
- [ ] `platform new-service` CLI — scaffolds service + CDK stack + pipeline + dashboard +
      alarms + runbook + SLO in one command. **The flagship platform-engineering deliverable.**
      First template: **"Next.js on Lambda via OpenNext + CloudFront"** — both existing
      applications fit it, so the abstraction is validated by two real consumers rather than
      being speculative.
- [ ] FIS chaos experiment: kill an AZ, show the SLO dashboard responding.
- [ ] Temporal only if Step Functions demonstrably can't express the workflows.
- [ ] Qdrant only if pgvector demonstrably falls over.

**Exit criteria:** a new service goes zero-to-production with observability, alarms, and a
runbook via one CLI command. AI-initiated production changes are gated, audited, reversible.

---

## Explicitly out of scope

Recorded so the reasoning survives, per ADR-0003:

- **Kubernetes / EKS / Helm / ArgoCD / Karpenter.** ~$200/mo for workloads that fit in
  Lambda and Fargate. Everything stays containerized so the option remains open.
- **NAT Gateways and NAT instances.** SCP-denied. IGW + EIGW + no-VPC-Lambda instead.
- **Transit Gateway.** One VPC. Future VPCs peer.
- **Self-hosted LGTM stack.** Grafana Cloud free tier.
- **Separate GitOps manifest repo.** No manifests exist.

---

## Continuous, from day one

- Write an ADR for every non-obvious decision. The ADR log is the highest-value artifact here.
- Keep one architecture diagram current. Most reviewers will see only this.
- Write publicly about the tradeoffs — especially where the cheaper option was chosen and
  you can say precisely what was given up. "$80/mo, and here's what that cost me" is a
  stronger story than a $300/mo cluster.
- Review the bill weekly for two months, then monthly.
- Maintain a teardown runbook per phase.
