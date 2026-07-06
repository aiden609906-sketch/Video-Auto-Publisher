import test from "node:test";
import assert from "node:assert/strict";
import { Publisher } from "../src/server/publisher.js";
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

function makePublisherWithPage() {
  const publisher = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const page = {
    goto: async () => undefined,
    bringToFront: async () => undefined
  };

  publisher.copy = async () => undefined;
  publisher.getContext = async () => ({
    pages: () => [page],
    newPage: async () => page
  });
  publisher.installFileChooserGuard = () => () => undefined;
  publisher.hasPublishingForm = async () => true;
  publisher.dismissDouyinTopicList = async () => undefined;
  publisher.tryUploadCover = async () => false;
  publisher.tryFillTitle = async () => true;
  publisher.tryFillBody = async () => true;
  publisher.trySelectAiDeclaration = async () => true;

  return { publisher: publisher as unknown as Publisher, hooks: publisher };
}

test("douyin revalidates body after first body fill reports success", async () => {
  const { publisher, hooks } = makePublisherWithPage();
  let ensureCalls = 0;
  hooks.ensureDouyinBody = async () => {
    ensureCalls += 1;
    return true;
  };

  const result = await publisher.open(
    "douyin",
    "default-douyin",
    "video.mp4",
    makeDouyinPost(),
    { landscape: null, portrait: null }
  );

  assert.equal(ensureCalls, 2);
  assert.equal(result.bodyPrefilled, true);
  assert.equal(result.tagsPrefilled, true);
  assert.equal(result.declarationPrefilled, true);
});

test("douyin reports body fill failure when final body verification fails", async () => {
  const { publisher, hooks } = makePublisherWithPage();
  hooks.ensureDouyinBody = async () => false;

  const result = await publisher.open(
    "douyin",
    "default-douyin",
    "video.mp4",
    makeDouyinPost(),
    { landscape: null, portrait: null }
  );

  assert.equal(result.bodyPrefilled, false);
  assert.equal(result.tagsPrefilled, false);
  assert.equal(result.declarationPrefilled, true);
});

test("douyin keeps fallback body fill when first body fill fails", async () => {
  const { publisher, hooks } = makePublisherWithPage();
  let ensureCalls = 0;
  hooks.tryFillBody = async () => false;
  hooks.ensureDouyinBody = async () => {
    ensureCalls += 1;
    return true;
  };

  const result = await publisher.open(
    "douyin",
    "default-douyin",
    "video.mp4",
    makeDouyinPost(),
    { landscape: null, portrait: null }
  );

  assert.equal(ensureCalls, 2);
  assert.equal(result.bodyPrefilled, true);
  assert.equal(result.tagsPrefilled, true);
  assert.equal(result.declarationPrefilled, true);
});

test("douyin fills text before starting slow cover upload", async () => {
  const { publisher, hooks } = makePublisherWithPage();
  const calls: string[] = [];

  hooks.tryUploadCover = async () => {
    calls.push("cover");
    return true;
  };
  hooks.tryFillTitle = async () => {
    calls.push("title");
    return true;
  };
  hooks.tryFillBody = async () => {
    calls.push("body");
    return true;
  };
  hooks.ensureDouyinBody = async () => {
    calls.push("verify-body");
    return true;
  };
  hooks.trySelectAiDeclaration = async () => {
    calls.push("declaration");
    return true;
  };

  await publisher.open("douyin", "default-douyin", "video.mp4", makeDouyinPost(), {
    landscape: "cover.png",
    portrait: null
  });

  assert.deepEqual(calls, ["title", "body", "verify-body", "cover", "verify-body", "declaration"]);
});

test("douyin cover upload fails when editor does not close after clicking complete", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.openDouyinCoverEditor = async () => true;
  hooks.clickDouyinCoverEditorText = async (_page: unknown, label: string) => {
    calls.push(`click:${label}`);
    return true;
  };
  hooks.uploadDouyinCoverFile = async () => {
    calls.push("upload-file");
    return true;
  };
  hooks.waitForDouyinCoverApplied = async () => {
    calls.push("wait-applied");
    return true;
  };
  hooks.waitForCoverDialogClosed = async () => {
    calls.push("wait-closed");
    return false;
  };

  const uploaded = await (hooks.uploadDouyinCovers as (page: unknown, covers: { landscape: string | null; portrait: string | null }) => Promise<boolean>)(
    page,
    { landscape: "cover.png", portrait: null }
  );

  assert.equal(uploaded, false);
  assert.ok(calls.includes("wait-applied"));
  assert.ok(calls.includes("wait-closed"));
});

