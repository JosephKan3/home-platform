# Cost Model

us-east-1 on-demand, rounded, as of design time. Verify before committing.
Assumes one region, one workload account, low traffic (< 100 GB/mo egress).

## Prices that drive decisions

| Item | Unit price | Monthly | Status |
| --- | --- | --- | --- |
| VPC, subnets, route tables, security groups | $0 | **$0** | Using |
| Internet Gateway | $0 | **$0** | Using |
| Egress-only Internet Gateway (IPv6) | $0 | **$0** | Using |
| Gateway VPC endpoint (S3, DynamoDB) | $0 | **$0** | Using |
| VPC peering (connection) | $0 | **$0** | Reserved for future |
| AWS Organizations, accounts, SCPs, Identity Center | $0 | **$0** | Using |
| ACM public certificate | $0 | **$0** | Using |
| **Public IPv4 address** | $0.005/hr | **$3.60 each** | The no-NAT trap |
| NAT Gateway | $0.045/hr + $0.045/GB | ~$33 | **SCP-denied** |
| Transit Gateway attachment | $0.05/hr + $0.02/GB | ~$36 | **SCP-denied** |
| EKS control plane | $0.10/hr | ~$73 | **Dropped (ADR-0003)** |
| ACM Private CA | — | $400 | Never |
| Interface VPC endpoint | $0.01/hr/AZ | $7.30/AZ each | Avoid; case-by-case |
| ALB | $0.0225/hr + LCU | **$17-22** | One, shared |
| Route53 hosted zone | $0.50 | **$0.50** | |
| Lambda | $0.20/M req + $0.0000133/GB-s | **~$0-2** | 1M req + 400k GB-s free forever |
| Fargate ARM | $0.03238/vCPU-hr + $0.00356/GB-hr | **~$10** per 0.25vCPU/0.5GB task | |
| Fargate Spot | ~70% off | **~$3** per small task | Dev default |
| RDS `db.t4g.micro` | $0.016/hr | **$12** | + $0.115/GB gp3. Free tier 12mo. |
| ElastiCache Valkey `t4g.micro` | ~$0.013/hr | **$9** | Defer; use Lambda memory or DynamoDB |
| EC2 `t4g.nano` | $0.0042/hr | **$3** | Tailscale router |
| S3 | $0.023/GB | **~$1** | |
| CloudFront | $0.085/GB out | **~$1** | 1 TB/mo free tier |
| DynamoDB on-demand | $1.25/M writes | **~$0-1** | 25 GB free |
| Step Functions Standard | $0.025/1k transitions | **~$0-1** | 4k free/mo |
| Secrets Manager | $0.40/secret | **$0.40 each** | Use SSM SecureString ($0) unless rotating |
| CloudWatch Logs ingest | $0.50/GB | varies | **Default retention is "never expire"** |
| GuardDuty | usage-based | **$3-10** | One account only. Keep on. |
| Grafana Cloud free tier | $0 | **$0** | 10k series, 50 GB logs, 50 GB traces |

## The three big avoidances

**NAT Gateway → IGW + EIGW + no-VPC Lambda.** Saves $33/mo. Replacement cost is $3.60/mo
per always-on public-IPv4 Fargate task, or $0 if the task is IPv6-only. See ADR-0002 for
the four egress strategies and the IPv6 coverage caveats.

**Transit Gateway → single VPC.** Saves $36/mo per attachment. Only one VPC exists, so
there is nothing to connect. Future VPCs peer (free) rather than attach.

**EKS → Lambda + Fargate.** Saves ~$73/mo control plane plus nodes, and removes the
operational surface of ArgoCD/Karpenter/controllers. See ADR-0003 for the capability-by-
capability replacement table.

Combined: roughly **$140-200/mo avoided** against the original design.

## Remaining traps

- **Public IPv4 at $3.60/mo per address.** The direct consequence of no-NAT. Cheap next to
  a NAT Gateway, but it scales with always-on task count. Prefer Lambda; prefer IPv6-only.
- **Two accounts, one GuardDuty.** Correct — enabling it per-account multiplies cost. The
  management account has no workloads, so findings there should be near-zero.
- **CloudWatch Logs default retention is infinite.** Enforce 14d dev / 30d prod via a CDK
  Aspect. This is the most common silent cost leak in any AWS account.
- **NAT Gateway can be created accidentally.** `SubnetType.PRIVATE_WITH_EGRESS` in CDK
  creates one per AZ without asking. Two layers prevent it (ADR-0002): a CDK Aspect that
  fails `cdk synth` with a message naming the cause, and an SCP denying
  `ec2:CreateNatGateway` as a backstop for anything bypassing CI.
- **Data transfer between AZs is $0.01/GB each way.** With 2 AZs and a shared RDS, chatty
  cross-AZ traffic adds up. Keep compute and its database AZ-aligned where it's free to do so.
- **AWS Config** is not enabled by default here. Leave it off until there's a reason; its
  per-item recording charges creep.

## Budget by phase

| Phase | Target | What runs |
| --- | --- | --- |
| 0 — Foundation | **$3-8** | Org, 2 accounts, SCPs, Identity Center, Route53, S3+CloudFront, GitHub OIDC, GuardDuty |
| 1 — Network + first service | **$20-35** | + VPC (free), Tailscale `t4g.nano`, RDS t4g.micro, Lambda, CloudWatch |
| 2 — Containers + platform services | **$50-80** | + shared ALB, 2-3 Fargate tasks, Authentik, CodeDeploy, Grafana Cloud free |
| 3 — Automation | **$70-110** | + Platform API, Step Functions, MCP server, deploy bot, more Fargate |

Steady state target: **under $80/mo**. That is a defensible number to state publicly and a
better story than a $300/mo cluster.

## Guardrails (Phase 0, not later)

- Budgets on the Platform account: 50/80/100% actual + 100% forecast → email + SNS.
- Cost Anomaly Detection monitor.
- SCP: region lock to primary + `us-east-1`.
- SCP: deny `ec2:CreateNatGateway`, `ec2:CreateTransitGateway`.
- CDK Aspect `NoManagedEgressAspect`: fail synth on NAT GW, TGW, `PRIVATE_WITH_EGRESS`;
  warn on non-allowlisted interface endpoints. Faster and more readable than the SCP denial.
- SCP: deny `ec2:RunInstances` for `p*`, `g*`, `x*`, `u-*`, `*.metal`, and anything above `large`.
- SCP: deny IAM user and access key creation.
- SCP: deny disabling CloudTrail or GuardDuty; deny leaving the organization.
- CDK Aspect: fail synth on any log group without explicit retention.
- CDK Aspect: fail synth on any resource missing `app`, `env`, `owner` tags.
- S3 lifecycle rules at bucket creation, always.
- Cost allocation tags activated day one — with one account, tags *are* the billing breakdown.
- A teardown runbook per phase. If it can't be cheaply destroyed, don't build it.
