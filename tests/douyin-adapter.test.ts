import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { DouyinAdapter } from "../src/server/publish/adapters/douyin.js";
import type { PublishInput } from "../src/server/publish/platform-adapter.js";

const FIXTURE_DIR = path.resolve("tests/fixtures/publisher/douyin");
let browser: Browser;

before(async () => {
  browser = await chromium.launch({ channel: "msedge", headless: true });
});

after(async () => {
  await browser.close();
});

function makeInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    platform: "douyin",
    accountId: "default-douyin",
    filePath: "video.mp4",
    post: {
      id: "post-1",
      videoId: "video-1",
      platform: "douyin",
      accountId: "default-douyin",
      enabled: true,
      title: "normalized title",
      body: "first line\nsecond line",
      hashtags: ["topic-one"],
      status: "ready",
      lastError: null
    },
    covers: { landscape: null, portrait: null },
    ...overrides
  };
}

async function fixturePage(browser: Browser, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.setContent(await readFile(path.join(FIXTURE_DIR, name), "utf8"));
  return page;
}

async function combinedFixturePage(browser: Browser, names: string[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const fragments = await Promise.all(names.map((name) => readFile(path.join(FIXTURE_DIR, name), "utf8")));
  await page.setContent(fragments.join("\n"));
  return page;
}

test("douyin body succeeds only when the normalized body is readable from the scoped editor", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const result = await new DouyinAdapter(page).runStage("body", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(
      await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').innerText(),
      "first line\nsecond line"
    );
  } finally {
    await page.close();
  }
});

test("douyin body fails with bounded safe evidence when the scoped editor does not retain the expected body", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').evaluate((editor) => {
      editor.addEventListener("input", () => editor.replaceChildren(document.createTextNode("unexpected value")));
    });

    const result = await new DouyinAdapter(page).runStage("body", makeInput());

    assert.equal(result.status, "failed");
    assert.match(result.detail, /normalizedLength=16/);
    assert.doesNotMatch(result.detail, /unexpected value|first line/i);
  } finally {
    await page.close();
  }
});

test("douyin title succeeds only when the scoped title input contains the expected value", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const result = await new DouyinAdapter(page).runStage("title", makeInput());

    assert.equal(result.status, "succeeded");
    assert.equal(
      await page.locator('[data-publisher-fixture-scope] .editor-kit-root-container input[type="text"]').inputValue(),
      "normalized title"
    );
  } finally {
    await page.close();
  }
});

test("douyin topics succeed only when every expected topic is a visible scoped chip", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "topic-picker-open.html"]);
  try {
    await page.evaluate(() => {
      const popup = document.querySelector('[class*="mention-suggest-item-container"]') as HTMLElement | null;
      const option = document.querySelector('[class*="mention-suggest-item-container"] [class*="tag-hash-"]');
      const optionName = option?.querySelector('[class*="tag-hash-view-name"]');
      if (!popup || !option || !optionName) throw new Error("fixture topic option missing");
      popup.style.display = "none";
      setTimeout(() => popup.style.removeProperty("display"), 300);
      optionName.textContent = "topic-one";
      option.addEventListener("click", () => {
        const editor = document.querySelector('[data-publisher-fixture-scope] [data-slate-editor]');
        if (!editor) throw new Error("fixture editor missing");
        const mention = document.createElement("span");
        mention.setAttribute("data-mention", "fixture");
        mention.textContent = "#topic-one";
        editor.append(mention);
      });
    });

    const result = await new DouyinAdapter(page).runStage("topics", makeInput());

    assert.equal(result.status, "succeeded");
    assert.equal(
      await page.locator('[data-publisher-fixture-scope] [data-slate-editor] [data-mention]').innerText(),
      "#topic-one"
    );
  } finally {
    await page.close();
  }
});

