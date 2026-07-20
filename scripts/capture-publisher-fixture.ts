import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";

export const DOUYIN_FIXED_UI_TEXT = [
  "标题",
  "简介",
  "作品简介",
  "添加作品简介",
  "话题",
  "添加话题",
  "封面",
  "封面设置",
  "选择封面",
  "上传封面",
  "上传图片",
  "设置横封面",
  "设置竖封面",
  "声明",
  "作者声明",
  "内容声明",
  "内容由AI生成",
  "AI生成",
  "确定",
  "确认",
  "完成",
  "发布"
] as const;

const DOUYIN_FIXED_UI_TEXT_SET = new Set<string>(DOUYIN_FIXED_UI_TEXT);

function validateAllowedUiText(allowedUiText: readonly string[]) {
  if (allowedUiText.some((item) => !DOUYIN_FIXED_UI_TEXT_SET.has(item))) throw new Error("invalid allowed UI text");
  return [...new Set(allowedUiText)];
}

export async function captureSanitizedFixture(
  page: Page,
  selector: string,
  allowedUiText: readonly string[] = DOUYIN_FIXED_UI_TEXT
): Promise<string> {
  const validatedAllowedUiText = validateAllowedUiText(allowedUiText);
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
    validatedAllowedUiText
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

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_FIXTURE_ROOT = path.join(REPOSITORY_ROOT, "tests", "fixtures", "publisher", "douyin");

function pathsMatch(left: string, right: string) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function isPathContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function assertSafeFixtureRoot(repositoryRoot: string, fixtureRoot: string) {
  const lexicalRepositoryRoot = path.resolve(repositoryRoot);
  const lexicalFixtureRoot = path.resolve(fixtureRoot);
  if (!isPathContained(lexicalRepositoryRoot, lexicalFixtureRoot) || pathsMatch(lexicalRepositoryRoot, lexicalFixtureRoot)) {
    throw new Error("invalid fixture root");
  }

  const relativeComponents = path.relative(lexicalRepositoryRoot, lexicalFixtureRoot).split(path.sep).filter(Boolean);
  for (let index = 0; index <= relativeComponents.length; index += 1) {
    const component = path.join(lexicalRepositoryRoot, ...relativeComponents.slice(0, index));
    const metadata = await lstat(component);
    if (metadata.isSymbolicLink()) throw new Error("invalid fixture root");
    if (!pathsMatch(component, await realpath(component))) throw new Error("invalid fixture root");
  }

  const realRepositoryRoot = await realpath(lexicalRepositoryRoot);
  const realFixtureRoot = await realpath(lexicalFixtureRoot);
  if (!isPathContained(realRepositoryRoot, realFixtureRoot) || pathsMatch(realRepositoryRoot, realFixtureRoot)) {
    throw new Error("invalid fixture root");
  }
}

export async function resolveFixtureOutputPath(fixtureDir: string, fixtureName: string) {
  if (!fixtureDir.trim() || !/^[a-z0-9][a-z0-9-]*$/i.test(fixtureName)) throw new Error("invalid fixture output");
  const requestedRoot = path.resolve(fixtureDir);
  if (!pathsMatch(requestedRoot, EXPECTED_FIXTURE_ROOT)) throw new Error("invalid fixture output");
  await assertSafeFixtureRoot(REPOSITORY_ROOT, EXPECTED_FIXTURE_ROOT);

  const outputFile = path.join(requestedRoot, `${fixtureName}.html`);
  const outputMetadata = await lstat(outputFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outputMetadata?.isSymbolicLink()) throw new Error("invalid fixture output");
  return outputFile;
}

type AtomicFixtureWriteOptions = {
  repositoryRoot: string;
  fixtureRoot: string;
  fixtureName: string;
  html: string;
  beforeCommit?: () => Promise<void>;
};

export async function writeFixtureAtomically(options: AtomicFixtureWriteOptions) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(options.fixtureName)) throw new Error("invalid fixture output");
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const fixtureRoot = path.resolve(options.fixtureRoot);
  const targetFile = path.join(fixtureRoot, `${options.fixtureName}.html`);
  const temporaryFile = path.join(fixtureRoot, `.${options.fixtureName}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let committed = false;

  try {
    await assertSafeFixtureRoot(repositoryRoot, fixtureRoot);
    const handle = await open(temporaryFile, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${options.html}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await options.beforeCommit?.();
    await assertSafeFixtureRoot(repositoryRoot, fixtureRoot);
    const temporaryMetadata = await lstat(temporaryFile);
    if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink()) throw new Error("invalid fixture output");
    const targetMetadata = await lstat(targetFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (targetMetadata) throw new Error("fixture output already exists");

    await rename(temporaryFile, targetFile);
    committed = true;
  } finally {
    if (temporaryCreated && !committed) {
      await assertSafeFixtureRoot(repositoryRoot, fixtureRoot)
        .then(() => unlink(temporaryFile))
        .catch(() => undefined);
    }
  }
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
  if (config.allowedUiText !== undefined) validateAllowedUiText(config.allowedUiText as string[]);
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
    const html = await captureSanitizedFixture(page, config.selector, config.allowedUiText || DOUYIN_FIXED_UI_TEXT);
    await writeFixtureAtomically({
      repositoryRoot: REPOSITORY_ROOT,
      fixtureRoot: fixtureDir,
      fixtureName: config.fixtureName,
      html
    });
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
