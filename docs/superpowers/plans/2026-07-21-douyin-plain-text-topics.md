# Douyin Plain-Text Topics Implementation Plan

> **Execution revision (2026-07-21):** Real pre-publish acceptance showed that the neutral-area click did not reliably dismiss Douyin's suggestion overlay. The final user-approved flow supersedes the dismissal steps below: `video → landscape cover → portrait cover → confirm covers → title → body → AI declaration → plain-text topics → stop for human review`. There is no Douyin `ready` stage and publish is never clicked.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat up to five normalized Douyin hashtags as successful when their plain text is readable in the scoped editor and the automatically opened suggestion overlay has been dismissed.

**Architecture:** Keep the existing workflow stage order. Replace suggestion selection and chip verification inside `DouyinAdapter.fillTopics()` with exact plain-text token verification, then click one unique neutral form header and wait until the known scoped suggestion overlay is hidden or detached. Preserve fail-fast behavior so cover and declaration run only after the editor and overlay postconditions succeed.

**Tech Stack:** TypeScript, Node test runner, Playwright, existing sanitized Douyin fixtures.

## Global Constraints

- Normalize, de-duplicate, and cap requested topics at five.
- Do not click topic suggestions and do not require topic chips.
- Do not use viewport coordinates, `document.body`, fuzzy text, `force`, or first-match fallbacks.
- Guard the creator route immediately before editor mutation and neutral-area click.
- Error evidence contains counts and booleans only; never topic values, post content, or file paths.
- Never click the final publish button.
- If the scoped neutral click is not stable in automated and live verification, stop and create the separate stage-reordering change described by the approved design.

---

### Task 1: Plain-Text Topic Postcondition and Overlay Dismissal

**Files:**
- Modify: `src/server/publish/adapters/douyin.ts:42-62,79,423-470`
- Modify: `tests/douyin-adapter.test.ts:132-280`
- Verify: `tests/publish-workflow.test.ts`

**Interfaces:**
- Consumes: `DouyinAdapter.runStage("topics", input)`, `uniqueTopics()`, `normalizeTopic()`, scoped creator form locators, and `waitForCondition()`.
- Produces: adapter version `2026.07.21-v3-state-machine-6`; a successful `topics` result with safe evidence `{ expectedTopics, writtenTopics, suggestionOverlayVisible }`.

- [ ] **Step 1: Replace the chip contract with failing plain-text tests**

Replace the obsolete suggestion/chip success tests with tests that exercise the real adapter:

```ts
test("douyin topics succeed when every expected topic is readable as plain text", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const result = await new DouyinAdapter(page).runStage("topics", makeInput({
      post: { ...makeInput().post, hashtags: ["topic-one", "topic-one", "topic-two"] }
    }));

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.evidence, {
      expectedTopics: 2,
      writtenTopics: 2,
      suggestionOverlayVisible: false
    });
    const text = await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').innerText();
    assert.match(text, /#topic-one/);
    assert.match(text, /#topic-two/);
    assert.equal(await page.locator('[data-slate-editor] [data-mention]').count(), 0);
  } finally {
    await page.close();
  }
});
```

Add a dismissal test using the real sanitized picker fragment. The fixture harness removes the popup only when the exact scoped neutral header is clicked:

```ts
test("douyin topics dismiss the automatic picker through the scoped neutral target", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "topic-picker-open.html"]);
  try {
    await page.evaluate(() => {
      const header = document.querySelector('[data-publisher-fixture-scope] .formHeader-iqcubT');
      const popup = document.querySelector('.mention-suggest-item-container-TVOZMl');
      if (!header || !popup) throw new Error("fixture controls missing");
      header.addEventListener("click", () => popup.remove());
    });

    const result = await new DouyinAdapter(page).runStage("topics", makeInput());

    assert.equal(result.status, "succeeded");
    assert.equal(await page.locator('.mention-suggest-item-container-TVOZMl').count(), 0);
  } finally {
    await page.close();
  }
});
```

Add three focused regressions:

```ts
test("douyin topics write at most five unique plain-text hashtags", async () => {
  const page = await fixturePage(browser, "form-ready.html");
  try {
    const input = makeInput();
    input.post.hashtags = ["one", "two", "two", "three", "four", "five", "six"];
    const result = await new DouyinAdapter(page).runStage("topics", input);
    const text = await page.locator('[data-publisher-fixture-scope] [data-slate-editor]').innerText();
    assert.equal(result.status, "succeeded");
    assert.equal((text.match(/#[a-z]+/g) || []).length, 5);
    assert.doesNotMatch(text, /#six(?:\s|$)/);
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
    const input = makeInput();
    input.post.hashtags = ["topic-one", "topic-two"];
    const result = await new DouyinAdapter(page).runStage("topics", input);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.evidence, {
      expectedTopics: 2,
      writtenTopics: 1,
      suggestionOverlayVisible: false
    });
  } finally {
    await page.close();
  }
});

test("douyin topics fail when the automatic picker remains visible", async () => {
  const page = await combinedFixturePage(browser, ["form-ready.html", "topic-picker-open.html"]);
  try {
    const result = await new DouyinAdapter(page).runStage("topics", makeInput());
    assert.equal(result.status, "failed");
    assert.match(result.detail, /topics postcondition timed out/);
  } finally {
    await page.close();
  }
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --import tsx --test --test-name-pattern "douyin topics" tests/douyin-adapter.test.ts
```

