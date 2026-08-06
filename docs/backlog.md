# Backlog

Workloads and ideas captured but not yet scheduled into a phase. Each entry records enough
context to act on later without re-deriving the reasoning.

Nothing here is committed to. Moving an item into `roadmap.md` is the decision point.

---

## LLM proxy on AWS

**Raised:** 2026-08-06. **Candidate phase:** 3 (alongside the Platform API and MCP server).

### What it is today

Kilo Code (VS Code extension, v7.4.20) talks to Claude through a proxy running on this
laptop. The proxy is the piece to migrate; the extension stays local.

Consequences of it being local, which are the actual reasons to move it:

- It only works when the laptop is on and awake.
- Configuration lives in one machine's VS Code settings — no second device, no phone, no
  cloud agent session can use it.
- The Anthropic API key sits in a local process and local config.
- There is no request log, no spend tracking, and no per-project attribution.

### Why this is a good fit for the platform

It is genuinely the platform's own dogfood: an AI service, used daily, by the person who
built the platform. That makes it the most honest possible test of the Phase 3 automation
story, and a much better demo than a synthetic example.

It also has a real shape — an authenticated HTTP service with streaming responses,
secrets, and a cost profile — without being large.

### Sketch

```
VS Code (Kilo) ─┐
Phone / other   ├─► Tailscale ─► private ALB or Lambda Function URL
Cloud agent     ─┘                    │
                                      ├─► key from SSM SecureString
                                      ├─► structured request/response log
                                      ├─► token + spend metering per project
                                      └─► upstream: Anthropic API
```

### Open questions

1. **Streaming.** This is the crux. LLM responses stream, and the transport choice follows
   from that:
   - **Lambda Function URL with `RESPONSE_STREAM`** — supports streaming, no idle cost, but
     a **15-minute hard timeout**. Long agentic turns could exceed it.
   - **Fargate behind an ALB** — no timeout ceiling, but ~$10/mo for the task plus **$17/mo
     for the ALB** (ADR-0002 currently has no ALB, deliberately).
   - Verify actual turn durations before choosing. If p99 is comfortably under 15 min,
     Lambda wins on cost by roughly $27/mo.

2. **Private or public?** Tailscale-only is the cheaper and safer default and matches the
   admin-plane pattern already in the design. Public would need auth, rate limiting, and
   probably WAF — and would make an exposed API key materially worse. **Start private.**

3. **Does it need a VPC?** Only if it must reach a database. If metering writes to DynamoDB
   and the key comes from SSM, it can stay VPC-less with free egress (ADR-0002 strategy 1).
   Prefer that.

4. **What does "proxy" mean here exactly?** A dumb pass-through is a weekend's work. Caching,
   routing between models, spend caps, or prompt logging each add real scope. **Decide the
   minimum viable version before starting** — the temptation to build an LLM gateway is
   strong and mostly not worth it.

5. **Is a local fallback needed?** If the proxy is down, coding stops. Either keep the local
   path as a fallback, or accept the dependency knowingly.

### Cost

Roughly **$1-3/mo** on Lambda + DynamoDB + SSM (the Anthropic API spend is unchanged and
passes through either way). Roughly **$27-30/mo** on Fargate + ALB. That difference is most
of the Phase 3 budget, so the streaming question decides whether this is cheap or not.

### Prerequisites

- Phase 1 Tailscale subnet router (private access)
- Phase 3 SSM secret handling and audit-event patterns from the Platform API

### Why not sooner

It is not on the critical path, it duplicates something that already works, and Phase 3
already builds the secret-handling, audit-logging, and private-access patterns it wants to
reuse. Doing it earlier means building those twice.

**Worth reconsidering earlier if** the laptop dependency becomes annoying in practice — for
example, wanting to run cloud agent sessions or use a second machine. That is a legitimate
trigger to promote it.
