import test from "node:test";
import assert from "node:assert/strict";
import { PublishAccountBusyError, PublishAccountLock } from "../src/server/publish/account-lock.js";

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
