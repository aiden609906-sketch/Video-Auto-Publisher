import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Publisher } from "../src/server/publisher.js";

test("existing Edge profile is reopened with Edge only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publisher-edge-profile-"));
  try {
    await writeFile(path.join(dir, "Last Browser"), "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "utf16le");

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const channels = await (hooks.browserChannelsForProfile as (profileDir: string) => Promise<string[]>)(dir);

    assert.deepEqual(channels, ["msedge"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown profile browser keeps the normal channel fallback order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publisher-unknown-profile-"));
  try {
    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const channels = await (hooks.browserChannelsForProfile as (profileDir: string) => Promise<string[]>)(dir);

    assert.deepEqual(channels, ["msedge", "chrome"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
