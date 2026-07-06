import test from "node:test";
import assert from "node:assert/strict";
import { resolveSelectedVideoId } from "../src/client/selection.js";
import type { VideoTask } from "../src/shared/types.js";

function video(id: string): VideoTask {
  return {
    id,
    filePath: `${id}.mp4`,
    filename: `${id}.mp4`,
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

test("refresh keeps the user's selected task when it still exists", () => {
  const videos = [video("first"), video("second")];

  assert.equal(resolveSelectedVideoId("second", videos), "second");
});

test("refresh selects the first task only when there is no current selection", () => {
  const videos = [video("first"), video("second")];

  assert.equal(resolveSelectedVideoId("", videos), "first");
});

test("refresh falls back to the first task when the selected task no longer exists", () => {
  const videos = [video("first"), video("second")];

  assert.equal(resolveSelectedVideoId("removed", videos), "first");
});
