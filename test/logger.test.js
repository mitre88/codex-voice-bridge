import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createBoundedLogger } from "../src/logger.js";
test("slow log sink bounds queued bytes and reports drops without ignoring backpressure", async () => {
  const written = [];
  let unblock;
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, _enc, callback) {
      written.push(chunk.toString());
      unblock = callback;
    },
  });
  const logger = createBoundedLogger({
    open: async () => ({ stream: sink, size: 0 }),
    rotate: async () => {},
    maxQueueBytes: 256,
    maxFileBytes: 4096,
  });
  logger.write("first");
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 100; i++) logger.write("line".repeat(20));
  assert.ok(logger.stats.queuedBytes <= 256);
  assert.ok(logger.stats.dropped > 0);
  assert.equal(written.length, 1);
  const closing = logger.close(100);
  for (let i = 0; i < 12; i++) {
    unblock?.();
    await new Promise((r) => setImmediate(r));
  }
  await closing;
  assert.match(written.join(""), /dropped/);
});
test("logger handles open/write errors and bounded shutdown without throwing", async () => {
  const logger = createBoundedLogger({
    open: async () => {
      throw new Error("disk denied");
    },
    rotate: async () => {},
  });
  assert.doesNotThrow(() => logger.write("message"));
  await logger.close(20);
  assert.ok(logger.stats.errors > 0);
});
