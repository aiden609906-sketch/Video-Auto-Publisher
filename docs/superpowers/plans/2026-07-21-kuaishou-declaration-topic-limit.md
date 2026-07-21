# Kuaishou Declaration and Topic Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kuaishou select “内容由 AI 生成” reliably and write no more than four topics without changing the rest of its publish flow.

**Architecture:** Keep Kuaishou in the existing `Publisher` workflow. Add one pure platform-topic normalizer used at the existing text-fill boundary, and narrow the Kuaishou declaration path so it opens the author declaration control, clicks the exact AI-generated option, and verifies the value in that row before returning success.

**Tech Stack:** TypeScript, Node.js built-in test runner, Playwright Core, Microsoft Edge channel.

## Global Constraints

- Do not change Kuaishou video, cover, title, body ordering, or final publish behavior.
- Kuaishou writes at most the first 4 non-empty, normalized, unique topics.
- Other platforms keep their current topic limits and declaration behavior.
- Kuaishou declaration succeeds only when the author-declaration control displays an AI-generated value.
- Do not click the final publish button.

---

### Task 1: Apply the Kuaishou four-topic boundary

**Files:**
- Modify: `src/server/publisher.ts:73-74,255-261,427-432`
- Create: `tests/kuaishou-topics.test.ts`

**Interfaces:**
- Consumes: `Platform` and the original `string[]` from `PlatformPost.hashtags`.
- Produces: `hashtagsForPlatform(platform: Platform, hashtags: string[]): string[]`.

- [ ] **Step 1: Write the failing topic tests**

Create `tests/kuaishou-topics.test.ts` with tests that require normalization, a four-topic Kuaishou cap, unchanged non-Kuaishou length, and integration with the body value:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { hashtagsForPlatform, Publisher } from "../src/server/publisher.js";
import type { PlatformPost } from "../src/shared/types.js";

test("kuaishou keeps at most four normalized unique topics", () => {
  assert.deepEqual(
    hashtagsForPlatform("kuaishou", [" one ", "#two", "", "one", "three", "four", "five"]),
    ["one", "two", "three", "four"]
  );
});

test("kuaishou topic limit does not cap other platforms", () => {
  assert.deepEqual(
    hashtagsForPlatform("bilibili", ["one", "two", "three", "four", "five"]),
    ["one", "two", "three", "four", "five"]
  );
});

test("kuaishou body receives only four topics", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  let filled = "";
  hooks.tryFillWithRetry = async (_page: unknown, _selectors: string[], value: string) => {
    filled = value;
    return true;
  };
  const post: PlatformPost = {
    id: "post-1", videoId: "video-1", platform: "kuaishou", accountId: "default-kuaishou",
    enabled: true, title: "title", body: "body", hashtags: ["one", "two", "three", "four", "five"],
    status: "ready", lastError: null
  };

  const result = await (hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost) => Promise<boolean>)({}, "kuaishou", post);

  assert.equal(result, true);
  assert.equal(filled, "body\n#one #two #three #four");
});
```

- [ ] **Step 2: Run the topic tests and verify RED**

Run: `node --import tsx --test tests/kuaishou-topics.test.ts`

Expected: FAIL because `hashtagsForPlatform` is not exported and the fifth Kuaishou topic is still appended.

- [ ] **Step 3: Add the minimal topic normalizer and use it at both legacy fill boundaries**

Add near the platform constants:

```ts
const KUAISHOU_MAX_HASHTAGS = 4;