Expected: the new plain-text success test fails because the current adapter waits for a suggestion/chip; the dismissal test fails because the neutral target is never clicked.

- [ ] **Step 3: Implement exact plain-text verification and dismissal**

Change `fillTopics()` to append only missing tokens and verify exact normalized hash tokens from the editor:

```ts
private async fillTopics(input: PublishInput): Promise<StageResult> {
  const topics = uniqueTopics(input.post.hashtags);
  const editor = this.scoped('[data-slate-editor]');
  if ((await editor.count()) !== 1 || !(await editor.isVisible())) {
    return { stage: "topics", status: "failed", detail: "topic editor was not uniquely visible" };
  }

  for (const topic of topics) {
    if (await this.hasPlainTextTopic(editor, topic)) continue;
    this.assertCreatorRoute("topics-operation", "topics-editor");
    await this.safeOperation("topics-operation", "topics-editor", async () => {
      await editor.click();
      await this.page.keyboard.press("End");
      await this.page.keyboard.insertText(` #${topic}`);
    });
  }

  const overlay = this.page.locator('.mention-suggest-item-container-TVOZMl');
  const writtenTopics = await this.countExpectedPlainTextTopics(editor, topics);
  if (writtenTopics !== topics.length) {
    const suggestionOverlayVisible = (await this.visibleLocatorCount(overlay)) > 0;
    return {
      stage: "topics",
      status: "failed",
      detail: "plain-text topic postcondition failed",
      evidence: { expectedTopics: topics.length, writtenTopics, suggestionOverlayVisible }
    };
  }

  if ((await this.visibleLocatorCount(overlay)) > 0) {
    const neutralTarget = this.scoped('.formHeader-iqcubT');
    if ((await neutralTarget.count()) !== 1 || !(await neutralTarget.isVisible())) {
      return { stage: "topics", status: "failed", detail: "topic dismiss target was not uniquely visible" };
    }
    this.assertCreatorRoute("topic-click", "topic-dismiss-target");
    await this.safeOperation("topic-click", "topic-dismiss-target", () => neutralTarget.click());
  }

  return this.waitForCondition("topics", 2_000, async () => {
    const suggestionOverlayVisible = (await this.visibleLocatorCount(overlay)) > 0;
    return {
      matched: !suggestionOverlayVisible,
      safeState: { expectedTopics: topics.length, writtenTopics, suggestionOverlayVisible }
    };
  });
}
```

Add `topic-dismiss-target` to `SelectorAlias`, add focused helpers that tokenize editor text by whitespace and compare `normalizeTopic()` values, and bump `DOUYIN_ADAPTER_VERSION` to `2026.07.21-v3-state-machine-6`. Do not call `findExactTopicSuggestion()` or `hasVisibleTopicChip()` from the topics stage.

Use these helpers so the implementation does not expose editor content and does not treat topic prefixes as exact matches:

```ts
private async countExpectedPlainTextTopics(editor: Locator, expected: string[]): Promise<number> {
  const tokens = new Set(
    (await editor.innerText())
      .split(/\s+/)
      .filter((token) => token.startsWith("#"))
      .map(normalizeTopic)
      .filter(Boolean)
  );
  return expected.filter((topic) => tokens.has(topic)).length;
}

private async hasPlainTextTopic(editor: Locator, topic: string): Promise<boolean> {
  return (await this.countExpectedPlainTextTopics(editor, [topic])) === 1;
}

private async visibleLocatorCount(locator: Locator): Promise<number> {
  let visible = 0;
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}
```

Use `visibleLocatorCount(overlay) > 0` in place of the abbreviated `hasVisibleLocator()` calls shown above.

- [ ] **Step 4: Run focused and workflow tests and verify GREEN**

Run:

```powershell
node --import tsx --test --test-name-pattern "douyin topics" tests/douyin-adapter.test.ts
node --import tsx --test tests/douyin-adapter.test.ts tests/publish-workflow.test.ts tests/publisher-douyin-fill.test.ts
npm run check
```

Expected: every command exits `0`, topic tests have no skip/todo, and workflow ordering remains `topics` before `cover` and `declaration`.

- [ ] **Step 5: Run the full suite and live pre-publish acceptance**

Run:

```powershell
node --import tsx --test tests/*.test.ts
```

Expected: all tests pass with no screenshot or swallowed-error noise.

Use the existing ignored Task 7 live harness with one browser instance. Stop at the first failed stage. Expected safe stage sequence is `page`, `video`, `title`, `body`, `topics`, `cover`, `declaration`, `ready`; the publish click counter must remain `0`.

If the scoped neutral click cannot close the real overlay, do not add coordinate/fuzzy fallbacks. Stop and implement the approved separate stage-order fallback instead.

- [ ] **Step 6: Review and commit**

Review the diff for suggestion clicks, chip dependencies, global selectors, raw topic values in evidence, `force`, and publish clicks. Then run:

```powershell
git diff --check
git add -- src/server/publish/adapters/douyin.ts tests/douyin-adapter.test.ts
git commit -m "fix: accept plain-text douyin topics"
```

Expected: one focused implementation commit and a clean tracked worktree.
