/**
 * Mandatory tags.
 *
 * With a single workload account, cost allocation tags ARE the billing
 * breakdown. RequiredTagsAspect enforces their presence at synth time, which
 * is what makes them trustworthy enough to bill against.
 */

import { Tags } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { Env } from "./environments.js";

export const REQUIRED_TAG_KEYS = ["app", "env", "owner"] as const;

export type RequiredTagKey = (typeof REQUIRED_TAG_KEYS)[number];

export interface PlatformTags {
  /** Application or platform component this resource belongs to. */
  readonly app: string;
  readonly env: Env;
  /** Owning identity. Constant while this is a solo platform. */
  readonly owner: string;
}

export const DEFAULT_OWNER = "josephkan";

/** Apply the mandatory tag set to a construct scope. */
export function applyPlatformTags(scope: IConstruct, tags: PlatformTags): void {
  Tags.of(scope).add("app", tags.app);
  Tags.of(scope).add("env", tags.env);
  Tags.of(scope).add("owner", tags.owner);
}
