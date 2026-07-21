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

test("manual partial outcomes fail truthfully with manual stage detail", () => {
  const mapped = mapPublishOutcome({
    status: "partial",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "ready", status: "failed", detail: "manual publish remains" }],
    failedStage: "ready",
    adapterVersion: "test"
  });

  assert.equal(mapped.diagnosticStatus, "partial");
  assert.equal(mapped.postStatus, "failed");
  assert.equal(mapped.videoStatus, "failed");
  assert.match(mapped.progressLabel, /人工发布材料未准备/);
  assert.match(mapped.progressLabel, /发布前就绪状态/);
  assert.match(mapped.progressLabel, /manual publish remains/);
  assert.doesNotMatch(mapped.progressLabel, /人工发布材料已准备|自动填写/);
});

test("manual failed outcomes never use automatic-fill wording", () => {
  const mapped = mapPublishOutcome({
    status: "failed",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "video", status: "failed", detail: "素材文件夹未能打开" }],
    failedStage: "video",
    adapterVersion: "test"
  });

  assert.equal(mapped.diagnosticStatus, "error");
  assert.equal(mapped.postStatus, "failed");
  assert.equal(mapped.videoStatus, "failed");
  assert.match(mapped.progressLabel, /人工发布材料未准备/);
  assert.match(mapped.progressLabel, /视频/);
  assert.match(mapped.progressLabel, /素材文件夹未能打开/);
  assert.doesNotMatch(mapped.progressLabel, /自动填写/);
});

test("legacy Douyin results complete after every required write was verified", () => {
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

  assert.equal(outcome.status, "complete");
  assert.equal(outcome.failedStage, null);
  assert.deepEqual(
    outcome.stages.map(({ stage, status }) => ({ stage, status })),
    [
      { stage: "page", status: "succeeded" },
      { stage: "video", status: "succeeded" },
      { stage: "title", status: "succeeded" },
      { stage: "body", status: "succeeded" },
      { stage: "topics", status: "succeeded" },
      { stage: "cover", status: "succeeded" },
      { stage: "declaration", status: "succeeded" }
    ]
  );
});

test("successful legacy manual result normalizes to complete prepared materials", () => {
  const outcome = normalizePublishOutcome("xiaohongshu", "legacy-manual-test", {
    browserMode: "manual",
    copied: true,
    loginRequired: false,
    uploadPrefilled: false,
    titlePrefilled: false,
    bodyPrefilled: false,
    tagsPrefilled: false,
    coverPrefilled: false,
    declarationPrefilled: false
  });

  assert.equal(outcome.status, "complete");
  assert.equal(outcome.failedStage, null);
  assert.ok(outcome.stages.length > 0);
  assert.ok(outcome.stages.every((stage) => stage.status !== "failed"));
  assert.match(outcome.stages.map((stage) => stage.detail).join(" "), /人工发布材料已准备/);
  assert.deepEqual(mapPublishOutcome(outcome), {
    diagnosticStatus: "ok",
    postStatus: "opened",
    videoStatus: "opened",
    httpStatus: 200,
    progressLabel: "人工发布材料已准备"
  });
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
