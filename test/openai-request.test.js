import assert from "node:assert/strict";
import { test } from "node:test";
import { postOpenAIJson } from "../src/openai-request.js";
test("main token HTTP request is cancelled by session owner, including before fetch", async () => {
  const controller = new AbortController();
  let seen,
    calls = 0;
  const fetch = (_url, options) => {
    calls++;
    seen = options;
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
    );
  };
  const options = {
    apiKey: "sk-fake",
    url: "https://api.openai.com/v1/realtime/client_secrets",
    body: { session: {} },
    signal: controller.signal,
    fetch,
    timeoutMs: 1000,
  };
  const pending = postOpenAIJson(options);
  controller.abort();
  await assert.rejects(pending, /cancel/i);
  assert.equal(seen.signal.aborted, true);
  await assert.rejects(postOpenAIJson(options), /cancel/i);
  assert.equal(calls, 1);
});
test("configured token timeout bounds a hung HTTP fetch", async () => {
  // Keep one test handle while AbortSignal.timeout's native timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      postOpenAIJson({
        apiKey: "sk-fake",
        url: "https://api.openai.com/v1/realtime/client_secrets",
        body: {},
        timeoutMs: 10,
        fetch: (_url, { signal }) =>
          new Promise((_r, j) => signal.addEventListener("abort", () => j(signal.reason), { once: true })),
      }),
      /timed out/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
