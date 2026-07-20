# Publisher V3 Foundation and Douyin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V3 result model, fail-fast workflow, per-account concurrency guard, truthful server/UI status mapping, and the first strict platform adapter for Douyin.

**Architecture:** Keep `Publisher.open(...)` as the external interface. Move orchestration into a deep `PublishWorkflow` module, inject one `PlatformAdapter`, and return a structured `PublishOutcome` whose completion is derived from required stage results. The Douyin adapter owns only Douyin DOM knowledge; server status mapping and UI rendering consume the outcome without guessing.

**Tech Stack:** Node.js 24, TypeScript 5.9, ESM, Playwright Core 1.57, React 19, Node test runner.

## Global Constraints

- Do not print or commit API keys, cookies, browser profile contents, `.env`, or `data/ai-config.json`.
- Windows PowerShell 5.1: do not pass complex JSON or secrets through CLI quoting; use files or SDK calls.
- Never click the final platform publish button; live acceptance stops when the button is enabled.
- Xiaohongshu remains in manual-assisted mode.
- Do not add runtime dependencies.
- Do not bulk-delete legacy files; migrate one platform at a time and keep Git history recoverable.
- No task is complete until its new test was observed failing for the expected reason and then passing.
- Do not create `v3.0.0` until Douyin, Kuaishou, and Bilibili plans and live acceptance all pass.

---

## File Structure

- Create `src/server/publish/types.ts`: V3 stages, results, required-stage policy, outcome calculation, and legacy compatibility projection.
- Create `src/server/publish/account-lock.ts`: exclusive `platform + accountId` execution.
- Create `src/server/publish/platform-adapter.ts`: the internal adapter interface used by the workflow.
- Create `src/server/publish/workflow.ts`: ordered execution, fail-fast behavior, and outcome aggregation.
- Create `src/server/publish/page-owner.ts`: creates one dedicated Page for each managed workflow.
- Create `src/server/publish/result-mapping.ts`: maps outcomes to diagnostic and store states.
- Create `src/server/publish/adapters/douyin.ts`: strict Douyin page behavior and postcondition checks.
- Modify `src/server/publisher.ts`: retain context/profile ownership and delegate Douyin to V3 workflow; leave other platform paths temporarily intact.
- Modify `src/server/index.ts`: lock handling, truthful diagnostics, and truthful task state.
- Modify `src/client/App.tsx`: render stage results and partial failures.
- Modify `src/shared/types.ts`: shared outcome and diagnostic status types.
- Create `tests/publish-outcome.test.ts`: result-model tests.
- Create `tests/publish-account-lock.test.ts`: exclusivity tests.
- Create `tests/publish-workflow.test.ts`: stage order and fail-fast tests.
- Create `tests/publish-result-mapping.test.ts`: server/store mapping tests.
- Create `tests/publisher-page-isolation.test.ts`: page ownership regression tests.
- Create `tests/douyin-adapter.test.ts`: adapter contract and exact failure-mode tests.
- Create `tests/capture-publisher-fixture.test.ts`: sanitizer tests for captured DOM.
- Create `tests/fixtures/publisher/douyin/`: sanitized DOM fragments captured from the real creator page.
- Create `scripts/capture-publisher-fixture.ts`: local-only sanitizing capture helper; output contains no account or content data.

---

### Task 1: V3 Outcome Model

**Files:**
- Create: `src/server/publish/types.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/publish-outcome.test.ts`

**Interfaces:**
- Consumes: existing `Platform` from `src/shared/types.ts`.
- Produces: `PublishStage`, `StageResult`, `PublishOutcome`, `requiredStagesFor()`, `buildPublishOutcome()`, and `toLegacyPrefillResult()`.

- [ ] **Step 1: Write failing outcome tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildPublishOutcome, requiredStagesFor } from "../src/server/publish/types.js";

test("managed outcome is partial when one required stage fails", () => {
  const stages = requiredStagesFor("douyin").map((stage) => ({
    stage,
    status: stage === "topics" ? "failed" as const : "succeeded" as const,
    detail: stage
  }));
  const outcome = buildPublishOutcome("douyin", "managed", stages, "v3-test");
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedStage, "topics");
});

