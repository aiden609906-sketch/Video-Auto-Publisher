import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { Publisher, type PublisherDependencies } from "../src/server/publisher.js";
import type { PlatformPost } from "../src/shared/types.js";

function makeDouyinPost(): PlatformPost {
  return {
    id: "post-1",
    videoId: "video-1",
    platform: "douyin",
    accountId: "default-douyin",
    enabled: true,
    title: "test title",
    body: "test body",
    hashtags: ["tag-one", "tag-two"],
    status: "ready",
    lastError: null
  };
}

test("Publisher.open delegates Douyin to the V3 workflow and derives legacy compatibility fields", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  const fixture = await readFile(path.resolve("tests/fixtures/publisher/douyin/ready-before-publish.html"), "utf8");
  await context.route("https://creator.douyin.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture })
  );
  const dependencies: PublisherDependencies = {
    copy: async () => undefined,
    getContext: async () => context
  };
  const publisher = new Publisher("profiles", true, dependencies);
  const post = makeDouyinPost();
  post.hashtags = [];

  try {
    const result = await publisher.open(
      "douyin",
      "default-douyin",
      "video.mp4",
      post,
      { landscape: null, portrait: null }
    );

    assert.equal(result.status, "complete");
    assert.equal(result.adapterVersion, "2026.07.20-v3-state-machine-1");
    assert.deepEqual(result.stages.map((stage) => stage.stage), [
      "page",
      "video",
      "title",
      "body",
      "topics",
      "cover",
      "declaration",
      "ready"
    ]);
    assert.equal(result.titlePrefilled, true);
    assert.equal(result.bodyPrefilled, true);
    assert.equal(result.declarationPrefilled, true);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("kuaishou AI declaration opens the author declaration dropdown before selecting", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  let opened = false;
  let selectedOption = false;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.closeTransientMenus = async () => undefined;
  hooks.scrollDeclarationSectionIntoView = async () => undefined;
  hooks.selectAiDeclarationByDom = async () => {
    calls.push(opened ? "dom-after-open" : "dom-before-open");
    return false;
  };
  hooks.clickKuaishouAuthorDeclarationControl = async () => {
    calls.push("open-kuaishou-author-declaration");
    opened = true;
    return true;
  };
  hooks.clickKuaishouAiGeneratedOption = async () => {
    calls.push(opened ? "click-kuaishou-ai-option" : "click-kuaishou-ai-before-open");
    selectedOption = opened;
    return selectedOption;
  };
  hooks.hasKuaishouAiDeclarationSelected = async () => {
    calls.push(selectedOption ? "verify-selected" : "verify-empty");
    return selectedOption;
  };
  hooks.clickVisibleText = async () => {
    calls.push("generic-label");
    return false;
  };
  hooks.clickAiGeneratedOption = async () => {
    calls.push("generic-ai-option");
    return false;
  };

  const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
    page,
    "kuaishou"
  );

  assert.equal(selected, true);
  assert.deepEqual(calls, [
    "verify-empty",
    "open-kuaishou-author-declaration",
    "dom-after-open",
    "click-kuaishou-ai-option",
    "verify-selected"
  ]);
});

test("kuaishou AI declaration does not report success when the author row remains unselected", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.closeTransientMenus = async () => undefined;
  hooks.scrollDeclarationSectionIntoView = async () => undefined;
  hooks.hasKuaishouAiDeclarationSelected = async () => false;
  hooks.clickKuaishouAuthorDeclarationControl = async () => true;
  hooks.selectAiDeclarationByDom = async () => true;
  hooks.clickKuaishouAiGeneratedOption = async () => true;
  hooks.clickVisibleText = async () => true;
  hooks.clickAiGeneratedOption = async () => true;

  const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
    page,
    "kuaishou"
  );

  assert.equal(selected, false);
});