test("douyin topics cap unique expected chips at five", async () => {
  const page = await fixturePage(browser, "ready-before-publish.html");
  try {
    await page.evaluate(() => {
      const editor = document.querySelector('[data-publisher-fixture-scope] [data-slate-editor]');
      const existing = editor?.querySelector('[data-mention]');
      if (!editor || !existing) throw new Error("fixture topic chip missing");
      existing.remove();
      for (let index = 1; index <= 5; index += 1) {
        const mention = document.createElement("span");
        mention.setAttribute("data-mention", "fixture");
        mention.textContent = `#topic-${index}`;
        editor.append(mention);
      }
    });
    const input = makeInput();
    input.post.hashtags = ["topic-1", "topic-2", "topic-3", "topic-4", "topic-5", "topic-6", "TOPIC-2"];

    const result = await new DouyinAdapter(page).runStage("topics", input);

    assert.equal(result.status, "succeeded");
    assert.equal(result.evidence?.expectedTopics, 5);
  } finally {
    await page.close();
  }
});

test("douyin cover succeeds only after the applied signature changes and the editor closes", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-cover-"));
  const coverPath = path.join(tempDir, "cover.png");
  await writeFile(coverPath, "fixture");
  try {
    const coverApplied = await readFile(path.join(FIXTURE_DIR, "cover-applied.html"), "utf8");
    const ready = await readFile(path.join(FIXTURE_DIR, "ready-before-publish.html"), "utf8");
    await page.evaluate(
      ({ coverApplied, ready }) => {
        const editor = document.querySelector('[data-publisher-fixture-scope].dy-creator-content-modal-content');
        const upload = editor?.querySelector('input.semi-upload-hidden-input');
        if (!editor || !upload) throw new Error("cover fixture controls missing");
        upload.addEventListener("change", () => {
          const appliedDocument = new DOMParser().parseFromString(coverApplied, "text/html");
          const appliedEditor = appliedDocument.body.firstElementChild;
          if (!appliedEditor) throw new Error("applied cover fixture missing");
          editor.replaceWith(appliedEditor);

          const complete = Array.from(appliedEditor.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "完成"
          );
          if (!complete) throw new Error("complete control missing");
          complete.addEventListener("click", () => {
            const readyDocument = new DOMParser().parseFromString(ready, "text/html");
            const appliedCover = readyDocument.querySelector(".content-upload-new");
            const currentCover = document.querySelector(
              '[data-publisher-fixture-scope].form-container-MDtobK .content-upload-new'
            );
            if (!appliedCover || !currentCover) throw new Error("main cover fixture missing");
            currentCover.replaceWith(appliedCover);
            appliedEditor.remove();
          });
        });
      },
      { coverApplied, ready }
    );
    const input = makeInput();
    input.covers.landscape = coverPath;

    const result = await new DouyinAdapter(page).runStage("cover", input);

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('[data-publisher-fixture-scope].dy-creator-content-modal-content').count(), 0);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin declaration succeeds only after the AI radio is checked and its modal closes", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "declaration-modal-open.html"]);
  try {
    const selectedModal = await readFile(path.join(FIXTURE_DIR, "declaration-selected.html"), "utf8");
    const ready = await readFile(path.join(FIXTURE_DIR, "ready-before-publish.html"), "utf8");
    await page.evaluate(
      ({ selectedModal, ready }) => {
        const modal = document.querySelector('[data-publisher-fixture-scope].semi-modal');
        const aiLabel = Array.from(modal?.querySelectorAll("label.semi-radio") || []).find((label) =>
          label.textContent?.includes("内容由AI生成")
        );
        if (!modal || !aiLabel) throw new Error("declaration fixture option missing");
        aiLabel.addEventListener("click", () => {
          const selectedDocument = new DOMParser().parseFromString(selectedModal, "text/html");
          const selected = selectedDocument.body.firstElementChild;
          if (!selected) throw new Error("selected declaration fixture missing");
          const selectedAiLabel = Array.from(selected.querySelectorAll("label.semi-radio")).find((label) =>
            label.textContent?.includes("内容由AI生成")
          );
          const selectedInput = selectedAiLabel?.querySelector('input[type="radio"]') as HTMLInputElement | null;
          if (!selectedAiLabel || !selectedInput) throw new Error("selected AI radio missing");
          selectedInput.checked = true;
          modal.replaceWith(selected);

          const confirm = Array.from(selected.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "确定"
          );
          if (!confirm) throw new Error("declaration confirm missing");
          confirm.addEventListener("click", () => {
            const readyDocument = new DOMParser().parseFromString(ready, "text/html");
            const readyValue = readyDocument.querySelector(".wrapper-MLZdnB .selectText-XSrMFZ");
            const currentValue = document.querySelector(
              '[data-publisher-fixture-scope].form-container-MDtobK .wrapper-MLZdnB .selectText-XSrMFZ'
            );
            if (!readyValue || !currentValue) throw new Error("declaration row fixture missing");
            currentValue.replaceWith(readyValue);
            selected.remove();
          });
        });
      },
      { selectedModal, ready }
    );

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('[data-publisher-fixture-scope].semi-modal').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin declaration does not run behind an open cover dialog", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  try {
    await page.evaluate(() => {
      const control = document.querySelector(
        '[data-publisher-fixture-scope].form-container-MDtobK .wrapper-MLZdnB .selectBox-buZRzi'
      );
      if (!control) throw new Error("declaration fixture control missing");
      control.addEventListener("click", () => {
        const marker = document.createElement("div");
        marker.setAttribute("data-test", "ai-declaration-clicked");
        control.append(marker);
      });
    });

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "failed");
    assert.match(result.detail, /cover dialog/i);
    assert.equal(await page.locator('[data-test="ai-declaration-clicked"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin declaration reuses an already selected scoped AI value without clicking", async () => {
  const page = await fixturePage(browser, "ready-before-publish.html");
  try {
    await page.evaluate(() => {
      const control = document.querySelector(
        '[data-publisher-fixture-scope].form-container-MDtobK .wrapper-MLZdnB .selectBox-buZRzi'
      );
      if (!control) throw new Error("declaration fixture control missing");
      control.addEventListener("click", () => control.setAttribute("data-test", "declaration-clicked"));
    });

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('[data-test="declaration-clicked"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin ready succeeds for one visible enabled scoped publish button without clicking it", async () => {
  const page = await fixturePage(browser, "ready-before-publish.html");
  try {
    await page.evaluate(() => {
      const button = document.querySelector(
        '[data-publisher-fixture-scope].form-container-MDtobK .content-confirm-container-Wp91G7 button.primary-cECiOJ'
      );
      if (!button) throw new Error("publish fixture control missing");
      button.addEventListener("click", () => button.setAttribute("data-test", "publish-clicked"));
    });

    const result = await new DouyinAdapter(page).runStage("ready", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('[data-test="publish-clicked"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin selectors scope to the creator form without relying on sanitizer-only fixture markers", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await page.locator("[data-publisher-fixture-scope]").evaluate((element) => {
      element.removeAttribute("data-publisher-fixture-scope");
    });

    const result = await new DouyinAdapter(page).runStage("body", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
  } finally {
    await page.close();
  }
});

test("douyin page succeeds only when one visible creator form is owned by the adapter", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await page.locator(".form-container-MDtobK").evaluate((form: HTMLElement) => {
      form.style.display = "none";
      setTimeout(() => form.style.removeProperty("display"), 300);
    });
    const adapter = new DouyinAdapter(page);
    const result = await adapter.runStage("page", makeInput());

    assert.equal(adapter.version, "2026.07.20-v3-state-machine-1");
    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.formCount, 1);
  } finally {
    await page.close();
  }
});

test("douyin video succeeds only after the creator form proves the upload is ready", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const result = await new DouyinAdapter(page).runStage("video", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.formReady, true);
  } finally {
    await page.close();
  }
});
