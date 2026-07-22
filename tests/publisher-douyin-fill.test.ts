import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  await context.addInitScript((readyFixture) => {
    document.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
      setTimeout(() => {
        document.body.innerHTML = readyFixture;
        document.querySelector(".wrapper-MLZdnB .selectText-XSrMFZ")?.setAttribute("aria-checked", "true");
        document.querySelector(".content-confirm-container-Wp91G7 button.primary-cECiOJ")?.addEventListener(
          "click",
          () => document.documentElement.setAttribute("data-publish-clicked", "true")
        );
      }, 100);
    });
  }, fixture);
  await context.route("https://creator.douyin.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
    })
  );
  const dependencies: PublisherDependencies = {
    copy: async () => undefined,
    getContext: async () => context
  };
  const publisher = new Publisher("profiles", true, dependencies);
  let legacyDouyinDeclarationCalls = 0;
  (publisher as unknown as { trySelectAiDeclaration: () => Promise<boolean> }).trySelectAiDeclaration = async () => {
    legacyDouyinDeclarationCalls += 1;
    return true;
  };
  const post = makeDouyinPost();
  post.hashtags = [];
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");

  try {
    const result = await publisher.open(
      "douyin",
      "default-douyin",
      videoPath,
      post,
      { landscape: null, portrait: null }
    );

    assert.equal(result.status, "complete");
    assert.equal(result.adapterVersion, "2026.07.21-v3-state-machine-8");
    assert.deepEqual(result.stages.map((stage) => stage.stage), [
      "page",
      "video",
      "cover",
      "title",
      "body",
      "declaration",
      "topics"
    ]);
    assert.equal(result.titlePrefilled, true);
    assert.equal(result.bodyPrefilled, true);
    assert.equal(result.declarationPrefilled, true);
    assert.equal(legacyDouyinDeclarationCalls, 0);
    assert.equal(await context.pages()[0].locator("html").getAttribute("data-publish-clicked"), null);
  } finally {
    await context.close();
    await browser.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin cover readiness ignores unrelated AI recommendation generation", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  try {
    await page.setContent(`
      <div role="dialog">
        <div class="ai-cover-recommendation">生成中</div>
        <div class="preview-m5zWH5">
          <img alt="uploaded cover" style="width:120px;height:90px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90'/%3E">
        </div>
      </div>
    `);

    const ready = await (hooks.waitForDouyinCoverApplied as (page: unknown, timeoutMs: number) => Promise<boolean>)(
      page,
      50
    );

    assert.equal(ready, true);
  } finally {
    await page.close();
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
    calls.push("unexpected-generic-dom-selection");
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
  hooks.saveKuaishouCoverDebugSnapshot = async () => undefined;
  hooks.confirmKuaishouCoverDialog = async () => {
    calls.push("confirm-cover-dialog");
    return true;
  };
  hooks.waitForKuaishouCoverDialogClosed = async (_page: unknown, timeoutMs: number) => {
    calls.push(`wait-dialog-closed:${timeoutMs}`);
    return true;
  };
  hooks.waitForKuaishouMainCoverChange = async () => true;

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, true);
  assert.deepEqual(calls, ["upload-cover-file", "wait-upload-preview", "confirm-cover-dialog", "wait-dialog-closed:30000"]);
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
  hooks.saveKuaishouCoverDebugSnapshot = async () => undefined;
  hooks.confirmKuaishouCoverDialog = async () => true;
  hooks.waitForKuaishouCoverDialogClosed = async () => true;
  hooks.waitForKuaishouMainCoverChange = async () => false;

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, false);
});

test("kuaishou accepts a changed blob cover without waiting for CDN replacement", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  hooks.kuaishouMainCoverSignature = async () => "blob:https://cp.kuaishou.com/applied-cover";
  const page = {
    waitForTimeout: async () => {
      throw new Error("changed cover should return immediately");
    }
  };

  const changed = await (
    hooks.waitForKuaishouMainCoverChange as (page: unknown, beforeCover: string | null, timeoutMs: number) => Promise<boolean>
  )(page, "https://cdn.example.com/old-cover.png", 10_000);

  assert.equal(changed, true);
});

test("kuaishou confirmation delegates processing wait to the dialog-close verifier", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  hooks.hasKuaishouCoverDialog = async () => true;
  hooks.kuaishouCoverDialogPreviewSignature = async () => "blob:https://cp.kuaishou.com/uploaded-cover";
  hooks.clickKuaishouCoverConfirmButton = async () => true;
  const page = {
    waitForTimeout: async () => {
      throw new Error("confirmation click should not add a separate processing wait");
    }
  };

  const confirmed = await (
    hooks.confirmKuaishouCoverDialog as (page: unknown) => Promise<boolean>
  )(page);

  assert.equal(confirmed, true);
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
  hooks.saveKuaishouCoverDebugSnapshot = async () => undefined;
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
  hooks.clickBilibiliCoverCompleteButton = async () => false;
  hooks.waitForBilibiliCoverEditorClosed = async () => false;

  const uploaded = await (hooks.uploadBilibiliCovers as (page: unknown, covers: { landscape: string | null; portrait: string | null }) => Promise<boolean>)(
    page,
    { landscape: "cover.png", portrait: null }
  );

  assert.equal(uploaded, false);
  assert.deepEqual(uploadedFiles, ["cover.png", "cover.png"]);
});

test("bilibili completes its custom cover editor after both covers are uploaded", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const uploadedFiles: string[] = [];
  const input = {
    setInputFiles: async (file: string) => {
      uploadedFiles.push(file);
    }
  };

  try {
    await page.setContent(`
      <div class="bilibili-cover-editor" style="position:fixed;inset:20px;background:white">
        <h2>封面制作</h2>
        <div>首页推荐封面（4:3）</div>
        <div>个人空间封面（16:9）</div>
        <button id="cover-complete" style="position:absolute;right:24px;bottom:24px">完成</button>
      </div>
      <script>
        document.querySelector('#cover-complete').addEventListener('click', () => {
          document.documentElement.setAttribute('data-cover-completed', 'true');
          document.querySelector('.bilibili-cover-editor').remove();
        });
      </script>
    `);
    hooks.openCoverPanel = async () => undefined;
    hooks.waitForImageInputs = async () => [input, input];
    hooks.clickVisibleDialogText = async () => false;
    hooks.clickVisibleButton = async () => false;

    const uploaded = await (
      hooks.uploadBilibiliCovers as (
        page: unknown,
        covers: { landscape: string | null; portrait: string | null }
      ) => Promise<boolean>
    )(page, { landscape: "cover.png", portrait: null });

    assert.equal(uploaded, true);
    assert.deepEqual(uploadedFiles, ["cover.png", "cover.png"]);
    assert.equal(await page.locator("html").getAttribute("data-cover-completed"), "true");
    assert.equal(await page.locator(".bilibili-cover-editor").count(), 0);
  } finally {
    await browser.close();
  }
});