test("kuaishou AI declaration waits for the selected value to settle after clicking", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  let verifyCalls = 0;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.closeTransientMenus = async () => undefined;
  hooks.scrollDeclarationSectionIntoView = async () => undefined;
  hooks.clickKuaishouAuthorDeclarationControl = async () => {
    calls.push("open");
    return true;
  };
  hooks.selectAiDeclarationByDom = async () => {
    calls.push("select-dom");
    return true;
  };
  hooks.clickKuaishouAiGeneratedOption = async () => {
    calls.push("click-option");
    return true;
  };
  hooks.hasKuaishouAiDeclarationSelected = async () => {
    verifyCalls += 1;
    calls.push(`verify-${verifyCalls}`);
    return verifyCalls >= 4;
  };

  const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
    page,
    "kuaishou"
  );

  assert.equal(selected, true);
  assert.ok(calls.includes("verify-4"));
});

test("kuaishou cover upload only succeeds after the cover dialog is confirmed and closed", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.scrollCoverSectionIntoView = async () => undefined;
  hooks.kuaishouMainCoverSignature = async () => "before";
  hooks.openKuaishouCoverDialog = async () => true;
  hooks.uploadKuaishouCoverFile = async () => {
    calls.push("upload-cover-file");
    return true;
  };
  hooks.waitForKuaishouCoverUploadPreview = async () => {
    calls.push("wait-upload-preview");
    return true;
  };
  hooks.confirmKuaishouCoverDialog = async () => {
    calls.push("confirm-cover-dialog");
    return true;
  };
  hooks.waitForKuaishouCoverDialogClosed = async () => {
    calls.push("wait-dialog-closed");
    return true;
  };
  hooks.waitForKuaishouMainCoverChange = async () => true;

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, true);
  assert.deepEqual(calls, ["upload-cover-file", "wait-upload-preview", "confirm-cover-dialog", "wait-dialog-closed"]);
});

test("kuaishou cover upload reports failure when the main cover does not verify", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.scrollCoverSectionIntoView = async () => undefined;
  hooks.kuaishouMainCoverSignature = async () => "before";
  hooks.openKuaishouCoverDialog = async () => true;
  hooks.uploadKuaishouCoverFile = async () => true;
  hooks.waitForKuaishouCoverUploadPreview = async () => true;
  hooks.confirmKuaishouCoverDialog = async () => true;
  hooks.waitForKuaishouCoverDialogClosed = async () => true;
  hooks.waitForKuaishouMainCoverChange = async () => false;

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, false);
});

test("kuaishou cover upload waits for the uploaded preview before confirming", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.scrollCoverSectionIntoView = async () => undefined;
  hooks.kuaishouMainCoverSignature = async () => "before";
  hooks.openKuaishouCoverDialog = async () => true;
  hooks.uploadKuaishouCoverFile = async () => {
    calls.push("upload-cover-file");
    return true;
  };
  hooks.waitForKuaishouCoverUploadPreview = async () => {
    calls.push("wait-upload-preview");
    return true;
  };
  hooks.confirmKuaishouCoverDialog = async () => {
    calls.push("confirm-cover-dialog");
    return true;
  };
  hooks.waitForKuaishouCoverDialogClosed = async () => true;
  hooks.waitForKuaishouMainCoverChange = async () => true;

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, true);
  assert.deepEqual(calls, ["upload-cover-file", "wait-upload-preview", "confirm-cover-dialog"]);
});

test("bilibili cover upload fails when the cover editor cannot be completed", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const uploadedFiles: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };
  const input = {
    setInputFiles: async (file: string) => {
      uploadedFiles.push(file);
    }
  };

  hooks.openCoverPanel = async () => undefined;
  hooks.waitForImageInputs = async () => [input, input];
  hooks.clickVisibleDialogText = async () => false;
  hooks.clickVisibleButton = async () => false;
  hooks.waitForCoverDialogClosed = async () => false;

  const uploaded = await (hooks.uploadBilibiliCovers as (page: unknown, covers: { landscape: string | null; portrait: string | null }) => Promise<boolean>)(
    page,
    { landscape: "cover.png", portrait: null }
  );

  assert.equal(uploaded, false);
  assert.deepEqual(uploadedFiles, ["cover.png", "cover.png"]);
});
