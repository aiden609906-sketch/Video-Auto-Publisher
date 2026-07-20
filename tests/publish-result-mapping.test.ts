import test from "node:test";
import assert from "node:assert/strict";
import {
  mapPublishOutcome,
  normalizePublishOutcome
} from "../src/server/publish/result-mapping.js";
import type { PublishOutcome } from "../src/shared/types.js";

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

test("failed and login-required outcomes map to truthful persisted states", () => {
  const failed = mapPublishOutcome({
    status: "failed",
    browserMode: "managed",
    platform: "douyin",
    stages: [],
    failedStage: null,
    adapterVersion: "test"
  });
  const loginRequired = mapPublishOutcome({
    status: "login_required",
    browserMode: "managed",
    platform: "douyin",
    stages: [{ stage: "page", status: "failed", detail: "login required", evidence: { loginRequired: true } }],
    failedStage: "page",
    adapterVersion: "test"
  });

  assert.deepEqual(failed, {
    diagnosticStatus: "error",
    postStatus: "failed",
    videoStatus: "failed",
    httpStatus: 200,
    progressLabel: "自动填写失败"
  });
  assert.equal(loginRequired.diagnosticStatus, "partial");
  assert.equal(loginRequired.postStatus, "ready");
  assert.equal(loginRequired.videoStatus, "ready");
  assert.match(loginRequired.progressLabel, /登录/);
});

test("manual outcomes describe prepared materials without claiming automatic completion", () => {
  const mapped = mapPublishOutcome({
    status: "partial",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "ready", status: "failed", detail: "manual publish remains" }],
    failedStage: "ready",
    adapterVersion: "test"
  });

  assert.equal(mapped.diagnosticStatus, "partial");
  assert.equal(mapped.postStatus, "opened");
  assert.equal(mapped.videoStatus, "opened");
  assert.equal(mapped.progressLabel, "人工发布材料已准备");
  assert.doesNotMatch(mapped.progressLabel, /自动.*完成/);
});

test("legacy managed results become partial because readiness was not verified", () => {
  const outcome = normalizePublishOutcome("douyin", "legacy-test", {
    browserMode: "managed",
    copied: true,
    loginRequired: false,
    uploadPrefilled: true,
    titlePrefilled: true,
    bodyPrefilled: true,
    tagsPrefilled: true,
    coverPrefilled: true,
    declarationPrefilled: true
  });

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedStage, "ready");
  assert.deepEqual(
    outcome.stages.map(({ stage, status }) => ({ stage, status })),
    [
      { stage: "page", status: "succeeded" },
      { stage: "video", status: "succeeded" },
      { stage: "title", status: "succeeded" },
      { stage: "body", status: "succeeded" },
      { stage: "topics", status: "succeeded" },
      { stage: "cover", status: "succeeded" },
      { stage: "declaration", status: "succeeded" },
      { stage: "ready", status: "failed" }
    ]
  );
  assert.match(outcome.stages.at(-1)?.detail || "", /legacy adapter/i);
});

test("legacy booleans map only to their matching stages and never override V3 outcomes", () => {
  const legacy = normalizePublishOutcome("kuaishou", "legacy-test", {
    browserMode: "managed",
    copied: true,
    loginRequired: true,
    uploadPrefilled: true,
    titlePrefilled: false,
    bodyPrefilled: true,
    tagsPrefilled: false,
    coverPrefilled: true,
    declarationPrefilled: false
  });
  const existing: PublishOutcome = {
    status: "partial",
    browserMode: "managed",
    platform: "bilibili",
    stages: [{ stage: "body", status: "failed", detail: "V3 evidence" }],
    failedStage: "body",
    adapterVersion: "v3-test"
  };

  assert.equal(legacy.status, "login_required");
  assert.deepEqual(
    Object.fromEntries(legacy.stages.map((stage) => [stage.stage, stage.status])),
    {
      page: "failed",
      video: "succeeded",
      title: "failed",
      body: "succeeded",
      topics: "failed",
      cover: "succeeded",
      declaration: "failed",
      ready: "failed"
    }
  );
  assert.strictEqual(normalizePublishOutcome("douyin", "ignored", existing), existing);
});
