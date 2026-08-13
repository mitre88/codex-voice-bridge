import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accumulateOutput,
  applyEnvOverrides,
  escapeAppleScript,
  hasVirtualAudioDevice,
  humanizeError,
  isPlausibleApiKey,
  isSafeAppIdentity,
  isSafeCuaToolName,
  isSafeLaunchUrl,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  parseEnvFile,
  redactSecrets,
  requireMaxLength,
  requireNonEmptyString,
  resolveAppIdentity,
  resolveOpenAppTarget,
  resolveWorkdir,
  rotateLogIfNeeded,
  toPositiveInt,
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

test("escapeAppleScript doubles quotes the AppleScript way", () => {
  assert.equal(escapeAppleScript('a"b\\c'), 'a""b\\c');
  assert.equal(escapeAppleScript("plain"), "plain");
  assert.equal(escapeAppleScript('x"\ndo shell script "id"'), 'x""do shell script ""id""');
});

test("escapeAppleScript keeps printable non-ASCII (accented app names)", () => {
  assert.equal(escapeAppleScript("Música"), "Música");
  assert.equal(escapeAppleScript("Números"), "Números");
  assert.equal(escapeAppleScript("Páginas"), "Páginas");
});

test("escapeAppleScript still strips control characters", () => {
  assert.equal(escapeAppleScript("a\u0007b\nc"), "abc");
  assert.equal(escapeAppleScript("a\u0085b"), "ab"); // C1 control
  assert.equal(escapeAppleScript("a\u007Fb"), "ab"); // DEL
});

test("isSafeAppIdentity allowlists bundle ids and simple app names", () => {
  assert.equal(isSafeAppIdentity({ bundle_id: "com.apple.Safari" }), true);
  assert.equal(isSafeAppIdentity({ name: "Visual Studio Code" }), true);
  assert.equal(isSafeAppIdentity({ name: 'x"\ndo shell script' }), false);
  assert.equal(isSafeAppIdentity({ bundle_id: "a; do shell script" }), false);
  assert.equal(isSafeAppIdentity({}), false);
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

test("resolveOpenAppTarget prefers an app identity over a url", () => {
  assert.deepEqual(resolveOpenAppTarget({ app_name: "Safari", url: "https://example.com" }), {
    kind: "app",
    identity: { bundle_id: "com.apple.Safari" },
  });
  assert.deepEqual(resolveOpenAppTarget({ bundle_id: "x.y.z" }), { kind: "app", identity: { bundle_id: "x.y.z" } });
  assert.deepEqual(resolveOpenAppTarget({ app_name: "MyApp" }), { kind: "app", identity: { name: "MyApp" } });
});

test("resolveOpenAppTarget allows a url-only open in the default browser", () => {
  assert.deepEqual(resolveOpenAppTarget({ url: "https://meet.google.com/abc" }), {
    kind: "url",
    url: "https://meet.google.com/abc",
  });
  assert.deepEqual(resolveOpenAppTarget({ url: "http://localhost:3000/page" }), {
    kind: "url",
    url: "http://localhost:3000/page",
  });
});

test("resolveOpenAppTarget rejects unsafe or missing targets", () => {
  assert.deepEqual(resolveOpenAppTarget({}), { kind: "error", code: -1, message: "Missing app_name, bundle_id, or url." });
  assert.deepEqual(resolveOpenAppTarget({ url: "" }), { kind: "error", code: -1, message: "Missing app_name, bundle_id, or url." });
  assert.equal(resolveOpenAppTarget({ url: "file:///etc/passwd" }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: "ssh://evil-host" }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: 42 }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: "javascript:alert(1)" }).code, -9);
});

test("isSafeCuaToolName accepts snake_case identifiers and rejects option-like names", () => {
  assert.equal(isSafeCuaToolName("launch_app"), true);
  assert.equal(isSafeCuaToolName("list_apps"), true);
  assert.equal(isSafeCuaToolName("--version"), false);
  assert.equal(isSafeCuaToolName("call --help"), false);
  assert.equal(isSafeCuaToolName(""), false);
  assert.equal(isSafeCuaToolName("a".repeat(101)), false);
  assert.equal(isSafeCuaToolName(42), false);
});

