/**
 * RequiredTagsAspect — every taggable resource must carry app/env/owner.
 *
 * With a single workload account these tags are the only billing breakdown,
 * so they are enforced at synth rather than audited after the fact.
 *
 * Apply this with `AspectPriority.READONLY` so it runs after the mutating
 * `Tags.of(...)` aspects that actually set the tags:
 *
 *     Aspects.of(stack).add(new RequiredTagsAspect(), { priority: AspectPriority.READONLY });
 */

import { Annotations, CfnResource, TagManager } from "aws-cdk-lib";
import { REQUIRED_TAG_KEYS } from "@platform/config";
import type { IAspect } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export interface RequiredTagsAspectProps {
  /** CloudFormation resource types that genuinely cannot carry tags. */
  readonly excludeResourceTypes?: string[];
}

export class RequiredTagsAspect implements IAspect {
  private readonly excludeResourceTypes: ReadonlySet<string>;

  constructor(props: RequiredTagsAspectProps = {}) {
    this.excludeResourceTypes = new Set(props.excludeResourceTypes ?? []);
  }

  visit(node: IConstruct): void {
    // A Stack is itself taggable, but its tags are stack-level metadata rather
    // than a billable resource. Only CloudFormation resources are checked.
    if (!(node instanceof CfnResource) || !TagManager.isTaggable(node)) {
      return;
    }

    if (this.excludeResourceTypes.has(node.cfnResourceType)) {
      return;
    }

    const present = tagKeys(node.tags.renderTags());
    const missing = REQUIRED_TAG_KEYS.filter((key) => !present.has(key));
    if (missing.length === 0) {
      return;
    }

    Annotations.of(node).addError(
      `Missing required tag(s): ${missing.join(", ")}. ` +
        `Every taggable resource must carry ${REQUIRED_TAG_KEYS.join(", ")}. ` +
        "Apply them with applyPlatformTags() from @platform/config.",
    );
  }
}

/**
 * renderTags() shape varies by resource: undefined when empty, an array of
 * `{key,value}` or `{Key,Value}` entries, or a plain key-value map.
 */
function tagKeys(rendered: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (rendered === undefined || rendered === null) {
    return keys;
  }

  if (Array.isArray(rendered)) {
    for (const entry of rendered) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const key = record["Key"] ?? record["key"];
      if (typeof key === "string") {
        keys.add(key);
      }
    }
    return keys;
  }

  if (typeof rendered === "object") {
    for (const key of Object.keys(rendered as Record<string, unknown>)) {
      keys.add(key);
    }
  }

  return keys;
}
