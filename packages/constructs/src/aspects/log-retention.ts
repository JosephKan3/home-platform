/**
 * LogRetentionAspect — no log group may rely on the CloudWatch default.
 */

import { Annotations } from "aws-cdk-lib";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import type { IAspect } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export class LogRetentionAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnLogGroup)) {
      return;
    }
    if (node.retentionInDays !== undefined) {
      return;
    }
    Annotations.of(node).addError(
      "Log group has no explicit retentionInDays. CloudWatch defaults to " +
        '"never expire", which is the most common silent cost leak in an AWS ' +
        "account. Set retention from the environment profile in @platform/config.",
    );
  }
}
