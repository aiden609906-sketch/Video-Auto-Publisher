import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import clipboard from "clipboardy";
import { chromium, type BrowserContext, type FileChooser, type Locator, type Page } from "playwright-core";
import type { Platform, PlatformPost } from "../shared/types.js";
import { formatPostText } from "./copy.js";

const PLATFORM_URLS: Record<Platform, string> = {
  douyin: "https://creator.douyin.com/creator-micro/content/upload",
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
  kuaishou: "https://cp.kuaishou.com/article/publish/video",
  bilibili: "https://member.bilibili.com/platform/upload/video/frame"
};

export const ADAPTER_VERSIONS: Record<Platform, string> = {
  douyin: "2026.06.08-fast-cover-v7",
  xiaohongshu: "2026.06.08-cover-v4",
  kuaishou: "2026.06.08-cover-v5",
  bilibili: "2026.06.08-dual-cover-v3"
};

export const BROWSER_CHANNELS = ["msedge", "chrome"] as const;

const WORD = {
  title: "\u6807\u9898",
  body: "\u6b63\u6587",
  desc: "\u63cf\u8ff0",
  intro: "\u7b80\u4ecb",
  tag: "\u6807\u7b7e",
  topic: "\u8bdd\u9898",
  cover: "\u5c01\u9762",
  coverSettings: "\u5c01\u9762\u8bbe\u7f6e",
  setCover: "\u8bbe\u7f6e\u5c01\u9762",
  chooseCover: "\u9009\u62e9\u5c01\u9762",
  editCover: "\u7f16\u8f91\u5c01\u9762",
  uploadCover: "\u4e0a\u4f20\u5c01\u9762",
  workIntro: "\u6dfb\u52a0\u4f5c\u54c1\u7b80\u4ecb",
  manuscriptTitle: "\u8bf7\u8f93\u5165\u7a3f\u4ef6\u6807\u9898",
  manuscriptDesc: "\u586b\u5199\u66f4\u5168\u9762\u7684\u76f8\u5173\u4fe1\u606f",
  enterCreateTag: "\u6309\u56de\u8f66\u952eEnter\u521b\u5efa\u6807\u7b7e"
};

const LOGIN_URL_PARTS = ["login", "passport", "sso"];
type CoverPaths = { landscape: string | null; portrait: string | null };
type ProgressReporter = (stage: string) => void;

const FIELD_SELECTORS: Record<Platform, { title: string[]; body: string[]; tags: string[] }> = {
  douyin: {
    title: [`input[maxlength="30"]`, `input[placeholder*="${WORD.title}"]`],
    body: [`[contenteditable="true"][data-placeholder*="${WORD.workIntro}"]`],
    tags: [`input[placeholder*="${WORD.topic}"]`, `input[placeholder*="${WORD.tag}"]`]
  },
  xiaohongshu: {
    title: [`input[placeholder*="${WORD.title}"]`],
    body: [".tiptap.ProseMirror", '[contenteditable="true"]'],
    tags: [`input[placeholder*="${WORD.topic}"]`, `input[placeholder*="${WORD.tag}"]`]
  },
  kuaishou: {
    title: [`input[placeholder*="${WORD.title}"]`],
    body: ['[contenteditable="true"][class*="description"]', '[contenteditable="true"]'],
    tags: [`input[placeholder*="${WORD.topic}"]`, `input[placeholder*="${WORD.tag}"]`]
  },
  bilibili: {
    title: [`input[placeholder*="${WORD.manuscriptTitle}"]`, `input[placeholder*="${WORD.title}"]`],
    body: [`[contenteditable="true"][data-placeholder*="${WORD.manuscriptDesc}"]`, ".ql-editor"],
    tags: [`input[placeholder*="${WORD.enterCreateTag}"]`, `input[placeholder*="${WORD.tag}"]`]
  }
};

export class Publisher {
  private contexts = new Map<Platform, BrowserContext>();
  private expectedFileChooserFiles = new WeakMap<Page, string>();
  private activeChannels = new Map<Platform, (typeof BROWSER_CHANNELS)[number]>();

  constructor(
    private readonly profilesDir: string,
    private readonly headless = false
  ) {}

  async copy(post: PlatformPost) {
    await clipboard.write(formatPostText(post));
  }

  getActiveChannel(platform: Platform) {
    return this.activeChannels.get(platform) || null;
  }

  async resetProfile(platform?: Platform) {
    const platforms = platform ? [platform] : [...this.contexts.keys()];
    await Promise.all(platforms.map((item) => this.contexts.get(item)?.close().catch(() => undefined)));
    if (platform) {
      this.contexts.delete(platform);
      this.activeChannels.delete(platform);
      await rm(path.join(this.profilesDir, platform), { recursive: true, force: true });
    } else {
      this.contexts.clear();
      this.activeChannels.clear();
      await rm(this.profilesDir, { recursive: true, force: true });
    }
    await mkdir(this.profilesDir, { recursive: true });
  }

