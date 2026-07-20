import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { captureSanitizedFixture } from "../scripts/capture-publisher-fixture.js";

function runCaptureCli(configFile: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/capture-publisher-fixture.ts"), configFile], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("fixture sanitizer removes secrets, media, and user content", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<section id="form"><img src="data:image/png;base64,secret"><input value="private title"><div>内容由AI生成</div><div>user body</div></section>'
    );

    const sanitized = await captureSanitizedFixture(page, "#form", ["内容由AI生成"]);

    assert.doesNotMatch(sanitized, /secret|private title|user body|data:image/);
    assert.match(sanitized, /内容由AI生成/);
    assert.match(sanitized, /\[redacted\]/);
  } finally {
    await browser.close();
  }
});

test("fixture sanitizer removes sensitive metadata and non-allowlisted attributes", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<section id="form" class="publish-form" style="color:red" onclick="privateHandler()"><!-- private note --><a href="https://example.invalid/private">private link</a><div class="profile-card">private account</div><button aria-label="private account" data-token="secret-token" data-state="open">发布</button></section>'
    );

    const sanitized = await captureSanitizedFixture(page, "#form", ["发布"]);

    assert.doesNotMatch(sanitized, /private|token|https?:|<!--|<a\b|href=|style=|onclick=|\sid=/i);
    assert.match(sanitized, /class="publish-form"/);
    assert.match(sanitized, /aria-label="\[redacted\]"/);
    assert.match(sanitized, /data-state="\[redacted\]"/);
    assert.match(sanitized, />发布</);
  } finally {
    await browser.close();
  }
});

test("fixture sanitizer fails closed on template contents", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<section id="form"><template><script>privateScript()</script><img src="data:image/png;base64,private"><div data-token="private-token">private body</div></template><button>发布</button></section>'
    );

    const sanitized = await captureSanitizedFixture(page, "#form", ["发布"]);

    assert.doesNotMatch(sanitized, /template|script|img|data:image|private|token/i);
    assert.match(sanitized, />发布</);
  } finally {
    await browser.close();
  }
});

test("fixture capture CLI refuses configs without an explicit fixture directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-cli-"));
  const configFile = path.join(directory, "capture.json");
  try {
    await writeFile(configFile, "{}", "utf8");
    const result = await runCaptureCli(configFile);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fixture capture failed/i);
    assert.doesNotMatch(result.stderr, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture output paths stay inside the repository Douyin fixture root", async () => {
  const captureModule = (await import("../scripts/capture-publisher-fixture.js")) as unknown as {
    resolveFixtureOutputPath?: (fixtureDir: string, fixtureName: string) => Promise<string>;
  };
  assert.equal(typeof captureModule.resolveFixtureOutputPath, "function");
  const resolveFixtureOutputPath = captureModule.resolveFixtureOutputPath!;
  const fixtureRoot = path.resolve("tests", "fixtures", "publisher", "douyin");
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-path-"));
  const alias = path.join(directory, "fixture-alias");
  try {
    await symlink(fixtureRoot, alias, "junction");

    assert.equal(await resolveFixtureOutputPath(fixtureRoot, "form-ready"), path.join(fixtureRoot, "form-ready.html"));
    await assert.rejects(resolveFixtureOutputPath(path.dirname(fixtureRoot), "escape"));
    await assert.rejects(resolveFixtureOutputPath(directory, "escape"));
    await assert.rejects(resolveFixtureOutputPath(alias, "escape"));
    await assert.rejects(resolveFixtureOutputPath(fixtureRoot, "../escape"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed Douyin fixtures are scoped, sanitized, and state-distinct", async () => {
  const fixtureRoot = path.resolve("tests", "fixtures", "publisher", "douyin");
  const expectedFiles = [
    "cover-applied.html",
    "cover-editor-open.html",
    "declaration-modal-open.html",
    "declaration-selected.html",
    "form-ready.html",
    "ready-before-publish.html",
    "topic-picker-open.html"
  ];
  const actualFiles = (await readdir(fixtureRoot)).filter((file) => file.endsWith(".html")).sort();
  assert.deepEqual(actualFiles, expectedFiles);

  const fixedUiVocabulary = new Set([
    "[redacted]",
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
  ]);
  const fixedUiTokens = [...fixedUiVocabulary].sort((left, right) => right.length - left.length);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const serializedStates: string[] = [];
  try {
    for (const fixtureFile of actualFiles) {
      const html = await readFile(path.join(fixtureRoot, fixtureFile), "utf8");
      serializedStates.push(html.trim());
      assert.doesNotMatch(html, /(?:https?|data|blob|file):|[a-z]:\\/i, fixtureFile);

      await page.setContent(html);
      const roots = page.locator("body > *");
      assert.equal(await roots.count(), 1, fixtureFile);
      const root = roots.first();
      assert.notEqual(await root.evaluate((element) => element.tagName.toLowerCase()), "body", fixtureFile);
      assert.notEqual(await root.evaluate((element) => element.tagName.toLowerCase()), "html", fixtureFile);
      assert.notEqual(await root.getAttribute("data-publisher-fixture-scope"), null, fixtureFile);
      assert.equal(await page.locator("script,style,template,img,video,source,a").count(), 0, fixtureFile);

      const invalidAttributes = await page.locator("body *").evaluateAll((elements) =>
        elements.flatMap((element) =>
          [...element.attributes]
            .map((attribute) => attribute.name.toLowerCase())
            .filter(
              (name) =>
                name !== "class" &&
                name !== "role" &&
                !name.startsWith("aria-") &&
                !name.startsWith("data-") &&
                name !== "type" &&
                name !== "placeholder" &&
                name !== "disabled" &&
                name !== "checked"
            )
        )
      );
      assert.deepEqual(invalidAttributes, [], fixtureFile);

      const textValues = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const values: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent?.trim();
          if (value) values.push(value);
        }
        return values;
      });
      const unexpectedText = textValues.filter((value) => {
        let remainder = value;
        for (const token of fixedUiTokens) remainder = remainder.split(token).join("");
        return remainder.trim().length > 0;
      });
      assert.deepEqual(unexpectedText, [], fixtureFile);
    }
  } finally {
    await browser.close();
  }

  assert.equal(new Set(serializedStates).size, serializedStates.length, "fixture states must not be byte-identical");
});