export function hashtagsForPlatform(platform: Platform, hashtags: string[]) {
  const seen = new Set<string>();
  const normalized = hashtags.flatMap((value) => {
    const topic = value.trim().replace(/^#+/, "").trim();
    if (!topic || seen.has(topic)) return [];
    seen.add(topic);
    return [topic];
  });
  return platform === "kuaishou" ? normalized.slice(0, KUAISHOU_MAX_HASHTAGS) : normalized;
}
```

In the legacy path, calculate `platformHashtags` once before body/tags filling and pass it through:

```ts
const platformHashtags = hashtagsForPlatform(platform, post.hashtags);
const platformPost = { ...post, hashtags: platformHashtags };
const bodyPrefilled = await this.tryFillBody(page, platform, platformPost);
const explicitTagsPrefilled = await this.tryFillTags(page, platform, platformHashtags);
const tagsPrefilled = explicitTagsPrefilled || (bodyPrefilled && platformHashtags.length > 0);
```

In `tryFillBody`, normalize the input before joining topics so direct callers obey the same boundary:

```ts
const tags = hashtagsForPlatform(platform, post.hashtags).map((tag) => `#${tag}`).join(" ");
```

- [ ] **Step 4: Run the topic tests and verify GREEN**

Run: `node --import tsx --test tests/kuaishou-topics.test.ts`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit the topic boundary**

```powershell
git add -- src/server/publisher.ts tests/kuaishou-topics.test.ts
git commit -m "fix: cap kuaishou topics at four"
```

### Task 2: Make Kuaishou declaration selection exact and verified

**Files:**
- Modify: `src/server/publisher.ts:695-809,951-1114`
- Modify: `tests/kuaishou-ai-dom.test.ts`
- Modify: `tests/publisher-douyin-fill.test.ts:124-235`

**Interfaces:**
- Consumes: existing `trySelectAiDeclaration(page, "kuaishou")` path.
- Produces: `true` only after `hasKuaishouAiDeclarationSelected(page)` reads an AI-generated value from the author-declaration row.

- [ ] **Step 1: Write failing declaration regressions**

Change the mocked ordering test so the generic selector records an error if called, while the Kuaishou-specific option click performs the selection:

```ts
hooks.selectAiDeclarationByDom = async () => {
  calls.push("unexpected-generic-dom-selection");
  return false;
};
```

Expected call order:

```ts
assert.deepEqual(calls, [
  "verify-empty",
  "open-kuaishou-author-declaration",
  "click-kuaishou-ai-option",
  "verify-selected"
]);
```

Extend `tests/kuaishou-ai-dom.test.ts` with an unrelated select above the author row and an exact AI option. Assert the unrelated select remains unchanged and the author row displays `内容由AI生成`. Add a second DOM test whose option click closes the menu without updating the author row, and assert `trySelectAiDeclaration` returns `false`.

- [ ] **Step 2: Run declaration tests and verify RED**

Run: `node --import tsx --test tests/kuaishou-ai-dom.test.ts tests/publisher-douyin-fill.test.ts`

Expected: FAIL because the current Kuaishou path invokes `selectAiDeclarationByDom` before its specific option selector.

- [ ] **Step 3: Implement the minimal exact Kuaishou declaration path**

Remove the generic DOM selector from `trySelectKuaishouAiDeclaration` and keep this sequence:

```ts
if (await this.hasKuaishouAiDeclarationSelected(page)) return true;
if (!(await this.clickKuaishouAuthorDeclarationControl(page))) {
  await page.waitForTimeout(500);
  continue;
}
if (await this.clickKuaishouAiGeneratedOption(page)) {
  if (await this.waitForKuaishouAiDeclarationSelected(page, 2_500)) return true;
}
```

In `clickKuaishouAiGeneratedOption`, normalize candidate text and require the exact phrase before clicking:

```ts
const optionText = ((await option.innerText({ timeout: 500 }).catch(() => "")) || "").replace(/\s+/g, "");
if (optionText !== WORD.aiGenerated) continue;
```

Apply the same exact-text condition in the DOM fallback, retain the existing author-row verification, and do not add a success shortcut based only on a click.

- [ ] **Step 4: Run declaration tests and verify GREEN**

Run: `node --import tsx --test tests/kuaishou-ai-dom.test.ts tests/publisher-douyin-fill.test.ts`

Expected: all selected tests pass, including the false-success regression.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm run check
node --import tsx --test tests/*.test.ts
git diff --check
```

Expected: TypeScript check passes, all tests pass, and `git diff --check` prints no errors.

- [ ] **Step 6: Commit the declaration fix**

```powershell
git add -- src/server/publisher.ts tests/kuaishou-ai-dom.test.ts tests/publisher-douyin-fill.test.ts
git commit -m "fix: select kuaishou AI declaration exactly"
```

### Task 3: Merge the Kuaishou title into the work description

**Files:**
- Modify: `src/server/publisher.ts:268-276,442-447`
- Modify: `tests/kuaishou-topics.test.ts`
- Modify: `tests/publisher-page-isolation.test.ts`

**Interfaces:**
- Consumes: the existing Kuaishou `PlatformPost` title, body, and platform-limited hashtags.
- Produces: the work-description string `title\nbody\n#topic1 #topic2 #topic3 #topic4`; a successful Kuaishou body fill also produces `titlePrefilled: true`.

- [ ] **Step 1: Write failing tests**

Change the Kuaishou body assertion to:

```ts
assert.equal(filled, "title\nbody\n#one #two #three #four");
```

Add a non-Kuaishou assertion showing Bilibili still receives `body\n#topic`, not the title. Add a managed Kuaishou result test that stubs `tryFillTitle` to `false`, `tryFillBody` to `true`, and asserts the returned `titlePrefilled` and `bodyPrefilled` are both `true`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --import tsx --test tests/kuaishou-topics.test.ts tests/publisher-page-isolation.test.ts`

Expected: FAIL because the Kuaishou body omits the title and `titlePrefilled` remains false.

- [ ] **Step 3: Implement the minimal Kuaishou-only behavior**

In `tryFillBody`, build segments as follows:

```ts
const content = platform === "kuaishou" ? [post.title.trim(), post.body.trim(), tags] : [post.body.trim(), tags];
const body = content.filter(Boolean).join(platform === "douyin" ? " " : "\n");
```

In the legacy publish flow, retain the standalone title attempt for other platforms and derive the Kuaishou title result after body filling:

```ts
const standaloneTitlePrefilled = await this.tryFillTitle(page, platform, post.title);
const bodyPrefilled = await this.tryFillBody(page, platform, platformPost);
const titlePrefilled = platform === "kuaishou" ? bodyPrefilled && Boolean(post.title.trim()) : standaloneTitlePrefilled;
```

- [ ] **Step 4: Run targeted and full verification**

Run:

```powershell
node --import tsx --test tests/kuaishou-topics.test.ts tests/publisher-page-isolation.test.ts
npm run check
node --import tsx --test tests/*.test.ts
```

Expected: all commands pass with no failures.

- [ ] **Step 5: Commit**

```powershell
git add -- src/server/publisher.ts tests/kuaishou-topics.test.ts tests/publisher-page-isolation.test.ts
git commit -m "fix: merge kuaishou title into description"
```
