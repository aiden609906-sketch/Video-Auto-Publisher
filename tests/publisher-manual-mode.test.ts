import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildManualBrowserApps, getPublishMode, shouldSelectAiDeclaration } from "../src/server/publisher.js";

test("xiaohongshu uses manual assisted publish mode", () => {
  assert.equal(getPublishMode("xiaohongshu"), "manual");
});

test("other platforms keep managed browser publish mode", () => {
  assert.equal(getPublishMode("douyin"), "managed");
  assert.equal(getPublishMode("kuaishou"), "managed");
  assert.equal(getPublishMode("bilibili"), "managed");
});

test("AI declaration is selected only for managed video platforms", () => {
  assert.equal(shouldSelectAiDeclaration("douyin"), true);
  assert.equal(shouldSelectAiDeclaration("kuaishou"), true);
  assert.equal(shouldSelectAiDeclaration("bilibili"), true);
  assert.equal(shouldSelectAiDeclaration("xiaohongshu"), false);
});

test("manual publish browser launch uses the selected account profile", () => {
  const profileDir = path.join("data", "browser-profiles", "accounts", "xiaohongshu", "account-123");
  const apps = buildManualBrowserApps(profileDir);

  assert.deepEqual(
    apps.map((app) => app.name),
    ["msedge", "chrome"]
  );
  assert.ok(apps.every((app) => app.arguments.includes(`--user-data-dir=${profileDir}`)));
  assert.ok(apps.every((app) => app.arguments.includes("--no-first-run")));
});