  async open(
    platform: Platform,
    filePath: string,
    post: PlatformPost,
    covers: CoverPaths,
    reportProgress: ProgressReporter = () => undefined
  ) {
    reportProgress("\u6b63\u5728\u590d\u5236\u6587\u6848\u5e76\u6253\u5f00\u5e73\u53f0\u53d1\u5e03\u9875");
    await this.copy(post);
    const context = await this.getContext(platform);
    const page = context.pages()[0] || (await context.newPage());
    const removeFileChooserGuard = this.installFileChooserGuard(page, filePath, covers);

    try {
      await page.goto(PLATFORM_URLS[platform], { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.bringToFront();

      reportProgress("\u6b63\u5728\u68c0\u67e5\u767b\u5f55\u72b6\u6001\u548c\u53d1\u5e03\u8868\u5355");
      if (platform === "kuaishou") await this.dismissKuaishouDraftPrompt(page);
      if (platform === "bilibili") await this.resumeBilibiliDraftPrompt(page);

    const existingForm = await this.hasPublishingForm(page, platform);
    if (!existingForm) reportProgress("\u6b63\u5728\u5bfb\u627e\u89c6\u9891\u4e0a\u4f20\u5165\u53e3");
    const videoInput = existingForm ? null : await this.waitForVideoUploadInput(page, platform, 45_000);
    if (!videoInput && !existingForm) return this.notReadyResult(page);
    if (videoInput) {
      reportProgress("\u6b63\u5728\u4e0a\u4f20\u89c6\u9891\u6587\u4ef6");
      await videoInput.setInputFiles(filePath);
    }

    reportProgress(videoInput ? "\u89c6\u9891\u5df2\u63d0\u4ea4\uff0c\u7b49\u5f85\u5e73\u53f0\u8868\u5355\u53ef\u586b\u5199" : "\u6b63\u5728\u590d\u7528\u5df2\u6253\u5f00\u7684\u53d1\u5e03\u8868\u5355");
    if (platform === "douyin") {
      reportProgress("\u6b63\u5728\u70b9\u51fb\u7a7a\u767d\u5904\u5173\u95ed\u8bdd\u9898\u5217\u8868");
      await this.dismissDouyinTopicList(page);
      reportProgress("\u6b63\u5728\u4e0e\u89c6\u9891\u5904\u7406\u540c\u6b65\u4e0a\u4f20\u5c01\u9762");
      let coverPrefilled = await this.tryUploadCover(page, platform, covers);
      reportProgress("\u6b63\u5728\u586b\u5199\u6296\u97f3\u6807\u9898");
      const titlePrefilled = await this.tryFillTitle(page, platform, post.title, 10_000);
      reportProgress("\u6b63\u5728\u586b\u5199\u6296\u97f3\u6b63\u6587\u548c\u8bdd\u9898");
      let bodyPrefilled = await this.tryFillBody(page, platform, post, 10_000);
      if (!coverPrefilled && (covers.landscape || covers.portrait)) {
        reportProgress("\u6b63\u5728\u5feb\u901f\u91cd\u8bd5\u4e0a\u4f20\u6296\u97f3\u5c01\u9762");
        coverPrefilled = await this.tryUploadCover(page, platform, covers);
      }
      await this.dismissDouyinTopicList(page);
      bodyPrefilled = (await this.ensureDouyinBody(page, post)) || bodyPrefilled;
      reportProgress("\u81ea\u52a8\u586b\u5199\u5b8c\u6210\uff0c\u6b63\u5728\u540c\u6b65\u7ed3\u679c");
      return {
        browserMode: "managed" as const,
        copied: true,
        loginRequired: false,
        uploadPrefilled: Boolean(videoInput),
        titlePrefilled,
        bodyPrefilled,
        tagsPrefilled: bodyPrefilled && post.hashtags.length > 0,
        coverPrefilled
      };
    }

    reportProgress("\u6b63\u5728\u586b\u5199\u6807\u9898");
    const titlePrefilled = await this.tryFillTitle(page, platform, post.title);
    reportProgress("\u6b63\u5728\u586b\u5199\u6b63\u6587\u548c\u8bdd\u9898");
    const bodyPrefilled = await this.tryFillBody(page, platform, post);
    reportProgress("\u6b63\u5728\u5904\u7406\u5e73\u53f0\u72ec\u7acb\u8bdd\u9898\u8f93\u5165");
    const explicitTagsPrefilled = await this.tryFillTags(page, platform, post.hashtags);
    const tagsPrefilled = explicitTagsPrefilled || (bodyPrefilled && post.hashtags.length > 0);
    reportProgress("\u6b63\u5728\u5173\u95ed\u8bdd\u9898\u4e0b\u62c9\u83dc\u5355");
    await this.closeTransientMenus(page, platform);
    reportProgress("\u6b63\u5728\u4e0a\u4f20\u5c01\u9762");
    const coverPrefilled = await this.tryUploadCover(page, platform, covers);
    reportProgress("\u81ea\u52a8\u586b\u5199\u5b8c\u6210\uff0c\u6b63\u5728\u540c\u6b65\u7ed3\u679c");

      return {
        browserMode: "managed" as const,
        copied: true,
        loginRequired: false,
        uploadPrefilled: Boolean(videoInput),
        titlePrefilled,
        bodyPrefilled,
        tagsPrefilled,
        coverPrefilled
      };
    } finally {
      removeFileChooserGuard();
      this.expectedFileChooserFiles.delete(page);
    }
  }

  private notReadyResult(page: Page) {
    return {
      browserMode: "managed" as const,
      copied: true,
      loginRequired: this.looksLikeLogin(page.url()),
      uploadPrefilled: false,
      titlePrefilled: false,
      bodyPrefilled: false,
      tagsPrefilled: false,
      coverPrefilled: false
    };
  }

  private installFileChooserGuard(page: Page, videoPath: string, covers: CoverPaths) {
    const handler = async (fileChooser: FileChooser) => {
      const explicitFile = this.expectedFileChooserFiles.get(page);
      if (explicitFile) this.expectedFileChooserFiles.delete(page);

      const accept = (
        await fileChooser
          .element()
          .getAttribute("accept")
          .catch(() => "")
      )?.toLowerCase();
      const fallbackFile = accept?.includes("image") ? covers.landscape || covers.portrait || videoPath : videoPath;
      const file = explicitFile || fallbackFile;
      try {
        await fileChooser.setFiles(file);
        console.log("[publisher:filechooser]", { accept, file });
      } catch (error) {
        console.warn("[publisher:filechooser]", error);
      }
    };

    page.on("filechooser", handler);
    return () => page.off("filechooser", handler);
  }

  private async dismissKuaishouDraftPrompt(page: Page) {
    const discard = page.getByText("\u653e\u5f03", { exact: true });
    if ((await discard.count().catch(() => 0)) > 0) {
      await discard.first().click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
    }
  }

  private async resumeBilibiliDraftPrompt(page: Page) {
    const clicked = await this.clickVisibleText(page, "\u7ee7\u7eed\u7f16\u8f91", 12_000);
    if (clicked) await page.waitForTimeout(3000);
  }

  private async hasPublishingForm(page: Page, platform: Platform) {
    for (const selector of [...FIELD_SELECTORS[platform].title, ...FIELD_SELECTORS[platform].body, ...FIELD_SELECTORS[platform].tags]) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) return true;
      }
    }
    return (await page.locator('[contenteditable="true"], input:not([type="file"]):not([type="hidden"])').count().catch(() => 0)) > 0;
  }

  private async waitForVideoUploadInput(page: Page, platform: Platform, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.looksLikeLogin(page.url())) return null;
      const input = await this.pickFileInput(page, "video", platform);
      if (input) return input;
      await page.waitForTimeout(1000);
    }
    return null;
  }

  private async pickFileInput(page: Page, kind: "video" | "image", platform?: Platform) {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count().catch(() => 0);
    const candidates: Array<{ locator: Locator; visible: boolean }> = [];
    for (let index = 0; index < count; index += 1) {
      const locator = inputs.nth(index);
      const accept = (await locator.getAttribute("accept").catch(() => ""))?.toLowerCase() || "";
      const name = (await locator.getAttribute("name").catch(() => "")) || "";
      if (kind === "video" && (accept.includes("image") || accept.includes(".txt"))) continue;
      if (kind === "image" && !accept.includes("image")) continue;
      if (platform === "bilibili" && kind === "video" && name === "buploader") continue;
      candidates.push({ locator, visible: await locator.isVisible().catch(() => false) });
    }
    if (platform === "bilibili" && kind === "video") return candidates[0]?.locator || null;
    return candidates.sort((a, b) => Number(b.visible) - Number(a.visible))[0]?.locator || null;
  }

  private async tryFillTitle(page: Page, platform: Platform, title: string, timeoutMs = platform === "douyin" ? 10_000 : 75_000) {
    if (!title.trim()) return false;
    if (platform === "kuaishou") return false;
    return this.tryFillWithRetry(page, FIELD_SELECTORS[platform].title, title.trim(), "title", timeoutMs);
  }

  private async tryFillBody(page: Page, platform: Platform, post: PlatformPost, timeoutMs = platform === "douyin" ? 10_000 : 75_000) {
    const tags = post.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
    const body = [post.body.trim(), tags].filter(Boolean).join(platform === "douyin" ? " " : "\n");
    if (!body.trim()) return false;
    return this.tryFillWithRetry(page, FIELD_SELECTORS[platform].body, body, "body", timeoutMs);
  }

  private async tryFillTags(page: Page, platform: Platform, hashtags: string[]) {
    if (!hashtags.length) return false;
    if (platform === "bilibili") return this.tryFillBilibiliTags(page, hashtags);
    return false;
  }

  private async tryFillBilibiliTags(page: Page, hashtags: string[]) {
    const input = page.locator(`input[placeholder*="${WORD.enterCreateTag}"]`).first();
    const started = Date.now();
    while (Date.now() - started < 75_000) {
      if (await input.isVisible().catch(() => false)) {
        for (const tag of hashtags.slice(0, 10)) {
          await input.fill(tag.replace(/^#/, ""), { timeout: 2500 });
          await input.press("Enter", { timeout: 2500 });
          await page.waitForTimeout(250);
        }
        return true;
      }
      await page.waitForTimeout(1000);
    }
    return false;
  }

  private async tryFillWithRetry(
    page: Page,
    selectors: string[],
    value: string,
    kind: "title" | "body" | "tags",
    timeoutMs: number
  ) {
    const started = Date.now();
    const actionTimeoutMs = timeoutMs <= 10_000 ? 1200 : 3000;
    while (Date.now() - started < timeoutMs) {
      if (await this.tryFillSelectors(page, selectors, value, actionTimeoutMs)) return true;
      if (Date.now() - started >= timeoutMs) return false;
      if (await this.tryFillSemantic(page, value, kind, actionTimeoutMs)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }

  private async tryFillSelectors(page: Page, selectors: string[], value: string, actionTimeoutMs: number) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 8); index += 1) {
        const target = locator.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        if (await this.fillLocator(page, target, value, actionTimeoutMs)) return true;
      }
    }
    return false;
  }

  private async tryFillSemantic(page: Page, value: string, kind: "title" | "body" | "tags", actionTimeoutMs: number) {
    const candidates = page.locator(
      'input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]'
    );
    const count = await candidates.count().catch(() => 0);
    let best: { locator: Locator; score: number } | null = null;
    for (let index = 0; index < Math.min(count, 80); index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const text = await locator
        .evaluate((element) => {
          let ancestorText = "";
          let current: Element | null = element;
          for (let depth = 0; depth < 4 && current; depth += 1) {
            ancestorText += ` ${current.textContent || ""}`;
            current = current.parentElement;
          }
          const attributes = ["placeholder", "aria-label", "data-placeholder", "name", "id"]
            .map((name) => element.getAttribute(name) || "")
            .join(" ");
          return `${attributes} ${ancestorText}`.slice(0, 800).toLowerCase();
        })
        .catch(() => "");
      const score = semanticScore(text, kind);
      if (score > 0 && (!best || score > best.score)) best = { locator, score };
    }
    return best ? this.fillLocator(page, best.locator, value, actionTimeoutMs) : false;
  }

  private async fillLocator(page: Page, locator: Locator, value: string, actionTimeoutMs = 3000) {
    const tagInfo = await locator
      .evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        editable: element.getAttribute("contenteditable") === "true"
      }))
      .catch(() => null);
    if (!tagInfo) return false;

    if (!tagInfo.editable) {
      try {
        await locator.fill(value, { timeout: actionTimeoutMs });
        await locator.evaluate((element) => {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
        return true;
      } catch {
        return false;
      }
    }

    try {
      if (actionTimeoutMs <= 1200) {
        if (await this.pasteIntoEditable(page, locator, value, actionTimeoutMs)) return true;
        return false;
      }
      await locator.click({ timeout: actionTimeoutMs });
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.insertText(value);
      await locator.evaluate((element) => {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return true;
    } catch {
      try {
        await locator.evaluate((element, text) => {
          element.replaceChildren(document.createTextNode(text));
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }, value);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async tryUploadCover(page: Page, platform: Platform, covers: CoverPaths) {
    if (!covers.landscape && !covers.portrait) return false;
    if (platform === "douyin") return this.uploadDouyinCovers(page, covers);
    await this.closeTransientMenus(page, platform);
    if (platform === "xiaohongshu") return this.uploadXiaohongshuCover(page, covers.landscape || covers.portrait!);
    if (platform === "kuaishou") return this.uploadKuaishouCover(page, covers.landscape || covers.portrait!);
    return this.uploadBilibiliCovers(page, covers);
  }

  private async uploadDouyinCovers(page: Page, covers: CoverPaths) {
    const landscape = covers.landscape || covers.portrait;
    const portrait = covers.portrait || covers.landscape;
    if (!(await this.openDouyinCoverEditor(page))) return false;

    if (landscape) {
      if (!(await this.clickDouyinCoverEditorText(page, "\u8bbe\u7f6e\u6a2a\u5c01\u9762", "top", 5000))) return false;
      if (!(await this.uploadDouyinCoverFile(page, landscape))) return false;
    }

    if (portrait) {
      if (!(await this.clickDouyinCoverEditorText(page, "\u8bbe\u7f6e\u7ad6\u5c01\u9762", "top", 5000))) return false;
      if (!(await this.uploadDouyinCoverFile(page, portrait))) return false;
    }

    const completed = await this.clickDouyinCoverEditorText(page, "\u5b8c\u6210", "bottom", 6000);
    if (!completed) return false;
    await this.waitForCoverDialogClosed(page, 2500);
    return true;
  }

  private async uploadKuaishouCover(page: Page, coverPath: string) {
    await this.scrollCoverSectionIntoView(page);
    const beforeCover = await this.kuaishouMainCoverSignature(page);
    if (!(await this.openKuaishouCoverDialog(page))) return false;
    await this.clickVisibleDialogText(page, WORD.uploadCover, 10_000);

    const input = await this.waitForKuaishouDialogImageInput(page, 20_000);
    if (!input) return false;
    await input.setInputFiles(coverPath);
    await page.waitForTimeout(2500);

    const confirmed = await this.clickVisibleDialogText(page, "\u786e\u8ba4", 20_000);
    if (!confirmed) return false;
    await this.waitForCoverDialogClosed(page, 12_000);
    await this.waitForKuaishouMainCoverChange(page, beforeCover, 30_000);
    return true;
  }

  private async openDouyinCoverEditor(page: Page) {
    if (await this.hasDouyinCoverEditor(page)) return true;
    await this.scrollCoverSectionIntoView(page);
    const chooseButtons = page.getByText(WORD.chooseCover, { exact: true });
    const count = await chooseButtons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = chooseButtons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
      if (await this.hasDouyinCoverEditor(page)) return true;
    }

    for (const label of [WORD.chooseCover, WORD.coverSettings, WORD.setCover]) {
      if (await this.clickVisibleText(page, label, 800)) {
        await page.waitForTimeout(500);
        break;
      }
    }
    return this.hasDouyinCoverEditor(page);
  }

  private async hasDouyinCoverEditor(page: Page) {
    const horizontal = page.getByText("\u8bbe\u7f6e\u6a2a\u5c01\u9762", { exact: true });
    const vertical = page.getByText("\u8bbe\u7f6e\u7ad6\u5c01\u9762", { exact: true });
    return (
      (await horizontal.count().catch(() => 0)) > 0 &&
      (await vertical.count().catch(() => 0)) > 0 &&
      (await horizontal.first().isVisible().catch(() => false))
    );
  }

  private async uploadDouyinCoverFile(page: Page, coverPath: string) {
    const directInput = await this.waitForDouyinCoverInput(page, 1200);
    if (directInput) {
      await directInput.setInputFiles(coverPath);
      await page.waitForTimeout(350);
      return true;
    }

    this.expectedFileChooserFiles.set(page, coverPath);
    try {
      const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 2000 }).catch(() => null);
      if (!(await this.clickDouyinCoverEditorText(page, WORD.uploadCover, "bottom", 5000))) return false;
      const fileChooser = await fileChooserPromise;
      if (fileChooser) {
        await fileChooser.setFiles(coverPath).catch(() => undefined);
        await page.waitForTimeout(350);
        return true;
      }
    } finally {
      this.expectedFileChooserFiles.delete(page);
    }

    const input = await this.waitForDouyinCoverInput(page, 3000);
    if (!input) return false;
    await input.setInputFiles(coverPath);
    await page.waitForTimeout(350);
    return true;
  }

  private async waitForDouyinCoverInput(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of [
        'input.semi-upload-hidden-input[type="file"]',
        '.semi-upload input[type="file"][accept*="image"]',
        'input[type="file"][accept*="image"]'
      ]) {
        const inputs = page.locator(selector);
        const count = await inputs.count().catch(() => 0);
        if (count > 0) return inputs.nth(count - 1);
      }
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async clickDouyinCoverEditorText(
    page: Page,
    label: string,
    position: "top" | "bottom",
    timeoutMs: number
  ) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const candidates = page.getByText(label, { exact: true });
      const count = await candidates.count().catch(() => 0);
      const visible: Array<{ locator: Locator; y: number; area: number }> = [];
      for (let index = 0; index < count; index += 1) {
        const locator = candidates.nth(index);
        if (!(await locator.isVisible().catch(() => false))) continue;
        const box = await locator.boundingBox().catch(() => null);
        if (!box) continue;
        visible.push({ locator, y: box.y, area: box.width * box.height });
      }
      visible.sort((a, b) => {
        if (position === "top") return a.y - b.y || a.area - b.area;
        return b.y - a.y || a.area - b.area;
      });
      for (const candidate of visible) {
        const disabled = await candidate.locator
          .evaluate((element) => {
            const control = element.closest("button,[aria-disabled],.disabled,.is-disabled");
            return (
              control?.getAttribute("aria-disabled") === "true" ||
              control?.className?.toString().includes("disabled") ||
              (control instanceof HTMLButtonElement && control.disabled)
            );
          })
          .catch(() => false);
        if (disabled) continue;
        await candidate.locator.click({ force: true, timeout: 2500 }).catch(() => undefined);
        await page.waitForTimeout(600);
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async waitForCoverDialogClosed(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const visible = await page
        .locator('[role="dialog"], .semi-modal-content, .semi-modal, .ant-modal-content')
        .filter({ hasText: WORD.cover })
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async kuaishouMainCoverSignature(page: Page) {
    return page
      .evaluate((coverLabel) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const elements = Array.from(document.querySelectorAll("*"));
        const label = elements
          .filter((element) => visible(element) && (element.textContent || "").includes(coverLabel))
          .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
        if (!label) return null;

        const labelRect = label.getBoundingClientRect();
        const region = {
          left: labelRect.right + 20,
          right: labelRect.right + 420,
          top: labelRect.top - 80,
          bottom: labelRect.top + 240
        };
        const inRegion = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          return centerX >= region.left && centerX <= region.right && centerY >= region.top && centerY <= region.bottom;
        };

        const candidates = elements.flatMap((element) => {
          if (!visible(element) || !inRegion(element)) return [];
          const rect = element.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area < 8000) return [];
          const imageParts = Array.from(element.querySelectorAll("img"))
            .map((image) => image.currentSrc || image.src)
            .filter(Boolean);
          const backgroundParts = Array.from(element.querySelectorAll("*"))
            .map((child) => getComputedStyle(child).backgroundImage)
            .filter((background) => background && background !== "none");
          const bg = getComputedStyle(element).backgroundImage;
          const value = [element.outerHTML.slice(0, 300), bg !== "none" ? bg : "", ...imageParts, ...backgroundParts].filter(Boolean).join("|");
          return [{ value, area }];
        });
        candidates.sort((a, b) => b.area - a.area);
        return candidates[0]?.value || null;
      }, WORD.coverSettings)
      .catch(() => null);
  }

  private async waitForKuaishouMainCoverChange(page: Page, beforeCover: string | null, timeoutMs: number) {
    const started = Date.now();
    let sawChangedCover = false;
    while (Date.now() - started < timeoutMs) {
      const current = await this.kuaishouMainCoverSignature(page);
      if (current && current !== beforeCover) sawChangedCover = true;
      if (sawChangedCover && current && !current.includes("blob:")) return true;
      await page.waitForTimeout(1000);
    }
    return sawChangedCover;
  }

  private async openKuaishouCoverDialog(page: Page) {
    if (await this.hasKuaishouCoverDialog(page)) return true;
    await this.scrollKuaishouCoverIntoView(page);
    await this.hoverKuaishouMainCover(page);
    await page.waitForTimeout(400);
    if (await this.clickKuaishouCoverOverlay(page)) {
      await page.waitForTimeout(1200);
      if (await this.hasKuaishouCoverDialog(page)) return true;
    }
    if (await this.clickKuaishouMainCover(page)) {
      await page.waitForTimeout(1200);
      if (await this.hasKuaishouCoverDialog(page)) return true;
    }
    return false;
  }

  private async hasKuaishouCoverDialog(page: Page) {
    return page
      .locator('[role="dialog"],.ant-modal-content,.semi-modal-content')
      .filter({ hasText: "\u5c01\u9762\u622a\u53d6" })
      .first()
      .isVisible()
      .catch(() => false);
  }

  private async waitForKuaishouDialogImageInput(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const dialogs = page.locator('[role="dialog"],.ant-modal-content,.semi-modal-content').filter({ hasText: "\u5c01\u9762\u622a\u53d6" });
      const dialogCount = await dialogs.count().catch(() => 0);
      for (let index = dialogCount - 1; index >= 0; index -= 1) {
        const dialog = dialogs.nth(index);
        if (!(await dialog.isVisible().catch(() => false))) continue;
        const inputs = dialog.locator('input[type="file"][accept*="image"]');
        const inputCount = await inputs.count().catch(() => 0);
        if (inputCount > 0) return inputs.nth(inputCount - 1);
      }
      await this.clickVisibleDialogText(page, WORD.uploadCover, 1000);
      await page.waitForTimeout(700);
    }
    return null;
  }

  private async clickKuaishouMainCover(page: Page) {
    for (const selector of ['[class*="default-cover"][class*="big"]', '[class*="default-cover"]']) {
      const card = page.locator(selector).first();
      if (await card.isVisible().catch(() => false)) {
        await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
        await card.hover({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        const box = await card.boundingBox().catch(() => null);
        if (box) {
          await card.click({ position: { x: box.width / 2, y: box.height / 2 }, timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(600);
          if (await this.hasKuaishouCoverDialog(page)) return true;
          await card.hover({ timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(300);
          await card.click({ position: { x: Math.max(8, box.width - 28), y: 28 }, timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(600);
        } else {
          await card.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined);
        }
        return true;
      }
    }
    const point = await this.kuaishouMainCoverPoint(page);
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    return true;
  }

  private async clickKuaishouCoverOverlay(page: Page) {
    const cardPoint = await this.kuaishouMainCoverPoint(page);
    if (!cardPoint) return false;
    await page.mouse.move(cardPoint.x, cardPoint.y);
    await page.waitForTimeout(500);
    const overlayPoint = await page
      .evaluate(({ label, x, y }) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            !!rect.width &&
            !!rect.height &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01
          );
        };
        const candidates = Array.from(document.querySelectorAll("*")).flatMap((element) => {
          if (!visible(element)) return [];
          const text = (element.textContent || "").trim();
          if (text !== label) return [];
          const rect = element.getBoundingClientRect();
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          const distance = Math.abs(centerX - x) + Math.abs(centerY - y);
          if (distance > 260) return [];
          return [{ x: centerX, y: centerY, distance }];
        });
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0] || null;
      }, { label: WORD.coverSettings, x: cardPoint.x, y: cardPoint.y })
      .catch(() => null);
    if (!overlayPoint) return false;
    await page.mouse.click(overlayPoint.x, overlayPoint.y);
    return true;
  }

  private async hoverKuaishouMainCover(page: Page) {
    await this.scrollKuaishouCoverIntoView(page);
    const point = await this.kuaishouMainCoverPoint(page);
    if (!point) return false;
    await page.mouse.move(point.x, point.y);
    return true;
  }

  private async kuaishouMainCoverPoint(page: Page) {
    return page
      .evaluate((coverLabel) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const elements = Array.from(document.querySelectorAll("*"));
        const label = elements
          .filter((element) => visible(element) && (element.textContent || "").includes(coverLabel))
          .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
        if (!label) return null;
        const labelRect = label.getBoundingClientRect();
        const region = {
          left: labelRect.right + 20,
          right: labelRect.right + 420,
          top: labelRect.top - 80,
          bottom: labelRect.top + 240
        };
        const candidates = elements.flatMap((element) => {
          if (!visible(element)) return [];
          const rect = element.getBoundingClientRect();
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          if (centerX < region.left || centerX > region.right || centerY < region.top || centerY > region.bottom) return [];
          const text = (element.textContent || "").trim();
          const className = (element as HTMLElement).className?.toString() || "";
          const isCoverCard = text === coverLabel || className.includes("default-cover");
          const hasMedia = isCoverCard || element instanceof HTMLImageElement || getComputedStyle(element).backgroundImage !== "none";
          const area = rect.width * rect.height;
          if (!hasMedia || area < 1200) return [];
          const viewportY = Math.min(Math.max(rect.y + Math.min(48, rect.height / 2), 8), innerHeight - 24);
          return [{ x: centerX, y: viewportY, area }];
        });
        candidates.sort((a, b) => b.area - a.area);
        return candidates[0] || null;
      }, WORD.coverSettings)
      .catch(() => null);
  }

  private async scrollKuaishouCoverIntoView(page: Page) {
    await this.scrollCoverSectionIntoView(page);
    await page.mouse.wheel(0, 700).catch(() => undefined);
    await page.waitForTimeout(300);
    await page
      .evaluate((coverLabel) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden";
        };
        const label = Array.from(document.querySelectorAll("*"))
          .filter((element) => visible(element) && (element.textContent || "").includes(coverLabel))
          .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
        label?.scrollIntoView({ block: "center", inline: "nearest" });
      }, WORD.coverSettings)
      .catch(() => undefined);
    await page.mouse.wheel(0, 500).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  private async uploadXiaohongshuCover(page: Page, coverPath: string) {
    const publishPane = page.locator(".publish-page").first();
    if ((await publishPane.count().catch(() => 0)) > 0) {
      await publishPane
        .evaluate((element) => {
          const cover = element.querySelector(".publish-page-content-cover") as HTMLElement | null;
          if (cover) (element as HTMLElement).scrollTop = Math.max(0, cover.offsetTop - 80);
        })
        .catch(() => undefined);
      await page.waitForTimeout(600);
    }

    const coverCard = page.locator(".publish-page-content-cover .default.row").first();
    if (!(await coverCard.isVisible().catch(() => false))) return false;
    await coverCard.hover({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(350);

    const operator = page.locator(".publish-page-content-cover .operator.pointer").first();
    if ((await operator.count().catch(() => 0)) > 0) {
      await operator.click({ force: true, timeout: 3000 }).catch(() => undefined);
    } else {
      await coverCard.click({ force: true, timeout: 3000 }).catch(() => undefined);
    }

    const imageInput = page.locator('input[type="file"][accept*="image"]').last();
    await imageInput.waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
    if ((await imageInput.count().catch(() => 0)) === 0) return false;

    await imageInput.setInputFiles(coverPath);
    await page.waitForTimeout(2500);
    const confirmed = await this.clickVisibleButton(page, "\u786e\u5b9a", 15_000);
    if (!confirmed) return false;
    await page.waitForTimeout(1200);
    return true;
  }

  private async hasKuaishouCoverPreview(page: Page) {
    return page
      .evaluate(() => {
        const images = Array.from(document.querySelectorAll("img"));
        if (images.some((image) => image.src.startsWith("blob:https://cp.kuaishou.com/"))) return true;
        const backgrounds = Array.from(document.querySelectorAll("*")).map((element) => getComputedStyle(element).backgroundImage);
        return backgrounds.some((background) => background.includes("blob:https://cp.kuaishou.com/"));
      })
      .catch(() => false);
  }

  private async uploadBilibiliCovers(page: Page, covers: CoverPaths) {
    await this.openCoverPanel(page);
    const inputs = await this.waitForImageInputs(page, 30_000);
    if (!inputs.length) return false;

    const homeCover = covers.landscape || covers.portrait;
    const spaceCover = covers.landscape || covers.portrait;
    let uploaded = 0;
    if (homeCover && inputs[0]) {
      await inputs[0].setInputFiles(homeCover);
      uploaded += 1;
    }
    if (spaceCover && inputs[1]) {
      await inputs[1].setInputFiles(spaceCover);
      uploaded += 1;
    }
    if (inputs.length < 2 || uploaded < 2) return false;

    await page.waitForTimeout(1200);
    const completed = await this.clickVisibleButton(page, "\u5b8c\u6210", 25_000);
    return completed || uploaded === 2;
  }

  private async waitForImageInputs(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const locator = page.locator('input[type="file"][accept*="image"]');
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        const inputs: Locator[] = [];
        for (let index = 0; index < count; index += 1) inputs.push(locator.nth(index));
        return inputs;
      }
      await this.openCoverPanel(page);
      await page.waitForTimeout(750);
    }
    return [];
  }

  private async clickVisibleButton(page: Page, label: string, timeoutMs: number) {
    return this.clickVisibleText(page, label, timeoutMs);
  }

  private async clickVisibleDialogText(page: Page, label: string, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const candidates = page.locator("button,[role='button'],.semi-button,.ant-btn,span,div");
      const targets = await candidates
        .evaluateAll((elements, targetLabel) => {
          return elements.slice(0, 2500).flatMap((element, index) => {
            const dialog = element.closest('[role="dialog"],.semi-modal,.semi-modal-content,.ant-modal,.ant-modal-content');
            if (!dialog) return [];
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = (element.textContent || "").trim();
            const disabled =
              element.getAttribute("aria-disabled") === "true" ||
              element.closest("button,[aria-disabled],.is-disabled,.disabled")?.getAttribute("aria-disabled") === "true" ||
              (element instanceof HTMLButtonElement && element.disabled);
            if (
              !rect.width ||
              !rect.height ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity || "1") <= 0.01 ||
              disabled ||
              !text.includes(targetLabel)
            ) {
              return [];
            }
            const tag = element.tagName.toLowerCase();
            const className = (element as HTMLElement).className?.toString() || "";
            const exactScore = text === targetLabel ? 100_000 : Math.max(0, 50_000 - text.length * 100);
            const clickableScore = tag === "button" || element.getAttribute("role") === "button" || /btn|button|confirm|submit/.test(className) ? 20_000 : 0;
            const positionScore = rect.x + rect.y;
            return [{ index, score: exactScore + clickableScore + positionScore }];
          });
        }, label)
        .catch(() => [] as Array<{ index: number; score: number }>);

      for (const { index } of targets.sort((a, b) => b.score - a.score).slice(0, 6)) {
        const locator = candidates.nth(index);
        await locator.click({ timeout: 2500 }).catch(async () => {
          await locator.evaluate((element) => (element as HTMLElement).click());
        });
        await page.waitForTimeout(500);
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async clickVisibleText(page: Page, label: string, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const candidates = page.locator("*");
      const targets = await candidates
        .evaluateAll((elements, targetLabel) => {
          return elements.slice(0, 2500).flatMap((element, index) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = (element.textContent || "").trim();
            const tag = element.tagName.toLowerCase();
            const control = element.closest("button,[aria-disabled],.is-disabled,.disabled") as HTMLElement | null;
            const disabled =
              element.getAttribute("aria-disabled") === "true" ||
              control?.getAttribute("aria-disabled") === "true" ||
              control?.className?.toString().includes("disabled") ||
              (control instanceof HTMLButtonElement && control.disabled);
            if (
              tag === "html" ||
              tag === "body" ||
              !rect.width ||
              !rect.height ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity || "1") <= 0.01 ||
              disabled ||
              !text.includes(targetLabel)
            ) {
              return [];
            }
            const className = (element as HTMLElement).className?.toString() || "";
            const exactScore = text === targetLabel ? 100_000 : Math.max(0, 50_000 - text.length * 100);
            const clickableScore =
              tag === "button" ||
              element.getAttribute("role") === "button" ||
              /btn|button|edit|confirm|submit|text/.test(className)
                ? 20_000
                : 0;
            const areaScore = Math.max(0, 10_000 - rect.width * rect.height);
            return [{ index, score: exactScore + clickableScore + areaScore }];
          });
        }, label)
        .catch(() => [] as Array<{ index: number; score: number }>);

      for (const { index } of targets.sort((a, b) => b.score - a.score).slice(0, 8)) {
        const locator = candidates.nth(index);
        await locator.click({ timeout: 2500 }).catch(async () => {
          await locator.evaluate((element) => (element as HTMLElement).click());
        });
        await page.waitForTimeout(500);
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async openCoverPanel(page: Page) {
    await this.scrollCoverSectionIntoView(page);
    for (const label of [WORD.coverSettings, WORD.setCover, WORD.chooseCover, WORD.editCover, WORD.uploadCover, WORD.cover]) {
      if (await this.clickVisibleText(page, label, 1500)) {
        await page.waitForTimeout(1000);
        return;
      }
    }
  }

  private async closeTransientMenus(page: Page, platform: Platform) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
    await page
      .evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      })
      .catch(() => undefined);
    await this.clickFormBlankArea(page, platform);
    await page.waitForTimeout(800);
  }

  private async dismissDouyinTopicList(page: Page) {
    await page
      .evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      })
      .catch(() => undefined);

    const point = await page
      .evaluate(() => {
        const blockedSelector = [
          "a",
          "button",
          "input",
          "textarea",
          "select",
          '[contenteditable="true"]',
          '[role="button"]',
          '[role="option"]',
          '[role="listbox"]',
          '[role="menu"]',
          '[role="dialog"]',
          "nav",
          "aside",
          "header"
        ].join(",");
        const candidates = [
          { x: Math.round(innerWidth * 0.72), y: Math.round(innerHeight * 0.34) },
          { x: Math.round(innerWidth * 0.58), y: Math.round(innerHeight * 0.28) },
          { x: Math.round(innerWidth * 0.84), y: Math.round(innerHeight * 0.5) },
          { x: Math.round(innerWidth * 0.35), y: Math.round(innerHeight * 0.42) },
          { x: Math.max(24, innerWidth - 48), y: Math.round(innerHeight * 0.42) }
        ];

        for (const candidate of candidates) {
          const element = document.elementFromPoint(candidate.x, candidate.y);
          if (!(element instanceof HTMLElement)) continue;
          if (element.closest(blockedSelector)) continue;
          const style = getComputedStyle(element);
          if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") continue;
          return candidate;
        }
        return { x: Math.max(24, innerWidth - 48), y: Math.max(80, Math.round(innerHeight * 0.4)) };
      })
      .catch(() => null);

    if (point) await page.mouse.click(point.x, point.y).catch(() => undefined);
    await page.waitForTimeout(250);
  }

  private async ensureDouyinBody(page: Page, post: PlatformPost) {
    const tags = post.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
    const expected = [post.body.trim(), tags].filter(Boolean).join(" ");
    const editor = await this.findDouyinBodyEditor(page, expected);
    if (!editor) {
      console.log("[publisher:douyin-body]", { matches: false, reason: "editor not found" });
      return false;
    }

    const read = () =>
      editor
        .evaluate((element) => (element as HTMLElement).innerText || element.textContent || "")
        .then(normalizeEditorText)
        .catch(() => "");

    let actual = await read();
    if (actual !== normalizeEditorText(expected)) {
      await this.pasteIntoEditable(page, editor, expected, 1200);
      await page.waitForTimeout(250);
      actual = await read();
    }

    const matches = actual === normalizeEditorText(expected);
    console.log("[publisher:douyin-body]", {
      expectedLength: normalizeEditorText(expected).length,
      actualLength: actual.length,
      matches
    });
    return matches;
  }

  private async pasteIntoEditable(page: Page, locator: Locator, value: string, actionTimeoutMs: number) {
    try {
      await clipboard.write(value);
      await locator.click({ timeout: actionTimeoutMs });
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await page.keyboard.press("Control+V").catch(() => undefined);
      await page.waitForTimeout(200);
      await locator
        .evaluate((element) => {
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          (element as HTMLElement).blur();
        })
        .catch(() => undefined);
      const actual = await locator
        .evaluate((element) => (element as HTMLElement).innerText || element.textContent || "")
        .then(normalizeEditorText)
        .catch(() => "");
      return actual === normalizeEditorText(value);
    } catch {
      return false;
    }
  }

  private async findDouyinBodyEditor(page: Page, expected: string) {
    const strict = await this.findVisibleLocator(page, FIELD_SELECTORS.douyin.body);
    if (strict) return strict;

    const candidates = page.locator('[contenteditable="true"], textarea');
    const count = await candidates.count().catch(() => 0);
    const expectedSnippet = normalizeEditorText(expected).slice(0, 12);
    const summaries: Array<{ index: number; width: number; height: number; text: string }> = [];
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width < 200 || box.height < 40) continue;
      const text = normalizeEditorText(
        await candidate.evaluate((element) => (element as HTMLElement).innerText || element.textContent || "").catch(() => "")
      );
      summaries.push({ index, width: Math.round(box.width), height: Math.round(box.height), text: text.slice(0, 120) });
      if (!text || text.includes(expectedSnippet) || text.includes("#")) return candidate;
    }
    console.log("[publisher:douyin-body-candidates]", summaries);
    return null;
  }

  private async clickFormBlankArea(page: Page, platform: Platform) {
    const editor = await this.findVisibleLocator(page, FIELD_SELECTORS[platform].body);
    if (!editor) return false;
    const box = await editor.boundingBox().catch(() => null);
    if (!box) return false;

    const viewport = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const centerY = box.y + Math.min(Math.max(box.height / 2, 24), 48);
    const candidates = [
      { x: box.x - 28, y: centerY },
      { x: box.x - 16, y: centerY },
      { x: box.x + box.width + 20, y: centerY },
      { x: box.x + Math.min(box.width - 24, 160), y: box.y - 18 }
    ].filter(({ x, y }) => x >= 4 && y >= 4 && x < viewport.width - 4 && y < viewport.height - 4);

    for (const point of candidates) {
      const safe = await page
        .evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          if (!(element instanceof HTMLElement)) return false;
          const blocked = element.closest(
            'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="option"],[role="listbox"],[role="menu"],[role="dialog"],nav,aside,header'
          );
          return !blocked;
        }, point)
        .catch(() => false);
      if (!safe) continue;
      await page.mouse.click(point.x, point.y);
      return true;
    }
    return false;
  }

  private async findVisibleLocator(page: Page, selectors: string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 8); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    return null;
  }

  private async scrollCoverSectionIntoView(page: Page) {
    for (const label of [WORD.coverSettings, WORD.setCover, WORD.chooseCover, WORD.editCover, WORD.uploadCover, WORD.cover]) {
      const target = page.getByText(label, { exact: false }).first();
      if ((await target.count().catch(() => 0)) > 0) {
        await target.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(400);
        return;
      }
    }
  }

  private looksLikeLogin(url: string) {
    const lower = url.toLowerCase();
    return LOGIN_URL_PARTS.some((part) => lower.includes(part));
  }

  private async getContext(platform: Platform) {
    const existing = this.contexts.get(platform);
    if (existing) return existing;
    const profileDir = path.join(this.profilesDir, platform);
    await mkdir(profileDir, { recursive: true });
    let lastError: unknown = null;
    for (const channel of BROWSER_CHANNELS) {
      try {
        const context = await chromium.launchPersistentContext(profileDir, {
          channel,
          headless: this.headless,
          viewport: null,
          args: ["--start-maximized"]
        });
        context.on("close", () => {
          this.contexts.delete(platform);
          this.activeChannels.delete(platform);
        });
        this.contexts.set(platform, context);
        this.activeChannels.set(platform, channel);
        return context;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("无法启动 Edge 或 Chrome");
  }
}

function semanticScore(text: string, kind: "title" | "body" | "tags") {
  const rules = {
    title: { positive: [WORD.title, "title"], negative: [WORD.body, WORD.desc, WORD.intro, WORD.topic, WORD.tag, "tag"] },
    body: {
      positive: [WORD.body, WORD.desc, WORD.intro, "\u4ecb\u7ecd", "\u6587\u6848", "\u5185\u5bb9", "description"],
      negative: [WORD.title, WORD.topic, WORD.tag]
    },
    tags: { positive: [WORD.topic, WORD.tag, "tag", "topic"], negative: [WORD.title, WORD.body, WORD.desc, WORD.intro] }
  }[kind];
  return (
    rules.positive.reduce((score, keyword) => score + (text.includes(keyword.toLowerCase()) ? 3 : 0), 0) -
    rules.negative.reduce((score, keyword) => score + (text.includes(keyword.toLowerCase()) ? 2 : 0), 0)
  );
}

function normalizeEditorText(value: string) {
  return value
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
