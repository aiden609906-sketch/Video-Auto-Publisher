import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import clipboard from "clipboardy";
import openExternal from "open";
import { chromium, type BrowserContext, type FileChooser, type Locator, type Page } from "playwright-core";
import type { Platform, PlatformPost } from "../shared/types.js";
import { getProfileDir } from "./account-matrix.js";
import { formatPostText } from "./copy.js";

const PLATFORM_URLS: Record<Platform, string> = {
  douyin: "https://creator.douyin.com/creator-micro/content/upload",
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
  kuaishou: "https://cp.kuaishou.com/article/publish/video",
  bilibili: "https://member.bilibili.com/platform/upload/video/frame"
};

export const ADAPTER_VERSIONS: Record<Platform, string> = {
  douyin: "2026.07.06-cover-wait-inline-topic-v1",
  xiaohongshu: "2026.06.25-manual-profile-v1",
  kuaishou: "2026.07.05-kuaishou-cover-real-page-v20",
  bilibili: "2026.07.05-bilibili-ai-declaration-real-page-v2"
};

export const BROWSER_CHANNELS = ["msedge", "chrome"] as const;
export type PublishMode = "managed" | "manual";
export type ManualBrowserApp = { name: (typeof BROWSER_CHANNELS)[number]; arguments: string[] };

export function getPublishMode(platform: Platform): PublishMode {
  return platform === "xiaohongshu" ? "manual" : "managed";
}

export function shouldSelectAiDeclaration(platform: Platform) {
  return platform === "douyin" || platform === "kuaishou" || platform === "bilibili";
}

