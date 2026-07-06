import test from "node:test";
import assert from "node:assert/strict";
import { resolvePublishAccount } from "../src/server/publish-account.js";
import type { AccountProfile, PlatformPost } from "../src/shared/types.js";

const post: PlatformPost = {
  id: "post-1",
  videoId: "video-1",
  platform: "xiaohongshu",
  accountId: "default-xiaohongshu",
  enabled: true,
  title: "",
  body: "",
  hashtags: [],
  status: "ready",
  lastError: null
};

const defaultAccount: AccountProfile = {
  id: "default-xiaohongshu",
  platform: "xiaohongshu",
  name: "默认账号",
  isDefault: true,
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z"
};

const extraAccount: AccountProfile = {
  id: "extra-xhs",
  platform: "xiaohongshu",
  name: "矩阵账号",
  isDefault: false,
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z"
};

test("publish account can be overridden by request account id", () => {
  const account = resolvePublishAccount(post, "extra-xhs", (id) => (id === "extra-xhs" ? extraAccount : defaultAccount));

  assert.equal(account.id, "extra-xhs");
});

test("publish account falls back to saved post account when request has no account id", () => {
  const account = resolvePublishAccount(post, "", (id) => (id === "extra-xhs" ? extraAccount : defaultAccount));

  assert.equal(account.id, "default-xiaohongshu");
});

test("publish account override must belong to the post platform", () => {
  assert.throws(
    () =>
      resolvePublishAccount(post, "douyin-account", () => ({
        ...extraAccount,
        id: "douyin-account",
        platform: "douyin"
      })),
    /账号不属于当前平台/
  );
});