test("isSafeLaunchUrl accepts http/https URLs with a hostname", () => {
  assert.equal(isSafeLaunchUrl("https://meet.google.com/abc"), true);
  assert.equal(isSafeLaunchUrl("http://localhost:3000/page"), true);
  assert.equal(isSafeLaunchUrl("https://example.com"), true);
});

test("isSafeLaunchUrl rejects non-http schemes and malformed input", () => {
  assert.equal(isSafeLaunchUrl("file:///etc/passwd"), false);
  assert.equal(isSafeLaunchUrl("ssh://evil-host"), false);
  assert.equal(isSafeLaunchUrl("x-apple.systempreferences:com.apple.preference.general"), false);
  assert.equal(isSafeLaunchUrl("javascript:alert(1)"), false);
  assert.equal(isSafeLaunchUrl("https://"), false);
  assert.equal(isSafeLaunchUrl("not a url"), false);
  assert.equal(isSafeLaunchUrl(""), false);
  assert.equal(isSafeLaunchUrl(42), false);
  assert.equal(isSafeLaunchUrl(undefined), false);
});

test("isPlausibleApiKey accepts sk- keys and rejects obvious non-keys", () => {
  assert.equal(isPlausibleApiKey("sk-proj-abc123_DEF"), true);
  assert.equal(isPlausibleApiKey("sk-abc"), true);
  assert.equal(isPlausibleApiKey(""), false);
  assert.equal(isPlausibleApiKey("sk- with space"), false);
  assert.equal(isPlausibleApiKey("not-a-key"), false);
  assert.equal(isPlausibleApiKey(42), false);
});

test("requireNonEmptyString accepts non-empty strings and rejects the rest", () => {
  assert.equal(requireNonEmptyString("run the tests", "prompt"), null);
  assert.equal(requireNonEmptyString("  spaced  ", "prompt"), null);
  assert.equal(requireNonEmptyString("", "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString("   ", "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(undefined, "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(null, "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(42, "text"), "text must be a non-empty string.");
  assert.equal(requireNonEmptyString({ a: 1 }, "key"), "key must be a non-empty string.");
});

test("requireMaxLength caps oversized argv-bound values", () => {
  assert.equal(requireMaxLength("short", "prompt"), null);
  assert.equal(requireMaxLength("x".repeat(200001), "prompt"), "prompt exceeds the maximum length of 200000 characters.");
  assert.equal(requireMaxLength("y".repeat(50), "key", 100), null);
  assert.equal(requireMaxLength("y".repeat(101), "key", 100), "key exceeds the maximum length of 100 characters.");
  // Non-strings pass through: type checks are the caller's job.
  assert.equal(requireMaxLength(undefined, "prompt"), null);
  assert.equal(requireMaxLength({ a: 1 }, "prompt"), null);
});

test("redactSecrets masks OpenAI keys", () => {
  assert.equal(redactSecrets("key sk-proj-abc123_DEF"), "key [REDACTED_OPENAI_KEY]");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

test("redactSecrets masks modern project keys containing dots", () => {
  assert.equal(redactSecrets("token sk-proj-abc123.def456-ghi"), "token [REDACTED_OPENAI_KEY]");
  assert.equal(redactSecrets("sk-proj-a.b.c"), "[REDACTED_OPENAI_KEY]");
});

test("humanizeError maps common failure modes to actionable messages", () => {
  assert.match(humanizeError({ name: "NotAllowedError", message: "denied" }), /microphone or screen access was denied/i);
  assert.match(humanizeError({ name: "NotFoundError", message: "no device" }), /no audio input device/i);
  assert.match(humanizeError({ name: "TimeoutError", message: "aborted" }), /request timed out/i);
  assert.match(humanizeError({ name: "AbortError", message: "aborted" }), /request timed out/i);
  assert.match(humanizeError(new Error("insufficient_quota")), /insufficient_quota/i);
  assert.match(humanizeError(new Error("exceeded your current quota")), /insufficient_quota/i);
});

test("humanizeError maps stale media device selections to an actionable message", () => {
  assert.match(
    humanizeError({ name: "OverconstrainedError", message: "Constraints could not be satisfied" }),
    /no longer available/i,
  );
  assert.match(humanizeError(new Error("Constraints could not be satisfied")), /no longer available/i);
});

test("humanizeError maps invalid API key failures to an actionable message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 401 invalid_api_key")), /rejected the API key/i);
  assert.match(humanizeError(new Error("Incorrect API key provided")), /rejected the API key/i);
});