export function buildManualBrowserApps(profileDir: string): ManualBrowserApp[] {
  return BROWSER_CHANNELS.map((name) => ({
    name,
    arguments: [`--user-data-dir=${profileDir}`, "--no-first-run", "--new-window"]
  }));
}

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
  authorDeclaration: "\u4f5c\u8005\u58f0\u660e",
  creationDeclaration: "\u521b\u4f5c\u58f0\u660e",
  contentDeclaration: "\u5185\u5bb9\u58f0\u660e",
  aiGenerated: "\u5185\u5bb9\u7531AI\u751f\u6210",
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
  private contexts = new Map<string, BrowserContext>();
  private expectedFileChooserFiles = new WeakMap<Page, string>();
  private activeChannels = new Map<string, (typeof BROWSER_CHANNELS)[number]>();

  constructor(
    private readonly profilesDir: string,
    private readonly headless = false
  ) {}

  async copy(post: PlatformPost) {
    await clipboard.write(formatPostText(post));
  }

  getActiveChannel(platform: Platform, accountId: string) {
    return this.activeChannels.get(this.contextKey(platform, accountId)) || null;
  }

  async resetProfile(platform?: Platform, accountId?: string) {
    if (platform && accountId) {
      const key = this.contextKey(platform, accountId);
      await this.contexts.get(key)?.close().catch(() => undefined);
      this.contexts.delete(key);
      this.activeChannels.delete(key);
      await rm(getProfileDir(this.profilesDir, platform, accountId), { recursive: true, force: true });
    } else if (platform) {
      const keys = [...this.contexts.keys()].filter((key) => key.startsWith(`${platform}:`));
      await Promise.all(keys.map((key) => this.contexts.get(key)?.close().catch(() => undefined)));
      for (const key of keys) {
        this.contexts.delete(key);
        this.activeChannels.delete(key);
      }
      await rm(path.join(this.profilesDir, platform), { recursive: true, force: true });
      await rm(path.join(this.profilesDir, "accounts", platform), { recursive: true, force: true });
    } else {
      await Promise.all([...this.contexts.values()].map((context) => context.close().catch(() => undefined)));
      this.contexts.clear();
      this.activeChannels.clear();
      await rm(this.profilesDir, { recursive: true, force: true });
    }
    await mkdir(this.profilesDir, { recursive: true });
  }

  async open(
    platform: Platform,
    accountId: string,
    filePath: string,
    post: PlatformPost,
    covers: CoverPaths,
    reportProgress: ProgressReporter = () => undefined
  ) {
    reportProgress("\u6b63\u5728\u590d\u5236\u6587\u6848\u5e76\u6253\u5f00\u5e73\u53f0\u53d1\u5e03\u9875");
    await this.copy(post);
    if (getPublishMode(platform) === "manual") {
      return this.openManualPublishPage(platform, accountId, filePath, covers, reportProgress);
    }

    const context = await this.getContext(platform, accountId);
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
      reportProgress("\u6b63\u5728\u586b\u5199\u6296\u97f3\u6807\u9898");
      const titlePrefilled = await this.tryFillTitle(page, platform, post.title, 10_000);
      reportProgress("\u6b63\u5728\u586b\u5199\u6296\u97f3\u6b63\u6587\u548c\u8bdd\u9898");
      let bodyPrefilled = await this.tryFillBody(page, platform, post, 10_000);
      reportProgress("\u6b63\u5728\u5173\u95ed\u6296\u97f3\u8bdd\u9898\u6d6e\u5c42");
      await this.dismissDouyinTopicList(page);
      reportProgress(bodyPrefilled ? "\u6b63\u5728\u6821\u9a8c\u6296\u97f3\u6b63\u6587\u548c\u8bdd\u9898" : "\u6b63\u5728\u5feb\u901f\u8865\u586b\u6296\u97f3\u6b63\u6587\u548c\u8bdd\u9898");
      bodyPrefilled = await this.ensureDouyinBody(page, post);
      reportProgress("\u6b63\u5728\u4e0a\u4f20\u6296\u97f3\u5c01\u9762\u5e76\u7b49\u5f85\u751f\u6548");
      let coverPrefilled = await this.tryUploadCover(page, platform, covers);
      if (!coverPrefilled && (covers.landscape || covers.portrait)) {
        reportProgress("\u6b63\u5728\u91cd\u8bd5\u6296\u97f3\u5c01\u9762\uff0c\u5e76\u7b49\u5f85\u5c01\u9762\u7a97\u53e3\u5173\u95ed");
        coverPrefilled = await this.tryUploadCover(page, platform, covers);
      }
      if (!coverPrefilled && (covers.landscape || covers.portrait)) {
        reportProgress("\u6296\u97f3\u5c01\u9762\u672a\u786e\u8ba4\u751f\u6548\uff0c\u5df2\u505c\u5728\u5f53\u524d\u9875\u9762\u4fbf\u4e8e\u624b\u52a8\u5904\u7406");
        return {
          browserMode: "managed" as const,
          copied: true,
          loginRequired: false,
          uploadPrefilled: Boolean(videoInput),
          titlePrefilled,
          bodyPrefilled,
          tagsPrefilled: bodyPrefilled && post.hashtags.length > 0,
          coverPrefilled: false,
          declarationPrefilled: false
        };
      }
      reportProgress("\u6b63\u5728\u5c01\u9762\u4e0a\u4f20\u540e\u590d\u6838\u6296\u97f3\u6b63\u6587\u548c\u8bdd\u9898");
      bodyPrefilled = await this.ensureDouyinBody(page, post);
      reportProgress("\u6b63\u5728\u9009\u62e9\u4f5c\u8005\u58f0\u660e\uff1a\u5185\u5bb9\u7531AI\u751f\u6210");
      const declarationPrefilled = await this.trySelectAiDeclaration(page, platform);
      reportProgress("\u81ea\u52a8\u586b\u5199\u5b8c\u6210\uff0c\u6b63\u5728\u540c\u6b65\u7ed3\u679c");
      return {
        browserMode: "managed" as const,
        copied: true,
        loginRequired: false,
        uploadPrefilled: Boolean(videoInput),
        titlePrefilled,
        bodyPrefilled,
        tagsPrefilled: bodyPrefilled && post.hashtags.length > 0,
        coverPrefilled,
        declarationPrefilled
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
    if (platform === "kuaishou" && (covers.landscape || covers.portrait) && !coverPrefilled) {
      reportProgress("\u5feb\u624b\u5c01\u9762\u81ea\u52a8\u4e0a\u4f20\u672a\u5b8c\u6210\uff0c\u5df2\u505c\u5728\u5f53\u524d\u9875\u9762\u4fbf\u4e8e\u624b\u52a8\u5904\u7406");
      return {
        browserMode: "managed" as const,
        copied: true,
        loginRequired: false,
        uploadPrefilled: Boolean(videoInput),
        titlePrefilled,
        bodyPrefilled,
        tagsPrefilled,
        coverPrefilled: false,
        declarationPrefilled: false
      };
    }
    reportProgress("\u6b63\u5728\u9009\u62e9\u4f5c\u8005\u58f0\u660e\uff1a\u5185\u5bb9\u7531AI\u751f\u6210");
    const declarationPrefilled = await this.trySelectAiDeclaration(page, platform);
    reportProgress("\u81ea\u52a8\u586b\u5199\u5b8c\u6210\uff0c\u6b63\u5728\u540c\u6b65\u7ed3\u679c");

      return {
        browserMode: "managed" as const,
        copied: true,
        loginRequired: false,
        uploadPrefilled: Boolean(videoInput),
        titlePrefilled,
        bodyPrefilled,
        tagsPrefilled,
        coverPrefilled,
        declarationPrefilled
      };
    } finally {
      removeFileChooserGuard();
      this.expectedFileChooserFiles.delete(page);
    }
  }

  private async openManualPublishPage(platform: Platform, accountId: string, filePath: string, covers: CoverPaths, reportProgress: ProgressReporter) {
    const profileDir = getProfileDir(this.profilesDir, platform, accountId);
    await mkdir(profileDir, { recursive: true });

    reportProgress("\u6b63\u5728\u6253\u5f00\u5f53\u524d\u8d26\u53f7\u7684\u72ec\u7acb\u6d4f\u89c8\u5668\u53d1\u5e03\u9875");
    await openExternal(PLATFORM_URLS[platform], { app: buildManualBrowserApps(profileDir) });

    const folders = new Set([path.dirname(filePath)]);
    for (const coverPath of [covers.landscape, covers.portrait]) {
      if (coverPath) folders.add(path.dirname(coverPath));
    }

    reportProgress("\u6b63\u5728\u6253\u5f00\u89c6\u9891\u548c\u5c01\u9762\u6240\u5728\u6587\u4ef6\u5939");
    await Promise.all([...folders].map((folder) => openExternal(folder)));
    reportProgress("\u5c0f\u7ea2\u4e66\u5df2\u5207\u6362\u4e3a\u4eba\u5de5\u4e0a\u4f20\u6a21\u5f0f\uff0c\u8bf7\u5728\u9875\u9762\u5185\u624b\u52a8\u9009\u62e9\u6587\u4ef6\u5e76\u53d1\u5e03");

    return {
      browserMode: "manual" as const,
      copied: true,
      loginRequired: false,
      uploadPrefilled: false,
      titlePrefilled: false,
      bodyPrefilled: false,
      tagsPrefilled: false,
      coverPrefilled: false,
      declarationPrefilled: false
    };
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
      coverPrefilled: false,
      declarationPrefilled: false
    };
  }

  private installFileChooserGuard(page: Page, videoPath: string, covers: CoverPaths) {
    const handler = async (fileChooser: FileChooser) => {
      const explicitFile = this.expectedFileChooserFiles.get(page);
      if (explicitFile) return;

      const accept = (
        await fileChooser
          .element()
          .getAttribute("accept")
          .catch(() => "")
      )?.toLowerCase();
      const fallbackFile = accept?.includes("image") ? covers.landscape || covers.portrait || videoPath : videoPath;
      try {
        await fileChooser.setFiles(fallbackFile);
        console.log("[publisher:filechooser]", { accept, file: fallbackFile });
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
    if (platform === "douyin") return this.tryFillDouyinBodyAndTopics(page, post, timeoutMs);
    return this.tryFillWithRetry(page, FIELD_SELECTORS[platform].body, body, "body", timeoutMs);
  }

  private async tryFillDouyinBodyAndTopics(page: Page, post: PlatformPost, timeoutMs: number) {
    const body = post.body.trim();
    const bodyFilled = body ? await this.tryFillDouyinIntro(page, body, timeoutMs) : true;
    const topicsFilled = post.hashtags.length ? await this.tryFillDouyinTopics(page, post.hashtags, timeoutMs) : true;
    return bodyFilled && topicsFilled;
  }

  private async tryFillDouyinIntro(page: Page, body: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const editor = await this.findDouyinBodyEditor(page, body);
      if (editor) {
        if (await this.fillDouyinIntroEditor(page, editor, body, 1500)) return true;
      }
      await this.clickDouyinIntroPlaceholder(page);
      const focused = page.locator('[contenteditable="true"]:focus, textarea:focus').first();
      if ((await focused.count().catch(() => 0)) > 0 && (await this.fillDouyinIntroEditor(page, focused, body, 1500))) return true;
      await page.waitForTimeout(400);
    }
    return this.verifyDouyinIntro(page, body);
  }

  private async tryFillDouyinBody(page: Page, body: string, timeoutMs: number) {
    const deadline = Date.now() + Math.min(timeoutMs, 3_000);
    while (Date.now() < deadline) {
      const editor = await this.findDouyinBodyEditor(page, body);
      if (editor) {
        if (await this.pasteIntoEditable(page, editor, body, 1200)) return true;
        if (await this.verifyDouyinBody(page, body)) return true;
        break;
      }
      await page.waitForTimeout(300);
    }
    if (await this.verifyDouyinBody(page, body)) return true;
    return this.tryFillWithRetry(page, FIELD_SELECTORS.douyin.body, body, "body", Math.min(timeoutMs, 6_000));
  }

  private async tryFillDouyinTopics(page: Page, hashtags: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (const rawTag of hashtags.slice(0, 10)) {
      const tag = rawTag.replace(/^#/, "").trim();
      if (!tag) continue;
      if (await this.hasDouyinTopic(page, tag)) continue;

      let added = false;
      while (!added && Date.now() < deadline) {
        const input = await this.findDouyinTopicInput(page);
        if (!input) {
          added = await this.tryFillDouyinInlineTopic(page, tag);
          if (!added) await page.waitForTimeout(400);
          continue;
        }
        await input.click({ timeout: 1000 }).catch(() => undefined);
        await page.keyboard.press("Control+A").catch(() => undefined);
        await page.keyboard.press("Backspace").catch(() => undefined);
        await page.keyboard.insertText(tag);
        await page.waitForTimeout(250);
        await page.keyboard.press("Enter").catch(() => undefined);
        await page.waitForTimeout(600);
        if (!(await this.hasDouyinTopic(page, tag))) {
          await this.clickDouyinFirstTopicSuggestion(page, tag);
          await page.waitForTimeout(500);
        }
        added = await this.hasDouyinTopic(page, tag);
      }
      if (!added) return false;
    }
    return true;
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
    if (platform === "kuaishou") return this.uploadKuaishouCover(page, covers.landscape || covers.portrait!);
    return this.uploadBilibiliCovers(page, covers);
  }

  private async trySelectAiDeclaration(page: Page, platform: Platform) {
    if (!shouldSelectAiDeclaration(platform)) return false;
    await this.closeTransientMenus(page, platform).catch(() => undefined);
    await this.scrollDeclarationSectionIntoView(page);

    if (platform === "kuaishou") return this.trySelectKuaishouAiDeclaration(page);
    if (platform === "bilibili") return this.trySelectBilibiliAiDeclaration(page);

    if (await this.finishAiDeclarationSelection(page, platform, await this.selectAiDeclarationByDom(page))) return true;

    for (const label of [WORD.authorDeclaration, WORD.creationDeclaration, WORD.contentDeclaration, "\u58f0\u660e"]) {
      if (await this.clickVisibleText(page, label, 1500)) {
        await page.waitForTimeout(800);
        if (await this.finishAiDeclarationSelection(page, platform, await this.selectAiDeclarationByDom(page))) return true;
        if (await this.finishAiDeclarationSelection(page, platform, await this.clickAiGeneratedOption(page, 2500))) return true;
      }
    }

    if (await this.finishAiDeclarationSelection(page, platform, await this.clickAiGeneratedOption(page, 2500))) return true;
    return this.finishAiDeclarationSelection(page, platform, await this.selectAiDeclarationByDom(page));
  }

  private async trySelectBilibiliAiDeclaration(page: Page) {
    await this.scrollDeclarationSectionIntoView(page, WORD.creationDeclaration);
    await this.saveBilibiliDeclarationScreenshot(page, "before-open");
    if (await this.hasBilibiliAiDeclarationSelected(page)) {
      await this.saveBilibiliDeclarationScreenshot(page, "selected-existing");
      return true;
    }
    if (!(await this.clickBilibiliCreationDeclarationControl(page))) return false;
    await this.saveBilibiliDeclarationScreenshot(page, "dropdown-open");
    if (!(await this.clickBilibiliAiGeneratedOption(page))) return false;
    await page.waitForTimeout(800);
    const selected = await this.hasBilibiliAiDeclarationSelected(page);
    await this.saveBilibiliDeclarationScreenshot(page, selected ? "selected" : "not-selected");
    return selected;
  }

  private async trySelectKuaishouAiDeclaration(page: Page) {
    const started = Date.now();
    let attempts = 0;
    while (Date.now() - started < 8_000 && attempts < 4) {
      attempts += 1;
      if (await this.hasKuaishouAiDeclarationSelected(page)) return true;
      if (!(await this.clickKuaishouAuthorDeclarationControl(page))) {
        await page.waitForTimeout(500);
        continue;
      }
      if (await this.selectAiDeclarationByDom(page)) {
        if (await this.waitForKuaishouAiDeclarationSelected(page, 2_500)) return true;
      }
      if (await this.clickKuaishouAiGeneratedOption(page)) {
        if (await this.waitForKuaishouAiDeclarationSelected(page, 2_500)) return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async waitForKuaishouAiDeclarationSelected(page: Page, timeoutMs: number) {
    const started = Date.now();
    let attempts = 0;
    while (Date.now() - started < timeoutMs && attempts < Math.max(2, Math.ceil(timeoutMs / 300))) {
      attempts += 1;
      if (await this.hasKuaishouAiDeclarationSelected(page)) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  private async hasKuaishouAiDeclarationSelected(page: Page) {
    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.authorDeclaration);
    if (!labelBox) return false;
    const controls = page.locator(".ant-select,.ant-select-selector,.semi-select,.semi-select-selection,[role='combobox'],[aria-haspopup]");
    const count = await controls.count().catch(() => 0);
    const labelCenterY = labelBox.y + labelBox.height / 2;
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.x < labelBox.x + labelBox.width - 8 || Math.abs(box.y + box.height / 2 - labelCenterY) > 90) continue;
      const text = ((await control.innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, "");
      if (/AI/i.test(text) && text.includes("\u751f") && text.includes("\u6210")) return true;
    }
    return false;
  }

  private async clickKuaishouAiGeneratedOption(page: Page) {
    for (const selector of [
      ".ant-select-dropdown [role='option']",
      ".ant-select-dropdown .ant-select-item-option",
      ".semi-select-dropdown [role='option']",
      ".semi-select-dropdown .semi-select-option",
      "[role='listbox'] [role='option']"
    ]) {
      const options = page.locator(selector).filter({ hasText: /AI/i });
      const count = await options.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const option = options.nth(index);
        if (!(await option.isVisible({ timeout: 500 }).catch(() => false))) continue;
        await option.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
        await option.click({ force: true, timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(500);
        return true;
      }
    }

    return page
      .evaluate(() => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const candidates = Array.from(document.querySelectorAll("[role='option'],[role='menuitem'],li,button,div,span"))
          .flatMap((element) => {
            if (!visible(element)) return [];
            const text = (element.textContent || "").replace(/\s+/g, "");
            if (!/AI/i.test(text) || !text.includes("\u751f") || !text.includes("\u6210")) return [];
            const rect = element.getBoundingClientRect();
            const className = String((element as HTMLElement).className || "");
            const role = element.getAttribute("role") || "";
            const optionLike = role === "option" || role === "menuitem" || /ant-select-item-option|semi-select-option|option|menuitem/i.test(className);
            const hasMatchingChild = Array.from(element.children).some((child) => {
              if (!visible(child)) return false;
              const childText = (child.textContent || "").replace(/\s+/g, "");
              const childRole = child.getAttribute("role") || "";
              const childClass = String((child as HTMLElement).className || "");
              return /AI/i.test(childText) && childText.includes("\u751f") && childText.includes("\u6210") && /option|menuitem|ant-select-item-option|semi-select-option/i.test(`${childRole} ${childClass}`);
            });
            if (!optionLike && hasMatchingChild) return [];
            const dropdown = element.closest(
              "[role='listbox'],[role='menu'],.ant-select-dropdown,.semi-select-option-list,.semi-select-dropdown,.semi-portal,.ant-select-item-option"
            );
            const score =
              (optionLike ? 300_000 : 0) +
              (dropdown ? 150_000 : 0) +
              (/option|menu|select|dropdown|item/i.test(`${className} ${role}`) ? 100_000 : 0) +
              Math.max(0, 50_000 - text.length * 100) +
              Math.max(0, 10_000 - rect.top);
            return [{ element, score }];
          })
          .sort((left, right) => right.score - left.score);
        const target = candidates[0]?.element as HTMLElement | undefined;
        if (!target) return false;
        const clickable = target.closest("button,[role='option'],[role='menuitem'],li,[role='button'],.ant-select-item-option,.semi-select-option") || target;
        for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
          clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })
      .catch(() => false);
  }

  private async hasBilibiliAiDeclarationSelected(page: Page) {
    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.creationDeclaration);
    if (!labelBox) return false;
    const aiTexts = page.getByText(/AI|\u4eba\u5de5\u667a\u80fd/i);
    const aiTextCount = await aiTexts.count().catch(() => 0);
    const labelCenterY = labelBox.y + labelBox.height / 2;
    for (let index = 0; index < Math.min(aiTextCount, 30); index += 1) {
      const textNode = aiTexts.nth(index);
      if (!(await textNode.isVisible().catch(() => false))) continue;
      const box = await textNode.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.x < labelBox.x + labelBox.width - 8 || Math.abs(box.y + box.height / 2 - labelCenterY) > 90) continue;
      const text = (await textNode.innerText({ timeout: 300 }).catch(() => "")).replace(/\s+/g, "");
      if (/AI|\u4eba\u5de5\u667a\u80fd/i.test(text)) return true;
    }
    const controls = page.locator(".bcc-select,.bcc-select-input-wrap,.bcc-select-selector,.ant-select,.ant-select-selector,[role='combobox'],[aria-haspopup]");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.x < labelBox.x + labelBox.width - 8 || Math.abs(box.y + box.height / 2 - labelCenterY) > 90) continue;
      const text = [
        await control.innerText({ timeout: 300 }).catch(() => ""),
        await control.getAttribute("title").catch(() => ""),
        await control.getAttribute("aria-label").catch(() => "")
      ]
        .join(" ")
        .replace(/\s+/g, "");
      if (/AI|\u4eba\u5de5\u667a\u80fd/i.test(text)) return true;
    }
    return false;
  }

  private async clickBilibiliCreationDeclarationControl(page: Page) {
    const placeholder = page.getByText("\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e", { exact: false }).first();
    if (await placeholder.isVisible({ timeout: 800 }).catch(() => false)) {
      const box = await placeholder.boundingBox({ timeout: 800 }).catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
        await page.waitForTimeout(900);
        return true;
      }
    }

    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.creationDeclaration);
    if (!labelBox) return false;
    const controls = page.locator(".bcc-select,.bcc-select-input-wrap,.bcc-select-selector,.ant-select,.ant-select-selector,[role='combobox'],[aria-haspopup]");
    const count = await controls.count().catch(() => 0);
    const labelCenterY = labelBox.y + labelBox.height / 2;
    let best: { box: { x: number; y: number; width: number; height: number }; score: number } | null = null;
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.x < labelBox.x + labelBox.width - 8 || Math.abs(box.y + box.height / 2 - labelCenterY) > 90 || box.width < 160) continue;
      const meta = [
        await control.innerText({ timeout: 300 }).catch(() => ""),
        await control.getAttribute("role").catch(() => ""),
        await control.getAttribute("class").catch(() => ""),
        await control.getAttribute("aria-label").catch(() => "")
      ].join(" ");
      const score =
        (meta.includes("\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e") ? 200_000 : 0) +
        (/select|dropdown|combobox|input-wrap|selector|bcc/i.test(meta) ? 80_000 : 0) +
        Math.min(30_000, box.width * 10) -
        Math.abs(box.y + box.height / 2 - labelCenterY) * 500;
      if (!best || score > best.score) best = { box, score };
    }
    const point = best
      ? {
          x: best.box.x + best.box.width - Math.min(32, Math.max(12, best.box.width / 6)),
          y: best.box.y + best.box.height / 2
        }
      : null;
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(900);
    return true;
  }

  private async clickBilibiliAiGeneratedOption(page: Page) {
    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.creationDeclaration);
    const textOptions = page.getByText(/AI|\u4eba\u5de5\u667a\u80fd/i);
    const textOptionCount = await textOptions.count().catch(() => 0);
    const textCandidates: Array<{ locator: Locator; score: number }> = [];
    for (let index = 0; index < Math.min(textOptionCount, 30); index += 1) {
      const option = textOptions.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const box = await option.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box) continue;
      if (labelBox && (box.y < labelBox.y + labelBox.height || box.x < labelBox.x + labelBox.width - 16)) continue;
      const text = (await option.innerText({ timeout: 300 }).catch(() => "")).replace(/\s+/g, "");
      if (!/AI|\u4eba\u5de5\u667a\u80fd/i.test(text)) continue;
      const score = (text.includes("\u751f\u6210") ? 100_000 : 0) + Math.max(0, 40_000 - text.length * 300) - Math.max(0, box.y - (labelBox?.y || 0)) * 10;
      textCandidates.push({ locator: option, score });
    }
    for (const { locator } of textCandidates.sort((left, right) => right.score - left.score).slice(0, 5)) {
      await locator.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
      await locator.click({ force: true, timeout: 1500 }).catch(async () => {
        const box = await locator.boundingBox({ timeout: 300 }).catch(() => null);
        if (box) await page.mouse.click(box.x + Math.min(box.width / 2, Math.max(8, box.width - 4)), box.y + box.height / 2);
      });
      await page.waitForTimeout(600);
      return true;
    }

    for (const selector of [
      "[role='listbox'] [role='option']",
      "[role='option']",
      ".bcc-select-dropdown *",
      ".bcc-option",
      ".bcc-select-option",
      ".ant-select-dropdown [role='option']",
      ".ant-select-item-option",
      "li",
      "button"
    ]) {
      const options = page.locator(selector).filter({ hasText: /AI|\u4eba\u5de5\u667a\u80fd/i });
      const count = await options.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 8); index += 1) {
        const option = options.nth(index);
        if (!(await option.isVisible({ timeout: 500 }).catch(() => false))) continue;
        await option.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
        await option.click({ force: true, timeout: 1500 }).catch(async () => {
          await option.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined);
        });
        await page.waitForTimeout(600);
        return true;
      }
    }
    return false;
  }

  private async saveBilibiliDeclarationScreenshot(page: Page, name: string) {
    const dir = path.join(process.cwd(), "data", "diagnostics", "bilibili-declaration");
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const filePath = path.join(dir, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false }).catch(() => undefined);
  }

  private async clickKuaishouAuthorDeclarationControl(page: Page) {
    if (await this.clickKuaishouAuthorDeclarationPlaceholder(page)) return true;
    if (await this.clickKuaishouAuthorDeclarationComboboxByRow(page)) return true;
    const point = await page
      .evaluate((config) => {
        const isVisible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const compactText = (element: Element) => (element.textContent || "").replace(/\s+/g, "");
        const labels = Array.from(document.querySelectorAll("*"))
          .filter((element) => isVisible(element) && compactText(element).includes(config.label))
          .sort((left, right) => compactText(left).length - compactText(right).length)
          .slice(0, 8);

        for (const label of labels) {
          const labelRect = label.getBoundingClientRect();
          const labelY = labelRect.top + labelRect.height / 2;
          const candidates = Array.from(
            document.querySelectorAll("button,[role='button'],[role='combobox'],[aria-haspopup],.semi-select,.semi-select-selection,.ant-select,.ant-select-selector,div,span")
          )
            .flatMap((element) => {
              if (!isVisible(element) || element === label || element.contains(label)) return [];
              const rect = element.getBoundingClientRect();
              if (rect.left < labelRect.right - 12) return [];
              const yDistance = Math.abs(rect.top + rect.height / 2 - labelY);
              if (yDistance > 90) return [];
              const clickable =
                element.closest("button,[role='button'],[role='combobox'],[aria-haspopup],.semi-select,.semi-select-selection,.ant-select,.ant-select-selector") ||
                element;
              if (!isVisible(clickable)) return [];
              const clickableRect = clickable.getBoundingClientRect();
              const meta = [
                compactText(clickable),
                (clickable as HTMLElement).getAttribute("placeholder") || "",
                (clickable as HTMLElement).getAttribute("aria-label") || "",
                (clickable as HTMLElement).getAttribute("role") || "",
                String((clickable as HTMLElement).className || "")
              ].join(" ");
              const hasHint = config.hints.some((hint) => meta.includes(hint));
              const selectLike = /select|dropdown|picker|combobox|trigger|placeholder|selector/i.test(meta);
              const score = (hasHint ? 100_000 : 0) + (selectLike ? 50_000 : 0) + Math.min(10_000, clickableRect.width * 10) - yDistance * 200;
              return [{ rect: clickableRect, score }];
            })
            .sort((left, right) => right.score - left.score);
          const best = candidates[0];
          if (best && best.score > -20_000) {
            return {
              x: best.rect.left + Math.min(Math.max(best.rect.width / 2, 24), Math.max(24, best.rect.width - 8)),
              y: best.rect.top + best.rect.height / 2
            };
          }
        }
        return null;
      }, { label: WORD.authorDeclaration, hints: ["\u4e3a\u4f5c\u54c1\u6dfb\u52a0\u8865\u5145\u8bf4\u660e", "\u8865\u5145\u8bf4\u660e", "\u9009\u62e9\u58f0\u660e"] })
      .catch(() => null as { x: number; y: number } | null);

    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(800);
    return true;
  }

  private async clickKuaishouAuthorDeclarationComboboxByRow(page: Page) {
    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.authorDeclaration);
    if (!labelBox) return false;
    const controls = page.locator(".ant-select,.ant-select-selector,.semi-select,.semi-select-selection,[role='combobox'],[aria-haspopup]");
    const count = await controls.count().catch(() => 0);
    const labelCenterY = labelBox.y + labelBox.height / 2;
    const candidates: Array<{ locator: Locator; score: number; box: { x: number; y: number; width: number; height: number } }> = [];
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.x < labelBox.x + labelBox.width - 8 || Math.abs(box.y + box.height / 2 - labelCenterY) > 90 || box.width < 100) continue;
      const className = (await control.getAttribute("class").catch(() => "")) || "";
      const role = (await control.getAttribute("role").catch(() => "")) || "";
      const score =
        (/ant-select$|semi-select$|combobox/i.test(`${className} ${role}`) ? 100_000 : 0) +
        Math.min(20_000, box.width * 10) -
        Math.abs(box.y + box.height / 2 - labelCenterY) * 200 -
        Math.max(0, box.x - (labelBox.x + labelBox.width));
      candidates.push({ locator: control, score, box });
    }
    const best = candidates.sort((left, right) => right.score - left.score)[0];
    if (!best) return false;
    await best.locator.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
    await page.mouse.click(best.box.x + Math.min(Math.max(best.box.width / 2, 24), Math.max(24, best.box.width - 8)), best.box.y + best.box.height / 2);
    await page.waitForTimeout(800);
    return true;
  }

  private async findSmallestVisibleTextBox(page: Page, label: string) {
    const matches = page.getByText(label, { exact: false });
    const count = await matches.count().catch(() => 0);
    let best: { x: number; y: number; width: number; height: number; textLength: number } | null = null;
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const match = matches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      const box = await match.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box) continue;
      const textLength = ((await match.innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, "").length;
      const candidate = { ...box, textLength };
      if (!best || candidate.textLength < best.textLength || (candidate.textLength === best.textLength && candidate.width * candidate.height < best.width * best.height)) {
        best = candidate;
      }
    }
    return best;
  }

  private async clickKuaishouAuthorDeclarationPlaceholder(page: Page) {
    for (const label of ["\u4e3a\u4f5c\u54c1\u6dfb\u52a0\u8865\u5145\u8bf4\u660e", "\u8865\u5145\u8bf4\u660e"]) {
      const locator = page.getByText(label, { exact: false }).first();
      if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
      const box = await locator.boundingBox({ timeout: 1000 }).catch(() => null);
      if (!box) continue;
      await page.mouse.click(box.x + Math.min(Math.max(box.width / 2, 12), Math.max(12, box.width - 4)), box.y + box.height / 2);
      await page.waitForTimeout(800);
      return true;
    }

    const clicked = await page
      .evaluate((config) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const compactText = (element: Element) => (element.textContent || "").replace(/\s+/g, "");
        const candidates = Array.from(document.querySelectorAll("*"))
          .flatMap((element) => {
            if (!visible(element)) return [];
            const text = compactText(element);
            if (!config.placeholders.some((placeholder: string) => text.includes(placeholder))) return [];
            const rect = element.getBoundingClientRect();
            const clickable =
              element.closest(
                ".ant-select,.ant-select-selector,.semi-select,.semi-select-selection,[role='combobox'],[aria-haspopup],button,[role='button']"
              ) || element;
            if (!visible(clickable)) return [];
            const clickableRect = clickable.getBoundingClientRect();
            const className = String((clickable as HTMLElement).className || "");
            const score =
              (/select|combobox|dropdown|picker|placeholder|selector/i.test(className) ? 100_000 : 0) +
              Math.max(0, 20_000 - text.length * 50) +
              Math.min(10_000, clickableRect.width * 10);
            return [{ element: clickable, score }];
          })
          .sort((left, right) => right.score - left.score);
        const target = candidates[0]?.element as HTMLElement | undefined;
        if (!target) return false;
        target.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      }, { placeholders: ["\u4e3a\u4f5c\u54c1\u6dfb\u52a0\u8865\u5145\u8bf4\u660e", "\u8865\u5145\u8bf4\u660e"] })
      .catch(() => false);
    if (!clicked) return false;
    await page.waitForTimeout(800);
    return true;
  }

  private async finishAiDeclarationSelection(page: Page, platform: Platform, selected: boolean) {
    if (!selected) return false;
    if (platform !== "douyin") return true;
    for (const label of ["\u786e\u5b9a", "\u786e\u8ba4", "\u5b8c\u6210"]) {
      if (await this.clickVisibleDialogText(page, label, 5000)) {
        await page.waitForTimeout(800);
        return true;
      }
    }
    return false;
  }

  private async scrollDeclarationSectionIntoView(page: Page, targetLabel?: string) {
    const labels = targetLabel ? [targetLabel] : [WORD.authorDeclaration, WORD.creationDeclaration, WORD.contentDeclaration, WORD.aiGenerated, "AI\u751f\u6210"];
    for (const label of labels) {
      const target = page.getByText(label, { exact: false }).first();
      if ((await target.count().catch(() => 0)) > 0) {
        await target.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(400);
        return;
      }
    }
  }

  private async clickAiGeneratedOption(page: Page, timeoutMs: number) {
    const labels = [WORD.aiGenerated, "\u7531AI\u751f\u6210", "AI\u751f\u6210", "\u4eba\u5de5\u667a\u80fd\u751f\u6210"];
    for (const label of labels) {
      if (await this.clickVisibleText(page, label, timeoutMs)) {
        await page.waitForTimeout(600);
        if (await this.hasAiDeclarationSelected(page)) return true;
        return true;
      }
    }
    return this.clickVisibleAiGeneratedText(page, timeoutMs);
  }

  private async clickVisibleAiGeneratedText(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const candidates = page.locator("[role='option'],[role='menuitem'],li,button,span,div");
      const targets = await candidates
        .evaluateAll((elements) => {
          const normalize = (value: string) => value.replace(/\s+/g, "");
          return elements.slice(0, 2500).flatMap((element, index) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = normalize((element.textContent || "").trim());
            if (
              !rect.width ||
              !rect.height ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity || "1") <= 0.01 ||
              !/AI/i.test(text) ||
              !text.includes("\u751f\u6210")
            ) {
              return [];
            }
            const tag = element.tagName.toLowerCase();
            const className = (element as HTMLElement).className?.toString() || "";
            const clickableScore =
              tag === "button" ||
              tag === "li" ||
              element.getAttribute("role") === "option" ||
              element.getAttribute("role") === "menuitem" ||
              /option|menu|select|item/.test(className)
                ? 50_000
                : 0;
            const textScore = Math.max(0, 40_000 - text.length * 100);
            return [{ index, score: clickableScore + textScore }];
          });
        })
        .catch(() => [] as Array<{ index: number; score: number }>);

      for (const { index } of targets.sort((a, b) => b.score - a.score).slice(0, 6)) {
        const locator = candidates.nth(index);
        await locator.click({ timeout: 2500 }).catch(async () => {
          await locator.evaluate((element) => (element as HTMLElement).click());
        });
        await page.waitForTimeout(600);
        return true;
      }
      await page.waitForTimeout(300);
    }
    return false;
  }

  private async hasAiDeclarationSelected(page: Page) {
    return page
      .evaluate(() => {
        const textMatches = (value: string) => /AI|\u4eba\u5de5\u667a\u80fd/i.test(value) && /\u751f\u6210/.test(value);
        const controls = Array.from(document.querySelectorAll('input[type="radio"],input[type="checkbox"],option'));
        return controls.some((control) => {
          if (control instanceof HTMLOptionElement) {
            return control.selected && textMatches(control.textContent || control.value || "");
          }
          if (!(control instanceof HTMLInputElement) || !control.checked) return false;
          const labelText =
            control.closest("label")?.textContent ||
            (control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent : "") ||
            control.getAttribute("aria-label") ||
            "";
          return textMatches(labelText);
        });
      })
      .catch(() => false);
  }

  private async selectAiDeclarationByDom(page: Page) {
    return page
      .evaluate(() => {
        const textMatches = (value: string) => /AI|\u4eba\u5de5\u667a\u80fd/i.test(value) && /\u751f\u6210/.test(value);
        const isVisible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
        };
        const dispatch = (element: Element) => {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        };

        for (const select of Array.from(document.querySelectorAll("select"))) {
          if (!isVisible(select)) continue;
          const option = Array.from(select.options).find((item) => textMatches(item.textContent || item.value || ""));
          if (!option) continue;
          select.value = option.value;
          option.selected = true;
          dispatch(select);
          return true;
        }

        const elements = Array.from(document.querySelectorAll("label,*[role='radio'],*[role='option'],*[role='menuitem'],span,div,button"));
        const candidates = elements
          .filter((element) => isVisible(element) && textMatches((element.textContent || "").trim()))
          .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

        for (const element of candidates.slice(0, 8)) {
          const label = element.closest("label");
          const input =
            label?.querySelector('input[type="radio"],input[type="checkbox"]') ||
            (element.querySelector?.('input[type="radio"],input[type="checkbox"]') as HTMLInputElement | null);
          if (input instanceof HTMLInputElement) {
            input.checked = true;
            dispatch(input);
            dispatch(label || element);
            return true;
          }
          const clickable = element.closest("button,[role='button'],[role='radio'],[role='option'],[role='menuitem'],label") || element;
          (clickable as HTMLElement).click();
          dispatch(clickable);
          return true;
        }
        return false;
      })
      .catch(() => false);
  }

  private async uploadDouyinCovers(page: Page, covers: CoverPaths) {
    const landscape = covers.landscape || covers.portrait;
    const portrait = covers.portrait || covers.landscape;
    if (!(await this.openDouyinCoverEditor(page))) return false;

    if (landscape) {
      if (!(await this.clickDouyinCoverEditorText(page, "\u8bbe\u7f6e\u6a2a\u5c01\u9762", "top", 5000))) return false;
      if (!(await this.uploadDouyinCoverFile(page, landscape))) return false;
      if (!(await this.waitForDouyinCoverApplied(page, 60_000))) return false;
    }

    if (portrait) {
      if (!(await this.clickDouyinCoverEditorText(page, "\u8bbe\u7f6e\u7ad6\u5c01\u9762", "top", 5000))) return false;
      if (!(await this.uploadDouyinCoverFile(page, portrait))) return false;
      if (!(await this.waitForDouyinCoverApplied(page, 60_000))) return false;
    }

    const completed = await this.clickDouyinCoverEditorText(page, "\u5b8c\u6210", "bottom", 30_000);
    if (!completed) return false;
    return this.waitForCoverDialogClosed(page, 15_000);
  }

  private async uploadKuaishouCover(page: Page, coverPath: string) {
    if (await this.kuaishouCoverDialogLooksLikeStaleCapture(page)) {
      this.logKuaishouCover("close-stale-dialog", { ok: true });
      await this.closeKuaishouCoverDialog(page);
      await this.waitForKuaishouCoverDialogClosed(page, 3000);
    }
    await this.scrollCoverSectionIntoView(page);
    const beforeCover = await this.kuaishouMainCoverSignature(page);
    if (!(await this.openKuaishouCoverDialog(page))) {
      this.logKuaishouCover("open-dialog", { ok: false });
      return false;
    }
    this.logKuaishouCover("open-dialog", { ok: true });
    const fail = async () => {
      await this.saveKuaishouCoverDebugSnapshot(page, "failed");
      return false;
    };

    if (!(await this.uploadKuaishouCoverFile(page, coverPath))) return fail();
    if (!(await this.waitForKuaishouCoverUploadPreview(page, 30_000))) {
      this.logKuaishouCover("wait-preview", { ok: false });
      return fail();
    }
    this.logKuaishouCover("wait-preview", { ok: true });
    await this.saveKuaishouCoverDebugSnapshot(page, "wait-preview-success");

    const confirmed = await this.confirmKuaishouCoverDialog(page);
    this.logKuaishouCover("confirm-dialog", { ok: confirmed });
    if (!confirmed) return fail();
    const closed = await this.waitForKuaishouCoverDialogClosed(page, 12_000);
    this.logKuaishouCover("dialog-closed", { ok: closed });
    if (!closed) return fail();
    const changed = await this.waitForKuaishouMainCoverChange(page, beforeCover, 10_000);
    this.logKuaishouCover("main-cover-change", { ok: changed });
    return changed;
  }

  private async confirmKuaishouCoverDialog(page: Page) {
    if (!(await this.hasKuaishouCoverDialog(page))) return true;
    if (!(await this.kuaishouCoverDialogPreviewSignature(page))) return false;
    if (!(await this.clickKuaishouCoverConfirmButton(page))) return false;

    const started = Date.now();
    while (Date.now() - started < 3_000) {
      if (!(await this.hasKuaishouCoverDialog(page))) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  private async clickKuaishouCoverConfirmButton(page: Page) {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let dialogIndex = dialogCount - 1; dialogIndex >= 0; dialogIndex -= 1) {
      const dialog = dialogs.nth(dialogIndex);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const dialogBox = await dialog.boundingBox({ timeout: 500 }).catch(() => null);
      const controls = dialog.locator("button,.ant-btn,.semi-button,[role='button'],span,div").filter({ hasText: "\u786e\u8ba4" });
      const controlCount = await controls.count().catch(() => 0);
      const candidates: Array<{ locator: Locator; score: number; box: { x: number; y: number; width: number; height: number } }> = [];

      for (let index = 0; index < Math.min(controlCount, 40); index += 1) {
        const control = controls.nth(index);
        if (!(await control.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const text = ((await control.innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, "");
        if (!text.includes("\u786e\u8ba4")) continue;
        const disabled = await control
          .evaluate((element) => {
            const wrapper = element.closest("button,[aria-disabled],.is-disabled,.disabled") as HTMLElement | null;
            return (
              element.getAttribute("aria-disabled") === "true" ||
              wrapper?.getAttribute("aria-disabled") === "true" ||
              wrapper?.className?.toString().includes("disabled") ||
              (wrapper instanceof HTMLButtonElement && wrapper.disabled)
            );
          })
          .catch(() => false);
        if (disabled) continue;
        const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
        if (!box || box.width < 8 || box.height < 8) continue;
        const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
        const className = await control.evaluate((element) => (element as HTMLElement).className?.toString() || "").catch(() => "");
        const clickableScore = tag === "button" || /btn|button|confirm|primary|semi-button|ant-btn/.test(className) ? 20_000 : 0;
        const exactScore = text === "\u786e\u8ba4" ? 100_000 : Math.max(0, 50_000 - text.length * 150);
        const areaScore = Math.max(0, 20_000 - box.width * box.height);
        const lowerScore = dialogBox ? Math.max(0, box.y + box.height / 2 - (dialogBox.y + dialogBox.height * 0.55)) : 0;
        const rightScore = dialogBox ? Math.max(0, box.x + box.width / 2 - (dialogBox.x + dialogBox.width * 0.55)) : 0;
        candidates.push({ locator: control, score: exactScore + clickableScore + areaScore + lowerScore + rightScore, box });
      }

      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, 4)) {
        const clicked = await candidate.locator
          .click({ force: true, timeout: 1000 })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          await page.mouse.click(candidate.box.x + candidate.box.width / 2, candidate.box.y + candidate.box.height / 2).catch(() => undefined);
        }
        await page.waitForTimeout(500);
        return true;
      }
    }
    return false;
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
    this.expectedFileChooserFiles.set(page, coverPath);
    try {
      const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
      if (!(await this.clickDouyinCoverEditorText(page, WORD.uploadCover, "bottom", 5000))) return false;
      const fileChooser = await fileChooserPromise;
      if (fileChooser) {
        await fileChooser.setFiles(coverPath).catch(() => undefined);
        await page.waitForTimeout(350);
        return true;
      }

      const input = await this.waitForDouyinCoverInput(page, 5000);
      if (!input) return false;
      await input.setInputFiles(coverPath);
      await page.waitForTimeout(350);
      return true;
    } finally {
      this.expectedFileChooserFiles.delete(page);
    }
  }

  private async waitForDouyinCoverApplied(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await page
        .evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.semi-modal-content,.semi-modal,.ant-modal-content'));
          const dialog = dialogs.find((element) => (element.textContent || "").includes("\u5c01\u9762")) || document.body;
          const text = (dialog.textContent || "").replace(/\s+/g, "");
          const uploading = /\u4e0a\u4f20\u4e2d|\u751f\u6210\u4e2d|\u5904\u7406\u4e2d|loading/i.test(text);
          const failed = /\u4e0a\u4f20\u5931\u8d25|\u91cd\u8bd5|\u5931\u8d25/.test(text);
          const hasImage = Array.from(dialog.querySelectorAll("img")).some((image) => {
            const rect = image.getBoundingClientRect();
            return rect.width > 20 && rect.height > 20 && Boolean(image.currentSrc || image.src);
          });
          const hasBlobBackground = Array.from(dialog.querySelectorAll("*")).some((element) => {
            const rect = element.getBoundingClientRect();
            const background = getComputedStyle(element).backgroundImage;
            return rect.width > 20 && rect.height > 20 && /blob:|data:image|http/.test(background);
          });
          return { uploading, failed, hasImage, hasBlobBackground };
        })
        .catch(() => ({ uploading: false, failed: false, hasImage: false, hasBlobBackground: false }));

      if (state.failed) return false;
      if (!state.uploading && (state.hasImage || state.hasBlobBackground)) return true;
      await page.waitForTimeout(800);
    }
    return false;
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
    const labelBox = await this.findSmallestVisibleTextBox(page, WORD.coverSettings);
    const elements = page.locator("img,div,span,[style]");
    const count = await elements.count().catch(() => 0);
    const candidates: Array<{ signature: string; score: number; area: number }> = [];
    const labelCenterY = labelBox ? labelBox.y + labelBox.height / 2 : null;

    for (let index = 0; index < Math.min(count, 800); index += 1) {
      const element = elements.nth(index);
      if (!(await element.isVisible({ timeout: 100 }).catch(() => false))) continue;
      const box = await element.boundingBox({ timeout: 100 }).catch(() => null);
      if (!box || box.width * box.height < 8_000) continue;
      const meta = await element
        .evaluate((node) => {
          if (node.closest('[role="dialog"],.semi-modal,.semi-modal-content,.ant-modal,.ant-modal-content')) return null;
          const bg = getComputedStyle(node).backgroundImage;
          const ownImage = node instanceof HTMLImageElement ? node.currentSrc || node.src : "";
          const childImages = Array.from(node.querySelectorAll("img"))
            .map((image) => image.currentSrc || image.src)
            .filter(Boolean);
          const childBackgrounds = Array.from(node.querySelectorAll("*"))
            .map((child) => getComputedStyle(child).backgroundImage)
            .filter((background) => background && background !== "none");
          const signature = [node.outerHTML.slice(0, 300), bg !== "none" ? bg : "", ownImage, ...childImages, ...childBackgrounds].filter(Boolean).join("|");
          if (!signature.includes("url(") && !ownImage && !childImages.length) return null;
          return signature;
        })
        .catch(() => null);
      if (!meta) continue;

      const centerY = box.y + box.height / 2;
      const labelScore =
        labelBox && labelCenterY !== null
          ? (box.x >= labelBox.x + labelBox.width - 12 ? 80_000 : 0) + Math.max(0, 40_000 - Math.abs(centerY - labelCenterY) * 400)
          : 0;
      candidates.push({ signature: meta, score: labelScore + Math.min(30_000, box.width * box.height), area: box.width * box.height });
    }

    candidates.sort((left, right) => right.score - left.score || right.area - left.area);
    return candidates[0]?.signature || null;
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
    try {
      return await this.kuaishouCoverDialogs(page)
        .first()
        .isVisible()
        .catch(() => false);
    } catch {
      return false;
    }
  }

  private kuaishouCoverDialogs(page: Page) {
    return page.locator('[role="dialog"],.ant-modal,.ant-modal-content,.semi-modal,.semi-modal-content').filter({ hasText: /\u5c01\u9762\u622a\u53d6|\u4e0a\u4f20\u5c01\u9762/ });
  }

  private async kuaishouCoverDialogLooksLikeStaleCapture(page: Page) {
    try {
      const dialogs = this.kuaishouCoverDialogs(page);
      const count = await dialogs.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const dialog = dialogs.nth(index);
        if (!(await dialog.isVisible().catch(() => false))) continue;
        const text = await dialog.innerText({ timeout: 500 }).catch(() => "");
        if (/00:00|\u53bb\u7f16\u8f91/.test(text) && !/\u4e0a\u4f20\u56fe\u7247|\u6e05\u7a7a\s*\u4e0a\u4f20/.test(text)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async waitForKuaishouCoverDialogClosed(page: Page, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!(await this.hasKuaishouCoverDialog(page))) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async waitForKuaishouDialogImageInput(page: Page, timeoutMs: number, requireAvailable = true) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const input = await this.kuaishouDialogImageInput(page, requireAvailable);
      if (input) return input;
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async uploadKuaishouCoverFile(page: Page, coverPath: string) {
    const uploadPath = await this.kuaishouSafeUploadCoverPath(coverPath);
    this.expectedFileChooserFiles.set(page, coverPath);
    try {
      const chooserPromise = this.waitForKuaishouCoverFileChooser(page, 10_000);
      const clicked = await this.clickKuaishouUploadCoverTab(page);
      this.logKuaishouCover("click-upload-tab", { ok: clicked });
      if (!clicked) return false;
      await this.saveKuaishouCoverDebugSnapshot(page, "after-upload-tab");

      let chooser = await Promise.race([chooserPromise, page.waitForTimeout(1500).then(() => null)]);
      if (chooser) {
        await chooser.setFiles(uploadPath);
        await page.waitForTimeout(1000);
        await this.saveKuaishouCoverDebugSnapshot(page, "after-filechooser");
        this.logKuaishouCover("upload-file", { ok: true, method: "filechooser-tab" });
        return true;
      }

      const activeInput = await this.kuaishouDialogImageInput(page, true);
      if (activeInput) {
        await activeInput.setInputFiles(uploadPath);
        await page.waitForTimeout(800);
        await this.saveKuaishouCoverDebugSnapshot(page, "after-active-input");
        this.logKuaishouCover("upload-file", { ok: true, method: "active-input" });
        return true;
      }

      const panelClicked = await this.clickKuaishouUploadPanelFileTrigger(page);
      this.logKuaishouCover("click-upload-trigger", { ok: panelClicked });
      if (panelClicked) {
        chooser = await chooserPromise;
        if (chooser) {
          await chooser.setFiles(uploadPath);
          await page.waitForTimeout(1000);
          await this.saveKuaishouCoverDebugSnapshot(page, "after-panel-filechooser");
          this.logKuaishouCover("upload-file", { ok: true, method: "filechooser-panel" });
          return true;
        }
      }

      chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(uploadPath);
        await page.waitForTimeout(1000);
        await this.saveKuaishouCoverDebugSnapshot(page, "after-delayed-filechooser");
        this.logKuaishouCover("upload-file", { ok: true, method: "filechooser-delayed" });
        return true;
      }

      this.logKuaishouCover("upload-file", { ok: false, reason: "no-filechooser-or-active-input" });
      return false;
    } finally {
      this.expectedFileChooserFiles.delete(page);
    }
  }

  private async kuaishouSafeUploadCoverPath(coverPath: string) {
    const ext = path.extname(coverPath).toLowerCase() || ".png";
    const info = await stat(coverPath).catch(() => null);
    const hash = createHash("sha1")
      .update(`${coverPath}:${info?.mtimeMs || 0}:${info?.size || 0}`)
      .digest("hex")
      .slice(0, 12);
    const dir = path.resolve(this.profilesDir, "..", "temp", "kuaishou-covers");
    await mkdir(dir, { recursive: true });
    const safePath = path.join(dir, `cover-${hash}${ext}`);
    const copied = await copyFile(coverPath, safePath)
      .then(() => true)
      .catch(() => false);
    if (!copied) return coverPath;
    return safePath;
  }

  private async clickKuaishouUploadCoverTab(page: Page) {
    if (await this.clickKuaishouCoverDialogText(page, WORD.uploadCover, "top")) return true;
    return this.clickKuaishouCoverDialogExactText(page, WORD.uploadCover, "top");
  }

  private async waitForKuaishouCoverFileChooser(page: Page, timeoutMs: number) {
    return page
      .waitForEvent("filechooser", { timeout: timeoutMs })
      .then((chooser) => chooser)
      .catch(() => null);
  }

  private async clickKuaishouUploadPanelFileTrigger(page: Page) {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let dialogIndex = dialogCount - 1; dialogIndex >= 0; dialogIndex -= 1) {
      const dialog = dialogs.nth(dialogIndex);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const dialogBox = await dialog.boundingBox({ timeout: 500 }).catch(() => null);
      if (!dialogBox) continue;
      const controls = dialog.locator("button,[role='button'],.semi-upload,.ant-upload,[class*='upload'],[class*='Upload']").filter({
        hasText: /\u4e0a\u4f20\u56fe\u7247|\u70b9\u51fb\u4e0a\u4f20|\u9009\u62e9\u56fe\u7247|\u4e0a\u4f20/
      });
      const controlCount = await controls.count().catch(() => 0);
      const candidates: Array<{ locator: Locator; score: number; box: { x: number; y: number; width: number; height: number } }> = [];

      for (let index = 0; index < Math.min(controlCount, 40); index += 1) {
        const control = controls.nth(index);
        if (!(await control.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
        if (!box || box.width < 20 || box.height < 20) continue;
        const centerY = box.y + box.height / 2;
        if (centerY < dialogBox.y + Math.max(150, dialogBox.height * 0.28)) continue;
        const text = ((await control.innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, "");
        if (/\u5c01\u9762\u622a\u53d6|\u53d6\u6d88|\u786e\u8ba4|\u5173\u95ed|^\u00d7$/.test(text)) continue;
        const className = await control.evaluate((element) => (element as HTMLElement).className?.toString() || "").catch(() => "");
        const exactUploadScore = /\u4e0a\u4f20\u56fe\u7247|\u70b9\u51fb\u4e0a\u4f20|\u9009\u62e9\u56fe\u7247/.test(text) ? 100_000 : 0;
        const uploadClassScore = /upload/i.test(className) ? 30_000 : 0;
        candidates.push({ locator: control, score: exactUploadScore + uploadClassScore + Math.min(10_000, box.width * box.height), box });
      }

      candidates.sort((left, right) => right.score - left.score);
      for (const candidate of candidates.slice(0, 2)) {
        await this.saveKuaishouCoverDebugSnapshot(page, "before-upload-trigger");
        const clicked = await candidate.locator
          .click({ force: true, timeout: 1000 })
          .then(() => true)
          .catch(() => false);
        if (!clicked) await page.mouse.click(candidate.box.x + candidate.box.width / 2, candidate.box.y + candidate.box.height / 2).catch(() => undefined);
        await page.waitForTimeout(500);
        return true;
      }
    }
    return false;
  }

  private async clickKuaishouCoverDialogExactText(page: Page, label: string, region: "top" | "any" = "any") {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let index = 0; index < Math.min(dialogCount, 8); index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const box = await dialog.boundingBox({ timeout: 300 }).catch(() => null);
      if (box) dialogBoxes.push(box);
    }

    const candidates = page.getByText(label, { exact: true });
    const count = await candidates.count().catch(() => 0);
    const visible: Array<{ locator: Locator; score: number; box: { x: number; y: number; width: number; height: number } }> = [];
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const box = await locator.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.width < 8 || box.height < 8) continue;
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const containingDialog = dialogBoxes.find(
        (dialogBox) =>
          centerX >= dialogBox.x &&
          centerX <= dialogBox.x + dialogBox.width &&
          centerY >= dialogBox.y &&
          centerY <= dialogBox.y + dialogBox.height
      );
      if (dialogBoxes.length && !containingDialog) continue;
      if (region === "top" && containingDialog && centerY > containingDialog.y + Math.max(150, containingDialog.height * 0.3)) continue;
      const dialogScore = containingDialog ? 80_000 : 0;
      const topScore = containingDialog ? Math.max(0, 20_000 - Math.abs(box.y - containingDialog.y) * 100) : Math.max(0, 20_000 - box.y * 10);
      visible.push({ locator, score: dialogScore + topScore + Math.max(0, 10_000 - box.width * box.height), box });
    }

    visible.sort((left, right) => right.score - left.score);
    for (const candidate of visible.slice(0, 4)) {
      const clicked = await candidate.locator
        .click({ force: true, timeout: 1000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) await page.mouse.click(candidate.box.x + candidate.box.width / 2, candidate.box.y + candidate.box.height / 2).catch(() => undefined);
      await page.waitForTimeout(500);
      return true;
    }
    return false;
  }

  private logKuaishouCover(stage: string, fields: Record<string, unknown> = {}) {
    console.log("[publisher:kuaishou-cover]", { stage, ...fields });
  }

  private async saveKuaishouCoverDebugSnapshot(page: Page, stage: string) {
    try {
      const dir = path.resolve(this.profilesDir, "..", "diagnostics", "kuaishou-cover");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${stage}.png`);
      await page.screenshot({ path: file, fullPage: true, timeout: 3000 });
      const summary = await this.kuaishouCoverDialogSummary(page);
      console.log("[publisher:kuaishou-cover-debug]", { stage, file, ...summary });
    } catch (error) {
      console.warn("[publisher:kuaishou-cover-debug]", { stage, error });
    }
  }

  private async kuaishouCoverDialogSummary(page: Page) {
    return page
      .evaluate(() => {
        const dialog =
          [...document.querySelectorAll('[role="dialog"],.ant-modal,.ant-modal-content,.semi-modal,.semi-modal-content')].find((element) =>
            /封面截取|上传封面/.test(element.textContent || "")
          ) || null;
        if (!dialog) return { hasDialog: false };
        const dialogRect = dialog.getBoundingClientRect();
        const controls = [...dialog.querySelectorAll("button,[role='button'],[role='tab'],.semi-tabs-tab,.ant-tabs-tab,.semi-upload,.ant-upload,input[type='file'],span,div")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const input = element instanceof HTMLInputElement ? { type: element.type, accept: element.accept, files: element.files?.length || 0 } : {};
            return {
              tag: element.tagName.toLowerCase(),
              text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
              role: element.getAttribute("role") || "",
              className: (element as HTMLElement).className?.toString().slice(0, 80) || "",
              visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01 && rect.width > 0 && rect.height > 0,
              x: Math.round(rect.x - dialogRect.x),
              y: Math.round(rect.y - dialogRect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              ...input
            };
          })
          .filter((item) => item.visible || item.tag === "input")
          .slice(0, 80);
        return { hasDialog: true, controls };
      })
      .catch(() => ({ hasDialog: false }));
  }

  private async kuaishouDialogImageInput(page: Page, requireAvailable = true) {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let index = dialogCount - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const inputs = dialog.locator('input[type="file"][accept*="image"]');
      const inputCount = await inputs.count().catch(() => 0);
      for (let inputIndex = inputCount - 1; inputIndex >= 0; inputIndex -= 1) {
        const input = inputs.nth(inputIndex);
        if (!requireAvailable) return input;
        const available = await input
          .evaluate((element) => {
            let current: Element | null = element;
            while (current && current !== document.body) {
              const style = getComputedStyle(current);
              const rect = current.getBoundingClientRect();
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0.01) return false;
              if (current !== element && !rect.width && !rect.height) return false;
              current = current.parentElement;
            }
            return true;
          })
          .catch(() => false);
        if (available) return input;
      }
    }
    return null;
  }

  private async clickKuaishouCoverDialogText(page: Page, label: string, region: "top" | "any" = "any") {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let dialogIndex = dialogCount - 1; dialogIndex >= 0; dialogIndex -= 1) {
      const dialog = dialogs.nth(dialogIndex);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const dialogBox = await dialog.boundingBox({ timeout: 500 }).catch(() => null);
      const controls = dialog.locator("button,[role='button'],[role='tab'],.semi-tabs-tab,.ant-tabs-tab,span,div").filter({ hasText: label });
      const controlCount = await controls.count().catch(() => 0);
      const candidates: Array<{ locator: Locator; score: number; text: string; box: { x: number; y: number; width: number; height: number } }> = [];
      for (let index = 0; index < Math.min(controlCount, 80); index += 1) {
        const control = controls.nth(index);
        if (!(await control.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const text = ((await control.innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, "");
        if (!text.includes(label)) continue;
        if (label === WORD.uploadCover && text.includes("\u5c01\u9762\u622a\u53d6") && !text.includes(WORD.uploadCover)) continue;
        if (text !== label && text.length > label.length + 4) continue;
        const box = await control.boundingBox({ timeout: 300 }).catch(() => null);
        if (!box || box.width < 8 || box.height < 8) continue;
        if (region === "top" && dialogBox && box.y + box.height / 2 > dialogBox.y + Math.max(140, dialogBox.height * 0.25)) continue;
        const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
        const className = await control.evaluate((element) => (element as HTMLElement).className?.toString() || "").catch(() => "");
        const exactScore = text === label ? 100_000 : Math.max(0, 50_000 - text.length * 120);
        const clickableScore = tag === "button" || /tab|btn|button/.test(className) || (await control.getAttribute("role").catch(() => "")) ? 20_000 : 0;
        const areaScore = Math.max(0, 15_000 - box.width * box.height);
        const topScore = dialogBox ? Math.max(0, 20_000 - Math.abs(box.y - dialogBox.y) * 100) : 0;
        candidates.push({ locator: control, score: exactScore + clickableScore + areaScore + topScore, text, box });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, 4)) {
        const position =
          label === WORD.uploadCover && candidate.text.includes("\u5c01\u9762\u622a\u53d6") && candidate.text.includes(WORD.uploadCover)
            ? { x: Math.min(candidate.box.width - 4, Math.max(4, candidate.box.width * 0.75)), y: candidate.box.height / 2 }
            : undefined;
        const clicked = await candidate.locator
          .click({ force: true, timeout: 1000, ...(position ? { position } : {}) })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          const x = candidate.box.x + (position?.x ?? candidate.box.width / 2);
          const y = candidate.box.y + (position?.y ?? candidate.box.height / 2);
          await page.mouse.click(x, y).catch(() => undefined);
        }
        await page.waitForTimeout(500);
        return true;
      }
    }
    return false;
  }

  private async closeKuaishouCoverDialog(page: Page) {
    if (!(await this.hasKuaishouCoverDialog(page))) return;
    if (await this.clickKuaishouCoverDialogText(page, "\u00d7")) return;
    if (await this.clickKuaishouCoverDialogText(page, "\u5173\u95ed")) return;
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let index = dialogCount - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const box = await dialog.boundingBox({ timeout: 500 }).catch(() => null);
      if (!box) continue;
      await page.mouse.click(box.x + box.width - 32, box.y + 32).catch(() => undefined);
      await page.waitForTimeout(500);
      if (!(await this.hasKuaishouCoverDialog(page))) return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(500);
  }

  private async waitForKuaishouCoverUploadPreview(page: Page, timeoutMs: number) {
    const started = Date.now();
    let nextSnapshotAt = 10_000;
    while (Date.now() - started < timeoutMs) {
      if (await this.kuaishouCoverDialogPreviewSignature(page)) return true;
      const elapsed = Date.now() - started;
      if (elapsed >= nextSnapshotAt) {
        await this.saveKuaishouCoverDebugSnapshot(page, `wait-preview-${Math.round(nextSnapshotAt / 1000)}s`);
        nextSnapshotAt += 10_000;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async kuaishouCoverDialogPreviewSignature(page: Page) {
    const dialogs = this.kuaishouCoverDialogs(page);
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let dialogIndex = dialogCount - 1; dialogIndex >= 0; dialogIndex -= 1) {
      const dialog = dialogs.nth(dialogIndex);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const uploadedMarker = await dialog
        .evaluate((element) => /清空\s*上传/.test(element.textContent || ""))
        .catch(() => false);
      if (uploadedMarker) return "kuaishou-uploaded-cover-marker";
      const media = dialog.locator("img,div,span");
      const mediaCount = await media.count().catch(() => 0);
      for (let index = 0; index < Math.min(mediaCount, 300); index += 1) {
        const item = media.nth(index);
        if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
        const box = await item.boundingBox({ timeout: 200 }).catch(() => null);
        if (!box || box.width * box.height < 8_000) continue;
        const signature = await item
          .evaluate((element) => {
            const tag = element.tagName.toLowerCase();
            const image = element instanceof HTMLImageElement ? element.currentSrc || element.src : "";
            const background = getComputedStyle(element).backgroundImage;
            if (image) return `img:${image}`;
            if (tag !== "canvas" && background && background !== "none" && /url\(/.test(background)) return `bg:${background}`;
            return "";
          })
          .catch(() => "");
        if (signature) return signature;
      }
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
    const completed = (await this.clickVisibleDialogText(page, "\u5b8c\u6210", 25_000)) || (await this.clickVisibleButton(page, "\u5b8c\u6210", 5_000));
    if (!completed) return false;
    return this.waitForCoverDialogClosed(page, 8_000);
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
    const expected = post.body.trim();
    if (!expected && post.hashtags.length) return this.tryFillDouyinTopics(page, post.hashtags, 10_000);
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
    if (!this.editorTextMatchesExpected(actual, expected)) {
      await this.fillDouyinIntroEditor(page, editor, expected, 1500);
      await page.waitForTimeout(250);
      actual = await read();
    }

    const bodyMatches = this.editorTextMatchesExpected(actual, expected);
    const topicsMatch = post.hashtags.length ? await this.tryFillDouyinTopics(page, post.hashtags, 10_000) : true;
    const matches = bodyMatches && topicsMatch;
    console.log("[publisher:douyin-body]", {
      expectedLength: normalizeEditorText(expected).length,
      actualLength: actual.length,
      matches
    });
    return matches;
  }

  private async verifyDouyinBody(page: Page, expected: string) {
    return this.verifyDouyinIntro(page, expected);
  }

  private async verifyDouyinIntro(page: Page, expected: string) {
    const editor = await this.findDouyinBodyEditor(page, expected);
    if (!editor) return false;
    const actual = await editor
      .evaluate((element) => (element as HTMLElement).innerText || element.textContent || "")
      .then(normalizeEditorText)
      .catch(() => "");
    return this.editorTextMatchesExpected(actual, expected);
  }

  private async clickDouyinIntroPlaceholder(page: Page) {
    if (typeof page.getByText !== "function") return false;
    const placeholder = page.getByText(WORD.workIntro, { exact: false }).first();
    if (!(await placeholder.isVisible({ timeout: 500 }).catch(() => false))) return false;
    await placeholder.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
    const box = await placeholder.boundingBox({ timeout: 500 }).catch(() => null);
    if (!box) return false;
    await page.mouse.click(box.x + Math.min(24, Math.max(4, box.width / 2)), box.y + box.height / 2).catch(() => undefined);
    await page.waitForTimeout(250);
    return true;
  }

  private async fillDouyinIntroEditor(page: Page, locator: Locator, value: string, actionTimeoutMs: number) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: actionTimeoutMs }).catch(() => undefined);
      await locator.click({ timeout: actionTimeoutMs });
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await page.keyboard.insertText(value);
      await locator.evaluate((element) => {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(200);
      if (await this.verifyDouyinIntro(page, value)) return true;
    } catch {
      // Fall through to direct DOM assignment when the editor swallows keyboard input.
    }

    try {
      await locator.evaluate((element, text) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          element.value = text;
        } else {
          element.replaceChildren(document.createTextNode(text));
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
      await page.waitForTimeout(200);
      return this.verifyDouyinIntro(page, value);
    } catch {
      return false;
    }
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
      return this.editorTextMatchesExpected(actual, value);
    } catch {
      return false;
    }
  }

  private editorTextMatchesExpected(actual: string, expected: string) {
    const normalizedActual = normalizeEditorText(actual);
    const normalizedExpected = normalizeEditorText(expected);
    if (!normalizedExpected) return false;
    return normalizedActual === normalizedExpected || normalizedActual.includes(normalizedExpected);
  }

  private async findDouyinBodyEditor(page: Page, expected: string) {
    const strict = await this.findVisibleLocator(page, FIELD_SELECTORS.douyin.body);
    if (strict) return strict;

    const candidates = page.locator('[contenteditable="true"], textarea, [role="textbox"]');
    const count = await candidates.count().catch(() => 0);
    const expectedSnippet = normalizeEditorText(expected).slice(0, 12);
    const summaries: Array<{ index: number; score: number; width: number; height: number; text: string; meta: string }> = [];
    let best: { locator: Locator; score: number } | null = null;
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box || box.width < 200 || box.height < 40) continue;
      const text = normalizeEditorText(await candidate.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
        return (element as HTMLElement).innerText || element.textContent || "";
      }, { timeout: 300 }).catch(() => ""));
      const meta = await candidate
        .evaluate((element) => {
          let ancestorText = "";
          let current: Element | null = element;
          for (let depth = 0; depth < 5 && current; depth += 1) {
            ancestorText += ` ${current.textContent || ""}`;
            current = current.parentElement;
          }
          const attributes = ["placeholder", "aria-label", "data-placeholder", "name", "id", "class"]
            .map((name) => element.getAttribute(name) || "")
            .join(" ");
          return `${attributes} ${ancestorText}`;
        }, { timeout: 300 })
        .catch(() => "");
      const normalizedMeta = meta.replace(/\s+/g, "");
      const score =
        (text.includes(expectedSnippet) ? 100_000 : 0) +
        (normalizedMeta.includes(WORD.workIntro) ? 80_000 : 0) +
        (normalizedMeta.includes("\u4f5c\u54c1\u63cf\u8ff0") ? 60_000 : 0) +
        (/正文|描述|简介|话题|description/i.test(normalizedMeta) ? 20_000 : 0) +
        (text.includes("#") ? 10_000 : 0) +
        Math.min(10_000, Math.round((box.width * box.height) / 100)) -
        (/标题|封面|title|cover/i.test(normalizedMeta) ? 80_000 : 0);
      summaries.push({
        index,
        score,
        width: Math.round(box.width),
        height: Math.round(box.height),
        text: text.slice(0, 120),
        meta: normalizedMeta.slice(0, 120)
      });
      if (score > 0 && (!best || score > best.score)) best = { locator: candidate, score };
    }
    if (best) return best.locator;
    console.log("[publisher:douyin-body-candidates]", summaries);
    return null;
  }

  private async findDouyinTopicInput(page: Page) {
    for (const selector of [
      'input:focus:not([type="file"]):not([type="hidden"])',
      `input[placeholder*="${WORD.topic}"]`,
      `input[placeholder*="${WORD.tag}"]`,
      'input[placeholder*="\u8f93\u5165\u8bdd\u9898"]'
    ]) {
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 300 }).catch(() => false)) return input;
    }

    const labelBox = await this.findSmallestVisibleTextBox(page, "#\u6dfb\u52a0\u8bdd\u9898");
    const inputs = page.locator('input:not([type="file"]):not([type="hidden"]), textarea');
    const count = await inputs.count().catch(() => 0);
    const candidates: Array<{ locator: Locator; score: number }> = [];
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      const box = await input.boundingBox({ timeout: 300 }).catch(() => null);
      if (!box) continue;
      if (!labelBox) continue;
      const yDistance = Math.abs(box.y + box.height / 2 - (labelBox.y + labelBox.height / 2));
      if (yDistance > 40) continue;
      const meta = [
        await input.getAttribute("placeholder").catch(() => ""),
        await input.getAttribute("aria-label").catch(() => ""),
        await input.evaluate((element) => element.parentElement?.textContent || "").catch(() => "")
      ].join(" ");
      const normalizedMeta = meta.replace(/\s+/g, "");
      const topicScore = /\u8bdd\u9898|\u6807\u7b7e|topic|tag/i.test(normalizedMeta) ? 100_000 : 0;
      const rowScore = Math.max(0, 40_000 - yDistance * 1000);
      const notTitlePenalty = /\u6807\u9898|title/i.test(normalizedMeta) ? 100_000 : 0;
      const score = topicScore + rowScore - notTitlePenalty;
      if (score > 0) candidates.push({ locator: input, score });
    }
    return candidates.sort((left, right) => right.score - left.score)[0]?.locator || null;
  }

  private async openDouyinTopicInput(page: Page) {
    const addTopic = page.getByText("#\u6dfb\u52a0\u8bdd\u9898", { exact: true });
    const count = await addTopic.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const target = addTopic.nth(index);
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 1000 }).catch(async () => {
        const box = await target.boundingBox({ timeout: 300 }).catch(() => null);
        if (box) await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + box.height / 2).catch(() => undefined);
      });
      await page.waitForTimeout(400);
      return true;
    }
    for (const label of ["#\u6dfb\u52a0\u8bdd\u9898", WORD.topic, WORD.tag]) {
      if (await this.clickVisibleText(page, label, 800)) {
        await page.waitForTimeout(400);
        return true;
      }
    }
    return false;
  }

  private async tryFillDouyinInlineTopic(page: Page, tag: string) {
    const editor = await this.findDouyinBodyEditor(page, "");
    if (!editor) return false;

    await editor.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
    if (!(await this.hasDouyinTopicSuggestionPopup(page))) {
      if (!(await this.openDouyinTopicInput(page))) {
        await editor.click({ timeout: 1000 }).catch(() => undefined);
        await page.keyboard.press("End").catch(() => undefined);
        await page.keyboard.insertText(" #");
      }
      await page.waitForTimeout(300);
    }

    await page.keyboard.insertText(tag);
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(700);

    if (await this.hasDouyinTopic(page, tag)) return true;
    await this.clickDouyinFirstTopicSuggestion(page, tag);
    await page.waitForTimeout(500);
    return this.hasDouyinTopic(page, tag);
  }

  private async hasDouyinTopicSuggestionPopup(page: Page) {
    return page
      .evaluate(() => {
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]'));
        const editorRects = editors.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 100 && rect.height > 30);
        const editorBottom = editorRects.length ? Math.min(...editorRects.map((rect) => rect.bottom)) : 0;
        return Array.from(document.querySelectorAll("div,li,span,button")).some((element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width < 120 || rect.height < 24 || rect.top < editorBottom - 8) return false;
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0.01) return false;
          if (element.closest('[contenteditable="true"], textarea, [role="textbox"]')) return false;
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return /^#\s*\S+/.test(text);
        });
      })
      .catch(() => false);
  }

  private async clickDouyinFirstTopicSuggestion(page: Page, preferredTag = "") {
    const point = await page
      .evaluate((rawPreferredTag) => {
        const preferredTag = rawPreferredTag.replace(/^#/, "").trim();
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]'));
        const editorRects = editors.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 100 && rect.height > 30);
        const editorBottom = editorRects.length ? Math.min(...editorRects.map((rect) => rect.bottom)) : 0;
        const candidates = Array.from(document.querySelectorAll("div,li,span,button"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            const visible =
              rect.width >= 120 &&
              rect.height >= 24 &&
              rect.top >= editorBottom - 8 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01;
            const outsideEditor = !element.closest('[contenteditable="true"], textarea, [role="textbox"]');
            const looksLikeTopic = /^#\s*\S+/.test(text);
            const className = String(element.getAttribute("class") || "");
            const suggestionScore =
              /suggest|option|select|dropdown|popup|list|item/i.test(className) || rect.width > 300 || rect.height > 36 ? 1000 : 0;
            const preferredScore = preferredTag && text.replace(/\s+/g, "").includes(preferredTag) ? 2000 : 0;
            return { element, rect, text, visible, outsideEditor, looksLikeTopic, score: preferredScore + suggestionScore - rect.top / 1000 };
          })
          .filter((candidate) => candidate.visible && candidate.outsideEditor && candidate.looksLikeTopic)
          .sort((left, right) => right.score - left.score || left.rect.top - right.rect.top || left.rect.left - right.rect.left);
        const target = candidates[0];
        if (!target) return null;
        return { x: target.rect.left + Math.min(36, Math.max(12, target.rect.width / 6)), y: target.rect.top + target.rect.height / 2 };
      }, preferredTag)
      .catch(() => null);
    if (!point) return false;
    await page.mouse.click(point.x, point.y).catch(() => undefined);
    return true;
  }

  private async hasDouyinTopic(page: Page, tag: string) {
    const normalized = tag.replace(/^#/, "").trim();
    if (!normalized) return true;
    return page
      .locator("span,button,div,a")
      .evaluateAll((elements, target) => {
        const exact = `#${target}`;
        return elements.some((element) => {
          const text = (element.textContent || "").replace(/\s+/g, "");
          if (text !== exact && text !== target) return false;
          const className = element.getAttribute("class") || "";
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
          if (!visible && !/topic|tag|chip/i.test(className)) return false;
          if (element.closest('[class*="recommend"],[class*="suggest"],[class*="hot"]')) return false;
          return true;
        });
      }, normalized)
      .catch(() => false);
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

  private async getContext(platform: Platform, accountId: string) {
    const key = this.contextKey(platform, accountId);
    const existing = this.contexts.get(key);
    if (existing) return existing;
    const profileDir = getProfileDir(this.profilesDir, platform, accountId);
    await mkdir(profileDir, { recursive: true });
    let lastError: unknown = null;
    for (const channel of await this.browserChannelsForProfile(profileDir)) {
      try {
        const context = await chromium.launchPersistentContext(profileDir, {
          channel,
          headless: this.headless,
          viewport: null,
          args: ["--start-maximized"]
        });
        context.on("close", () => {
          this.contexts.delete(key);
          this.activeChannels.delete(key);
        });
        this.contexts.set(key, context);
        this.activeChannels.set(key, channel);
        return context;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("无法启动 Edge 或 Chrome");
  }

  private async browserChannelsForProfile(profileDir: string): Promise<Array<(typeof BROWSER_CHANNELS)[number]>> {
    const existingChannel = await this.lastBrowserChannel(profileDir);
    return existingChannel ? [existingChannel] : [...BROWSER_CHANNELS];
  }

  private async lastBrowserChannel(profileDir: string): Promise<(typeof BROWSER_CHANNELS)[number] | null> {
    const bytes = await readFile(path.join(profileDir, "Last Browser")).catch(() => null);
    if (!bytes?.length) return null;
    const text = `${bytes.toString("utf16le")}\n${bytes.toString("utf8")}`.replace(/\0/g, "").toLowerCase();
    if (text.includes("msedge.exe") || text.includes("microsoft\\edge")) return "msedge";
    if (text.includes("chrome.exe") || text.includes("google\\chrome")) return "chrome";
    return null;
  }

  private contextKey(platform: Platform, accountId: string) {
    return `${platform}:${accountId}`;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