test("douyin body fill accepts verified intro and topics", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.tryFillDouyinIntro = async () => true;
  hooks.tryFillDouyinTopics = async () => true;

  const filled = await (hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost, timeoutMs: number) => Promise<boolean>)(
    page,
    "douyin",
    makeDouyinPost(),
    10_000
  );

  assert.equal(filled, true);
});

test("douyin topic fill uses inline picker when no standalone topic input exists", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const added = new Set<string>();
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.hasDouyinTopic = async (_page: unknown, tag: string) => added.has(tag);
  hooks.findDouyinTopicInput = async () => null;
  hooks.tryFillDouyinInlineTopic = async (_page: unknown, tag: string) => {
    calls.push(`inline:${tag}`);
    added.add(tag);
    return true;
  };
  hooks.openDouyinTopicInput = async () => {
    calls.push("open-topic");
    return true;
  };

  const filled = await (hooks.tryFillDouyinTopics as (page: unknown, hashtags: string[], timeoutMs: number) => Promise<boolean>)(
    page,
    ["tag-one", "tag-two"],
    10_000
  );

  assert.equal(filled, true);
  assert.deepEqual(calls, ["inline:tag-one", "inline:tag-two"]);
});

test("douyin topic fill sends at most five unique topics", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const added = new Set<string>();
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.hasDouyinTopic = async (_page: unknown, tag: string) => added.has(tag);
  hooks.findDouyinTopicInput = async () => null;
  hooks.tryFillDouyinInlineTopic = async (_page: unknown, tag: string) => {
    calls.push(tag);
    added.add(tag);
    return true;
  };

  const filled = await (hooks.tryFillDouyinTopics as (page: unknown, hashtags: string[], timeoutMs: number) => Promise<boolean>)(
    page,
    ["tag-one", "#tag-two", "tag-three", "tag-four", "tag-five", "tag-six", "TAG-TWO"],
    10_000
  );

  assert.equal(filled, true);
  assert.deepEqual(calls, ["tag-one", "tag-two", "tag-three", "tag-four", "tag-five"]);
});

test("douyin body fill fails when intro cannot be verified", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.tryFillDouyinIntro = async () => false;
  hooks.tryFillDouyinTopics = async () => true;

  const filled = await (hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost, timeoutMs: number) => Promise<boolean>)(
    page,
    "douyin",
    makeDouyinPost(),
    10_000
  );

  assert.equal(filled, false);
});

test("douyin AI declaration confirms the modal after selecting the AI generated option", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const clickedLabels: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.closeTransientMenus = async () => undefined;
  hooks.scrollDeclarationSectionIntoView = async () => undefined;
  hooks.selectAiDeclarationByDom = async () => true;
  hooks.clickVisibleDialogText = async (_page: unknown, label: string) => {
    clickedLabels.push(label);
    return label === "\u786e\u5b9a";
  };

  const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
    page,
    "douyin"
  );

  assert.equal(selected, true);
  assert.deepEqual(clickedLabels, ["\u786e\u5b9a"]);
});

test("AI declaration falls back to declaration labels before selecting the AI generated option", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.closeTransientMenus = async () => undefined;
  hooks.scrollDeclarationSectionIntoView = async () => undefined;
  hooks.selectAiDeclarationByDom = async () => {
    calls.push("dom");
    return false;
  };
  hooks.clickVisibleText = async (_page: unknown, label: string) => {
    calls.push(`label:${label}`);
    return label === "\u4f5c\u8005\u58f0\u660e";
  };
  hooks.clickAiGeneratedOption = async () => {
    calls.push("ai-option");
    return true;
  };
  hooks.clickVisibleDialogText = async (_page: unknown, label: string) => {
    calls.push(`dialog:${label}`);
    return label === "\u786e\u5b9a";
  };

  const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
    page,
    "douyin"
  );

  assert.equal(selected, true);
  assert.deepEqual(calls, ["dom", "label:\u4f5c\u8005\u58f0\u660e", "dom", "ai-option", "dialog:\u786e\u5b9a"]);
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

test("douyin body verification tolerates editor helper text after successful paste", () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const expected = "body text #tag-one #tag-two";
  const actual = `${expected}\n#add topic    @friend\nrecommend  #magic`;

  const matches = (hooks.editorTextMatchesExpected as (actual: string, expected: string) => boolean)(actual, expected);

  assert.equal(matches, true);
});
