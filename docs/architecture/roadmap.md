# Roadmap

Each phase has explicit exit criteria. Do not start a phase until the previous phase's
criteria are met and its idle cost has been verified over two billing cycles.

---

## Phase 0 — Foundation

**Budget: $5-15/mo**

The only manual work in the entire project happens here, and it should be a short,
documented list.

- [ ] Register domain. Route53 public hosted zone in Shared-Services.
- [ ] Create AWS Organization from the management account. MFA on root, then lock it away.
- [ ] Create accounts: Security, Shared-Services, Dev, Prod, Sandbox.
- [ ] IAM Identity Center: permission sets, no IAM users, no access keys anywhere.
- [ ] Org CloudTrail → Security account S3 bucket. GuardDuty delegated admin. Security Hub.
- [ ] SCPs: region lock, deny leaving org, deny disabling CloudTrail/GuardDuty,
      deny expensive instance families outside Prod, Sandbox restrictions.
- [ ] AWS Budgets per account with 50/80/100% actual + 100% forecast alerts. Cost Anomaly Detection.
- [ ] Activate cost allocation tags: `app`, `env`, `owner`, `cost-center`.
- [ ] `cdk bootstrap` every account, trusting the deployment account.
- [ ] GitHub OIDC provider + per-account roles. `sub` scoped to `repo:ORG/REPO:environment:*`.
      Separate read-only plan role from apply role.
- [ ] Monorepo scaffold: pnpm workspaces, Turborepo, CDK app, jest, eslint, cdk-nag, Renovate.
- [ ] CI: lint → test → `cdk synth` → cdk-nag → diff on PR, deploy on merge.
- [ ] Tagging Aspect + log-retention Aspect applied globally in CDK.
- [ ] Deploy the portfolio site: S3 + CloudFront + OAC + ACM. First real thing shipped.

**Exit criteria:** a commit to `main` deploys to Prod with no human touching the console.
Monthly bill under $15. Budget alerts have fired at least once in testing.

---

## Phase 1 — Private access, data, and the first real service

**Budget: $45-75/mo**

- [ ] VPC construct: dual-stack, 3 AZ, public/private/isolated, gateway endpoints for S3+DynamoDB.
- [ ] Egress: `fck-nat` instance in Dev, single-AZ NAT GW in Prod. Egress-only IGW for IPv6.
- [ ] Tailscale subnet router on `t4g.nano` in Shared-Services. Advertise all VPC CIDRs.
      ACLs by tag. Tailscale SSH. **Close all public SSH and DB ports permanently.**
- [ ] Private hosted zone `internal.example.com`. Cross-account zone association or delegation.
- [ ] Shared RDS Postgres `t4g.micro` in Dev isolated subnets. pgvector extension.
      Database + role per app. PITR on. Secrets Manager with rotation Lambda.
- [ ] AWS Backup plan. Cross-account copy to the Security account vault.
      **Perform and document a real restore. Record measured RTO/RPO.**
- [ ] OTel instrumentation in every service from the first line of code.
      Export to Grafana Cloud free tier. CloudWatch for AWS-native metrics.
- [ ] Define SLIs and SLOs for the first real service. Multi-window burn-rate alerts.
- [ ] Ship the first real application on Lambda or ECS Fargate. End to end: build → image →
      ECR → deploy → smoke test → dashboard → alerts → runbook.
- [ ] `runbooks/` directory with genuine procedures for the top 5 plausible failures.

**Exit criteria:** a real application is serving traffic with an SLO and burn-rate alerts.
A database restore has been performed and timed. No public ingress except CloudFront/ALB.
Two clean billing cycles.

---

## Phase 2 — Kubernetes, GitOps, and identity

**Budget: $180-260/mo**

Only if Phase 1 has been stable for two billing cycles and there are two services that
concretely benefit.

- [ ] EKS in Dev. Karpenter, spot + graviton. Minimal on-demand baseline for system pods.
- [ ] AWS Load Balancer Controller. One shared ALB, host-based Ingress. External DNS.
- [ ] EKS Pod Identity for per-workload IAM. cert-manager. Kyverno or OPA Gatekeeper.
- [ ] ArgoCD in Dev, private-only via Tailscale. App-of-apps from the GitOps repo.
- [ ] Authentik. OIDC for ArgoCD, Grafana, and every internal tool. No local accounts anywhere.
- [ ] Migrate one Fargate service to EKS. Write up the comparison — that's the artifact.
- [ ] Argo Rollouts: canary with automated rollback on SLO burn. **Highest-signal item here.**
- [ ] Supply chain: cosign signing, SBOM generation, ECR scan-on-push, Renovate automerge for patches.
- [ ] Prod cluster only once Dev has been stable for a month.

**Exit criteria:** application deploys are fully GitOps-driven. A canary has automatically
rolled back on a deliberately injected SLO violation. All internal tools behind SSO + Tailscale.

---

## Phase 3 — Platform API, AI automation, workflows

**Budget: $300+/mo**

- [ ] Temporal. Temporal Cloud free tier first; self-host only if the operational experience
      is itself the goal.
- [ ] Platform API. Every mutating operation is a workflow. Scoped role per activity.
      Approval signals. Kill switch. Structured audit events.
- [ ] `platform-mcp` server wrapping the Platform API. Read-only GitHub + CloudWatch MCP alongside.
- [ ] Deploy Bot GitHub App: PR previews, deploy status, `/deploy` and `/rollback` commands
      routed through the Platform API with approval gates.
- [ ] `platform new-service` CLI: scaffolds repo + CDK stack + pipeline + dashboard + alerts
      + runbook + SLO. The paved road. **This is the flagship platform-engineering deliverable.**
- [ ] Self-hosted LGTM stack, only if you specifically want the operational experience.
- [ ] Qdrant, only if pgvector demonstrably falls over.
- [ ] FIS chaos experiment: kill an AZ, show the SLO dashboard responding.

**Exit criteria:** a new service goes from zero to production with observability, alerts,
and a runbook via one CLI command. AI-initiated production changes are gated, audited, and
reversible.

---

## Continuous, from day one

- Write an ADR for every non-obvious decision. The ADR log is the highest-value artifact here.
- Keep one architecture diagram current. Most reviewers will see only this.
- Write publicly about tradeoffs — especially the ones where you chose the cheaper option
  and can explain exactly what you gave up.
- Review the bill weekly for the first two months, then monthly.
- Maintain a teardown runbook per phase. Anything you cannot cheaply destroy, do not build.
