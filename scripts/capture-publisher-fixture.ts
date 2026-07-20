import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";

const DEFAULT_ALLOWED_UI_TEXT = [
  "标题",
  "简介",
  "话题",
  "封面",
  "声明",
  "内容由AI生成",
  "确定",
  "完成",
  "发布"
] as const;

export async function captureSanitizedFixture(
  page: Page,
  selector: string,
  allowedUiText: readonly string[] = DEFAULT_ALLOWED_UI_TEXT
): Promise<string> {
  return page.locator(selector).evaluate(
    (selected, allowedText) => {
      const clone = selected.cloneNode(true) as HTMLElement;
      const allowed = new Set(allowedText);
      const removableSelector = [
        "script",
        "style",
        "template",
        "img",
        "video",
        "source",
        "[class*='avatar' i]",
        "[class*='account' i]",
        "[class*='user-info' i]",
        "[class*='profile' i]"
      ].join(",");

      clone.querySelectorAll(removableSelector).forEach((node) => node.remove());
      clone.querySelectorAll("a").forEach((link) => link.replaceWith(...link.childNodes));

      const commentWalker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments: Comment[] = [];
      for (let node = commentWalker.nextNode(); node; node = commentWalker.nextNode()) {
        comments.push(node as Comment);
      }
      comments.forEach((comment) => comment.remove());

      const elements = [clone, ...clone.querySelectorAll("*")];
      for (const element of elements) {
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          const isAllowed =
            name === "class" ||
            name === "role" ||
            name.startsWith("aria-") ||
            name.startsWith("data-") ||
            name === "type" ||
            name === "placeholder" ||
            name === "disabled" ||
            name === "checked";

          if (!isAllowed) {
            element.removeAttribute(attribute.name);
            continue;
          }

          if (name.startsWith("data-") && /(?:^|-)(?:auth|authorization|cookie|token|secret|key|url|src|href|path|account|user|uid)(?:-|$)/i.test(name.slice(5))) {
            element.removeAttribute(attribute.name);
            continue;
          }

          if (name.startsWith("data-") && attribute.value) {
            element.setAttribute(attribute.name, "[redacted]");
            continue;
          }

          if (
            (name === "placeholder" || name.startsWith("aria-")) &&
            attribute.value &&
            !/^(?:true|false|mixed|-?\d+(?:\.\d+)?)$/i.test(attribute.value.trim()) &&
            !allowed.has(attribute.value.trim())
          ) {
            element.setAttribute(attribute.name, "[redacted]");
          }
        }
      }

      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        textNodes.push(node as Text);
      }
      for (const textNode of textNodes) {
        const text = textNode.data.trim();
        if (!text) {
          textNode.remove();
        } else {
          textNode.data = allowed.has(text) ? text : "[redacted]";
        }
      }

      return clone.outerHTML;
    },
    [...DEFAULT_ALLOWED_UI_TEXT, ...allowedUiText]
  );
}

type CaptureCliConfig = {
  fixtureDir: string;
  fixtureName: string;
  profileDir: string;
  url: string;
  selector: string;
  allowedUiText?: string[];
  channel?: "msedge" | "chrome";
  headless?: boolean;
  timeoutMs?: number;
};

const EXPECTED_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "publisher", "douyin");

function pathsMatch(left: string, right: string) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

export async function resolveFixtureOutputPath(fixtureDir: string, fixtureName: string) {
  if (!fixtureDir.trim() || !/^[a-z0-9][a-z0-9-]*$/i.test(fixtureName)) throw new Error("invalid fixture output");
  const requestedRoot = path.resolve(fixtureDir);
  if (!pathsMatch(requestedRoot, EXPECTED_FIXTURE_ROOT)) throw new Error("invalid fixture output");

  const [requestedRealRoot, expectedRealRoot] = await Promise.all([realpath(requestedRoot), realpath(EXPECTED_FIXTURE_ROOT)]);
  if (!pathsMatch(requestedRealRoot, expectedRealRoot)) throw new Error("invalid fixture output");

  const outputFile = path.join(requestedRoot, `${fixtureName}.html`);
  const outputMetadata = await lstat(outputFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outputMetadata?.isSymbolicLink()) throw new Error("invalid fixture output");
  return outputFile;
}

function parseCliConfig(value: unknown): CaptureCliConfig {
  if (!value || typeof value !== "object") throw new Error("invalid config");
  const config = value as Record<string, unknown>;
  for (const field of ["fixtureDir", "fixtureName", "profileDir", "url", "selector"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) throw new Error("invalid config");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(config.fixtureName as string)) throw new Error("invalid config");
  if (config.channel !== undefined && config.channel !== "msedge" && config.channel !== "chrome") throw new Error("invalid config");
  if (config.allowedUiText !== undefined && (!Array.isArray(config.allowedUiText) || config.allowedUiText.some((item) => typeof item !== "string"))) {
    throw new Error("invalid config");
  }
  if (config.headless !== undefined && typeof config.headless !== "boolean") throw new Error("invalid config");
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || (config.timeoutMs as number) <= 0)) throw new Error("invalid config");
  const parsedUrl = new URL(config.url as string);
  if (parsedUrl.protocol !== "https:") throw new Error("invalid config");
  return config as CaptureCliConfig;
}

async function runCli(configFile: string | undefined) {
  if (!configFile) throw new Error("missing config");
  const config = parseCliConfig(JSON.parse(await readFile(path.resolve(configFile), "utf8")));
  const outputFile = await resolveFixtureOutputPath(config.fixtureDir, config.fixtureName);
  const fixtureDir = path.dirname(outputFile);
  const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
    channel: config.channel || "msedge",
    headless: config.headless ?? false,
    viewport: config.headless ? { width: 1440, height: 1000 } : null
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs || 45_000 });
    await page.locator(config.selector).waitFor({ state: "attached", timeout: config.timeoutMs || 120_000 });
    const html = await captureSanitizedFixture(page, config.selector, config.allowedUiText || []);
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(outputFile, `${html}\n`, "utf8");
  } finally {
    await context.close().catch(() => undefined);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  runCli(process.argv[2]).catch(() => {
    console.error("Fixture capture failed.");
    process.exitCode = 1;
  });
}
