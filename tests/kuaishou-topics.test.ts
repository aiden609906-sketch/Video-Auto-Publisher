import test from "node:test";
import assert from "node:assert/strict";
import { hashtagsForPlatform, Publisher } from "../src/server/publisher.js";
import type { PlatformPost } from "../src/shared/types.js";

test("kuaishou keeps at most four normalized unique topics", () => {
  assert.deepEqual(
    hashtagsForPlatform("kuaishou", [" one ", "#two", "", "one", "three", "four", "five"]),
    ["one", "two", "three", "four"]
  );
});

test("kuaishou topic limit does not cap other platforms", () => {
  assert.deepEqual(
    hashtagsForPlatform("bilibili", ["one", "two", "three", "four", "five"]),
    ["one", "two", "three", "four", "five"]
  );
});

test("kuaishou body receives only four topics", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  let filled = "";
  hooks.tryFillWithRetry = async (_page: unknown, _selectors: string[], value: string) => {
    filled = value;
    return true;
  };
  const post: PlatformPost = {
    id: "post-1",
    videoId: "video-1",
    platform: "kuaishou",
    accountId: "default-kuaishou",
    enabled: true,
    title: "title",
    body: "body",
    hashtags: ["one", "two", "three", "four", "five"],
    status: "ready",
    lastError: null
  };

  const result = await (
    hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost) => Promise<boolean>
  )({}, "kuaishou", post);

  assert.equal(result, true);
  assert.equal(filled, "title\nbody\n#one #two #three #four");
});

test("other platforms do not merge the title into the body", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  let filled = "";
  hooks.tryFillWithRetry = async (_page: unknown, _selectors: string[], value: string) => {
    filled = value;
    return true;
  };
  const post: PlatformPost = {
    id: "post-1",
    videoId: "video-1",
    platform: "bilibili",
    accountId: "default-bilibili",
    enabled: true,
    title: "title",
    body: "body",
    hashtags: ["topic"],
    status: "ready",
    lastError: null
  };

  await (
    hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost) => Promise<boolean>
  )({}, "bilibili", post);

  assert.equal(filled, "body\n#topic");
});