test("managed outcome is complete only when every required stage succeeds", () => {
  const stages = requiredStagesFor("douyin").map((stage) => ({ stage, status: "succeeded" as const, detail: stage }));
  assert.equal(buildPublishOutcome("douyin", "managed", stages, "v3-test").status, "complete");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --import tsx --test tests/publish-outcome.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/server/publish/types.js`.

- [ ] **Step 3: Implement the model**

Add these shared response types to `src/shared/types.ts`:

```ts
export type PublishStage = "page" | "video" | "title" | "body" | "topics" | "cover" | "declaration" | "ready";
export type StageStatus = "succeeded" | "skipped" | "failed";
export type StageResult = {
  stage: PublishStage;
  status: StageStatus;
  detail: string;
  evidence?: Record<string, string | number | boolean>;
};
export type PublishOutcome = {
  status: "complete" | "partial" | "login_required" | "failed";
  browserMode: "managed" | "manual";
  platform: Platform;
  stages: StageResult[];
  failedStage: PublishStage | null;
  adapterVersion: string;
};
```

Then implement the server policy in `src/server/publish/types.ts`:

```ts
import type { Platform, PublishOutcome, PublishStage, StageResult } from "../../shared/types.js";

const MANAGED_REQUIRED: PublishStage[] = ["page", "video", "title", "body", "topics", "cover", "declaration", "ready"];

export function requiredStagesFor(platform: Platform): PublishStage[] {
  return platform === "xiaohongshu" ? [] : [...MANAGED_REQUIRED];
}

export function buildPublishOutcome(
  platform: Platform,
  browserMode: "managed" | "manual",
  stages: StageResult[],
  adapterVersion: string
): PublishOutcome {
  const failed = stages.find((result) => result.status === "failed") || null;
  const loginRequired = stages.some((result) => result.stage === "page" && result.evidence?.loginRequired === true);
  const complete = requiredStagesFor(platform).every((stage) => stages.some((result) => result.stage === stage && result.status === "succeeded"));
  return {
    status: loginRequired ? "login_required" : complete ? "complete" : failed ? "partial" : "failed",
    browserMode,
    platform,
    stages,
    failedStage: failed?.stage || null,
    adapterVersion
  };
}
```

Implement `toLegacyPrefillResult()` in the same server module by mapping each legacy boolean to the matching successful stage; do not infer one stage from another.

- [ ] **Step 4: Run focused and type tests and verify GREEN**

Run: `node --import tsx --test tests/publish-outcome.test.ts`

Expected: 2 tests pass.

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 5: Commit**

```powershell
git add -- src/server/publish/types.ts src/shared/types.ts tests/publish-outcome.test.ts
git commit -m "refactor: add publisher v3 outcome model"
```

---

### Task 2: Account Lock and Fail-Fast Workflow

**Files:**
- Create: `src/server/publish/account-lock.ts`
- Create: `src/server/publish/platform-adapter.ts`
- Create: `src/server/publish/workflow.ts`
- Test: `tests/publish-account-lock.test.ts`
- Test: `tests/publish-workflow.test.ts`

**Interfaces:**
- Consumes: `PublishStage`, `StageResult`, `PublishOutcome`, and `buildPublishOutcome()` from Task 1.
- Produces: `PublishAccountLock.runExclusive(key, operation)`, `PublishAccountBusyError`, `PlatformAdapter`, and `PublishWorkflow.run(input)`.

- [ ] **Step 1: Write failing lock tests**

```ts
test("same platform account cannot execute concurrently", async () => {
  const lock = new PublishAccountLock();
  let release!: () => void;
  const first = lock.runExclusive("douyin:account-1", () => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(
    lock.runExclusive("douyin:account-1", async () => undefined),
    (error: unknown) => error instanceof PublishAccountBusyError && error.code === "PUBLISH_ACCOUNT_BUSY"
  );
  release();
  await first;
});
```

- [ ] **Step 2: Run the lock test and verify RED**

Run: `node --import tsx --test tests/publish-account-lock.test.ts`

Expected: FAIL because `PublishAccountLock` does not exist.

- [ ] **Step 3: Implement the lock**

```ts
export class PublishAccountBusyError extends Error {
  readonly code = "PUBLISH_ACCOUNT_BUSY";
  constructor(readonly key: string) {
    super(`A publish workflow is already running for ${key}`);
  }
}

export class PublishAccountLock {
  private readonly active = new Set<string>();
  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) throw new PublishAccountBusyError(key);
    this.active.add(key);
    try { return await operation(); }
    finally { this.active.delete(key); }
  }
}
```

- [ ] **Step 4: Write failing workflow tests**

```ts
const calls: string[] = [];
const adapter: PlatformAdapter = {
  platform: "douyin",
  version: "test",
  async runStage(stage) {
    calls.push(stage);
    return stage === "cover"
      ? { stage, status: "failed", detail: "dialog remained open" }
      : { stage, status: "succeeded", detail: stage };
  }
};
const input: PublishInput = {
  platform: "douyin",
  accountId: "default-douyin",
  filePath: "video.mp4",
  post: {
    id: "post-1", videoId: "video-1", platform: "douyin", accountId: "default-douyin",
    enabled: true, title: "title", body: "body", hashtags: ["topic"], status: "ready", lastError: null
  },
  covers: { landscape: "landscape.png", portrait: "portrait.png" }
};
const outcome = await new PublishWorkflow(adapter).run(input);
assert.deepEqual(calls, ["page", "video", "title", "body", "topics", "cover"]);
assert.equal(outcome.failedStage, "cover");
```

- [ ] **Step 5: Run the workflow test and verify RED**

Run: `node --import tsx --test tests/publish-workflow.test.ts`

Expected: FAIL because `PublishWorkflow` does not exist.

- [ ] **Step 6: Implement the adapter interface and workflow**

```ts
export type CoverPaths = { landscape: string | null; portrait: string | null };
export type PublishInput = { platform: Platform; accountId: string; filePath: string; post: PlatformPost; covers: CoverPaths };
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly version: string;
  runStage(stage: PublishStage, input: PublishInput): Promise<StageResult>;
}

