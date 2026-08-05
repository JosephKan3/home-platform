# Cost Model

Prices are us-east-1 on-demand, rounded, as of design time. Verify before committing.
Everything here assumes a single region and low traffic (< 100 GB/mo egress).

## The line items that actually matter

| Item | Unit price | Monthly | Notes |
| --- | --- | --- | --- |
| EKS control plane | $0.10/hr | **$73** | Per cluster. Flat. Unavoidable. |
| NAT Gateway | $0.045/hr + $0.045/GB | **$33+** | Per AZ. The classic homelab bill killer. |
| ALB | $0.0225/hr + LCU | **$17-22** | Per load balancer. |
| NLB | $0.0225/hr + NLCU | **$17-22** | Same order. |
| Interface VPC endpoint | $0.01/hr/AZ + $0.01/GB | **$7.30/AZ** | Per endpoint, per AZ. |
| Gateway VPC endpoint (S3, DynamoDB) | $0 | **$0** | Always use these. |
| Transit Gateway attachment | $0.05/hr | **$36** | Per attachment, plus $0.02/GB. |
| VPC peering | $0 | **$0** | Cross-AZ data $0.01/GB each way. |
| VPC itself | $0 | **$0** | Correct in the handoff. |
| Egress-only IGW (IPv6) | $0 | **$0** | The cheapest outbound path that exists. |
| RDS Postgres `db.t4g.micro` | $0.016/hr | **$12** | + $0.115/GB gp3. Multi-AZ doubles it. |
| ElastiCache `cache.t4g.micro` | $0.016/hr | **$12** | Valkey is ~20% cheaper than Redis OSS. |
| EC2 `t4g.nano` | $0.0042/hr | **$3** | Fine for a NAT instance or subnet router. |
| EC2 `t4g.small` | $0.0168/hr | **$12** | |
| EC2 `t4g.large` | $0.0672/hr | **$49** | ~$30 on 1-yr compute savings plan. |
| Fargate | $0.04048/vCPU-hr + $0.004445/GB-hr | **$12/0.25vCPU+0.5GB** | ARM is ~20% cheaper. |
| Route53 hosted zone | $0.50 | **$0.50** | Queries are negligible. |
| Secrets Manager secret | $0.40 | **$0.40** | Per secret. SSM SecureString is $0. |
| CloudWatch Logs ingest | $0.50/GB | varies | **Default retention is "never expire".** |
| ACM public cert | $0 | **$0** | |
| ACM Private CA | $400/mo | **$400** | Never do this. Use step-ca or cert-manager. |
| AWS Config | $0.003/item | creeps | Enable selectively. |
| GuardDuty | ~$4-15 | **$5-15** | Worth it. Enable. |

## Correcting the handoff's cost assumptions

**"Use VPC Endpoints instead of NAT Gateways to save money" is wrong at this scale.**
A NAT Gateway is $33/mo. Five interface endpoints across two AZs is $73/mo — more than
double, and it still doesn't cover arbitrary internet egress (GitHub, Docker Hub, npm,
Anthropic/OpenAI APIs, Tailscale coordination). Endpoints only win at high data volume,
where the $0.045/GB NAT processing fee dominates. You will not hit that.

Cheapest-to-most-expensive egress, in order:

1. **No egress.** Put workloads in isolated subnets; use gateway endpoints for S3/DynamoDB.
2. **Egress-only Internet Gateway over IPv6.** Free. Works for any IPv6-capable destination.
   AWS APIs are increasingly dualstack. Pair with DNS64/NAT64 if you must reach IPv4-only
   destinations — but NAT64 requires a NAT Gateway, so this only helps for pure-IPv6 paths.
3. **NAT instance.** `t4g.nano` in an ASG of 1, ~$3/mo. Use the `fck-nat` AMI. ~5 Gbps.
   Acceptable SPOF for this platform. This is the right default.
4. **Single-AZ NAT Gateway.** $33/mo. Buy this when you want to stop thinking about it.
5. **Multi-AZ NAT Gateway.** $66+/mo. Never, unless something is actually production-critical.

**Multi-VPC is not free.** VPCs are free; *connecting* them is not. Four bounded-context
VPCs needing full mesh connectivity via Transit Gateway = 4 × $36 = **$144/mo before any
traffic**. Peering avoids that fee but is non-transitive and hits a 125-peering limit /
route-table sprawl. Every app in the Public Applications VPC reaching Postgres in the Shared
Services VPC also pays $0.01-0.02/GB each way.

**Account boundaries are free. Network boundaries are not.** This is the single most
important cost fact for this design. See ADR-0002.

## Budget tiers

| Phase | Monthly target | What runs |
| --- | --- | --- |
| 0 — Foundation | **$5-15** | Org, SSO, Route53, S3/CloudFront, Lambda, Tailscale, GitHub OIDC |
| 1 — Services | **$45-75** | + NAT instance, RDS t4g.micro, internal ALB, ECS Fargate, Grafana Cloud free tier |
| 2 — Kubernetes | **$180-260** | + EKS ($73), 2× t4g.medium nodes or Karpenter spot, public ALB, ArgoCD, Authentik |
| 3 — Advanced | **$300+** | + Temporal, self-hosted LGTM stack, GPU workers, Qdrant |

Do not enter a phase until the previous one has been stable and idle-cost-verified for
two full billing cycles.

## Guardrails (build these in Phase 0, not later)

- AWS Budgets: monthly budget with 50/80/100% actual and 100% forecast alerts to email + SNS.
- Cost Anomaly Detection: one monitor per linked account.
- Service Control Policy: deny all regions except your chosen one + `us-east-1` for global
  services. This alone prevents most surprise bills and crypto-mining blast radius.
- SCP: deny `ec2:RunInstances` for instance families you'll never use (p*, g*, x*, u-*, *metal).
- SCP: deny `organizations:LeaveOrganization`, deny disabling CloudTrail/GuardDuty.
- CloudWatch log group retention: default 14 days dev / 30 days prod, enforced by an
  Aspect in CDK. Never leave it unset.
- S3 lifecycle rules on every bucket at creation.
- Cost allocation tags activated day one: `app`, `env`, `owner`, `cost-center`.
  Enforce via CDK Aspect + SCP requiring tags on create.
- A written teardown runbook per phase. If you can't cheaply destroy it, don't build it.
