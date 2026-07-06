import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultAccountId, ensureDefaultAccounts, getProfileDir } from "../src/server/account-matrix.js";
import { Store } from "../src/server/store.js";
import type { AppData, PlatformPost } from "../src/shared/types.js";

test("ensureDefaultAccounts creates one stable default account per platform", () => {
  const now = "2026-06-19T00:00:00.000Z";
  const accounts = ensureDefaultAccounts([], now);

  assert.equal(accounts.length, 4);
  assert.deepEqual(
    accounts.map((account) => [account.platform, account.id, account.name, account.isDefault]),
    [
      ["douyin", "default-douyin", "默认账号", true],
      ["xiaohongshu", "default-xiaohongshu", "默认账号", true],
      ["kuaishou", "default-kuaishou", "默认账号", true],
      ["bilibili", "default-bilibili", "默认账号", true]
    ]
  );
});

test("getProfileDir keeps legacy profile path for default accounts and isolates extra accounts", () => {
  const root = path.join("data", "browser-profiles");

  assert.equal(getProfileDir(root, "douyin", defaultAccountId("douyin")), path.join(root, "douyin"));
  assert.equal(getProfileDir(root, "douyin", "account-123"), path.join(root, "accounts", "douyin", "account-123"));
});

test("store migration assigns old posts to the matching platform default account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "account-matrix-"));
  const stateFile = path.join(dir, "state.json");
  try {
    const oldPost: Omit<PlatformPost, "accountId"> = {
      id: randomUUID(),
      videoId: "video-1",
      platform: "douyin",
      enabled: true,
      title: "title",
      body: "body",
      hashtags: [],
      status: "ready",
      lastError: null
    };
    const oldData = {
      version: 1,
      videos: [
        {
          id: "video-1",
          filePath: "video.mp4",
          filename: "video.mp4",
          size: 100,
          sha256: "abc",
          status: "ready",
          note: "",
          covers: { landscape: null, portrait: null },
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          posts: [oldPost]
        }
      ],
      settings: {
        defaultStyle: "style",
        defaultPlatforms: ["douyin"]
      }
    };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile, JSON.stringify(oldData), "utf8"));

    const store = new Store(stateFile);
    await store.init();

    const video = store.getVideo("video-1");
    assert.equal(video?.posts[0].accountId, defaultAccountId("douyin"));
    assert.equal(store.listAccounts().find((account) => account.id === defaultAccountId("douyin"))?.platform, "douyin");

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as AppData;
    assert.equal(persisted.videos[0].posts[0].accountId, defaultAccountId("douyin"));
    assert.ok(persisted.accounts.some((account) => account.id === defaultAccountId("douyin")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
