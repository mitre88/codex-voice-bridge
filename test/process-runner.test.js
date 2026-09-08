import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createProcessRunner } from "../src/process-runner.js";
function child() {
  const c = new EventEmitter();
  Object.assign(c, { pid: 81234, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return c;
}
test("aborted jobs never spawn; cancelled output stops immediately and descendants still receive SIGKILL after leader close", async () => {
  const c = child(),
    signals = [];
  let spawns = 0;
  const runner = createProcessRunner({
    spawn: () => {
      spawns++;
      return c;
    },
    kill: (_pid, s) => signals.push(s),
    killGraceMs: 15,
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal((await runner.run("fake", [], { signal: abort.signal })).code, -95);
  assert.equal(spawns, 0);
  const second = new AbortController(),
    chunks = [];
  const pending = runner.run("fake", [], { signal: second.signal, onOutput: (s) => chunks.push(s) });
  c.stdout.write("before");
  second.abort();
  c.stdout.write("late");
  c.emit("close", 0);
  const result = await pending;
  assert.equal(result.code, -95);
  await new Promise((r) => setTimeout(r, 35));
  assert.deepEqual(chunks, ["before"]);
  assert.ok(signals.includes("SIGTERM"));
  assert.ok(signals.includes("SIGKILL"));
  assert.equal(runner.size, 0);
});
test("stdout and stderr preserve UTF-8 tails of 1048576 characters without unbounded growth", async () => {
  const c = child();
  const runner = createProcessRunner({ spawn: () => c });
  const pending = runner.run("fake", []);
  const emoji = Buffer.from("😀");
  c.stdout.write(emoji.subarray(0, 2));
  c.stdout.write(emoji.subarray(2));
  c.stdout.write("x".repeat(1048576));
  c.stdout.write("TAIL");
  c.stderr.write("y".repeat(1048600));
  c.emit("close", 0);
  const result = await pending;
  assert.ok(result.stdout.endsWith("TAIL"));
  assert.ok(result.stdout.includes("1048576 characters"));
  assert.ok(result.stderr.length < 1048650);
  assert.equal(runner.size, 0);
});
test("real owned descendants that ignore SIGTERM are killed even after their leader exits", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups; app targets macOS.");
  for (const leaderExits of [false, true]) {
    const runner = createProcessRunner({ killGraceMs: 50 });
    t.after(() => runner.close());
    const controller = new AbortController();
    let childPid, markReady;
    const ready = new Promise((r) => (markReady = r));
    const run = runner.run(
      process.execPath,
      [new URL("./fixtures/descendant.cjs", import.meta.url).pathname, ...(leaderExits ? ["--leader-exits"] : [])],
      {
        env: {},
        signal: controller.signal,
        timeoutMs: 3000,
        onOutput: (text) => {
          const match = text.match(/DESC:(\d+)/);
          if (match) {
            childPid = Number(match[1]);
            markReady();
          }
        },
      },
    );
    await ready;
    if (!leaderExits) controller.abort();
    await run;
    await runner.close();
    let alive = true;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(alive, false, "Owned descendant must not outlive cleanup");
    assert.equal(runner.size, 0);
  }
});
