import test from "node:test";
import assert from "node:assert/strict";
import type { PlatformAdapter, PublishInput } from "../src/server/publish/platform-adapter.js";
import { PublishWorkflow } from "../src/server/publish/workflow.js";

test("workflow stops at the first failed stage", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter = {
    platform: "douyin",
    version: "test",
    async runStage(stage) {
      calls.push(stage);
      return stage === "cover"
        ? { stage, status: "failed", detail: "dialog remained open" }
        : { stage, status: "succeeded", detail: stage };
    }
  };
  const input: PublishInput = {
    platform: "douyin",
    accountId: "default-douyin",
    filePath: "video.mp4",
    post: {
      id: "post-1",
      videoId: "video-1",
      platform: "douyin",
      accountId: "default-douyin",
      enabled: true,
      title: "title",
      body: "body",
      hashtags: ["topic"],
      status: "ready",
      lastError: null
    },
    covers: { landscape: "landscape.png", portrait: "portrait.png" }
  };

  const outcome = await new PublishWorkflow(adapter).run(input);

  assert.deepEqual(calls, ["page", "video", "title", "body", "topics", "cover"]);
  assert.equal(outcome.failedStage, "cover");
});

test("workflow rejects Xiaohongshu before running an adapter stage", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter = {
    platform: "douyin",
    version: "test",
    async runStage(stage) {
      calls.push(stage);
      return { stage, status: "succeeded", detail: stage };
    }
  };
  const input = {
    platform: "xiaohongshu",
    accountId: "default-xiaohongshu",
    filePath: "video.mp4",
    post: {
      id: "post-2",
      videoId: "video-1",
      platform: "xiaohongshu",
      accountId: "default-xiaohongshu",
      enabled: true,
      title: "title",
      body: "body",
      hashtags: ["topic"],
      status: "ready",
      lastError: null
    },
    covers: { landscape: "landscape.png", portrait: "portrait.png" }
  } as unknown as PublishInput;

  await assert.rejects(
    new PublishWorkflow(adapter).run(input),
    /Xiaohongshu uses manual-assisted publish mode/
  );
  assert.deepEqual(calls, []);
});

test("workflow honors a complete adapter-specific stage order", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter = {
    platform: "douyin",
    version: "test",
    stageOrder: ["page", "video", "cover", "title", "body", "declaration", "topics"],
    async runStage(stage) {
      calls.push(stage);
      return { stage, status: "succeeded", detail: stage };
    }
  };
  const input: PublishInput = {
    platform: "douyin",
    accountId: "default-douyin",
    filePath: "video.mp4",
    post: {
      id: "post-3",
      videoId: "video-1",
      platform: "douyin",
      accountId: "default-douyin",
      enabled: true,
      title: "title",
      body: "body",
      hashtags: ["topic"],
      status: "ready",
      lastError: null
    },
    covers: { landscape: "landscape.png", portrait: "portrait.png" }
  };

  const outcome = await new PublishWorkflow(adapter).run(input);

  assert.equal(outcome.status, "complete");
  assert.deepEqual(calls, ["page", "video", "cover", "title", "body", "declaration", "topics"]);
});

test("workflow rejects an incomplete adapter-specific stage order before running stages", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter = {
    platform: "douyin",
    version: "test",
    stageOrder: ["page", "video", "title", "body", "cover", "declaration", "topics", "topics"],
    async runStage(stage) {
      calls.push(stage);
      return { stage, status: "succeeded", detail: stage };
    }
  };
  const input: PublishInput = {
    platform: "douyin",
    accountId: "default-douyin",
    filePath: "video.mp4",
    post: {
      id: "post-4",
      videoId: "video-1",
      platform: "douyin",
      accountId: "default-douyin",
      enabled: true,
      title: "title",
      body: "body",
      hashtags: ["topic"],
      status: "ready",
      lastError: null
    },
    covers: { landscape: "landscape.png", portrait: "portrait.png" }
  };

  await assert.rejects(
    new PublishWorkflow(adapter).run(input),
    /must contain every required douyin stage exactly once/
  );
  assert.deepEqual(calls, []);
});
