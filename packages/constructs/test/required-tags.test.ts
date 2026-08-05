import { App, AspectPriority, Aspects, Stack, Tags } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { RequiredTagsAspect } from "../src/index.js";

function newStack(): Stack {
  const app = new App();
  return new Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
}

/** Must run after the mutating Tags aspects, or nothing has been tagged yet. */
function addAspect(stack: Stack, aspect: RequiredTagsAspect): void {
  Aspects.of(stack).add(aspect, { priority: AspectPriority.READONLY });
}

describe("RequiredTagsAspect", () => {
  it("stays silent when all three tags are present", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket");
    Tags.of(bucket).add("app", "platform");
    Tags.of(bucket).add("env", "dev");
    Tags.of(bucket).add("owner", "josephkan");
    addAspect(stack, new RequiredTagsAspect());

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("errors naming the missing key when owner is absent", () => {
    const stack = newStack();
    const bucket = new s3.Bucket(stack, "Bucket");
    Tags.of(bucket).add("app", "platform");
    Tags.of(bucket).add("env", "dev");
    addAspect(stack, new RequiredTagsAspect());

    Annotations.fromStack(stack).hasError(
      "*",
      Match.stringLikeRegexp("Missing required tag\\(s\\): owner"),
    );
  });

  it("errors listing every missing key when untagged", () => {
    const stack = newStack();
    new sqs.Queue(stack, "Queue");
    addAspect(stack, new RequiredTagsAspect());

    Annotations.fromStack(stack).hasError(
      "*",
      Match.stringLikeRegexp("Missing required tag\\(s\\): app, env, owner"),
    );
  });

  it("skips resource types in excludeResourceTypes", () => {
    const stack = newStack();
    new sqs.Queue(stack, "Queue");
    addAspect(stack, new RequiredTagsAspect({ excludeResourceTypes: ["AWS::SQS::Queue"] }));

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("accepts tags applied at stack scope", () => {
    const stack = newStack();
    new sqs.Queue(stack, "Queue");
    Tags.of(stack).add("app", "platform");
    Tags.of(stack).add("env", "dev");
    Tags.of(stack).add("owner", "josephkan");
    addAspect(stack, new RequiredTagsAspect());

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });

  it("does not flag the stack itself, which is taggable but not a resource", () => {
    const stack = newStack();
    addAspect(stack, new RequiredTagsAspect());

    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
  });
});
