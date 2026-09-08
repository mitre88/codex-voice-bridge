import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationRegistry } from "../src/operations.js";
const owner = (id) => ({
  id,
  isDestroyed: () => false,
  sent: [],
  send(...args) {
    this.sent.push(args);
  },
});
test("disconnect drops queued actions and output cannot reach a replacement window/session", async () => {
  const registry = createOperationRegistry();
  const a = owner(1),
    b = owner(2);
  registry.begin(a, "old");
  registry.begin(b, "other");
  let release;
  const entered = new Promise((resolve) => (release = resolve));
  let old;
  const first = registry.run(
    a,
    { sessionId: "old", requestId: "one" },
    async (c) => {
      old = c;
      await entered;
      return { ok: true };
    },
    { queued: true },
  );
  let launched = 0;
  const second = registry.run(
    a,
    { sessionId: "old", requestId: "two" },
    async () => {
      launched++;
      return { ok: true };
    },
    { queued: true },
  );
  await new Promise((r) => setImmediate(r));
  registry.cancel(a, "old");
  registry.begin(a, "new");
  old.output("stale");
  release();
  await first;
  await second;
  assert.equal(launched, 0);
  assert.deepEqual(a.sent, []);
  assert.deepEqual(b.sent, []);
});
test("only originating owner receives scoped output; request IDs cannot replay", async () => {
  const r = createOperationRegistry(),
    a = owner(1),
    b = owner(2);
  r.begin(a, "session-a");
  r.begin(b, "session-b");
  let signal;
  await r.run(a, { sessionId: "session-a", requestId: "job" }, async (c) => {
    signal = c.signal;
    c.output("current");
    return { ok: true };
  });
  assert.deepEqual(a.sent, [["codex-output", { sessionId: "session-a", requestId: "job", chunk: "current" }]]);
  assert.equal(b.sent.length, 0);
  assert.equal(
    (
      await r.run(a, { sessionId: "session-a", requestId: "job" }, () => {
        throw new Error("replayed");
      })
    ).ok,
    false,
  );
  r.destroy(a);
  assert.equal(signal.aborted, true);
  assert.equal(r.size, 1);
  r.dispose();
  assert.equal(r.size, 0);
});