export class PublishWorkflow {
  constructor(private readonly adapter: PlatformAdapter) {}
  async run(input: PublishInput): Promise<PublishOutcome> {
    const results: StageResult[] = [];
    for (const stage of requiredStagesFor(input.platform)) {
      const result = await this.adapter.runStage(stage, input);
      results.push(result);
      if (result.status === "failed") break;
    }
    return buildPublishOutcome(input.platform, "managed", results, this.adapter.version);
  }
}
```

- [ ] **Step 7: Verify GREEN and commit**

Run: `node --import tsx --test tests/publish-account-lock.test.ts tests/publish-workflow.test.ts`

Expected: all tests pass with no warnings.

```powershell
git add -- src/server/publish/account-lock.ts src/server/publish/platform-adapter.ts src/server/publish/workflow.ts tests/publish-account-lock.test.ts tests/publish-workflow.test.ts
git commit -m "refactor: add fail-fast publish workflow"
```

---

### Task 3: Truthful Server, Diagnostic, and UI Mapping

**Files:**
- Create: `src/server/publish/result-mapping.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/diagnostics.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/shared/types.ts`
- Test: `tests/publish-result-mapping.test.ts`

**Interfaces:**
- Consumes: `PublishOutcome` from Task 1 and `PublishAccountBusyError` from Task 2.
- Produces: `mapPublishOutcome(outcome)` returning diagnostic status, post status, video status, progress label, and HTTP status.

- [ ] **Step 1: Write the failing mapping test**

```ts
test("partial publisher result is never persisted as opened or ok", () => {
  const mapped = mapPublishOutcome({
    status: "partial",
    browserMode: "managed",
    platform: "douyin",
    stages: [{ stage: "cover", status: "failed", detail: "dialog remained open" }],
    failedStage: "cover",
    adapterVersion: "test"
  });
  assert.equal(mapped.diagnosticStatus, "partial");
  assert.equal(mapped.postStatus, "failed");
  assert.equal(mapped.videoStatus, "failed");
  assert.match(mapped.progressLabel, /封面/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/publish-result-mapping.test.ts`

Expected: FAIL because `mapPublishOutcome` does not exist.

- [ ] **Step 3: Implement exact mapping**

```ts
export function mapPublishOutcome(outcome: PublishOutcome) {
  if (outcome.status === "complete") return { diagnosticStatus: "ok" as const, postStatus: "opened" as const, videoStatus: "opened" as const, httpStatus: 200, progressLabel: "自动填写完成" };
  if (outcome.status === "login_required") return { diagnosticStatus: "partial" as const, postStatus: "ready" as const, videoStatus: "ready" as const, httpStatus: 200, progressLabel: "需要登录后重试" };
  const label = outcome.failedStage ? `自动填写未完成：${outcome.failedStage}` : "自动填写失败";
  return { diagnosticStatus: outcome.status === "partial" ? "partial" as const : "error" as const, postStatus: "failed" as const, videoStatus: "failed" as const, httpStatus: 200, progressLabel: label };
}
```

Extend `DiagnosticSummary.status` to `"ok" | "partial" | "error"`. In the route, catch `PublishAccountBusyError` before the generic error handler and respond with HTTP 409 and `{ code: "PUBLISH_ACCOUNT_BUSY" }`. Replace unconditional `opened`/`ok` writes with `mapPublishOutcome()` values.

- [ ] **Step 4: Update the UI to consume stages**

Render each returned stage using its `status` and `detail`. Use error styling for `partial` and `failed`; do not reconstruct success solely from legacy booleans. Keep the existing manual Xiaohongshu notice.

- [ ] **Step 5: Verify focused tests and typecheck**

Run: `node --import tsx --test tests/publish-result-mapping.test.ts tests/publish-outcome.test.ts`

Expected: all tests pass.

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 6: Commit**

```powershell
git add -- src/server/publish/result-mapping.ts src/server/index.ts src/server/diagnostics.ts src/client/App.tsx src/shared/types.ts tests/publish-result-mapping.test.ts
git commit -m "fix: report partial publish outcomes truthfully"
```

---

### Task 4: Dedicated Page Ownership

**Files:**
- Create: `src/server/publish/page-owner.ts`
- Modify: `src/server/publisher.ts`
- Test: `tests/publisher-page-isolation.test.ts`

**Interfaces:**
- Consumes: account lock from Task 2.
- Produces: `createWorkflowPage(context)` and `contextKey(platform, accountId)` locking.

- [ ] **Step 1: Write a failing page-isolation test**

Create a structural BrowserContext fake containing an unrelated existing page. Call `createWorkflowPage()` and assert it creates a dedicated page rather than returning `pages()[0]`. Account-lock concurrency remains covered by Task 2.

```ts
const unrelatedPage = { id: "old" };
const createdPage = { id: "new", bringToFront: async () => undefined };
let newPageCalls = 0;
const context = {
  pages: () => [unrelatedPage],
  newPage: async () => { newPageCalls += 1; return createdPage; }
};
const acquiredPage = await createWorkflowPage(context as never);
assert.equal(acquiredPage, createdPage);
assert.notEqual(acquiredPage, unrelatedPage);
assert.equal(newPageCalls, 1);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/publisher-page-isolation.test.ts`

Expected: FAIL because `createWorkflowPage` does not exist.

- [ ] **Step 3: Implement page ownership**

Implement a small page-owner module and use it from Publisher. V3 does not reuse old pages. Wrap managed `open()` execution with `accountLock.runExclusive(contextKey, operation)`.

```ts
export async function createWorkflowPage(context: Pick<BrowserContext, "newPage">) {
  const page = await context.newPage();
  await page.bringToFront();
  return page;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --import tsx --test tests/publisher-page-isolation.test.ts tests/publish-account-lock.test.ts`

Expected: all tests pass.

```powershell
git add -- src/server/publish/page-owner.ts src/server/publisher.ts tests/publisher-page-isolation.test.ts
git commit -m "fix: isolate publisher workflow pages"
```

---

### Task 5: Sanitized Real-Page Fixture Capture

**Files:**
- Create: `scripts/capture-publisher-fixture.ts`
- Create: `tests/fixtures/publisher/douyin/README.md`
- Create: `tests/capture-publisher-fixture.test.ts`
- Create during live capture: `tests/fixtures/publisher/douyin/*.html`

**Interfaces:**
- Consumes: an already logged-in local Playwright Page and an explicit platform/form selector.
- Produces: `captureSanitizedFixture(page, selector, allowedUiText)` and deterministic UTF-8 HTML fragments stripped of personal and content data.

- [ ] **Step 1: Write a failing sanitizer test**

```ts
import { chromium } from "playwright-core";
import { captureSanitizedFixture } from "../scripts/capture-publisher-fixture.js";

test("fixture sanitizer removes secrets, media, and user content", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<section id="form"><img src="data:image/png;base64,secret"><input value="private title"><div>内容由AI生成</div><div>user body</div></section>`);
    const sanitized = await captureSanitizedFixture(page, "#form", ["内容由AI生成"]);
    assert.doesNotMatch(sanitized, /secret|private title|user body|data:image/);
    assert.match(sanitized, /内容由AI生成/);
    assert.match(sanitized, /\[redacted\]/);
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 2: Run the sanitizer test and verify RED**

Run: `node --import tsx --test tests/capture-publisher-fixture.test.ts`

Expected: FAIL because `sanitizePublisherHtml` does not exist.

- [ ] **Step 3: Implement the capture sanitizer as test tooling**

The sanitizer must clone only the selected publish form or dialog. Before serializing, remove `script`, `style`, `img[src]`, `video`, `source`, file values, free-form editor text, links, data URLs, account labels, avatars, and all attributes except `class`, `role`, `aria-*`, `data-*`, `type`, `placeholder`, `disabled`, and `checked`. Replace user text nodes with `[redacted]` unless they match a fixed UI vocabulary such as 标题、简介、话题、封面、声明、内容由AI生成、确定、完成、发布.

Export `captureSanitizedFixture(page, selector, allowedUiText)` for the test. It clones the explicitly scoped locator inside `page.evaluate()`, sanitizes the clone, returns its `outerHTML`, and writes UTF-8 output only when the CLI entry point is invoked with an explicit fixture directory.

- [ ] **Step 4: Run the sanitizer test and verify GREEN**

Run: `node --import tsx --test tests/capture-publisher-fixture.test.ts`

Expected: the sanitizer test passes.

- [ ] **Step 5: Run capture against the real Douyin creator page**

Use the existing local browser profile. Upload the designated test video only if needed to expose the form. Capture these states without clicking final publish:

- form-ready
- topic-picker-open
- cover-editor-open
- cover-uploading
- cover-applied
- declaration-modal-open
- declaration-selected
- ready-before-publish

Expected: each output is a small UTF-8 HTML file containing no account name, material title/body, URLs with tokens, Cookie, local absolute profile path, or image data.

- [ ] **Step 6: Audit fixtures for sensitive data**

Run targeted searches for `cookie`, `authorization`, `token`, `api`, `data:image`, local profile directory fragments, and the current account name. Do not print matched sensitive values; report only filename and match category. Fix the sanitizer and recapture if any match exists.

- [ ] **Step 7: Commit only sanitized tooling and fixtures**

```powershell
git add -- scripts/capture-publisher-fixture.ts tests/capture-publisher-fixture.test.ts tests/fixtures/publisher/douyin
git commit -m "test: add sanitized douyin page fixtures"
```

---

### Task 6: Strict Douyin Adapter

**Files:**
- Create: `src/server/publish/adapters/douyin.ts`
- Modify: `src/server/publisher.ts`
- Test: `tests/douyin-adapter.test.ts`
- Test fixtures: `tests/fixtures/publisher/douyin/*.html`

**Interfaces:**
- Consumes: `PlatformAdapter`, `PublishInput`, `StageResult`, workflow Page ownership, and sanitized fixtures.
- Produces: `DouyinAdapter` version `2026.07.20-v3-state-machine-1`.

- [ ] **Step 1: Write failing adapter contract tests**

Cover one behavior per test:

- body succeeds only when the expected normalized body is readable from the scoped editor;
- topics succeed only when all expected topics, capped at five, exist as visible topic chips;
- cover succeeds only when upload signature changes and the cover editor closes;
- declaration succeeds only when the AI radio state is selected and its modal closes;
- ready succeeds only when the scoped publish button is visible and enabled;
- an open cover dialog makes declaration fail without clicking anything.

```ts
test("douyin declaration does not run behind an open cover dialog", async () => {
  const page = await fixturePage("cover-applied-but-dialog-open.html");
  const adapter = new DouyinAdapter(page);
  const result = await adapter.runStage("declaration", {
    platform: "douyin",
    accountId: "default-douyin",
    filePath: "video.mp4",
    post: {
      id: "post-1", videoId: "video-1", platform: "douyin", accountId: "default-douyin",
      enabled: true, title: "title", body: "body", hashtags: ["topic"], status: "ready", lastError: null
    },
    covers: { landscape: "landscape.png", portrait: "portrait.png" }
  });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /cover dialog/i);
  assert.equal(await page.locator("[data-test=ai-declaration-clicked]").count(), 0);
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `node --import tsx --test tests/douyin-adapter.test.ts`

Expected: FAIL because `DouyinAdapter` does not exist.

- [ ] **Step 3: Implement scoped condition helpers**

Implement a single `waitForCondition(name, timeoutMs, read)` loop using `Date.now()` and 200 ms polling. It must return the last observed safe state in failure detail. Do not use fixed sleeps as success proof.

Implement cover signatures from the cover editor/main cover target only. Do not fall back to `document.body`. Implement declaration verification from checked radio/ARIA state inside the declaration modal or declaration row only.

- [ ] **Step 4: Implement `runStage()` with strict postconditions**

Each case delegates to one focused private function and returns a `StageResult`. The method catches errors once, converts them to a failed stage with a sanitized message, and never suppresses selector/time-out context.

```ts
async runStage(stage: PublishStage, input: PublishInput): Promise<StageResult> {
  try {
    switch (stage) {
      case "page": return this.ensurePage(input);
      case "video": return this.uploadVideo(input);
      case "title": return this.fillTitle(input);
      case "body": return this.fillBody(input);
      case "topics": return this.fillTopics(input);
      case "cover": return this.uploadCovers(input);
      case "declaration": return this.selectDeclaration(input);
      case "ready": return this.verifyReady(input);
    }
  } catch (error) {
    return { stage, status: "failed", detail: this.safeError(error) };
  }
}
```

- [ ] **Step 5: Delegate Douyin from Publisher to V3 workflow**

Instantiate `DouyinAdapter` with the workflow-owned Page and progress/evidence callbacks. Preserve the public `Publisher.open(...)` parameters. For Douyin only, return the V3 outcome plus compatibility fields derived through `toLegacyPrefillResult()`; do not call any old Douyin fill/cover/declaration methods.

- [ ] **Step 6: Run adapter, workflow, and existing Douyin tests**

Run: `node --import tsx --test tests/douyin-adapter.test.ts tests/publish-workflow.test.ts tests/publisher-douyin-fill.test.ts`

Expected: all relevant V3 tests pass. Any obsolete test that overrides old private Douyin methods must be replaced by public-interface assertions before removal.

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 7: Commit**

```powershell
git add -- src/server/publish/adapters/douyin.ts src/server/publisher.ts tests/douyin-adapter.test.ts tests/publisher-douyin-fill.test.ts
git commit -m "refactor: migrate douyin to publisher v3"
```

---

### Task 7: Douyin Regression and Live Acceptance Gate

**Files:**
- Modify: `AI_HANDOFF.md`
- Add local-only evidence: `data/diagnostics/douyin-v3-*` or ignored `diagnostics/douyin-v3-*`

**Interfaces:**
- Consumes: completed V3 foundation and Douyin adapter.
- Produces: a verified Douyin checkpoint and evidence for the Kuaishou implementation plan.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm run check`

Expected: exit 0.

Run: `node --import tsx --test tests/*.test.ts`

Expected: all tests pass with no `page.screenshot is not a function` warnings and no swallowed-error debug noise.

- [ ] **Step 2: Replay the latest diagnostic failure audit**

Run the existing captured-report audit against the new outcome records. Expected for newly generated V3 Douyin records: all required stages succeed or the record is explicitly `partial/error`; no incomplete record is `ok`.

- [ ] **Step 3: Perform real Douyin acceptance to pre-publish readiness**

Using a designated test task and logged-in profile, run the complete flow. Confirm on the real page:

- correct video submitted;
- title present;
- body present;
- each expected topic visible as a chip;
- horizontal and vertical cover applied;
- AI declaration selected;
- final publish button enabled;
- final publish button not clicked.

Save local diagnostic screenshots for each postcondition. Do not commit screenshots containing account or content details.

- [ ] **Step 4: Update handoff documentation**

Record V3 architecture, adapter version, verification commands, known external-page risks, and the fact that Kuaishou/Bilibili remain on legacy paths until their plans complete. Do not include sensitive paths or content.

- [ ] **Step 5: Commit the Douyin checkpoint**

```powershell
git add -- AI_HANDOFF.md
git commit -m "docs: record publisher v3 douyin checkpoint"
```

- [ ] **Step 6: Run code review before proceeding**

Use the `code-review` skill against the fixed point immediately before Task 1. Resolve P0/P1 findings, rerun the focused and full suites, then write the separate Kuaishou plan from the same approved V3 design.

Do not tag or release V3 at this checkpoint.

---

## Plan Self-Review

- Spec coverage in this plan: outcome truthfulness, concurrency, fail-fast sequencing, page ownership, strict selector rules, sanitized replay fixtures, Douyin migration, and real pre-publish acceptance.
- Intentionally deferred to separate plans: Kuaishou adapter, Bilibili adapter, final legacy cleanup, final GitHub `v3.0.0` tag, and Release `V3.0`.
- The deferred plans depend only on the interfaces produced here; each platform can be rejected or accepted independently without undoing the foundation.
- No placeholder steps or unresolved type names remain in this plan.
