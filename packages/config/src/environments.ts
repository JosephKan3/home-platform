/**
 * Environment profiles.
 *
 * Two named, tested profiles — not free-form parameterization. Independent
 * feature flags produce 2^n untested combinations and dead code paths that
 * break silently. A third profile is added only when a real third case exists.
 */

import { RemovalPolicy } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

export type Env = "dev" | "prod";

export interface EnvProfile {
  readonly env: Env;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  /** Enable CodeDeploy canary traffic shifting. Phase 2. */
  readonly progressiveDelivery: boolean;
  /** Point-in-time recovery on data stores. */
  readonly pointInTimeRecovery: boolean;
}

export const profiles: Record<Env, EnvProfile> = {
  dev: {
    env: "dev",
    logRetention: RetentionDays.TWO_WEEKS,
    removalPolicy: RemovalPolicy.DESTROY,
    progressiveDelivery: false,
    pointInTimeRecovery: false,
  },
  prod: {
    env: "prod",
    logRetention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
    progressiveDelivery: true,
    pointInTimeRecovery: true,
  },
};

export function profileFor(env: Env): EnvProfile {
  return profiles[env];
}
