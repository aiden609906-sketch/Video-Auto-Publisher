import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat as fileStat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { DouyinAdapter } from "../src/server/publish/adapters/douyin.js";
import type { PublishInput } from "../src/server/publish/platform-adapter.js";

const FIXTURE_DIR = path.resolve("tests/fixtures/publisher/douyin");
const DOUYIN_UPLOAD_URL = "https://creator.douyin.com/creator-micro/content/upload";
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
  return htmlPage(browser, await readFile(path.join(FIXTURE_DIR, name), "utf8"));
}

async function combinedFixturePage(browser: Browser, names: string[]): Promise<Page> {
  const fragments = await Promise.all(names.map((name) => readFile(path.join(FIXTURE_DIR, name), "utf8")));
  return htmlPage(browser, fragments.join("\n"));
}

async function htmlPage(browser: Browser, html: string, url = DOUYIN_UPLOAD_URL): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(url);
  return page;
}

async function preparePlainTextTopicEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = document.querySelector('[data-publisher-fixture-scope] [data-slate-editor]');
    if (!editor) throw new Error("real topic editor fixture is incomplete");
    editor.setAttribute("contenteditable", "true");
  });
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

test("douyin read failures expose only a whitelisted operation, selector alias, and category", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  await page.close();

  const result = await new DouyinAdapter(page).runStage("title", makeInput());

  assert.equal(result.status, "failed");
  assert.match(result.detail, /operation=title-read/);
  assert.match(result.detail, /target=title-input/);
  assert.match(result.detail, /category=detached/);
  assert.doesNotMatch(result.detail, /form-container|editor-kit|normalized title|default-douyin/i);
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

test("douyin topics succeed when every expected topic is readable as plain text", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await preparePlainTextTopicEditor(page);
    const input = makeInput();
    input.post.hashtags = ["topic-one", "topic-one", "topic-two"];

    const result = await new DouyinAdapter(page).runStage("topics", input);

    assert.equal(result.status, "succeeded", result.detail);
    assert.deepEqual(result.evidence, {
      expectedTopics: 2,
      writtenTopics: 2,
      suggestionOverlayVisible: false
    });
    const text = await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').innerText();
    assert.match(text, /#topic-one(?:\s|$)/);
    assert.match(text, /#topic-two(?:\s|$)/);
    assert.equal(await page.locator('[data-publisher-fixture-scope] [data-slate-editor] [data-mention]').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin topics succeed without interacting with the automatic picker", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "topic-picker-open.html"]);
  try {
    await preparePlainTextTopicEditor(page);
    await page.evaluate(() => {
      const header = document.querySelector('[data-publisher-fixture-scope] .formHeader-iqcubT');
      const popup = document.querySelector('.mention-suggest-item-container-TVOZMl');
      if (!header || !popup) throw new Error("fixture controls missing");
      header.addEventListener("click", () => document.documentElement.setAttribute("data-topic-dismiss-clicked", "true"));
    });

    const result = await new DouyinAdapter(page).runStage("topics", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('.mention-suggest-item-container-TVOZMl').count(), 1);
    assert.equal(await page.locator("html").getAttribute("data-topic-dismiss-clicked"), null);
    assert.equal(result.evidence?.suggestionOverlayVisible, true);
  } finally {
    await page.close();
  }
});

test("douyin topics write at most five unique plain-text hashtags", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await preparePlainTextTopicEditor(page);
    const input = makeInput();
    input.post.hashtags = ["topic-1", "topic-2", "topic-2", "topic-3", "topic-4", "topic-5", "topic-6"];

    const result = await new DouyinAdapter(page).runStage("topics", input);
    const text = await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').innerText();

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.expectedTopics, 5);
    assert.equal((text.match(/#topic-[1-5](?:\s|$)/g) || []).length, 5);
    assert.doesNotMatch(text, /#topic-6(?:\s|$)/);
  } finally {
    await page.close();
  }
});

test("douyin topics fail when an expected plain-text hashtag is not readable", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  const originalInsertText = page.keyboard.insertText.bind(page.keyboard);
  Object.defineProperty(page.keyboard, "insertText", {
    configurable: true,
    value: async (text: string) => text.includes("topic-two") ? undefined : originalInsertText(text)
  });
  try {
    await preparePlainTextTopicEditor(page);
    const input = makeInput();
    input.post.hashtags = ["topic-one", "topic-two"];

    const result = await new DouyinAdapter(page).runStage("topics", input);

    assert.equal(result.status, "failed");
    assert.deepEqual(result.evidence, {
      expectedTopics: 2,
      writtenTopics: 0,
      suggestionOverlayVisible: false
    });
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
        const upload = editor?.querySelector('.container-XzaV9h.upload-ZOJTUA input.semi-upload-hidden-input');
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

test("douyin cover opens the current two-control cover surface through the landscape control", async () => {
  const page = await fixturePage(browser, "video-post-upload-current.html");
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-current-cover-"));
  const coverPath = path.join(tempDir, "landscape.png");
  await writeFile(coverPath, "landscape-fixture");
  try {
    const editorHtml = await readFile(path.join(FIXTURE_DIR, "cover-editor-open.html"), "utf8");
    await page.evaluate((editorHtml) => {
      const controls = document.querySelectorAll(
        '[data-publisher-fixture-scope].form-container-MDtobK .content-upload-new .wrapper-NN3Jh1 > .coverControl-CjlzqC'
      );
      const mainBackground = document.querySelector(
        ".form-container-MDtobK .content-upload-new .background-OpVteV"
      ) as HTMLElement | null;
      if (controls.length !== 2 || !mainBackground) throw new Error("current cover fixture controls missing");
      controls[0].addEventListener("click", () => {
        const editorDocument = new DOMParser().parseFromString(editorHtml, "text/html");
        const editor = editorDocument.body.firstElementChild;
        if (!editor) throw new Error("current cover editor fixture missing");
        document.body.append(editor);
        const upload = editor.querySelector('.container-XzaV9h.upload-ZOJTUA input.semi-upload-hidden-input') as HTMLInputElement | null;
        const canvas = editor.querySelector("canvas") as HTMLCanvasElement | null;
        const complete = editor.querySelector('.buttons-BoCvr4 button.secondary-zU1YLr[type="button"]');
        if (!upload || !canvas || !complete) throw new Error("current cover editor controls missing");
        upload.addEventListener("change", () => {
          const context = canvas.getContext("2d");
          if (!context) throw new Error("current cover canvas unavailable");
          context.fillStyle = "rgb(7, 11, 13)";
          context.fillRect(0, 0, 1, 1);
        });
        complete.addEventListener("click", () => {
          mainBackground.style.backgroundImage = "linear-gradient(rgb(3, 3, 3), rgb(4, 4, 4))";
          editor.remove();
        });
      });
    }, editorHtml);

    const result = await new DouyinAdapter(page).runStage(
      "cover",
      makeInput({ covers: { landscape: coverPath, portrait: null } })
    );

    assert.equal(result.status, "succeeded", result.detail);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin cover detects in-place image content changes without replacing DOM nodes", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-cover-"));
  const coverPath = path.join(tempDir, "cover.png");
  await writeFile(coverPath, "fixture");
  try {
    await page.evaluate(() => {
      const editor = document.querySelector('[data-publisher-fixture-scope].dy-creator-content-modal-content');
      const upload = editor?.querySelector('.container-XzaV9h.upload-ZOJTUA input.semi-upload-hidden-input') as HTMLInputElement | null;
      const canvas = editor?.querySelector("canvas") as HTMLCanvasElement | null;
      const complete = editor?.querySelector('.buttons-BoCvr4 button.secondary-zU1YLr[type="button"]');
      const mainBackground = document.querySelector(
        ".form-container-MDtobK .content-upload-new .background-i_il_l"
      ) as HTMLElement | null;
      if (!editor || !upload || !canvas || !complete || !mainBackground) {
        throw new Error("cover fixture controls missing");
      }
      mainBackground.style.backgroundImage = "linear-gradient(rgb(1, 1, 1), rgb(2, 2, 2))";
      upload.addEventListener("change", () => {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("cover fixture canvas unavailable");
        context.fillStyle = "rgb(7, 11, 13)";
        context.fillRect(0, 0, 1, 1);
      });
      complete.addEventListener("click", () => {
        mainBackground.style.backgroundImage = "linear-gradient(rgb(3, 3, 3), rgb(4, 4, 4))";
        editor.remove();
      });
    });
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

test("douyin cover uploads landscape and portrait before completing the editor", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-cover-pair-"));
  const landscapePath = path.join(tempDir, "landscape.png");
  const portraitPath = path.join(tempDir, "portrait.png");
  await writeFile(landscapePath, "landscape-fixture");
  await writeFile(portraitPath, "portrait-fixture");
  try {
    await page.evaluate(() => {
      const editor = document.querySelector('[data-publisher-fixture-scope].dy-creator-content-modal-content');
      const upload = editor?.querySelector('.container-XzaV9h.upload-ZOJTUA input.semi-upload-hidden-input') as HTMLInputElement | null;
      const decoyUpload = editor?.querySelector('.container-Xnz3EO input.semi-upload-hidden-input') as HTMLInputElement | null;
      const uploadTrigger = Array.from(editor?.querySelectorAll('.container-XzaV9h.upload-ZOJTUA *') || []).find(
        (element) => element.children.length === 0 && element.textContent?.trim() === "上传封面"
      );
      const canvas = editor?.querySelector("canvas") as HTMLCanvasElement | null;
      const steps = editor?.querySelectorAll('.steps-cgzd9T .step-dXVbPX');
      const vertical = steps?.item(1) || null;
      const complete = editor?.querySelector('.buttons-BoCvr4 button.secondary-zU1YLr[type="button"]');
      const mainBackground = document.querySelector(
        ".form-container-MDtobK .content-upload-new .background-i_il_l"
      ) as HTMLElement | null;
      if (!editor || !upload || !decoyUpload || !uploadTrigger || !canvas || !vertical || !complete || !mainBackground) {
        throw new Error("cover pair fixture controls missing");
      }
      if (steps?.item(0)) steps.item(0).textContent = "设置横封面";
      vertical.textContent = "设置竖封面";
      let uploadCount = 0;
      let activeOrientation: "landscape" | "portrait" = "landscape";
      upload.addEventListener("change", () => {
        uploadCount += 1;
        document.documentElement.setAttribute("data-cover-upload-count", String(uploadCount));
        document.documentElement.setAttribute(`data-${activeOrientation}-uploaded`, "true");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("cover pair fixture canvas unavailable");
        context.fillStyle = uploadCount === 1 ? "rgb(7, 11, 13)" : "rgb(17, 19, 23)";
        context.fillRect(uploadCount - 1, 0, 1, 1);
      });
      decoyUpload.addEventListener("change", () => {
        document.documentElement.setAttribute("data-decoy-uploaded", "true");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("cover pair fixture canvas unavailable");
        context.fillStyle = "rgb(29, 31, 37)";
        context.fillRect(3, 0, 1, 1);
      });
      let triggerCount = 0;
      uploadTrigger.addEventListener("click", () => {
        triggerCount += 1;
        document.documentElement.setAttribute("data-cover-trigger-count", String(triggerCount));
        upload.click();
      });
      vertical.addEventListener("click", () => {
        window.setTimeout(() => {
          activeOrientation = "portrait";
          steps?.item(0).classList.remove("step-active-AWDV7U");
          vertical.classList.add("step-active-AWDV7U");
          document.documentElement.setAttribute("data-portrait-step", "opened");
        }, 50);
      });
      complete.addEventListener("click", () => {
        mainBackground.style.backgroundImage = "linear-gradient(rgb(3, 3, 3), rgb(4, 4, 4))";
        editor.remove();
      });
    });

    const result = await new DouyinAdapter(page).runStage(
      "cover",
      makeInput({ covers: { landscape: landscapePath, portrait: portraitPath } })
    );

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator("html").getAttribute("data-cover-upload-count"), "2");
    assert.equal(await page.locator("html").getAttribute("data-portrait-step"), "opened");
    assert.equal(await page.locator("html").getAttribute("data-landscape-uploaded"), "true");
    assert.equal(await page.locator("html").getAttribute("data-portrait-uploaded"), "true");
    assert.equal(await page.locator("html").getAttribute("data-decoy-uploaded"), null);
    assert.equal(await page.locator("html").getAttribute("data-cover-trigger-count"), "2");
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin cover can reuse the Publisher V2 cover flow as one linear operation", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    let calls = 0;
    const adapter = new DouyinAdapter(page, {
      uploadCovers: async (covers) => {
        calls += 1;
        assert.equal(Boolean(covers.landscape), true);
        assert.equal(Boolean(covers.portrait), true);
        return true;
      }
    });

    const result = await adapter.runStage(
      "cover",
      makeInput({ covers: { landscape: "landscape.png", portrait: "portrait.png" } })
    );

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(calls, 1);
    assert.deepEqual(result.evidence, { landscapeApplied: true, portraitApplied: true });
  } finally {
    await page.close();
  }
});

test("douyin cover does not treat file input metadata as applied visual content", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-cover-"));
  const coverPath = path.join(tempDir, "cover.png");
  await writeFile(coverPath, "fixture");
  try {
    await page.locator('.buttons-BoCvr4 button.secondary-zU1YLr[type="button"]').evaluate((complete) => {
      complete.addEventListener("click", () => document.documentElement.setAttribute("data-complete-clicked", "true"));
    });

    const result = await new DouyinAdapter(page).runStage(
      "cover",
      makeInput({ covers: { landscape: coverPath, portrait: null } })
    );

    assert.equal(result.status, "failed");
    assert.equal(await page.locator("html").getAttribute("data-complete-clicked"), null);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin cover canvas read failure is safely categorized without leaking page text", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "cover-editor-open.html"]);
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-cover-"));
  const coverPath = path.join(tempDir, "private-cover.png");
  await writeFile(coverPath, "fixture");
  try {
    await page.evaluate(`(() => {
      const canvas = document.querySelector('[data-publisher-fixture-scope].dy-creator-content-modal-content canvas');
      if (!canvas) throw new Error('cover fixture canvas missing');
      Object.defineProperty(canvas, 'getContext', {
        value: function () { throw new Error('private account and content'); }
      });
    })()`);
    const input = makeInput({ covers: { landscape: coverPath, portrait: null } });

    const result = await new DouyinAdapter(page).runStage("cover", input);

    assert.equal(result.status, "failed");
    assert.match(result.detail, /operation=cover-read-signature/);
    assert.match(result.detail, /target=cover-editor/);
    assert.match(result.detail, /category=evaluate/);
    assert.doesNotMatch(result.detail, /private-cover|private account|content-upload-new|\.png/i);
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
            readyValue.setAttribute("aria-checked", "true");
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

test("douyin declaration can reuse the Publisher V2 declaration flow", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    let calls = 0;
    const adapter = new DouyinAdapter(page, {
      selectDeclaration: async () => {
        calls += 1;
        await page.locator('.wrapper-MLZdnB .selectText-XSrMFZ').evaluate((element) => {
          element.textContent = "内容由AI生成";
        });
        return true;
      }
    });

    const result = await adapter.runStage("declaration", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(calls, 1);
    assert.deepEqual(result.evidence, { declarationModalCount: 0, aiValueSelected: true });
  } finally {
    await page.close();
  }
});

test("douyin declaration fails when confirmation leaves the actual modal shell connected", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "declaration-selected.html"]);
  try {
    await page.evaluate(() => {
      const modal = document.querySelector('[data-publisher-fixture-scope].semi-modal');
      const confirm = Array.from(modal?.querySelectorAll("button") || []).find(
        (button) => button.textContent?.trim() === "确定"
      );
      const row = document.querySelector(".form-container-MDtobK .wrapper-MLZdnB .selectText-XSrMFZ");
      if (!modal || !confirm || !row) throw new Error("declaration fixture controls missing");
      confirm.addEventListener("click", () => {
        modal.querySelector(".btnWrapper-LtGF4z")?.remove();
        row.textContent = "内容由AI生成";
        row.classList.add("selected-Vx6wO5");
        row.setAttribute("aria-checked", "true");
      });
    });

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "failed");
    assert.equal(await page.locator('[data-publisher-fixture-scope].semi-modal').count(), 1);
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

test("douyin declaration rejects selected text and class without checked or ARIA state", async () => {
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

    assert.equal(result.status, "failed");
    assert.equal(await page.locator('[data-test="declaration-clicked"]').count(), 1);
    assert.doesNotMatch(result.detail, /aiValueSelected=true/);
  } finally {
    await page.close();
  }
});

test("douyin declaration reuses an already checked scoped AI row without clicking", async () => {
  const page = await fixturePage(browser, "ready-before-publish.html");
  try {
    await page.evaluate(() => {
      const value = document.querySelector(
        '[data-publisher-fixture-scope].form-container-MDtobK .wrapper-MLZdnB .selectText-XSrMFZ'
      );
      const control = document.querySelector(
        '[data-publisher-fixture-scope].form-container-MDtobK .wrapper-MLZdnB .selectBox-buZRzi'
      );
      if (!value || !control) throw new Error("declaration fixture row missing");
      value.setAttribute("aria-checked", "true");
      control.addEventListener("click", () => control.setAttribute("data-test", "declaration-clicked"));
    });

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.declarationModalCount, 0);
    assert.equal(await page.locator('[data-test="declaration-clicked"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("douyin declaration requires the cover dialog to be absent, not merely hidden", async () => {
  const page = await combinedFixturePage(browser, ["ready-before-publish.html", "cover-editor-open.html"]);
  try {
    await page.locator('[data-publisher-fixture-scope].dy-creator-content-modal-content').evaluate((dialog: HTMLElement) => {
      dialog.style.display = "none";
    });

    const result = await new DouyinAdapter(page).runStage("declaration", makeInput());

    assert.equal(result.status, "failed");
    assert.match(result.detail, /cover dialog/i);
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

test("douyin page rejects a non-creator origin even when a video input exists", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload"><input type="file" accept="video/mp4"></div>',
    "https://example.test/creator-micro/content/upload"
  );
  try {
    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(result.status, "failed");
    assert.equal(result.evidence?.approvedPage, false);
  } finally {
    await page.close();
  }
});

test("douyin page rejects a lookalike creator upload path", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>',
    "https://creator.douyin.com/creator-micro/content/upload-evil"
  );
  try {
    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(result.status, "failed");
    assert.equal(result.evidence?.approvedPage, false);
  } finally {
    await page.close();
  }
});

test("douyin page reports login required when navigation changes during polling", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    await page.locator(".form-container-MDtobK").evaluate((form: HTMLElement) => {
      form.style.display = "none";
      setTimeout(() => history.replaceState({}, "", "/login"), 100);
      setTimeout(() => form.style.removeProperty("display"), 400);
    });

    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(result.status, "failed");
    assert.equal(result.evidence?.loginRequired, true);
  } finally {
    await page.close();
  }
});

test("douyin page does not accept a hidden global video input as the upload page", async () => {
  const page = await htmlPage(browser, '<input type="file" accept="video/mp4" style="display:none">');
  try {
    await page.evaluate(() => setTimeout(() => history.replaceState({}, "", "/login"), 300));

    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(result.status, "failed");
  } finally {
    await page.close();
  }
});

test("douyin page does not accept multiple upload roots as proof of ownership", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload"><input type="file" accept="video/mp4"></div><div class="semi-upload"><input type="file" accept="video/mp4"></div><div class="form-container-MDtobK" style="display:none;padding:10px">ready</div>'
  );
  try {
    await page.evaluate(() => {
      setTimeout(() => history.replaceState({}, "", "/login"), 100);
      setTimeout(() => (document.querySelector<HTMLElement>(".form-container-MDtobK")!.style.display = "block"), 400);
    });

    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(result.status, "failed");
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

    assert.equal(adapter.version, "2026.07.21-v3-state-machine-8");
    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.formCount, 1);
  } finally {
    await page.close();
  }
});

test("douyin page recognizes the current sanitized upload entry without fuzzy fallback", async () => {
  const page = await fixturePage(browser, "upload-entry-current.html");
  const originalNow = Date.now;
  let fakeNow = 0;
  try {
    Date.now = () => fakeNow;
    Object.defineProperty(page, "waitForTimeout", {
      configurable: true,
      value: async (milliseconds: number) => {
        fakeNow += milliseconds;
      }
    });
    const result = await new DouyinAdapter(page).runStage("page", makeInput());

    assert.equal(await page.locator('.container-drag-VAfIfu > input[type="file"]').count(), 1);
    assert.equal(await page.locator('.semi-upload:has(> input[type="file"][accept*="video" i])').count(), 0);
    assert.equal(result.status, "succeeded", `selector-mismatch: ${result.detail}`);
    assert.equal(result.evidence?.uploadRootCount, 1);
    assert.equal(result.evidence?.videoInputCount, 1);
  } finally {
    Date.now = originalNow;
    await page.close();
  }
});

test("douyin title route guard stops mutation after the page leaves the approved creator path", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const adapter = new DouyinAdapter(page);
    assert.equal((await adapter.runStage("page", makeInput())).status, "succeeded");
    await page.evaluate(() => history.replaceState({}, "", "/creator-micro/content/not-upload"));

    const result = await adapter.runStage("title", makeInput());

    assert.equal(result.status, "failed");
    assert.match(result.detail, /operation=title-fill/);
    assert.match(result.detail, /category=route/);
    assert.equal(await page.locator('.form-container-MDtobK .editor-kit-root-container input[type="text"]').inputValue(), "");
    assert.doesNotMatch(result.detail, /not-upload|normalized title|creator\.douyin\.com/i);
  } finally {
    await page.close();
  }
});

