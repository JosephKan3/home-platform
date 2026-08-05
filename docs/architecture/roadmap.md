# Roadmap

Two accounts, one VPC, no NAT, no Kubernetes. Each phase has exit criteria; don't start a
phase until the previous one's criteria are met and its idle cost is verified over a full
billing cycle.

---

## Phase 0 — Organization and foundation

**Budget: $3-8/mo**

The only manual work in the project happens here. Keep the list short and documented.

- [ ] Register domain. Route53 public hosted zone.
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
- [ ] Ship the portfolio site: S3 + CloudFront + OAC + ACM. First real thing deployed.

**Exit criteria:** a merge to `main` deploys to production with nobody touching the console.
Bill under $8. Budget alert has fired at least once in testing. A CI test proves the dev
role is denied a prod-tagged action.

---

## Phase 1 — Network, private access, data

**Budget: $20-35/mo**

- [ ] VPC construct: `10.20.0.0/16`, dual-stack, 2 AZs, **public + isolated subnets only**.
      No `PRIVATE_WITH_EGRESS` anywhere — it silently creates NAT Gateways.
- [ ] IGW + Egress-only IGW. Gateway endpoints for S3 and DynamoDB. Zero interface endpoints.
- [ ] **Verify IPv6 egress works** for each real dependency before relying on it.
      Known IPv4-only: Docker Hub, `git clone` from github.com. Document the results in
      `docs/architecture/ipv6-coverage.md` as they're tested.
- [ ] Tailscale subnet router on `t4g.nano`, public subnet, advertising `10.20.0.0/16`.
      Tailscale SSH, ACLs by tag. **Close all public SSH and DB ports permanently.**
- [ ] Private hosted zone `internal.example.com`.
- [ ] RDS Postgres `t4g.micro`, isolated subnet, no public access, pgvector enabled.
      Database + role per app. PITR on. Credentials in Secrets Manager with rotation.
- [ ] AWS Backup plan. **Perform and document a real restore. Record measured RTO/RPO.**
- [ ] OTel instrumentation from the first line of service code. CloudWatch for AWS metrics.
- [ ] First real application on **Lambda** (no VPC attachment unless it needs RDS).
      End to end: build → deploy → smoke test → dashboard → alarms → runbook.
- [ ] SLIs and SLOs for that service. Multi-window burn-rate alerts.
- [ ] `runbooks/` with real procedures for the top 5 plausible failures.

**Exit criteria:** a real app serves traffic with an SLO and burn-rate alerts. A database
restore has been performed and timed. No public ingress except CloudFront. No NAT Gateway
exists. One clean billing cycle.

---

## Phase 2 — Containers, progressive delivery, identity

**Budget: $50-80/mo**

- [ ] One shared ALB. Host- and path-based listener rules across all services.
- [ ] ECS Fargate cluster (no EC2 capacity). ARM tasks. Spot in dev.
      Public subnet + security group with inbound **only** from the ALB's SG.
- [ ] **CodeDeploy progressive delivery** — canary/linear traffic shifting with automatic
      rollback on CloudWatch alarm, for both Lambda and ECS. Prove it: deliberately break
      a deploy and show the automatic rollback. **Highest-signal item in the whole roadmap.**
- [ ] Authentik on a single Fargate task, private-only via Tailscale.
      OIDC for every internal tool. No local accounts anywhere.
- [ ] Grafana Cloud free tier as the OTel backend. Dashboards + SLO alerts.
- [ ] Supply chain: cosign image signing, SBOM generation, ECR scan-on-push,
      Renovate automerge for patch updates.
- [ ] cdk-nag blocking in CI with documented, justified suppressions.
- [ ] CloudFormation drift detection on a schedule — the substitute for a GitOps reconcile loop.

**Exit criteria:** a canary deploy has automatically rolled back on an injected failure.
All internal tools behind SSO + Tailscale. Container images signed and scanned.

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
