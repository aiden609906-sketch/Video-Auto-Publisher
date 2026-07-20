import test from "node:test";
import assert from "node:assert/strict";
import { PublishAccountBusyError } from "../src/server/publish/account-lock.js";
import { createWorkflowPage } from "../src/server/publish/page-owner.js";
import { Publisher } from "../src/server/publisher.js";
import type { PlatformPost } from "../src/shared/types.js";

function makeBilibiliPost(accountId = "account-1"): PlatformPost {
  return {
    id: "post-1",
    videoId: "video-1",
    platform: "bilibili",
    accountId,
    enabled: true,
    title: "test title",
    body: "test body",
    hashtags: [],
    status: "ready",
    lastError: null
  };
}

function stubManagedPublisher(
  context: { pages: () => unknown[]; newPage: () => Promise<unknown> },
  getContext: () => Promise<unknown> = async () => context
) {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  hooks.copy = async () => undefined;
  hooks.getContext = getContext;
  hooks.installFileChooserGuard = () => () => undefined;
  hooks.resumeBilibiliDraftPrompt = async () => undefined;
  hooks.hasPublishingForm = async () => true;
  hooks.tryFillTitle = async () => true;
  hooks.tryFillBody = async () => true;
  hooks.tryFillTags = async () => false;
  hooks.closeTransientMenus = async () => undefined;
  hooks.tryUploadCover = async () => false;
  hooks.trySelectAiDeclaration = async () => true;
  return hooks as unknown as Publisher;
}

function openBilibili(publisher: Publisher, accountId = "account-1") {
  return publisher.open("bilibili", accountId, "video.mp4", makeBilibiliPost(accountId), {
    landscape: null,
    portrait: null
  });
}

test("publisher creates a dedicated workflow page instead of reusing an unrelated page", async () => {
  const unrelatedPage = { id: "old" };
  let bringToFrontCalls = 0;
  const createdPage = {
    id: "new",
    bringToFront: async () => {
      bringToFrontCalls += 1;
    }
  };
  let newPageCalls = 0;
  const context = {
    pages: () => [unrelatedPage],
    newPage: async () => {
      newPageCalls += 1;
      return createdPage;
    }
  };

  const acquiredPage = await createWorkflowPage(context as never);

  assert.equal(acquiredPage, createdPage);
  assert.notEqual(acquiredPage, unrelatedPage);
  assert.equal(newPageCalls, 1);
  assert.equal(bringToFrontCalls, 1);
});

test("managed Publisher.open uses the dedicated workflow page", async () => {
  let unrelatedGotoCalls = 0;
  let createdGotoCalls = 0;
  let newPageCalls = 0;
  const unrelatedPage = {
    goto: async () => {
      unrelatedGotoCalls += 1;
    },
    bringToFront: async () => undefined
  };
  const context = {
    pages: () => [unrelatedPage],
    newPage: async () => {
      newPageCalls += 1;
      return {
        goto: async () => {
          createdGotoCalls += 1;
        },
        bringToFront: async () => undefined
      };
    }
  };
  const publisher = stubManagedPublisher(context);

  await openBilibili(publisher);

  assert.equal(newPageCalls, 1);
  assert.equal(createdGotoCalls, 1);
  assert.equal(unrelatedGotoCalls, 0);
});

test("managed Publisher.open rejects a concurrent run for the same platform account", async () => {
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  let gotoCalls = 0;
  const context = {
    pages: () => [],
    newPage: async () => ({
      goto: async () => {
        gotoCalls += 1;
        if (gotoCalls === 1) {
          markFirstEntered();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
      bringToFront: async () => undefined
    })
  };
  const publisher = stubManagedPublisher(context);

  const first = openBilibili(publisher);
  await firstEntered;

  await assert.rejects(
    openBilibili(publisher),
    (error: unknown) => error instanceof PublishAccountBusyError && error.key === "bilibili:account-1"
  );

  releaseFirst();
  await first;
  await openBilibili(publisher);
  assert.equal(gotoCalls, 2);
});

test("managed Publisher.open releases the account lock after an exception", async () => {
  let getContextCalls = 0;
  let releaseRetry!: () => void;
  let markRetryEntered!: () => void;
  const retryEntered = new Promise<void>((resolve) => {
    markRetryEntered = resolve;
  });
  let gotoCalls = 0;
  const context = {
    pages: () => [],
    newPage: async () => ({
      goto: async () => {
        gotoCalls += 1;
        if (gotoCalls === 1) {
          markRetryEntered();
          await new Promise<void>((resolve) => {
            releaseRetry = resolve;
          });
        }
      },
      bringToFront: async () => undefined
    })
  };
  const publisher = stubManagedPublisher(context, async () => {
    getContextCalls += 1;
    if (getContextCalls === 1) throw new Error("context failed");
    return context;
  });

  await assert.rejects(openBilibili(publisher), /context failed/);
  const retry = openBilibili(publisher);
  await retryEntered;

  await assert.rejects(openBilibili(publisher), PublishAccountBusyError);

  releaseRetry();
  await retry;
  assert.equal(getContextCalls, 2);
});