test("humanizeError maps network failures to a connectivity message", () => {
  assert.match(humanizeError(new TypeError("fetch failed")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("getaddrinfo ENOTFOUND api.openai.com")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("fetch failed: ECONNREFUSED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("socket hang up")), /could not reach the openai api/i);
  assert.match(humanizeError(new TypeError("NetworkError when attempting to fetch resource.")), /could not reach the openai api/i);
  // A network error must not shadow a more specific API error.
  assert.match(humanizeError(new Error("Error code: 401 - invalid_api_key")), /rejected the API key/i);
});

test("humanizeError maps insufficient permissions failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 403 - insufficient_permissions for project")), /insufficient permissions \(403\)/i);
  assert.match(humanizeError(new Error("You do not have access to the realtime API")), /insufficient permissions \(403\)/i);
  // A 404 model error must keep mapping to the 404 branch, not the 403 one.
  assert.match(
    humanizeError(new Error("Error code: 404 - The model 'gpt-realtime-2' does not exist or you do not have access to it.")),
    /could not find the requested realtime model \(404\)/i,
  );
});

test("humanizeError maps rate limit failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 429 - rate_limit_exceeded for gpt-realtime-2")), /rate limit reached \(429\)/i);
  assert.match(humanizeError(new Error("Rate limit reached for model on requests per min (RPM)")), /rate limit reached \(429\)/i);
});

test("humanizeError maps missing model failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 404 - The model 'gpt-realtime-2' does not exist or you do not have access to it.")), /could not find the requested realtime model \(404\)/i);
  assert.match(humanizeError(new Error("model_not_found")), /could not find the requested realtime model \(404\)/i);
  // A generic "does not exist" that is not about a model still passes through.
  assert.equal(humanizeError(new Error("the file does not exist")), "the file does not exist");
});

