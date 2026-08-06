/**
 * cdk-nag suppressions (ADR-0007).
 *
 * cdk-nag 3.x removed `NagSuppressions` entirely. A pack is now an
 * `IPolicyValidationPlugin` registered with `Validations.of(app).addPlugins()`,
 * and it decides what to suppress by reading the CDK core acknowledged-rules
 * metadata key off a resource and every construct above it.
 *
 * `Validations.of(scope).acknowledge()` is the intended public door to that
 * metadata, but it validates the rule ID against a `prefix::RuleName` grammar
 * and rejects anything else. cdk-nag's granular rules emit IDs of the form
 * `AwsSolutions-IAM5[Resource::arn:...]`, which contain `::` inside the
 * bracketed finding and therefore always throw. Since the granular findings are
 * exactly the ones worth suppressing individually — suppressing bare
 * `AwsSolutions-IAM5` would silence every wildcard on the resource, including
 * ones added later — this writes the same metadata entry directly.
 *
 * Every suppression must carry a reason that names an ADR or a dollar figure.
 * That is enforced here rather than left to review: an unexplained suppression
 * is indistinguishable from an unnoticed finding six months later.
 */

import { Stack, Validations } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export interface NagSuppression {
  /**
   * Full cdk-nag rule ID, including the bracketed finding for granular rules.
   * `cdk synth` prints the exact string to use on the "Acknowledge with" line.
   */
  readonly id: string;

  /**
   * Why this finding is accepted. Must cite an ADR (`ADR-000N`) or a cost
   * figure, and must be specific enough to re-evaluate later.
   */
  readonly reason: string;
}

const MIN_REASON_LENGTH = 40;
const CITATION = /ADR-\d{4}|\$\d/;

/**
 * Suppress cdk-nag findings on a construct and everything beneath it.
 *
 * Prefer the narrowest scope that works: the `CfnResource` itself, or the L2
 * that owns it. Passing a `Stack` suppresses the rule for every resource in the
 * stack and is only appropriate when the finding is genuinely stack-wide.
 */
export function suppressNagRules(scope: IConstruct, suppressions: NagSuppression[]): void {
  for (const suppression of suppressions) {
    assertJustified(suppression);
    scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      [suppression.id]: suppression.reason,
    });
  }
}

/**
 * Suppress findings on a construct addressed by its path within `scope`.
 *
 * Needed for resources an L3 creates on your behalf — BucketDeployment's
 * handler role, the CDK log-retention provider — which have no reference to
 * reach for. Throws when the path does not resolve, so a construct ID that
 * changes under a CDK upgrade fails the build rather than silently leaving the
 * suppression attached to nothing.
 */
export function suppressNagRulesAtPath(
  scope: IConstruct,
  path: string,
  suppressions: NagSuppression[],
): void {
  const target = scope.node.findAll().find((node) => node.node.path === path);
  if (target === undefined) {
    throw new Error(
      `No construct at path "${path}" under "${scope.node.path}". cdk-nag ` +
        "suppressions are addressed by construct path; a stale path silences " +
        "nothing. Run `cdk synth` and copy the path from the finding.",
    );
  }
  suppressNagRules(target, suppressions);
}

/**
 * Render a value the way cdk-nag renders it inside a granular finding ID.
 *
 * cdk-nag resolves the template value and then flattens the CloudFormation
 * intrinsics: `{Ref: X}` becomes `<X>`, `{Fn::GetAtt: [X, Y]}` becomes `<X.Y>`,
 * and `Fn::Join` is concatenated. A CDK token interpolated into a template
 * string does not survive that, so suppression IDs that embed a resource ARN
 * have to be built through this rather than written by hand — a hand-copied
 * logical ID goes stale the moment a construct is renamed.
 */
export function flattenForNagId(scope: IConstruct, value: string): string {
  return flatten(Stack.of(scope).resolve(value));
}

function flatten(node: unknown): string {
  if (node === undefined || node === null) {
    return "";
  }
  if (typeof node === "string") {
    return node.replace(/\$\{/g, "<").replace(/\}/g, ">");
  }
  if (typeof node !== "object") {
    return JSON.stringify(node);
  }

  const record = node as Record<string, unknown>;
  if (Array.isArray(record["Fn::Join"])) {
    const [delimiter, items] = record["Fn::Join"] as [string, unknown[]];
    return items.map(flatten).join(delimiter);
  }
  if (record["Fn::Sub"] !== undefined) {
    return flatten(record["Fn::Sub"]);
  }
  if (Array.isArray(record["Fn::GetAtt"])) {
    const [resource, attribute] = record["Fn::GetAtt"] as [unknown, unknown];
    return `<${flatten(resource)}.${flatten(attribute)}>`;
  }
  if (record["Fn::ImportValue"] !== undefined) {
    return flatten(record["Fn::ImportValue"]);
  }
  if (record["Ref"] !== undefined) {
    return `<${flatten(record["Ref"])}>`;
  }
  return JSON.stringify(node);
}

function assertJustified(suppression: NagSuppression): void {
  if (!CITATION.test(suppression.reason)) {
    throw new Error(
      `cdk-nag suppression "${suppression.id}" must cite an ADR (ADR-0002) or a ` +
        `cost figure ($5/mo) in its reason (ADR-0007). Got: "${suppression.reason}".`,
    );
  }
  if (suppression.reason.length < MIN_REASON_LENGTH) {
    throw new Error(
      `cdk-nag suppression "${suppression.id}" reason is too short to be useful ` +
        `to a reviewer (ADR-0007). Got: "${suppression.reason}".`,
    );
  }
}
