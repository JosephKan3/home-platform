/**
 * Account and region topology (ADR-0001).
 *
 * Two accounts today, structured so adding a third is a config change rather
 * than a redesign. Account IDs are read from environment variables so no real
 * account identifier is committed to a public repository.
 *
 * Set these in CI as repository variables (not secrets — account IDs are not
 * sensitive, but keeping them out of git avoids trivial reconnaissance):
 *   MGMT_ACCOUNT_ID, PLATFORM_ACCOUNT_ID
 */

/**
 * Primary region for all workloads (Phase 0 action plan §0).
 *
 * us-east-1 is deliberate: ACM certificates for CloudFront must live in
 * us-east-1 regardless of where anything else runs. Choosing another primary
 * region would require a cross-region certificate stack as the very first
 * thing built. Revisit only if data residency becomes a stated requirement.
 */
export const PRIMARY_REGION = "us-east-1" as const;

/** Region where CloudFront requires its ACM certificates to live. Not configurable by AWS. */
export const CLOUDFRONT_CERT_REGION = "us-east-1" as const;

export interface AccountConfig {
  readonly id: string;
  readonly region: string;
}

function accountId(envVar: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(
      `Missing ${envVar}. Set it in your shell or as a CI repository variable. ` +
        `See docs/phase-0-action-plan.md §0.`,
    );
  }
  if (!/^\d{12}$/.test(value)) {
    throw new Error(`${envVar} must be a 12-digit AWS account ID, got: ${value}`);
  }
  return value;
}

/**
 * Lazily resolved so that synthesizing one stack does not require every
 * account ID to be present in the environment.
 */
export const accounts = {
  get management(): AccountConfig {
    return { id: accountId("MGMT_ACCOUNT_ID"), region: PRIMARY_REGION };
  },
  get platform(): AccountConfig {
    return { id: accountId("PLATFORM_ACCOUNT_ID"), region: PRIMARY_REGION };
  },
  // get prod(): AccountConfig {                          <- uncomment to graduate prod
  //   return { id: accountId('PROD_ACCOUNT_ID'), region: PRIMARY_REGION };
  // },
} as const;
