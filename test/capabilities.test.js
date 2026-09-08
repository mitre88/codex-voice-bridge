import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitySnapshot, resolveExecutable } from "../src/capabilities.js";
import { validateCuaRegistry, normalizeVoice } from "../src/lib.js";
test("Finder executable resolution trusts validated absolute locations, never a login shell", () => {
  const reads = [];
  const io = {
    realpathSync: (value) => {
      reads.push(value);
      return value;
    },
    statSync: () => ({ isFile: () => true, mode: 0o100755, uid: 501 }),
    accessSync: () => {},
  };
  assert.equal(resolveExecutable("codex", "/trusted/codex", { io, uid: 501 }), "/trusted/codex");
  assert.equal(resolveExecutable("codex", "relative/codex", { io, uid: 501 }), null);
  assert.equal(
    resolveExecutable("codex", "/untrusted/codex", {
      io: { ...io, statSync: () => ({ isFile: () => true, mode: 0o100777, uid: 501 }) },
      uid: 501,
    }),
    null,
  );
  assert.deepEqual(reads, ["/trusted/codex", "/untrusted/codex"]);
});
test("optional tools and denied accessibility do not block standalone voice or prompt", () => {
  let prompted = false;
  const capabilities = capabilitySnapshot({
    platform: "darwin",
    arch: "arm64",
    systemPreferences: {
      getMediaAccessStatus: () => "denied",
      isTrustedAccessibilityClient: (prompt) => {
        prompted = prompt;
        return false;
      },
    },
  });
  assert.equal(capabilities.standaloneVoice, true);
  assert.equal(capabilities.codex.available, false);
  assert.equal(capabilities.microphone, "denied");
  assert.equal(prompted, false);
});
test("positive CUA registry rejects unknown tools, unapproved fields and prompting diagnostics", () => {
  assert.match(validateCuaRegistry("delete_everything", {}), /Unknown/);
  assert.match(validateCuaRegistry("list_apps", { forceprompt: true }), /Unsupported/);
  assert.match(validateCuaRegistry("check_permissions", { forceprompt: true }), /false/);
  assert.equal(validateCuaRegistry("check_permissions", { forceprompt: false }), null);
  assert.match(validateCuaRegistry("launch_app", { url: "file:///etc/passwd" }), /unsafe/);
  assert.match(validateCuaRegistry("type_text_chars", { text: "safe", delay_ms: -1 }), /delay_ms/);
  assert.match(validateCuaRegistry("press_key", { key: "x", modifiers: [42] }), /strings/);
  assert.equal(validateCuaRegistry("list_apps", {}), null);
});
test("voice values normalize and validate against the selectable allowlist", () => {
  for (const value of [null, 42, "unknown", " "]) assert.equal(normalizeVoice(value), "marin");
  assert.equal(normalizeVoice(" CEDAR "), "cedar");
});