test("douyin video route guard prevents file submission after the page becomes login-required", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "private-video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    const adapter = new DouyinAdapter(page);
    assert.equal((await adapter.runStage("page", makeInput())).status, "succeeded");
    await page.evaluate(() => history.replaceState({}, "", "/login"));

    const result = await adapter.runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "failed");
    assert.match(result.detail, /operation=video-set-file/);
    assert.match(result.detail, /category=route/);
    assert.equal(await page.locator('.semi-upload > input[type="file"]').evaluate((input: HTMLInputElement) => input.files?.length), 0);
    assert.doesNotMatch(result.detail, /private-video|publisher-video-|\/login|\.mp4/i);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video fails closed when an existing creator form cannot prove the current video", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const result = await new DouyinAdapter(page).runStage("video", makeInput());

    assert.equal(result.status, "failed");
    assert.equal(result.evidence?.uploadSubmitted, false);
  } finally {
    await page.close();
  }
});

test("douyin video submits the scoped input and verifies a safe file digest before stable form readiness", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "private-video-name.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    const formReady = await readFile(path.join(FIXTURE_DIR, "form-ready.html"), "utf8");
    await page.evaluate((formReady) => {
      const root = document.querySelector(".semi-upload");
      const upload = root?.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!root || !upload) throw new Error("video fixture controls missing");
      upload.addEventListener("change", () => {
        const file = upload.files?.[0];
        document.documentElement.setAttribute(
          "data-upload-observed",
          file && file.size > 0 && file.type === "video/mp4" ? "safe" : "invalid"
        );
        setTimeout(() => {
          const parsed = new DOMParser().parseFromString(formReady, "text/html");
          const form = parsed.body.firstElementChild;
          if (!form) throw new Error("form fixture missing");
          root.replaceWith(form);
        }, 100);
      });
    }, formReady);
    const input = makeInput({ filePath: videoPath });

    const result = await new DouyinAdapter(page).runStage("video", input);

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator("html").getAttribute("data-upload-observed"), "safe");
    assert.match(String(result.evidence?.safeFileDigest), /^[a-f0-9]{64}$/);
    assert.ok(Number(result.evidence?.stableFormReads) >= 2);
    assert.ok(Number(result.evidence?.stableFormMs) >= 400);
    assert.doesNotMatch(JSON.stringify(result), /private-video-name|publisher-video-|\.mp4/i);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video accepts the current sanitized post-upload form after the upload entry exits", async () => {
  const page = await fixturePage(browser, "upload-entry-current.html");
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    page.setDefaultTimeout(500);
    const postUpload = await readFile(path.join(FIXTURE_DIR, "video-post-upload-current.html"), "utf8");
    await page.evaluate((postUpload) => {
      const root = document.querySelector(".container-drag-VAfIfu");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("captured upload entry is incomplete");
      upload.addEventListener("change", () => setTimeout(() => {
        const parsed = new DOMParser().parseFromString(postUpload, "text/html");
        const form = parsed.body.firstElementChild;
        if (!form) throw new Error("captured post-upload form is incomplete");
        root.replaceWith(form);
      }, 0));
    }, postUpload);

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "succeeded", `video-ready-form postcondition: ${result.detail}`);
    assert.equal(result.evidence?.uploadEntryDisconnected, true);
    assert.equal(result.evidence?.uploadTerminal, "entry-exited");
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video accepts the exact current post-upload editor route", async () => {
  const page = await fixturePage(browser, "upload-entry-current.html");
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    page.setDefaultTimeout(500);
    const postUpload = await readFile(path.join(FIXTURE_DIR, "video-post-upload-current.html"), "utf8");
    await page.evaluate((postUpload) => {
      const root = document.querySelector(".container-drag-VAfIfu");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("captured upload entry is incomplete");
      upload.addEventListener("change", () => setTimeout(() => {
        history.replaceState({}, "", "/creator-micro/content/post/video");
        const parsed = new DOMParser().parseFromString(postUpload, "text/html");
        const form = parsed.body.firstElementChild;
        if (!form) throw new Error("captured post-upload form is incomplete");
        root.replaceWith(form);
      }, 0));
    }, postUpload);

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "succeeded", `exact post-upload editor route: ${result.detail}`);
    assert.equal(result.evidence?.uploadEntryDisconnected, true);
    assert.equal(result.evidence?.uploadTerminal, "entry-exited");
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video fails closed when the scoped input detaches before initial identity evidence", async () => {
  const page = await fixturePage(browser, "upload-entry-current.html");
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    page.setDefaultTimeout(500);
    const postUpload = await readFile(path.join(FIXTURE_DIR, "video-post-upload-current.html"), "utf8");
    await page.evaluate((postUpload) => {
      const root = document.querySelector(".container-drag-VAfIfu");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("captured upload entry is incomplete");
      upload.addEventListener("input", () => {
        const parsed = new DOMParser().parseFromString(postUpload, "text/html");
        const form = parsed.body.firstElementChild;
        if (!form) throw new Error("captured post-upload form is incomplete");
        root.replaceWith(form);
      }, { capture: true, once: true });
    }, postUpload);

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "failed");
    assert.equal(result.evidence?.selectedFileConnected, false);
    assert.equal(result.evidence?.selectedFileVerified, false);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video does not succeed while scoped upload progress remains active", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    await page.evaluate(() => {
      const root = document.querySelector(".semi-upload");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("video fixture controls missing");
      upload.addEventListener("change", () => setTimeout(() => {
        const form = document.createElement("div");
        form.className = "form-container-MDtobK";
        form.style.padding = "10px";
        form.innerHTML = '<div aria-busy="true"><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="20" style="display:block;width:20px;height:8px"></div><div role="status" aria-busy="true">private processing text</div></div>';
        root.replaceWith(form);
        const progress = form.querySelector<HTMLElement>('[role="progressbar"]')!;
        const status = form.querySelector<HTMLElement>('[role="status"]')!;
        setTimeout(() => {
          progress.setAttribute("aria-valuenow", "45");
          progress.style.width = "45px";
          status.textContent = "different private progress text";
        }, 200);
        setTimeout(() => {
          progress.setAttribute("aria-valuenow", "70");
          progress.style.width = "70px";
        }, 450);
        setTimeout(() => history.replaceState({}, "", "/login"), 900);
      }, 100));
    });

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "failed");
    assert.notEqual(result.evidence?.uploadTerminal, "entry-exited");
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video succeeds after scoped busy progress becomes explicitly complete", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    await page.evaluate(() => {
      const root = document.querySelector(".semi-upload");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("video fixture controls missing");
      upload.addEventListener("change", () => setTimeout(() => {
        const form = document.createElement("div");
        form.className = "form-container-MDtobK";
        form.style.padding = "10px";
        form.innerHTML = '<div aria-busy="true"><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25" style="display:block;width:25px;height:8px"></div><div role="status" aria-busy="true">private processing text</div></div>';
        root.replaceWith(form);
        setTimeout(() => {
          form.querySelector('[aria-busy="true"]')?.setAttribute("aria-busy", "false");
          const status = form.querySelector('[role="status"]');
          status?.setAttribute("aria-busy", "false");
          const progress = form.querySelector<HTMLElement>('[role="progressbar"]');
          progress?.setAttribute("aria-valuenow", "100");
          if (progress) progress.style.width = "100px";
        }, 500);
      }, 100));
    });

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(result.evidence?.uploadBusyObserved, true);
    assert.equal(result.evidence?.uploadActive, false);
    assert.equal(result.evidence?.uploadTerminal, "busy-cleared");
    assert.equal(result.evidence?.uploadError, false);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video rejects a transient form even after the scoped input changes", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    await page.evaluate(() => {
      const upload = document.querySelector<HTMLInputElement>('.semi-upload > input[type="file"]');
      if (!upload) throw new Error("video fixture input missing");
      upload.addEventListener("change", () => {
        setTimeout(() => {
          const form = document.createElement("div");
          form.className = "form-container-MDtobK";
          form.style.padding = "10px";
          form.textContent = "ready";
          document.body.append(form);
          setTimeout(() => form.remove(), 250);
          setTimeout(() => history.replaceState({}, "", "/login"), 500);
        }, 100);
      });
    });

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "failed");
    assert.notEqual(result.evidence?.stableFormReads, 2);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video requires the same creator form node across stable readiness reads", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "safe-video-fixture");
  try {
    await page.evaluate(() => {
      const upload = document.querySelector<HTMLInputElement>('.semi-upload > input[type="file"]');
      if (!upload) throw new Error("video fixture input missing");
      upload.addEventListener("change", () => {
        setTimeout(() => {
          const first = document.createElement("div");
          first.className = "form-container-MDtobK";
          first.style.padding = "10px";
          first.textContent = "ready";
          document.body.append(first);
          setTimeout(() => first.replaceWith(first.cloneNode(true)), 150);
          setTimeout(() => history.replaceState({}, "", "/login"), 500);
        }, 100);
      });
    });

    const result = await new DouyinAdapter(page).runStage("video", makeInput({ filePath: videoPath }));

    assert.equal(result.status, "failed");
    assert.notEqual(result.evidence?.stableFormReads, 2);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video file input failures identify a safe operation and IO category", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  try {
    const input = makeInput({ filePath: "D:\\private-account\\missing-secret-video.mp4" });

    const result = await new DouyinAdapter(page).runStage("video", input);

    assert.equal(result.status, "failed");
    assert.match(result.detail, /operation=video-set-file/);
    assert.match(result.detail, /target=video-upload-input/);
    assert.match(result.detail, /category=io/);
    assert.doesNotMatch(result.detail, /private-account|missing-secret|\.mp4|default-douyin/i);
  } finally {
    await page.close();
  }
});

