import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  captureSanitizedFixture,
  DOUYIN_FIXED_UI_TEXT,
  isSafeRetainedTextAttributeValue
} from "../scripts/capture-publisher-fixture.js";

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

test("fixture sanitizer rejects caller text outside the fixed UI vocabulary", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<section id="form"><input placeholder="private label" aria-label="private label" aria-description="private label"><div>private label</div></section>'
    );

    await assert.rejects(captureSanitizedFixture(page, "#form", ["private label"]));
  } finally {
    await browser.close();
  }
});

test("ARIA ID references are not retained as structural values", async () => {
  assert.equal(isSafeRetainedTextAttributeValue("private-control-id"), false);

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<section id="form"><button aria-controls="private-control-id" aria-labelledby="private-label-id">发布</button></section>');
    const sanitized = await captureSanitizedFixture(page, "#form", ["发布"]);
    assert.match(sanitized, /aria-controls="\[redacted\]"/);
    assert.match(sanitized, /aria-labelledby="\[redacted\]"/);
    assert.doesNotMatch(sanitized, /private-(?:control|label)-id/);
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

test("fixture root rejects a junction component that resolves outside the repository", async () => {
  const captureModule = (await import("../scripts/capture-publisher-fixture.js")) as unknown as {
    assertSafeFixtureRoot?: (repositoryRoot: string, fixtureRoot: string) => Promise<void>;
  };
  assert.equal(typeof captureModule.assertSafeFixtureRoot, "function");
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-root-"));
  const repositoryRoot = path.join(directory, "repository");
  const fixtureParent = path.join(repositoryRoot, "tests", "fixtures", "publisher");
  const outsideRoot = path.join(directory, "outside");
  const fixtureRoot = path.join(fixtureParent, "douyin");
  try {
    await mkdir(fixtureParent, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, fixtureRoot, "junction");

    await assert.rejects(captureModule.assertSafeFixtureRoot!(repositoryRoot, fixtureRoot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic fixture write refuses a target replaced by a junction before commit", async () => {
  const captureModule = (await import("../scripts/capture-publisher-fixture.js")) as unknown as {
    writeFixtureAtomically?: (options: {
      repositoryRoot: string;
      fixtureRoot: string;
      fixtureName: string;
      html: string;
      beforeCommit?: () => Promise<void>;
    }) => Promise<void>;
  };
  assert.equal(typeof captureModule.writeFixtureAtomically, "function");
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-commit-"));
  const repositoryRoot = path.join(directory, "repository");
  const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "publisher", "douyin");
  const outsideRoot = path.join(directory, "outside");
  const outsideSentinel = path.join(outsideRoot, "sentinel.txt");
  const target = path.join(fixtureRoot, "state.html");
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(outsideSentinel, "outside unchanged", "utf8");

    await assert.rejects(
      captureModule.writeFixtureAtomically!({
        repositoryRoot,
        fixtureRoot,
        fixtureName: "state",
        html: "<section>[redacted]</section>",
        beforeCommit: async () => symlink(outsideRoot, target, "junction")
      })
    );

    assert.equal(await readFile(outsideSentinel, "utf8"), "outside unchanged");
    assert.deepEqual((await readdir(fixtureRoot)).sort(), ["state.html"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic fixture write creates a new controlled fixture and refuses overwrite", async () => {
  const captureModule = (await import("../scripts/capture-publisher-fixture.js")) as unknown as {
    writeFixtureAtomically: (options: {
      repositoryRoot: string;
      fixtureRoot: string;
      fixtureName: string;
      html: string;
    }) => Promise<void>;
  };
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-create-"));
  const repositoryRoot = path.join(directory, "repository");
  const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "publisher", "douyin");
  const target = path.join(fixtureRoot, "state.html");
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await captureModule.writeFixtureAtomically({
      repositoryRoot,
      fixtureRoot,
      fixtureName: "state",
      html: "<section>[redacted]</section>"
    });

    assert.equal(await readFile(target, "utf8"), "<section>[redacted]</section>\n");
    assert.deepEqual(await readdir(fixtureRoot), ["state.html"]);
    await assert.rejects(
      captureModule.writeFixtureAtomically({
        repositoryRoot,
        fixtureRoot,
        fixtureName: "state",
        html: "<section>replacement</section>"
      })
    );
    assert.equal(await readFile(target, "utf8"), "<section>[redacted]</section>\n");
    assert.deepEqual(await readdir(fixtureRoot), ["state.html"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent fixture writers atomically create without clobbering", async () => {
  const captureModule = (await import("../scripts/capture-publisher-fixture.js")) as unknown as {
    writeFixtureAtomically: (options: {
      repositoryRoot: string;
      fixtureRoot: string;
      fixtureName: string;
      html: string;
      beforeCommit?: () => Promise<void>;
    }) => Promise<void>;
  };
  const directory = await mkdtemp(path.join(tmpdir(), "publisher-fixture-race-"));
  const repositoryRoot = path.join(directory, "repository");
  const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "publisher", "douyin");
  const target = path.join(fixtureRoot, "state.html");
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const beforeCommit = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await gate;
  };
  try {
    await mkdir(fixtureRoot, { recursive: true });
    const writes = ["<section>first</section>", "<section>second</section>"].map((html) =>
      captureModule
        .writeFixtureAtomically({ repositoryRoot, fixtureRoot, fixtureName: "state", html, beforeCommit })
        .then(() => html)
    );
    const results = await Promise.allSettled(writes);
    const winners = results.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(await readFile(target, "utf8"), `${winners[0].value}\n`);
    assert.deepEqual(await readdir(fixtureRoot), ["state.html"]);

    const captureSource = await readFile(path.resolve("scripts", "capture-publisher-fixture.ts"), "utf8");
    assert.match(captureSource, /await link\(temporaryFile, targetFile\)/);
    assert.doesNotMatch(captureSource, /await rename\(temporaryFile, targetFile\)/);
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
    "topic-picker-open.html",
    "upload-entry-current.html",
    "video-post-upload-current.html"
  ];
  const actualFiles = (await readdir(fixtureRoot)).filter((file) => file.endsWith(".html")).sort();
  assert.deepEqual(actualFiles, expectedFiles);

  const fixedUiVocabulary = new Set(["[redacted]", ...DOUYIN_FIXED_UI_TEXT]);
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

      const retainedAttributes = await page.locator("body *").evaluateAll((elements) =>
        elements.flatMap((element) => [...element.attributes].map((attribute) => ({ name: attribute.name.toLowerCase(), value: attribute.value.trim() })))
      );
      const invalidAttributes = retainedAttributes
        .filter(({ name, value }) => {
          const allowedName =
            name === "class" ||
            name === "role" ||
            name.startsWith("aria-") ||
            name.startsWith("data-") ||
            name === "type" ||
            name === "placeholder" ||
            name === "disabled" ||
            name === "checked";
          if (!allowedName) return true;
          if (name.startsWith("data-")) {
            if (/(?:^|-)(?:auth|authorization|cookie|token|secret|key|url|src|href|path|account|user|uid)(?:-|$)/i.test(name.slice(5))) return true;
            return value !== "" && value !== "[redacted]";
          }
          if (name === "placeholder" || name.startsWith("aria-")) return !isSafeRetainedTextAttributeValue(value);
          return false;
        })
        .map(({ name }) => name);
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
