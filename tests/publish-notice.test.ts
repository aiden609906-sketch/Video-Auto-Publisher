import test from "node:test";
import assert from "node:assert/strict";
import { formatPublishNotice } from "../src/client/publish-notice.js";

test("manual complete notice says materials are ready and renders returned stages", () => {
  const notice = formatPublishNotice({
    status: "complete",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "page", status: "succeeded", detail: "发布页已打开" }],
    failedStage: null,
    adapterVersion: "test"
  });

  assert.equal(notice.type, "ok");
  assert.match(notice.text, /人工发布材料已准备/);
  assert.match(notice.text, /发布页面：成功/);
  assert.match(notice.text, /发布页已打开/);
});

test("manual failed notice reports returned failure detail without claiming readiness", () => {
  const notice = formatPublishNotice({
    status: "failed",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "video", status: "failed", detail: "素材文件夹未能打开" }],
    failedStage: "video",
    adapterVersion: "test"
  });

  assert.equal(notice.type, "error");
  assert.match(notice.text, /视频：失败/);
  assert.match(notice.text, /素材文件夹未能打开/);
  assert.doesNotMatch(notice.text, /人工发布材料已准备/);
});

test("login-required notice keeps the retry guidance", () => {
  const notice = formatPublishNotice({
    status: "login_required",
    browserMode: "manual",
    platform: "xiaohongshu",
    stages: [{ stage: "page", status: "failed", detail: "账号未登录" }],
    failedStage: "page",
    adapterVersion: "test"
  });

  assert.equal(notice.type, "error");
  assert.match(notice.text, /登录完成后再点一次打开发布/);
});
