import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
