import { App, Aspects, Stack } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import * as logs from "aws-cdk-lib/aws-logs";
import { LogRetentionAspect } from "../src/index.js";

function newStack(): Stack {
  const app = new App();
  return new Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
}

describe("LogRetentionAspect", () => {
  it("errors on a log group with no explicit retention", () => {
    const stack = newStack();
    new logs.LogGroup(stack, "Logs", { retention: logs.RetentionDays.INFINITE });
    Aspects.of(stack).add(new LogRetentionAspect());

    Annotations.fromStack(stack).hasError(
      "*",
      Match.stringLikeRegexp("no explicit retentionInDays"),
    );
  });

  it("explains the never-expire default", () => {
    const stack = newStack();
    new logs.CfnLogGroup(stack, "Logs", {});
    Aspects.of(stack).add(new LogRetentionAspect());

    Annotations.fromStack(stack).hasError("*", Match.stringLikeRegexp("never expire"));
  });

  it("stays silent when retention is set", () => {
    const stack = newStack();
    new logs.LogGroup(stack, "Logs", { retention: logs.RetentionDays.TWO_WEEKS });
    Aspects.of(stack).add(new LogRetentionAspect());

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });
});
