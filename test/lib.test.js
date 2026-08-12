import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeAppleScript,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  redactSecrets,
  resolveAppIdentity,
  truncateOutput,
} from "../src/lib.js";

test("normalizeReasoningEffort accepts known values and falls back", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("bogus"), "low");
  assert.equal(normalizeReasoningEffort("bogus", "medium"), "medium");
});

test("normalizeTone maps known tones and defaults to calm", () => {
  assert.match(normalizeTone("direct"), /direct/);
  assert.match(normalizeTone("energetic"), /upbeat/);
  assert.match(normalizeTone("unknown"), /calm/);
});

test("escapeAppleScript escapes quotes and backslashes", () => {
  assert.equal(escapeAppleScript('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(escapeAppleScript("plain"), "plain");
});

test("resolveAppIdentity maps aliases and falls back to name", () => {
  assert.deepEqual(resolveAppIdentity({ app_name: "Safari" }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(resolveAppIdentity({ app_name: "google chrome" }), { bundle_id: "com.google.Chrome" });
  assert.deepEqual(resolveAppIdentity({ app_name: "MyApp" }), { name: "MyApp" });
  assert.deepEqual(resolveAppIdentity({ bundle_id: "x.y.z" }), { bundle_id: "x.y.z" });
  assert.deepEqual(resolveAppIdentity({}), {});
});

test("normalizeCuaArgs fills bundle_id for launch_app from context", () => {
  assert.deepEqual(
    normalizeCuaArgs("launch_app", {}, { tool_name: "launch_app", json_args: {}, reason: "open safari" }),
    { bundle_id: "com.apple.Safari" },
  );
  assert.deepEqual(normalizeCuaArgs("launch_app", { name: "X" }), { name: "X" });
  assert.deepEqual(normalizeCuaArgs("other_tool", { a: 1 }), { a: 1 });
});

test("redactSecrets masks OpenAI keys", () => {
  assert.equal(redactSecrets("key sk-proj-abc123_DEF"), "key [REDACTED_OPENAI_KEY]");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

test("truncateOutput truncates long stdout and preserves metadata", () => {
  const out = truncateOutput({ ok: true, code: 0, stdout: "x".repeat(100), stderr: "" }, 50);
  assert.ok(out.stdout.includes("[truncated 50 chars]"));
  assert.equal(out.ok, true);
  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
});

test("truncateOutput leaves short output untouched", () => {
  const out = truncateOutput({ ok: true, stdout: "short", stderr: "" }, 50);
  assert.equal(out.stdout, "short");
});