test("humanizeError passes through unknown messages", () => {
  assert.equal(humanizeError(new Error("boom")), "boom");
  assert.equal(humanizeError("plain string"), "plain string");
  assert.equal(humanizeError(undefined), "undefined");
  assert.equal(humanizeError(null), "null");
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

test("accumulateOutput caps the buffer at maxChars and reports truncation", () => {
  const over = accumulateOutput("", "x".repeat(100), 50);
  assert.equal(over.text.length, 50);
  assert.equal(over.capped, true);
  // A buffer already at the cap stays put and keeps reporting truncation.
  const full = accumulateOutput("x".repeat(50), "more", 50);
  assert.equal(full.text, "x".repeat(50));
  assert.equal(full.capped, true);
  // Small chunks pass through untouched while under the cap.
  const ok = accumulateOutput("abc", "def", 100);
  assert.equal(ok.text, "abcdef");
  assert.equal(ok.capped, false);
});

test("resolveWorkdir keeps paths inside the base workdir", () => {
  const base = path.join(path.sep, "Users", "alex", "projects", "app");
  assert.equal(resolveWorkdir(undefined, base), base);
  assert.equal(resolveWorkdir("", base), base);
  assert.equal(resolveWorkdir("  ", base), base);
  assert.equal(resolveWorkdir("sub/dir", base), path.join(base, "sub", "dir"));
  assert.equal(resolveWorkdir(path.join(base, "sub"), base), path.join(base, "sub"));
});

test("resolveWorkdir rejects traversal and outside absolute paths", () => {
  const base = path.join(path.sep, "Users", "alex", "projects", "app");
  assert.equal(resolveWorkdir("../outside", base), base);
  assert.equal(resolveWorkdir("../../etc", base), base);
  assert.equal(resolveWorkdir(path.join(path.sep, "etc", "passwd"), base), base);
  // A sibling prefix must not pass the containment check.
  assert.equal(resolveWorkdir(`${base}2`, base), base);
  assert.equal(resolveWorkdir(base, base), base);
});

test("parseEnvFile parses KEY=VALUE lines, comments, blanks, and quoted values", () => {
  assert.deepEqual(
    parseEnvFile(`
      # full-line comment
      OPENAI_API_KEY=sk-test-123
      EMPTY=
      QUOTED="hello world"
      SINGLE='a=b'
      INLINE=sk-x-1 # trailing comment
      bad line
      =novalue
    `),
    {
      OPENAI_API_KEY: "sk-test-123",
      EMPTY: "",
      QUOTED: "hello world",
      SINGLE: "a=b",
      INLINE: "sk-x-1",
    },
  );
  assert.deepEqual(parseEnvFile(""), {});
  assert.deepEqual(parseEnvFile(null), {});
  assert.deepEqual(parseEnvFile(42), {});
});

test("parseEnvFile keeps '#' inside unquoted values without preceding whitespace", () => {
  assert.deepEqual(parseEnvFile("KEY=sk-x#note\nQUOTED=\"a # b\""), { KEY: "sk-x#note", QUOTED: "a # b" });
});

test("applyEnvOverrides never overrides existing environment variables", () => {
  const env = { EXISTING: "keep" };
  applyEnvOverrides({ EXISTING: "new", NEW: "added" }, env);
  assert.equal(env.EXISTING, "keep");
  assert.equal(env.NEW, "added");
});

test("toPositiveInt accepts positive integers and falls back otherwise", () => {
  assert.equal(toPositiveInt("120000", 60000), 120000);
  assert.equal(toPositiveInt("abc", 60000), 60000);
  assert.equal(toPositiveInt("0", 60000), 60000);
  assert.equal(toPositiveInt("-5", 60000), 60000);
  assert.equal(toPositiveInt("1.5", 60000), 60000);
  assert.equal(toPositiveInt("", 60000), 60000);
  assert.equal(toPositiveInt(undefined, 60000), 60000);
});

test("hasVirtualAudioDevice matches BlackHole, Loopback, and virtual labels", () => {
  assert.equal(hasVirtualAudioDevice([{ label: "MacBook Pro Microphone" }]), false);
  assert.equal(hasVirtualAudioDevice([{ label: "BlackHole 2ch" }]), true);
  assert.equal(hasVirtualAudioDevice([{ label: "Loopback Audio" }]), true);
  assert.equal(hasVirtualAudioDevice([{ label: "Virtual Cable" }]), true);
  assert.equal(hasVirtualAudioDevice([]), false);
});

test("rotateLogIfNeeded ignores a missing log file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  assert.equal(rotateLogIfNeeded(fs, logFile, 16), false);
  assert.equal(fs.existsSync(logFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateLogIfNeeded keeps a small log file in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  fs.writeFileSync(logFile, "small");
  assert.equal(rotateLogIfNeeded(fs, logFile, 16), false);
  assert.equal(fs.readFileSync(logFile, "utf8"), "small");
  assert.equal(fs.existsSync(`${logFile}.1`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateLogIfNeeded keeps only the previous oversized file as .1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  fs.writeFileSync(`${logFile}.1`, "older");
  fs.writeFileSync(logFile, "current-oversize");
  assert.equal(rotateLogIfNeeded(fs, logFile, 8), true);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.readFileSync(`${logFile}.1`, "utf8"), "current-oversize");
  fs.rmSync(dir, { recursive: true, force: true });
});
