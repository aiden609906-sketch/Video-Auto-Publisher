import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SCANNER_MODE, selectCoverTarget } from "../src/server/scanner.js";
import type { VideoTask } from "../src/shared/types.js";

function video(id: string, filename: string): VideoTask {
  return {
    id,
    filePath: path.join("D:\\inbox", filename),
    filename,
    size: 100,
    sha256: id,
    status: "ready",
    note: "",
    covers: { landscape: null, portrait: null },
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    posts: []
  };
}

test("scanner is manual-only so startup and file changes do not change the selected task", () => {
  assert.equal(SCANNER_MODE, "manual");
});

test("cover scan matches an image to the video with the same task name", () => {
  const videos = [video("first", "seedance2.5来了！AI视频又要进化了.mp4"), video("second", "厄尔尼诺亮红灯.mp4")];

  const matched = selectCoverTarget(path.join("D:\\inbox", "厄尔尼诺亮红灯-封面.png"), videos, "D:\\inbox");

  assert.equal(matched?.id, "second");
});

test("cover scan does not guess when multiple videos match equally", () => {
  const videos = [video("first", "厄尔尼诺-上集.mp4"), video("second", "厄尔尼诺-下集.mp4")];

  const matched = selectCoverTarget(path.join("D:\\inbox", "厄尔尼诺-封面.png"), videos, "D:\\inbox");

  assert.equal(matched, undefined);
});

test("cover scan does not attach an unrelated image just because there is one video", () => {
  const videos = [video("first", "seedance2.5来了！AI视频又要进化了.mp4")];

  const matched = selectCoverTarget(path.join("D:\\inbox", "厄尔尼诺亮红灯-封面.png"), videos, "D:\\inbox");

  assert.equal(matched, undefined);
});