test("douyin video does not reuse a verified form after the source file identity changes", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "first-safe-video");
  try {
    const formReady = await readFile(path.join(FIXTURE_DIR, "form-ready.html"), "utf8");
    await page.evaluate((formReady) => {
      const root = document.querySelector(".semi-upload");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("video fixture controls missing");
      upload.addEventListener("change", () => setTimeout(() => {
        const parsed = new DOMParser().parseFromString(formReady, "text/html");
        const form = parsed.body.firstElementChild;
        if (!form) throw new Error("form fixture missing");
        root.replaceWith(form);
      }, 100));
    }, formReady);
    const adapter = new DouyinAdapter(page);
    const input = makeInput({ filePath: videoPath });
    const first = await adapter.runStage("video", input);
    assert.equal(first.status, "succeeded", first.detail);
    await writeFile(videoPath, "changed-safe-video-with-different-size");

    const second = await adapter.runStage("video", input);

    assert.equal(second.status, "failed");
    assert.equal(second.evidence?.uploadSubmitted, false);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin video content identity detects a same-size replacement with restored timestamps", async () => {
  const page = await htmlPage(
    browser,
    '<div class="semi-upload" style="padding:10px"><input type="file" accept="video/mp4"></div>'
  );
  const tempDir = await mkdtemp(path.join(tmpdir(), "publisher-video-"));
  const videoPath = path.join(tempDir, "video.mp4");
  await writeFile(videoPath, "AAAA");
  try {
    const fixedTimestamp = new Date("2020-01-02T03:04:05.000Z");
    await utimes(videoPath, fixedTimestamp, fixedTimestamp);
    const original = await fileStat(videoPath);
    const formReady = await readFile(path.join(FIXTURE_DIR, "form-ready.html"), "utf8");
    await page.evaluate((formReady) => {
      const root = document.querySelector(".semi-upload");
      const upload = root?.querySelector('input[type="file"]');
      if (!root || !upload) throw new Error("video fixture controls missing");
      upload.addEventListener("change", () => setTimeout(() => {
        const parsed = new DOMParser().parseFromString(formReady, "text/html");
        const form = parsed.body.firstElementChild;
        if (!form) throw new Error("form fixture missing");
        root.replaceWith(form);
      }, 100));
    }, formReady);
    const adapter = new DouyinAdapter(page);
    const input = makeInput({ filePath: videoPath });
    const first = await adapter.runStage("video", input);
    assert.equal(first.status, "succeeded", first.detail);
    await writeFile(videoPath, "BBBB");
    await utimes(videoPath, original.atime, original.mtime);

    const second = await adapter.runStage("video", input);

    assert.equal(second.status, "failed");
    assert.equal(second.evidence?.uploadSubmitted, false);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true });
  }
});

test("douyin stage result callback failures do not replace or reject the stage result", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const adapter = new DouyinAdapter(page, {
      onStageResult: () => {
        throw new Error("observer failure");
      }
    });

    const result = await adapter.runStage("body", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
  } finally {
    await page.close();
  }
});

test("douyin stage start callback failures do not prevent the real stage mutation", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const adapter = new DouyinAdapter(page, {
      onStageStart: () => {
        throw new Error("observer failure");
      }
    });

    const result = await adapter.runStage("body", makeInput());

    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(await page.locator('.form-container-MDtobK [data-slate-editor]').innerText(), "first line\nsecond line");
  } finally {
    await page.close();
  }
});
