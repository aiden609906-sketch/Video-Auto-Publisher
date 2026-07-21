import test from "node:test";
import assert from "node:assert/strict";
import { buildPublishOutcome, requiredStagesFor, toLegacyPrefillResult } from "../src/server/publish/types.js";

test("managed outcome is partial when one required stage fails", () => {
  const stages = requiredStagesFor("douyin").map((stage) => ({
    stage,
    status: stage === "topics" ? ("failed" as const) : ("succeeded" as const),
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

test("xiaohongshu has no managed required stages", () => {
  assert.deepEqual(requiredStagesFor("xiaohongshu"), []);
});

test("Douyin ends after verified topics and leaves final review to the user", () => {
  assert.deepEqual(requiredStagesFor("douyin"), [
    "page",
    "video",
    "title",
    "body",
    "topics",
    "cover",
    "declaration"
  ]);
});

test("legacy prefill uses the explicit copied value and only succeeded matching stages", () => {
  const outcome = buildPublishOutcome("douyin", "managed", [
    { stage: "page", status: "succeeded", detail: "page" },
    { stage: "video", status: "succeeded", detail: "video" },
    { stage: "title", status: "failed", detail: "title" },
    { stage: "body", status: "skipped", detail: "body" },
    { stage: "topics", status: "succeeded", detail: "topics" },
    { stage: "cover", status: "succeeded", detail: "cover" },
    { stage: "declaration", status: "succeeded", detail: "declaration" },
    { stage: "ready", status: "succeeded", detail: "ready" }
  ], "v3-test");

  assert.deepEqual(toLegacyPrefillResult(outcome, false), {
    browserMode: "managed",
    copied: false,
    loginRequired: false,
    uploadPrefilled: true,
    titlePrefilled: false,
    bodyPrefilled: false,
    tagsPrefilled: true,
    coverPrefilled: true,
    declarationPrefilled: true
  });
});
